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
  dailyCap: number;
}

export async function checkRelay(store: Store, limits: RelayLimits, holder: string, now = Date.now()) {
  const day = dayKey(now);
  const mine = (await store.get<number>(`relay:addr:${holder.toLowerCase()}:${day}`)) ?? 0;
  if (mine >= limits.perAddressPerDay) return { ok: false as const, reason: 'daily relayed-mint limit for this address reached' };
  const all = (await store.get<number>(`relay:day:${day}`)) ?? 0;
  if (all >= limits.dailyCap) return { ok: false as const, reason: 'daily relay budget used up' };
  return { ok: true as const };
}

export async function recordRelay(store: Store, holder: string, now = Date.now()) {
  const day = dayKey(now);
  const k1 = `relay:addr:${holder.toLowerCase()}:${day}`;
  await store.put(k1, ((await store.get<number>(k1)) ?? 0) + 1);
  await store.put(`relay:day:${day}`, ((await store.get<number>(`relay:day:${day}`)) ?? 0) + 1);
  await store.put('relay:total', ((await store.get<number>('relay:total')) ?? 0) + 1);
}

export function secondsToUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000);
}
