// CHALLENGE WATCHER (launchd xyz.isotherm.challenge-watch, every 2 min). One pass per invocation:
//
//   1. scans Resolver LadderResolved / LadderChallenged events since the last pass (eth_getLogs in 100-block pages,
//      Monad's limit), plus a backstop over the vault's newest 64 ladders (resultOf), so a missed event is still checked;
//   2. for every resolved station-date it recomputes Tmax from the public archives with the SAME code as the workflow:
//      sources.ts observe()/toDayStats() and settle-core.ts decide() (IEM + AWC, Ogimet only if one is incomplete);
//   3. Settled result whose recomputed decide() is SETTLED with a DIFFERENT Tmax  ->  MISMATCH: logged loudly, re-fetched
//      once after WATCH_RECHECK_SEC to rule out a glitch, and then, while block.timestamp < finalAt:
//        - the guardian key is configured, matches Resolver.guardian() and holds enough MON -> challenge() is sent;
//        - otherwise the exact manual `cast send ... challenge(...)` command is printed (and written to ALERTS.log).
//      A recompute that cannot settle (sources incomplete/unavailable/disagreeing) is UNVERIFIED: loud warning + the
//      manual command, but no automatic challenge (a challenge turns the ladder into a 0.5/0.5 Void).
//   4. A reported Void is final at once on v1 (verifier finding N2): the guardian cannot act. It is still recomputed and
//      an alert is raised if the rule would have settled it.
//
// Env: ISOTHERM_RPC (default live), ISOTHERM_STATE_DIR (default: runtime var), ISOTHERM_GUARDIAN_KEY_FILE (default
//      ~/.config/isotherm/guardian.key; read in-process, never printed), WATCH_AUTO_CHALLENGE=0 (alert only),
//      WATCH_LOOKBACK_BLOCKS (default 4000 ~ 20 min), WATCH_RECHECK_SEC (default 20), WATCH_NOTIFY=0|1 (macOS
//      notification; default 1 on live), ISOTHERM_TEST_RELABEL (anvil forks only, see e2e/http.ts).
// Safety: the LIVE guardian key is refused on any non-live RPC (a tx signed for chain 10143 on a fork is valid on live).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex, createPublicClient, createWalletClient, formatEther, http, keccak256, parseAbi, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { configSchema } from '../config'
import { deployments } from '../e2e/chain'
import { isLoopbackRpc, LIVE_RPC, parseRelabel, sourceGet } from '../e2e/http'
import { intToYmd } from '../plan'
import { bytes4ToStation, canonicalSources, stationToBytes4 } from '../report'
import { decide } from '../settle-core'
import { observe, type SourceKind, type SourceStats, sourceUrl, toDayStats } from '../sources'

const env = (k: string) => process.env[k] || undefined
const RPC = env('ISOTHERM_RPC') ?? LIVE_RPC
const LIVE = RPC === LIVE_RPC
if (!LIVE && !isLoopbackRpc(RPC)) throw new Error(`ISOTHERM_RPC must be live testnet or a loopback anvil fork, got ${RPC}`)
const RUNTIME_STATE = join(env('ISOTHERM_RUNTIME') ?? join(homedir(), 'isotherm-live'), 'packages/cre-workflow/var')
const STATE = env('ISOTHERM_STATE_DIR') ?? (LIVE && existsSync(RUNTIME_STATE) ? RUNTIME_STATE : new URL('../../var', import.meta.url).pathname)
const DIR = join(STATE, 'watch')
const KEY_FILE = env('ISOTHERM_GUARDIAN_KEY_FILE') ?? join(homedir(), '.config/isotherm/guardian.key')
const AUTO = env('WATCH_AUTO_CHALLENGE') !== '0'
const LOOKBACK = Number(env('WATCH_LOOKBACK_BLOCKS') ?? 4000)
const RECHECK_SEC = Number(env('WATCH_RECHECK_SEC') ?? 20)
const NOTIFY = (env('WATCH_NOTIFY') ?? (LIVE ? '1' : '0')) === '1'
const relabel = parseRelabel(env('ISOTHERM_TEST_RELABEL'), RPC)
const cfg = configSchema.parse(JSON.parse(readFileSync(new URL('../config.testnet.json', import.meta.url), 'utf8')))
const RESOLVER = deployments.resolver as Address
const VAULT = deployments.vault as Address
const LIVE_GUARDIAN = (deployments.roles.guardian as string).toLowerCase()
const MIN_EXTRA_WEI = 2_000_000_000_000_000n // keep 0.002 MON above the billed gas (gas limit x price)

