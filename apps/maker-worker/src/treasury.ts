// TREASURY AUTO TOP-UP. One dedicated key (secret TREASURY_KEY; never the deployer/owner key, never a role key) keeps
// the role keys funded so a quiet testnet-faucet day does not stop the maker, the roll, the relayer, the CRE report
// or the guardian. Funding then flows deployer -> treasury (by hand, docs/OPERATIONS.md section 4) -> roles (here).
//
// Every `everySec` (600 s) from the maker tick:
//   1. read the MON balance of the treasury and of every configured role (addresses in config, not in code);
//   2. for each role below its `minMon`: send `targetMon - balance`, capped by the role's daily cap, the global daily
//      cap and the treasury floor (`floorMon` stays in the treasury), as a plain transfer with gas limit 21,000 (Monad
//      bills the limit: 21,000 x ~102 gwei = 0.0021 MON) through the Durable Object's nonce tracker. LIVE mode only;
//      SHADOW (and a missing or refused key) records the intent and sends nothing;
//   3. alerts: every top-up (`TOPUP <ROLE>`), `TREASURY LOW` below `lowAlertMon` (10 MON), and `<ROLE> LOW` when a role
//      is below its minimum and cannot be topped up (no key, shadow, a cap, the floor, a failed send). LOW alerts repeat
//      at most every `alertRepeatSec`. Without any TREASURY_KEY the balance checks and the LOW alerts still run.
// Safety: the key must match `treasury.address`; it may not be the owner/deployer or any role or maker key; the
// LIVE treasury key is refused on a non-live RPC (a transfer signed for chain 10143 on a fork is valid on live); a
// recipient with code is refused (a 21,000-gas transfer is for EOAs); transfers in one pass are >= 5 blocks apart
// (Monad's reserve-balance rule: an account under 10 MON may send value only with no tx of its own in the previous 3
// blocks); the daily meters are written BEFORE the broadcast, so a lost receipt can never cause a second top-up beyond
// the caps; a transfer counts against the treasury from its broadcast, and a top-up whose receipt is not confirmed ends
// the pass's sending (the floor holds, nothing goes out unspaced; the next pass re-reads every balance).
import { formatEther, getAddress, parseEther, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { budgetDay } from "../../../packages/maker/src/budget.ts";
import type { NonceSource } from "../../../packages/maker/src/chain.ts";
import { explainRevert } from "../../../packages/maker/src/chain.ts";
import type { Store } from "./store.ts";

export const TRANSFER_GAS = 21_000n;
const SPACING_BLOCKS = 5n;

export interface TreasuryRoleCfg {
  address: Address;
  minMon: number;
  targetMon: number;
  dailyCapMon: number;
}
export interface TreasuryCfg {
  address: Address;
  everySec: number;
  floorMon: number;
  lowAlertMon: number;
  globalDailyCapMon: number;
  minSendMon: number;
  alertRepeatSec: number;
  roles: Record<string, TreasuryRoleCfg>;
}

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const nonneg = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** Validate the `treasury` block of the maker config. null = absent (the feature is off). */
export function parseTreasuryCfg(raw: unknown): TreasuryCfg | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as any;
  if (!isAddr(r.address)) throw new Error("treasury.address must be an address");
  for (const k of ["everySec", "floorMon", "lowAlertMon", "globalDailyCapMon", "minSendMon", "alertRepeatSec"]) if (!nonneg(r[k])) throw new Error(`treasury.${k} must be a number >= 0`);
  if (r.everySec < 60) throw new Error("treasury.everySec must be >= 60");
  if (!r.roles || typeof r.roles !== "object" || !Object.keys(r.roles).length) throw new Error("treasury.roles is empty");
  const roles: Record<string, TreasuryRoleCfg> = {};
  const seen = new Set<string>([String(r.address).toLowerCase()]);
  for (const [name, v] of Object.entries<any>(r.roles)) {
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(name)) throw new Error(`treasury.roles: bad role name ${name}`);
    if (!isAddr(v?.address)) throw new Error(`treasury.roles.${name}.address must be an address`);
    if (seen.has(v.address.toLowerCase())) throw new Error(`treasury.roles.${name}.address repeats another address (or the treasury's)`);
    seen.add(v.address.toLowerCase());
    for (const k of ["minMon", "targetMon", "dailyCapMon"]) if (!nonneg(v[k])) throw new Error(`treasury.roles.${name}.${k} must be a number >= 0`);
    if (!(v.targetMon > v.minMon)) throw new Error(`treasury.roles.${name}: targetMon must be above minMon`);
    roles[name] = { address: getAddress(v.address), minMon: v.minMon, targetMon: v.targetMon, dailyCapMon: v.dailyCapMon };
  }
  return { address: getAddress(r.address), everySec: r.everySec, floorMon: r.floorMon, lowAlertMon: r.lowAlertMon, globalDailyCapMon: r.globalDailyCapMon, minSendMon: r.minSendMon, alertRepeatSec: r.alertRepeatSec, roles };
}

