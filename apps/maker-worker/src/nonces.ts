// Per-sender nonce tracker, persisted in the Durable Object (packages/maker chain.ts NonceSource).
//
// Why not just eth_getTransactionCount(pending)? Monad's RPC does not always count a just-submitted tx as pending
// (the API Worker hit this at go-live: the drip's second tx reused the first one's nonce). The maker waits for every
// receipt before its next send, so the chain count is normally right; the tracker covers the cases where it is not:
//   - next(): max(chain pending count, our next) while our in-flight txs are fresh; if an in-flight tx below our
//     `next` is older than STALE_MS and the chain has not counted it, it was dropped: fall back to the chain count;
//   - sent()/mined()/failed() keep the record; mined txs leave the in-flight set.
// One record per address, so the maker key and the operator key (and the guardian) never share a sequence.
import type { Address, Hex } from "viem";
import type { NonceSource } from "../../../packages/maker/src/chain.ts";
import type { Store } from "./store.ts";

export const STALE_MS = 120_000;

export interface NonceRecord {
  next: number;
  inflight: Record<string, { hash: Hex; at: number; label: string }>;
  lastMined?: { nonce: number; hash: Hex; at: number };
  lastError?: { nonce: number; error: string; at: number };
  resets?: number;
}

export class NonceTracker implements NonceSource {
  constructor(
    private store: Store,
    private now: () => number = () => Date.now(),
  ) {}

  private key(address: Address) {
    return `nonce:${address.toLowerCase()}`;
  }

  record(address: Address): NonceRecord {
    return this.store.get<NonceRecord>(this.key(address)) ?? { next: 0, inflight: {} };
  }

  async next(address: Address, chainPending: () => Promise<number>): Promise<number> {
    const chain = await chainPending();
    const rec = this.record(address);
    for (const n of Object.keys(rec.inflight)) if (Number(n) < chain) delete rec.inflight[n];
    let n = Math.max(chain, rec.next);
    if (n > chain) {
      const t = this.now();
      // a receipt we saw in the last minute excuses a lagging count; an older one does not (dropped / reset chain)
      const minedUpTo = rec.lastMined && t - rec.lastMined.at < 60_000 ? rec.lastMined.nonce : -1;
      for (let k = chain; k < n; k++) {
        if (k <= minedUpTo) continue; // we saw its receipt: the RPC's count is just lagging
        const f = rec.inflight[String(k)];
        if (!f || t - f.at > STALE_MS) {
          // a gap the chain never filled: the tx was dropped (or never accepted) -> trust the chain again
          n = chain;
          rec.inflight = {};
          rec.resets = (rec.resets ?? 0) + 1;
          break;
        }
      }
    }
    rec.next = n;
    this.store.put(this.key(address), rec);
    return n;
  }

  sent(address: Address, nonce: number, hash: Hex, label: string) {
    const rec = this.record(address);
    rec.inflight[String(nonce)] = { hash, at: this.now(), label: label.slice(0, 80) };
    rec.next = Math.max(rec.next, nonce + 1);
    this.store.put(this.key(address), rec);
  }

  mined(address: Address, nonce: number, hash: Hex) {
    const rec = this.record(address);
    delete rec.inflight[String(nonce)];
    if (!rec.lastMined || nonce >= rec.lastMined.nonce) rec.lastMined = { nonce, hash, at: this.now() };
    rec.next = Math.max(rec.next, nonce + 1);
    this.store.put(this.key(address), rec);
  }

  failed(address: Address, nonce: number, error: string) {
    const rec = this.record(address);
    // the RPC refused it: the nonce was not used, so the next send may take it again
    if (!rec.inflight[String(nonce)] && rec.next === nonce + 1) rec.next = nonce;
    rec.lastError = { nonce, error: error.slice(0, 200), at: this.now() };
    this.store.put(this.key(address), rec);
  }

  /** In-flight txs older than `minAgeMs` (a tick that died between broadcast and receipt left them). */
  stale(address: Address, minAgeMs: number): { nonce: number; hash: Hex; label: string; at: number }[] {
    const rec = this.record(address);
    const t = this.now();
    return Object.entries(rec.inflight)
      .filter(([, v]) => t - v.at >= minAgeMs)
      .map(([n, v]) => ({ nonce: Number(n), ...v }));
  }

  forget(address: Address, nonce: number) {
    const rec = this.record(address);
    delete rec.inflight[String(nonce)];
    this.store.put(this.key(address), rec);
  }
}