const ABI = parseAbi([
  'event LadderResolved(bytes4 indexed station, uint32 indexed date, uint8 status, int16 tmaxC, bytes32 sourcesHash, address caller)',
  'event LadderChallenged(bytes4 indexed station, uint32 indexed date, int16 previousTmaxC, bytes32 reasonHash, address guardian)',
  'function resultOf(bytes4 station, uint32 date) view returns ((uint8 status, int16 tmaxC, uint64 resolvedAt, uint64 finalAt, bytes32 sourcesHash))',
  'function guardian() view returns (address)',
  'function challenge(bytes4 station, uint32 date, bytes32 reasonHash)',
  'function ladderCount() view returns (uint256)',
  'function ladderAt(uint256 index) view returns ((bytes4 station, uint32 date))',
])
const chain = { id: 10143, name: 'monad-testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, retryDelay: 400 }) })

const STATUS = ['None', 'Settled', 'Void'] as const
type Rec = {
  key: string
  status: string
  tmaxC: number
  resolvedAt: number
  finalAt: number
  sourcesHash: Hex
  verdict: string
  final: boolean
  detail: string
  recomputed?: { status: string; tmaxC: number | null; reason: string; canonical: string }
  action?: string
  checkedAt: string
}
type State = { lastBlock: number; results: Record<string, Rec> }

const ts = () => new Date().toISOString()
const out = (s: string) => console.log(`[${ts()}] ${s}`)
mkdirSync(DIR, { recursive: true })
const loadState = (): State => {
  try {
    return JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'))
  } catch {
    return { lastBlock: 0, results: {} }
  }
}
const saveState = (s: State) => {
  writeFileSync(join(DIR, 'state.json.tmp'), JSON.stringify(s, null, 2))
  renameSync(join(DIR, 'state.json.tmp'), join(DIR, 'state.json'))
}
const record = (r: Rec & Record<string, unknown>) => appendFileSync(join(DIR, 'watch.jsonl'), `${JSON.stringify({ at: ts(), network: LIVE ? 'live' : `fork ${RPC}`, ...r })}\n`)
const alert = (title: string, body: string) => {
  const banner = `\n${'!'.repeat(100)}\n!!! CHALLENGE WATCHER: ${title}\n${body.split('\n').map((l) => `!!! ${l}`).join('\n')}\n${'!'.repeat(100)}\n`
  console.log(banner)
  console.error(`[${ts()}] ALERT ${title} (details: ${join(DIR, 'ALERTS.log')})`)
  appendFileSync(join(DIR, 'ALERTS.log'), `[${ts()}] ${LIVE ? 'LIVE' : `FORK ${RPC}`} ${title}\n${body}\n\n`)
  if (NOTIFY) Bun.spawnSync(['osascript', '-e', `display notification ${JSON.stringify(body.split('\n')[0].slice(0, 200))} with title "Isotherm: ${title.replace(/"/g, "'").slice(0, 60)}" sound name "Basso"`])
}

// ---- single pass at a time (launchd never overlaps a job, but a manual run could)
const LOCK = join(DIR, 'lock')
if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 10 * 60_000) {
  out(`another pass holds ${LOCK}; skipping`)
  process.exit(0)
}
writeFileSync(LOCK, String(process.pid))
process.on('exit', () => rmSync(LOCK, { force: true }))

// ---- guardian key (optional): refuse the LIVE key on a fork; never print it
type Guardian = { address: Address; key: Hex } | null
const loadGuardian = (): { g: Guardian; why: string } => {
  if (!existsSync(KEY_FILE)) return { g: null, why: `no guardian key file (${KEY_FILE})` }
  const raw = readFileSync(KEY_FILE, 'utf8').trim()
  const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  const address = privateKeyToAccount(key).address
  if (!LIVE && address.toLowerCase() === LIVE_GUARDIAN) return { g: null, why: `REFUSED: the LIVE guardian key on a non-live RPC (${RPC})` }
  return { g: { address, key }, why: `guardian key ${address}` }
}