export interface TreasuryState {
  day: string;
  sent: Record<string, number>; // role -> MON sent today
  total: number;
  n: number;
  history?: { day: string; sent: Record<string, number>; total: number; n: number }[];
  lastAlert?: Record<string, number>; // title -> ms
}

export interface TreasuryTx {
  label: string;
  role: string;
  from: Address;
  to: Address;
  valueMon: number;
  hash: Hex;
  nonce: number;
  block: bigint;
  gasLimit: bigint;
  gasMon: number;
  status: string;
}

export interface TreasuryDeps {
  pub: PublicClient;
  store: Store;
  cfg: TreasuryCfg;
  /** LIVE mode this tick (and not held back by the interlock) */
  live: boolean;
  key: PrivateKeyAccount | null;
  liveRpc: boolean;
  /** the treasury address of the bundled config (the live one): its key is refused on a fork */
  liveTreasury: Address | null;
  /** addresses the treasury key may never be: the owner/deployer, the maker/operator/guardian keys */
  forbidden: Address[];
  wallet: (account: PrivateKeyAccount) => { sendTransaction(args: any): Promise<Hex> };
  chain: unknown;
  nonces: NonceSource;
  dayUtcOffsetMin: number;
  onTx?(tx: TreasuryTx): void;
  alert(title: string, body: string): void;
  log(msg: string): void;
  sleep(ms: number): Promise<void>;
  now(): number; // ms
}

export interface TreasuryAction {
  role: string;
  address: Address;
  balanceMon: number;
  needMon: number;
  amountMon: number;
  outcome: string; // "sent" | "intent (shadow)" | "not sent: ..." | "failed: ..."
  hash?: Hex;
}
export interface TreasuryReport {
  at: string;
  mode: "live" | "shadow";
  treasury: { address: Address; mon: number | null; key: string };
  balances: Record<string, number>;
  actions: TreasuryAction[];
  meter: { day: string; sent: Record<string, number>; total: number; globalCap: number };
  alerts: string[];
}

const mon = (wei: bigint) => Number(formatEther(wei));
const round6 = (x: number) => Math.floor(x * 1e6 + 1e-9) / 1e6;

/** Why the key cannot sign top-ups (null = usable). */
export function keyProblem(d: Pick<TreasuryDeps, "key" | "cfg" | "forbidden" | "liveRpc" | "liveTreasury">): string | null {
  if (!d.key) return "no TREASURY_KEY secret";
  const a = d.key.address.toLowerCase();
  if (a !== d.cfg.address.toLowerCase()) return `REFUSED: TREASURY_KEY is ${d.key.address}, not treasury.address ${d.cfg.address}`;
  if (d.forbidden.some((f) => f.toLowerCase() === a)) return "REFUSED: TREASURY_KEY is the owner/deployer or a maker role key";
  if (Object.values(d.cfg.roles).some((r) => r.address.toLowerCase() === a)) return "REFUSED: TREASURY_KEY is one of the funded roles";
  if (!d.liveRpc && d.liveTreasury && d.liveTreasury.toLowerCase() === a) return "REFUSED: the LIVE treasury key on a non-live RPC";
  return null;
}

export function treasuryState(store: Store, day: string): TreasuryState {
  const s = store.get<TreasuryState>("treasury:state") ?? { day, sent: {}, total: 0, n: 0 };
  if (s.day !== day) {
    if (s.day) s.history = [...(s.history ?? []), { day: s.day, sent: s.sent, total: s.total, n: s.n }].slice(-14);
    s.day = day;
    s.sent = {};
    s.total = 0;
    s.n = 0;
  }
  return s;
}

