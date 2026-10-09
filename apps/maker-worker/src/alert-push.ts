// Optional push channel for the Worker's alerts (secret ALERT_WEBHOOK_URL). Without it, alerts stay where they always
// were: the Durable Object's `alerts` log and the KV outbox (`scripts/control.mjs alerts`). With it, every alert is
// also POSTed, so a settlement problem reaches a phone at night:
//   - an ntfy topic URL (https://ntfy.sh/<topic>, or any *.ntfy.sh host): plain-text body, the title in the Title header;
//   - a Telegram bot URL (https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>): JSON {chat_id, text};
//   - anything else: JSON {title, body, text}.
// Only the alert's title and body are sent; they carry public chain data only (keys, tx hashes, station-dates,
// recomputed METAR figures), never a secret. Guarantees:
//   - a per-title rate limit (ALERT_PUSH_MIN_SEC, default 1 h, with 5 % slack so an hourly repeat is never skipped for
//     tick jitter) and at most PUSH_MAX_PER_TICK posts per tick;
//   - a 5 s timeout per post, all posts of a tick in parallel, so a dead endpoint costs a tick at most 5 s;
//   - a failure is logged (`alerts:push`, without the URL) and never breaks the tick;
//   - the URL itself is never logged, echoed or put in the KV outbox.
import type { Store } from "./store.ts";

export const PUSH_TIMEOUT_MS = 5_000;
export const PUSH_MAX_PER_TICK = 5;
/** Slack on the per-title rate limit. The hourly SETTLEMENT OVERDUE repeat is timed by chain time, the push by the
 *  wall clock at the end of the tick, so a repeat can land a few seconds "early"; it must still be pushed. */
export const PUSH_SLACK = 0.05;
const TITLE_MAX = 200;
const BODY_MAX = 3_500;
const LAST_KEY = "alert:push:last";
const LOG = "alerts:push";

export type HookKind = "ntfy" | "telegram" | "json";
export interface Webhook {
  url: string;
  kind: HookKind;
  chatId?: string;
}

/**
 * Validate ALERT_WEBHOOK_URL. Returns null when unset, `{ error }` when unusable (the message never contains the
 * URL), else the hook. https only; plain http only to a loopback host, and only when the RPC is a loopback fork.
 */
export function parseWebhook(raw: string | undefined, allowLoopbackHttp: boolean): Webhook | { error: string } | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  if (s.length > 2048 || /\s/.test(s)) return { error: "ALERT_WEBHOOK_URL is not a single URL" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "ALERT_WEBHOOK_URL is not a URL" };
  }
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback && allowLoopbackHttp)) return { error: "ALERT_WEBHOOK_URL must be https://" };
  if (u.username || u.password) return { error: "ALERT_WEBHOOK_URL must not carry credentials in the authority part" };
  const host = u.hostname.toLowerCase();
  if (host === "ntfy.sh" || host.endsWith(".ntfy.sh")) {
    if (u.pathname.length < 2) return { error: "ALERT_WEBHOOK_URL: an ntfy URL needs a topic (https://ntfy.sh/<topic>)" };
    return { url: u.toString(), kind: "ntfy" };
  }
  if (host === "api.telegram.org") {
    const chatId = u.searchParams.get("chat_id");
    if (!/\/bot[^/]+\/sendMessage$/.test(u.pathname) || !chatId) return { error: "ALERT_WEBHOOK_URL: a Telegram URL is https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>" };
    return { url: u.toString(), kind: "telegram", chatId };
  }
  return { url: u.toString(), kind: "json" };
}

/** HTTP header values are byte strings: keep printable ASCII only. */
const headerSafe = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, TITLE_MAX);

/** The request for one alert (exported for the tests). */
export function pushRequest(hook: Webhook, title: string, body: string): { url: string; init: RequestInit } {
  const t = title.slice(0, TITLE_MAX);
  const b = body.slice(0, BODY_MAX);
  if (hook.kind === "ntfy")
    return { url: hook.url, init: { method: "POST", headers: { "content-type": "text/plain; charset=utf-8", Title: headerSafe(t), Tags: "warning" }, body: b } };
  if (hook.kind === "telegram")
    return { url: hook.url, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: hook.chatId, text: `${t}\n\n${b}`, disable_web_page_preview: true }) } };
  return { url: hook.url, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t, body: b, text: `${t}\n${b}` }) } };
}

export interface PushOutcome {
  title: string;
  result: string; // "sent 200" | "rate-limited" | "failed: ..." | "dropped: ..."
}

export interface PushDeps {
  store: Store;
  hook: Webhook;
  minSec: number;
  now: () => number;
  fetch: typeof fetch;
  timeoutMs?: number;
}

/** Push this tick's alerts. Never throws. */
export async function pushAlerts(d: PushDeps, alerts: { title: string; body: string }[]): Promise<PushOutcome[]> {
  if (!alerts.length) return [];
  const out: PushOutcome[] = [];
  try {
    const t = d.now();
    const last = d.store.get<Record<string, number>>(LAST_KEY) ?? {};
    for (const [k, at] of Object.entries(last)) if (t - at > 7 * 86_400_000) delete last[k];
    const due: { title: string; body: string }[] = [];
    const seen = new Set<string>();
    const minMs = d.minSec * 1000 * (1 - PUSH_SLACK);
    for (const a of alerts) {
      if (seen.has(a.title)) continue; // the same title twice in one tick: one push
      seen.add(a.title);
      if (last[a.title] !== undefined && t - last[a.title] < minMs) out.push({ title: a.title, result: "rate-limited" });
      else if (due.length >= PUSH_MAX_PER_TICK) out.push({ title: a.title, result: `dropped: more than ${PUSH_MAX_PER_TICK} alerts this tick (all of them are in the KV outbox)` });
      else {
        due.push(a);
        last[a.title] = t; // counted at the attempt, so a dead endpoint is not retried every tick
      }
    }
    d.store.put(LAST_KEY, last);
    const sent = await Promise.all(due.map((a) => post(d, a)));
    out.push(...sent);
    for (const o of out) d.store.append(LOG, { at: new Date(t).toISOString(), title: o.title.slice(0, TITLE_MAX), result: o.result }, 200);
  } catch (e) {
    out.push({ title: "(push)", result: `failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
  }
  return out;
}

async function post(d: PushDeps, a: { title: string; body: string }): Promise<PushOutcome> {
  const { url, init } = pushRequest(d.hook, a.title, a.body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), d.timeoutMs ?? PUSH_TIMEOUT_MS);
  try {
    const r = await d.fetch(url, { ...init, redirect: "manual", signal: ctl.signal });
    try {
      await r.body?.cancel();
    } catch {}
    return { title: a.title, result: r.status >= 200 && r.status < 300 ? `sent ${r.status}` : `failed: HTTP ${r.status}` };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    // never include the URL: a fetch error message can quote it
    return { title: a.title, result: aborted ? `failed: timeout after ${d.timeoutMs ?? PUSH_TIMEOUT_MS} ms` : `failed: ${(e as Error)?.name ?? "error"}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The last push outcomes, for the status outbox (no URL). */
export function pushLog(store: Store, n = 5): { at: string; title: string; result: string }[] {
  return store.tail(LOG, n);
}