const reasonHashOf = (icao: string, date: number, reported: number, canonical: string) =>
  keccak256(stringToBytes(`isotherm-challenge-v1|${icao}|${date}|reported=${reported}|recomputed:${canonical}`))

const manualCommand = (b4: Hex, date: number, reasonHash: Hex, gasLimit: bigint) =>
  `cast send ${RESOLVER} 'challenge(bytes4,uint32,bytes32)' ${b4} ${date} ${reasonHash} --private-key "$(tr -d '[:space:]' < ${KEY_FILE})" --gas-limit ${gasLimit} --rpc-url ${RPC}`

const fmt = (s: SourceStats | null) => (s === null ? 'not fetched' : !s.healthy ? 'UNAVAILABLE' : `${s.tmaxC ?? '-'}C h=${s.nHours} last=${s.lastLocal ?? '-'} ${s.complete ? 'complete' : 'incomplete'}`)

/** The workflow's own decision for (icao, date), single node: observe() -> toDayStats() -> decide(). */
const recompute = (icao: string, date: number) => {
  const st = cfg.stations.find((s) => s.icao === icao)!
  const ymd = intToYmd(date)
  const get = (kind: SourceKind) => {
    const a = sourceGet(sourceUrl(kind, icao, ymd, st.utcOffsetMin, st.tzName), relabel, cfg.stations, 25, 'isotherm-challenge-watch/1.0')
    return toDayStats(observe(kind, a.body, ymd, st.utcOffsetMin, a.status))
  }
  const a = get('iem')
  const b = get('awc')
  const c = a.complete && b.complete ? null : get('ogimet')
  const d = decide([a, b], c ? [c] : [], false)
  const canonical = canonicalSources(icao, date, d.status, [
    { name: 'IEM', stats: a },
    { name: 'AWC', stats: b },
    { name: 'OGIMET', stats: c },
  ])
  return { d, canonical, usedOgimet: c !== null, text: `IEM ${fmt(a)} | AWC ${fmt(b)} | OGIMET ${fmt(c)}` }
}