/** One pass. Never throws: a failure is reported (and alerted where it leaves a role low). */
export async function treasuryPass(d: TreasuryDeps): Promise<TreasuryReport> {
  const t = d.now();
  const day = budgetDay(t, d.dayUtcOffsetMin);
  const st = treasuryState(d.store, day);
  const problem = keyProblem(d);
  const rep: TreasuryReport = { at: new Date(t).toISOString(), mode: d.live ? "live" : "shadow", treasury: { address: d.cfg.address, mon: null, key: problem ?? "ok" }, balances: {}, actions: [], meter: { day, sent: st.sent, total: st.total, globalCap: d.cfg.globalDailyCapMon }, alerts: [] };
  const lastAlert = (st.lastAlert ??= {});
  const alertOnce = (title: string, body: string) => {
    if (lastAlert[title] !== undefined && t - lastAlert[title] < d.cfg.alertRepeatSec * 1000 * 0.95) return;
    lastAlert[title] = t;
    rep.alerts.push(title);
    d.alert(title, body);
  };
  const save = () => d.store.put("treasury:state", st);
  try {
    const names = Object.keys(d.cfg.roles);
    const [tb, ...bals] = await Promise.all([d.pub.getBalance({ address: d.cfg.address }), ...names.map((n) => d.pub.getBalance({ address: d.cfg.roles[n].address }))]);
    let treasuryWei = tb;
    rep.treasury.mon = +mon(tb).toFixed(6);
    names.forEach((n, i) => (rep.balances[n] = +mon(bals[i]).toFixed(6)));
    if (mon(tb) < d.cfg.lowAlertMon)
      alertOnce("TREASURY LOW", `The treasury ${d.cfg.address} holds ${mon(tb).toFixed(4)} MON (alert line ${d.cfg.lowAlertMon}, floor ${d.cfg.floorMon} kept for gas). Claim testnet MON to the deployer and send it to the treasury (docs/OPERATIONS.md section 4).`);
    const canSend = d.live && !problem;
    const gasPrice = canSend ? await d.pub.getGasPrice() : 102_000_000_000n;
    const gasWei = TRANSFER_GAS * gasPrice;
    let lastBlock: bigint | null = null;
    // a broadcast top-up whose receipt was not confirmed: its value may still leave the treasury and it gives no block
    // to space the next transfer from, so nothing more is sent in this pass (the next pass re-reads every balance)
    let halted: string | null = null;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const r = d.cfg.roles[name];
      const bal = mon(bals[i]);
      if (bal >= r.minMon) continue;
      const need = r.targetMon - bal;
      const roleLeft = Math.max(0, r.dailyCapMon - (st.sent[name] ?? 0));
      const globalLeft = Math.max(0, d.cfg.globalDailyCapMon - st.total);
      const avail = Math.max(0, mon(treasuryWei - gasWei) - d.cfg.floorMon);
      const amount = round6(Math.min(need, roleLeft, globalLeft, avail));
      const act: TreasuryAction = { role: name, address: r.address, balanceMon: +bal.toFixed(6), needMon: +need.toFixed(6), amountMon: amount, outcome: "" };
      rep.actions.push(act);
      const lowTitle = `${name.toUpperCase()} LOW`;
      const lowBody = (why: string) => `${name} ${r.address} holds ${bal.toFixed(4)} MON, below its minimum ${r.minMon} (target ${r.targetMon}). Not topped up: ${why}. Fund it by hand (docs/OPERATIONS.md section 4).`;
      if (amount < d.cfg.minSendMon) {
        const why = roleLeft < d.cfg.minSendMon ? `the ${name} daily top-up cap ${r.dailyCapMon} MON is used (${(st.sent[name] ?? 0).toFixed(4)})` : globalLeft < d.cfg.minSendMon ? `the global daily top-up cap ${d.cfg.globalDailyCapMon} MON is used (${st.total.toFixed(4)})` : `the treasury holds ${mon(treasuryWei).toFixed(4)} MON and keeps a floor of ${d.cfg.floorMon}`;
        act.outcome = `not sent: ${why}`;
        alertOnce(lowTitle, lowBody(why));
        continue;
      }
      if (!canSend) {
        act.outcome = problem ? `not sent: ${problem}` : "intent (shadow: not sent)";
        alertOnce(lowTitle, lowBody(problem ?? "the maker is in shadow mode (top-ups are sent in live mode only)"));
        continue;
      }
      if (halted) {
        act.outcome = `not sent: ${halted}; the next pass re-reads the balances`;
        continue;
      }
      // a 21,000-gas transfer is for externally owned accounts
      const code = await d.pub.getCode({ address: r.address });
      if (code && code !== "0x") {
        act.outcome = "not sent: the recipient has code (not an EOA)";
        alertOnce(lowTitle, lowBody("the recipient has code, a 21,000-gas transfer would fail"));
        continue;
      }
      // Monad's reserve-balance rule: keep transfers of one pass >= 5 blocks apart
      if (lastBlock !== null)
        for (let w = 0; w < 30; w++) {
          if ((await d.pub.getBlockNumber()) >= lastBlock + SPACING_BLOCKS) break;
          await d.sleep(500);
        }
      const value = parseEther(amount.toFixed(6));
      const acct = d.key!;
      const chainPending = () => d.pub.getTransactionCount({ address: acct.address, blockTag: "pending" });
      // meter first (durable before the broadcast leaves the Durable Object): a lost receipt can never top up twice
      st.sent[name] = +((st.sent[name] ?? 0) + amount).toFixed(6);
      st.total = +(st.total + amount).toFixed(6);
      st.n++;
      save();
      let nonce = -1;
      let hash: Hex;
      try {
        nonce = await d.nonces.next(acct.address, chainPending);
        hash = await d.wallet(acct).sendTransaction({ account: acct, chain: d.chain, to: r.address, value, gas: TRANSFER_GAS, nonce });
      } catch (e) {
        if (nonce >= 0) d.nonces.failed(acct.address, nonce, explainRevert(e));
        // the broadcast was refused: nothing left the treasury, so the meter is given back
        st.sent[name] = +Math.max(0, (st.sent[name] ?? 0) - amount).toFixed(6);
        st.total = +Math.max(0, st.total - amount).toFixed(6);
        st.n--;
        save();
        act.outcome = `failed: ${explainRevert(e).slice(0, 160)}`;
        alertOnce(lowTitle, lowBody(`the top-up transfer was refused (${explainRevert(e).slice(0, 120)})`));
        continue;
      }
      d.nonces.sent(acct.address, nonce, hash, `topup ${name}`);
      act.hash = hash;
      // count the transfer as gone from the moment it was accepted for broadcast, so the floor holds for the rest of
      // the pass even if its receipt never arrives
      treasuryWei -= value + gasWei;
      try {
        const rc = await d.pub.waitForTransactionReceipt({ hash, pollingInterval: 400, timeout: 60_000 });
        d.nonces.mined(acct.address, nonce, hash);
        lastBlock = rc.blockNumber;
        const gasMon = mon(TRANSFER_GAS * (rc.effectiveGasPrice ?? gasPrice));
        if (rc.effectiveGasPrice && rc.effectiveGasPrice > gasPrice) treasuryWei -= TRANSFER_GAS * (rc.effectiveGasPrice - gasPrice);
        d.onTx?.({ label: `topup ${name} ${amount} MON`, role: "treasury", from: acct.address, to: r.address, valueMon: amount, hash, nonce, block: rc.blockNumber, gasLimit: TRANSFER_GAS, gasMon, status: rc.status });
        if (rc.status !== "success") {
          act.outcome = "failed: reverted";
          alertOnce(lowTitle, lowBody(`the top-up transfer ${hash} reverted`));
          continue;
        }
        act.outcome = "sent";
        rep.alerts.push(`TOPUP ${name.toUpperCase()}`);
        d.alert(`TOPUP ${name.toUpperCase()}`, `Sent ${amount} MON from the treasury ${acct.address} to ${name} ${r.address} (it held ${bal.toFixed(4)}, minimum ${r.minMon}, target ${r.targetMon}): tx ${hash}. Today: ${name} ${st.sent[name]} of ${r.dailyCapMon} MON, all roles ${st.total} of ${d.cfg.globalDailyCapMon}. The treasury holds about ${mon(treasuryWei).toFixed(4)} MON.`);
        if (bal + amount < r.minMon - 1e-9) alertOnce(lowTitle, lowBody(`topped up by only ${amount} MON (a cap or the treasury floor)`));
      } catch (e) {
        act.outcome = `sent, receipt not confirmed: ${explainRevert(e).slice(0, 120)} (metered; the next pass re-reads the balance)`;
        halted = `the ${name} top-up ${hash} of this pass has no receipt yet`;
        d.log(`treasury: ${name} top-up ${hash} has no receipt yet; no further top-ups in this pass`);
      }
    }
  } catch (e) {
    rep.actions.push({ role: "-", address: d.cfg.address, balanceMon: 0, needMon: 0, amountMon: 0, outcome: `pass failed: ${explainRevert(e).slice(0, 200)}` });
    d.log(`treasury pass failed: ${explainRevert(e)}`);
  }
  rep.meter = { day: st.day, sent: { ...st.sent }, total: st.total, globalCap: d.cfg.globalDailyCapMon };
  save();
  d.store.put("treasury:last", rep);
  return rep;
}
