// HTTP helpers: JSON responses, typed errors, CORS, bearer auth.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const jsonSafe = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(jsonSafe(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** `https://*.isotherm.pages.dev` and `http://localhost:*` style wildcards. */
export function originAllowed(origin: string | null, patterns: string[]): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  for (const p of patterns) {
    if (p === '*') return true;
    const m = p.match(/^(https?):\/\/(\*\.)?([^:/]+)(?::(\*|\d+))?$/);
    if (!m) continue;
    const [, proto, wild, host, port] = m;
    if (u.protocol !== `${proto}:`) continue;
    const hostOk = wild ? u.hostname.endsWith(`.${host}`) && u.hostname.length > host.length + 1 : u.hostname === host;
    if (!hostOk) continue;
    if (port === '*') return true;
    const actual = u.port || (proto === 'https' ? '443' : '80');
    if ((port ?? (proto === 'https' ? '443' : '80')) === actual) return true;
  }
  return false;
}

export function corsHeaders(origin: string | null, patterns: string[]): Record<string, string> {
  if (!originAllowed(origin, patterns)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin!,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** Constant-time string compare (both sides hashed first so lengths do not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length === b.length;
}

export async function requireBearer(req: Request, expected: string | undefined): Promise<void> {
  if (!expected) throw new HttpError(503, 'endpoint not configured');
  const h = req.headers.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || !(await safeEqual(token, expected))) throw new HttpError(401, 'unauthorized');
}

export async function readJson<T>(req: Request, limit = 16_384): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > limit) throw new HttpError(413, 'body too large');
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text || '{}') as T;
  } catch {
    throw new HttpError(400, 'bad json');
  }
}

/** UTC day key, e.g. 20261007. */
export const dayKey = (ms = Date.now()) => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

/** Rate-limit bucket for a client IP (security review v1). IPv4 is used as is; IPv6 is cut to its /64, because one
 *  subscriber usually holds a whole /64 (2^64 addresses), so a per-address limit is no limit at all. IPv4-mapped
 *  IPv6 (::ffff:a.b.c.d) is treated as the IPv4 address. Anything unparsable is returned unchanged. */
export function ipBucket(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(':')) return raw;
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const addr = raw.split('%')[0];
  const halves = addr.split('::');
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return raw;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Salted hash of the client IP so raw IPs are never stored. */
export async function ipTag(ip: string, salt: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}`));
  return [...new Uint8Array(h).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const errorMessage = (e: unknown) => {
  const m = (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return String(m).split('\n')[0].slice(0, 300);
};