const main = async () => {
  const state = loadState()
  const { g: guardian, why: guardianWhy } = loadGuardian()
  const chainId = await pub.getChainId()
  if (chainId !== 10143) throw new Error(`chain ${chainId} != 10143`)
  const latest = await pub.getBlock({ blockTag: 'latest' })
  const head = Number(latest.number)
  const now = Number(latest.timestamp)
  const onchainGuardian = (await pub.readContract({ address: RESOLVER, abi: ABI, functionName: 'guardian' })) as Address
  if (relabel) out(`[TEST] ISOTHERM_TEST_RELABEL active (fork only): ${[...relabel].map(([k, v]) => `${k} <- live data of ${v}`).join(', ')}`)

  // 1. events since the last pass (bounded lookback: anything older is past a 900 s window anyway; the backstop below still checks it)
  const from = Math.max(state.lastBlock + 1, head - LOOKBACK, 0)
  const keys = new Map<string, { b4: Hex; date: number; via: string }>()
  const challengedSeen = new Set<string>()
  let nEvents = 0
  for (let f = from; f <= head; f += 100) {
    const t = Math.min(f + 99, head)
    const logs = await pub.getLogs({ address: RESOLVER, events: [ABI[0], ABI[1]] as any, fromBlock: BigInt(f), toBlock: BigInt(t) })
    for (const l of logs as any[]) {
      nEvents++
      const k = `${bytes4ToStation(l.args.station)}:${l.args.date}`
      if (l.eventName === 'LadderChallenged') {
        challengedSeen.add(k)
        out(`event LadderChallenged ${k} previousTmaxC=${l.args.previousTmaxC} by ${l.args.guardian} (block ${l.blockNumber}, tx ${l.transactionHash})`)
      } else {
        out(`event LadderResolved ${k} status=${STATUS[l.args.status]} tmaxC=${l.args.tmaxC} caller=${l.args.caller} (block ${l.blockNumber}, tx ${l.transactionHash})`)
      }
      keys.set(k, { b4: l.args.station, date: Number(l.args.date), via: `event@${l.blockNumber}` })
    }
  }
  // 2. backstop: the vault's newest 64 ladders
  const count = Number(await pub.readContract({ address: VAULT, abi: ABI, functionName: 'ladderCount' }))
  for (let i = Math.max(0, count - 64); i < count; i++) {
    const r = (await pub.readContract({ address: VAULT, abi: ABI, functionName: 'ladderAt', args: [BigInt(i)] })) as { station: Hex; date: number }
    const k = `${bytes4ToStation(r.station)}:${r.date}`
    if (!keys.has(k)) keys.set(k, { b4: r.station, date: Number(r.date), via: `ladder#${i}` })
  }
  // previously UNVERIFIED / MISMATCH entries are re-examined until final
  for (const [k, r] of Object.entries(state.results)) if (!r.final && !keys.has(k)) keys.set(k, { b4: stationToBytes4(k.split(':')[0]), date: Number(k.split(':')[1]), via: 'state' })

  let checked = 0
  for (const [k, c] of keys) {
    const r = (await pub.readContract({ address: RESOLVER, abi: ABI, functionName: 'resultOf', args: [c.b4, c.date] })) as any
    const status = STATUS[Number(r.status)]
    if (status === 'None') continue
    const sig = `${status}:${r.tmaxC}:${r.resolvedAt}:${r.finalAt}`
    const prev = state.results[k]
    if (prev && prev.final && `${prev.status}:${prev.tmaxC}:${prev.resolvedAt}:${prev.finalAt}` === sig) continue
    checked++
    const icao = k.split(':')[0]
    const base = { key: k, status, tmaxC: Number(r.tmaxC), resolvedAt: Number(r.resolvedAt), finalAt: Number(r.finalAt), sourcesHash: r.sourcesHash as Hex, checkedAt: ts() }
    const windowLeft = Number(r.finalAt) - now
    if (!cfg.stations.some((s) => s.icao === icao)) {
      const rec: Rec = { ...base, verdict: 'UNKNOWN-STATION', final: true, detail: 'station not in config.testnet.json: cannot recompute' }
      state.results[k] = rec
      record(rec)
      alert(`cannot verify ${k}`, `${status} ${r.tmaxC}: station ${icao} is not configured, so the watcher cannot recompute it.`)
      continue
    }
    if (status === 'Void') {
      if (challengedSeen.has(k) || Number(r.finalAt) > Number(r.resolvedAt)) {
        const rec: Rec = { ...base, verdict: 'CHALLENGED', final: true, detail: 'Void after a guardian challenge (finalAt > resolvedAt)' }
        state.results[k] = rec
        record(rec)
        out(`${k}: Void by guardian challenge (resolvedAt ${r.resolvedAt}, finalAt ${r.finalAt})`)
        continue
      }
      if (/^0x0+$/.test(r.sourcesHash)) {
        const rec: Rec = { ...base, verdict: 'STALE-VOID', final: true, detail: 'voidIfStale (no sourcesHash)' }
        state.results[k] = rec
        record(rec)
        out(`${k}: Void through voidIfStale`)
        continue
      }
      const x = recompute(icao, c.date)
      const settles = x.d.status === 'SETTLED'
      const rec: Rec = { ...base, verdict: settles ? 'VOID-BUT-RULE-SETTLES' : 'VOID-CONSISTENT', final: true, detail: x.text, recomputed: { status: x.d.status, tmaxC: x.d.tmaxC, reason: x.d.reason, canonical: x.canonical } }
      state.results[k] = rec
      record(rec)
      if (settles) alert(`reported VOID for ${k}, but the rule settles ${x.d.tmaxC} C`, `On v1 a reported Void is final in the same block (verifier finding N2): the guardian cannot challenge it.\nRecomputed: ${x.text}\nEscalate: the attester key may be compromised. Rotate it from the owner key: setAttester(new).`)
      else out(`${k}: reported Void is consistent with the rule (${x.d.status}: ${x.d.reason})`)
      continue
    }

    // Settled
    let x = recompute(icao, c.date)
    const mismatch = (y: typeof x) => y.d.status === 'SETTLED' && y.d.tmaxC !== Number(r.tmaxC)
    if (x.d.status === 'SETTLED' && x.d.tmaxC === Number(r.tmaxC)) {
      const rec: Rec = { ...base, verdict: 'MATCH', final: true, detail: x.text, recomputed: { status: x.d.status, tmaxC: x.d.tmaxC, reason: x.d.reason, canonical: x.canonical } }
      state.results[k] = rec
      record({ ...rec, sourcesHashMatches: keccak256(stringToBytes(x.canonical)) === r.sourcesHash })
      out(`${k}: MATCH reported Settled ${r.tmaxC} == recomputed ${x.d.tmaxC} (${x.d.reason}); ${x.text}; window ${windowLeft > 0 ? `${windowLeft}s left` : 'closed'}`)
      continue
    }
    const reasonHash = reasonHashOf(icao, c.date, Number(r.tmaxC), x.canonical)
    let gasLimit = 80_000n
    if (windowLeft <= 0) {
      const v = mismatch(x) ? 'MISMATCH-WINDOW-CLOSED' : 'UNVERIFIED-WINDOW-CLOSED'
      const rec: Rec = { ...base, verdict: v, final: Number(r.finalAt) + 3600 < now, detail: x.text, recomputed: { status: x.d.status, tmaxC: x.d.tmaxC, reason: x.d.reason, canonical: x.canonical } }
      if (!prev || prev.verdict !== v) alert(`${v} ${k}`, `Reported Settled ${r.tmaxC}; recomputed ${x.d.status} ${x.d.tmaxC ?? ''} (${x.d.reason}).\n${x.text}\nThe 900 s challenge window closed at ${new Date(Number(r.finalAt) * 1000).toISOString()}: challenge() would revert. Owner actions only (rotate the attester).`)
      state.results[k] = rec
      record(rec)
      continue
    }
    if (!mismatch(x)) {
      const rec: Rec = { ...base, verdict: 'UNVERIFIED', final: false, detail: x.text, recomputed: { status: x.d.status, tmaxC: x.d.tmaxC, reason: x.d.reason, canonical: x.canonical } }
      if (!prev || prev.verdict !== 'UNVERIFIED')
        alert(
          `UNVERIFIED ${k}: could not reproduce Settled ${r.tmaxC}`,
          `Recomputed ${x.d.status} (${x.d.reason}): ${x.text}\nNot challenged automatically (a challenge voids the ladder 0.5/0.5). Re-checked every pass until ${new Date(Number(r.finalAt) * 1000).toISOString()} (${windowLeft}s left).\nIf you are sure the result is wrong, the guardian can challenge by hand before then:\n  ${manualCommand(c.b4, c.date, reasonHash, gasLimit)}`,
        )
      else out(`${k}: still UNVERIFIED (${x.d.status}: ${x.d.reason}); ${windowLeft}s left`)
      state.results[k] = rec
      record(rec)
      continue
    }

    // MISMATCH: confirm on a fresh fetch, then act
    alert(`MISMATCH ${k}: reported Settled ${r.tmaxC} C, the rule gives ${x.d.tmaxC} C`, `${x.text}\nre-fetching in ${x.usedOgimet ? Math.max(RECHECK_SEC, 45) : RECHECK_SEC}s to rule out a glitch; challenge window ${windowLeft}s left (finalAt ${new Date(Number(r.finalAt) * 1000).toISOString()})`)
    await Bun.sleep((x.usedOgimet ? Math.max(RECHECK_SEC, 45) : RECHECK_SEC) * 1000)
    const y = recompute(icao, c.date)
    if (!mismatch(y)) {
      const rec: Rec = { ...base, verdict: 'MISMATCH-NOT-REPRODUCED', final: false, detail: `first ${x.text} / re-fetch ${y.text}`, recomputed: { status: y.d.status, tmaxC: y.d.tmaxC, reason: y.d.reason, canonical: y.canonical } }
      state.results[k] = rec
      record(rec)
      out(`${k}: mismatch NOT reproduced on re-fetch (${y.d.status} ${y.d.tmaxC ?? ''}); re-checked next pass`)
      continue
    }
    x = y
    const rh = reasonHashOf(icao, c.date, Number(r.tmaxC), x.canonical)
    let action = ''
    let est: bigint | null = null
    if (guardian && guardian.address.toLowerCase() === onchainGuardian.toLowerCase()) {
      try {
        est = await pub.estimateContractGas({ address: RESOLVER, abi: ABI, functionName: 'challenge', args: [c.b4, c.date, rh], account: guardian.address })
        gasLimit = (est * 13n) / 10n + 5_000n
      } catch (e: any) {
        action = `estimateGas failed: ${String(e.shortMessage ?? e.message).slice(0, 160)}`
      }
    }
    const cmd = manualCommand(c.b4, c.date, rh, gasLimit)
    if (!action) {
      if (!AUTO) action = 'WATCH_AUTO_CHALLENGE=0'
      else if (!guardian) action = guardianWhy
      else if (guardian.address.toLowerCase() !== onchainGuardian.toLowerCase()) action = `guardian key ${guardian.address} != Resolver.guardian() ${onchainGuardian}`
    }
    if (!action && guardian && est !== null) {
      const bal = await pub.getBalance({ address: guardian.address })
      const price = await pub.getGasPrice()
      const need = gasLimit * price + MIN_EXTRA_WEI
      if (bal < need) action = `guardian ${guardian.address} holds ${formatEther(bal)} MON < ${formatEther(need)} MON needed (gas limit ${gasLimit} x ${price} wei + 0.002)`
      else {
        const wallet = createWalletClient({ chain, account: privateKeyToAccount(guardian.key), transport: http(RPC) })
        try {
          const hash = await wallet.writeContract({ address: RESOLVER, abi: ABI, functionName: 'challenge', args: [c.b4, c.date, rh], gas: gasLimit })
          const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
          const after = (await pub.readContract({ address: RESOLVER, abi: ABI, functionName: 'resultOf', args: [c.b4, c.date] })) as any
          const ok = rc.status === 'success' && Number(after.status) === 2
          const rec: Rec = { ...base, verdict: ok ? 'MISMATCH-CHALLENGED' : 'MISMATCH-CHALLENGE-FAILED', final: ok, detail: x.text, recomputed: { status: x.d.status, tmaxC: x.d.tmaxC, reason: x.d.reason, canonical: x.canonical }, action: `challenge tx ${hash} status=${rc.status} gasUsed=${rc.gasUsed} gasLimit=${gasLimit}; resultOf now ${STATUS[Number(after.status)]}` }
          state.results[k] = rec
          record({ ...rec, reasonHash: rh })
          alert(ok ? `CHALLENGED ${k}` : `CHALLENGE FAILED ${k}`, `${rec.action}\nreasonHash ${rh} = keccak256("isotherm-challenge-v1|${icao}|${c.date}|reported=${r.tmaxC}|recomputed:${x.canonical}")${ok ? '' : `\nRetry by hand before finalAt:\n  ${cmd}`}`)
          continue
        } catch (e: any) {
          action = `challenge send failed: ${String(e.shortMessage ?? e.message).slice(0, 200)}`
        }
      }
    }
    const rec: Rec = { ...base, verdict: 'MISMATCH-NOT-CHALLENGED', final: false, detail: x.text, recomputed: { status: x.d.status, tmaxC: x.d.tmaxC, reason: x.d.reason, canonical: x.canonical }, action }
    state.results[k] = rec
    record({ ...rec, manualCommand: cmd })
    alert(
      `MISMATCH ${k} NOT CHALLENGED automatically`,
      `Why: ${action}\nRUN THIS NOW as the guardian, before ${new Date(Number(r.finalAt) * 1000).toISOString()} (${Number(r.finalAt) - now}s left at the last block):\n  ${cmd}\n(fund the guardian first if it is short: it needs about ${formatEther(gasLimit * 110_000_000_000n)} MON)`,
    )
  }

  state.lastBlock = head
  saveState(state)
  writeFileSync(join(DIR, 'heartbeat.json'), JSON.stringify({ at: ts(), network: LIVE ? 'live' : RPC, head, chainTime: new Date(now * 1000).toISOString(), scanned: [from, head], events: nEvents, ladders: count, checked, guardian: guardianWhy, onchainGuardian, autoChallenge: AUTO }, null, 2))
  out(`pass done: blocks ${from}..${head} (${nEvents} events), ${count} ladders, ${checked} result(s) checked; ${guardianWhy}; auto-challenge ${AUTO ? 'on' : 'off'}`)
}

main().catch((e) => {
  out(`watcher error: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 400)}`)
  process.exit(1)
})
