// Drip / relay rate limits. The store is the Durable Object's strongly consistent storage (one instance for
// the whole API), so two edges cannot both pass a check that only one of them should pass.
import { dayKey } from './util';

export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export class MemStore implements Store {
  m = new Map<string, unknown>();
  async get<T>(k: string) {
    return this.m.get(k) as T | undefined;
  }
  async put(k: string, v: unknown) {
    this.m.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.m.delete(k);
  }
}

export interface DripRecord {
  at: number; // ms of the first successful drip in this cooldown period
  monTx?: string;
  ausdTx?: string;
  ausdPending?: boolean; // MON went out but the AUSD leg is waiting for the faucet cooldown
}

export interface DripLimits {
  dailyCap: number;
  perIpPerDay: number;
  addressCooldownMs: number;
}

export type DripDecision =
  | { ok: true; retryOfPending: boolean; record?: DripRecord }
  | { ok: false; status: number; reason: string; retryAfterSec?: number };

export async function checkDrip(
  store: Store,
  limits: DripLimits,
  user: string,
  ip: string,
  now = Date.now(),
): Promise<DripDecision> {
  const rec = await store.get<DripRecord>(`drip:addr:${user.toLowerCase()}`);
  if (rec && now - rec.at < limits.addressCooldownMs) {
    if (rec.ausdPending) return { ok: true, retryOfPending: true, record: rec };
    return {
      ok: false,
      status: 429,
      reason: 'this address already received test funds recently',
      retryAfterSec: Math.ceil((rec.at + limits.addressCooldownMs - now) / 1000),
    };
  }
  const day = dayKey(now);
  const ipCount = (await store.get<number>(`drip:ip:${ip}:${day}`)) ?? 0;
  if (ipCount >= limits.perIpPerDay) {
    return { ok: false, status: 429, reason: 'daily drip limit for this network reached', retryAfterSec: secondsToUtcMidnight(now) };
  }
  const total = (await store.get<number>(`drip:day:${day}`)) ?? 0;
  if (total >= limits.dailyCap) {
    return { ok: false, status: 429, reason: 'daily drip budget used up; try again tomorrow (UTC)', retryAfterSec: secondsToUtcMidnight(now) };
  }
  return { ok: true, retryOfPending: false };
}

export async function recordDrip(store: Store, user: string, ip: string, rec: DripRecord, countIt: boolean, now = Date.now()) {
  await store.put(`drip:addr:${user.toLowerCase()}`, rec);
  if (!countIt) return;
  const day = dayKey(now);
  await store.put(`drip:ip:${ip}:${day}`, ((await store.get<number>(`drip:ip:${ip}:${day}`)) ?? 0) + 1);
  await store.put(`drip:day:${day}`, ((await store.get<number>(`drip:day:${day}`)) ?? 0) + 1);
  await store.put('drip:total', ((await store.get<number>('drip:total')) ?? 0) + 1);
}

export interface RelayLimits {
  perAddressPerDay: number;
  /** Per client network (salted IPv4 / IPv6-/64 tag); skipped when no tag is given. */
  perIpPerDay?: number;
  dailyCap: number;
}

export type RelayDecision = { ok: true } | { ok: false; reason: string; retryAfterSec: number };

export async function checkRelay(store: Store, limits: RelayLimits, holder: string, ip?: string, now = Date.now()): Promise<RelayDecision> {
  const day = dayKey(now);
  const retryAfterSec = secondsToUtcMidnight(now);
  if (ip && limits.perIpPerDay !== undefined) {
    const net = (await store.get<number>(`relay:ip:${ip}:${day}`)) ?? 0;
    if (net >= limits.perIpPerDay) return { ok: false, reason: 'daily relayed-mint limit for this network reached', retryAfterSec };
  }
  const mine = (await store.get<number>(`relay:addr:${holder.toLowerCase()}:${day}`)) ?? 0;
  if (mine >= limits.perAddressPerDay) return { ok: false, reason: 'daily relayed-mint limit for this address reached', retryAfterSec };
  const all = (await store.get<number>(`relay:day:${day}`)) ?? 0;
  if (all >= limits.dailyCap) return { ok: false, reason: 'daily relay budget used up; try again tomorrow (UTC)', retryAfterSec };
  return { ok: true };
}

/** Counts a relayed mint against every cap. Called as soon as the tx is BROADCAST, not on success: Monad bills the
 *  gas limit even when a tx reverts, so a holder who makes their own relay revert (e.g. by moving the AUSD away
 *  between our estimate and inclusion) must still use up quota. */
export async function recordRelay(store: Store, holder: string, ip?: string, now = Date.now()) {
  const day = dayKey(now);
  const k1 = `relay:addr:${holder.toLowerCase()}:${day}`;
  await store.put(k1, ((await store.get<number>(k1)) ?? 0) + 1);
  if (ip) {
    const k2 = `relay:ip:${ip}:${day}`;
    await store.put(k2, ((await store.get<number>(k2)) ?? 0) + 1);
  }
  await store.put(`relay:day:${day}`, ((await store.get<number>(`relay:day:${day}`)) ?? 0) + 1);
  await store.put('relay:total', ((await store.get<number>('relay:total')) ?? 0) + 1);
}

/** Today's drip / relay counts (for /api/health). */
export async function usageToday(store: Store, now = Date.now()) {
  const day = dayKey(now);
  return {
    dripsToday: (await store.get<number>(`drip:day:${day}`)) ?? 0,
    relaysToday: (await store.get<number>(`relay:day:${day}`)) ?? 0,
  };
}

export function secondsToUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000);
}

/** Short-window request limit per client network, kept in the Durable Object's memory (one instance serves the
 *  whole API, so it is exact). It sits in front of all drip / relay work, so a flood of junk or replayed requests is
 *  refused before it can turn into reads on the public Monad RPC that the relayer itself depends on. */
export class WindowLimiter {
  private m = new Map<string, { start: number; n: number }>();
  constructor(
    private limit: number,
    private windowMs = 60_000,
  ) {}
  hit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    if (this.m.size > 10_000) for (const [k, v] of this.m) if (now - v.start >= this.windowMs) this.m.delete(k);
    const cur = this.m.get(key);
    if (!cur || now - cur.start >= this.windowMs) {
      this.m.set(key, { start: now, n: 1 });
      return { ok: true };
    }
    cur.n += 1;
    if (cur.n > this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cur.start + this.windowMs - now) / 1000)) };
    return { ok: true };
  }
}
