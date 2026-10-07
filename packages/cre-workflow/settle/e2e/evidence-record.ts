// Evidence record for one settlement job run (called by scripts/settle-job.sh; never fails the job).
// Parses the run log and appends ONE JSON line to <out>/settle-runs.jsonl stating which path was used:
//   "official"         = `cre workflow simulate --broadcast` (CRE engine, compiled WASM)
//   "harness-fallback" = the same handler under Bun in the CRE SDK test harness, NOT the CRE engine
// It also writes <out>/LATEST.json and, for every run that sent a report, <out>/settlement-<ICAO>-<date>-<path>.json.
//   bun e2e/evidence-record.ts --log F --path official|harness --why S --login yes|no --rpc URL --rc N --started ISO --out DIR [--dry 0|1]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const LIVE_RPC = 'https://testnet-rpc.monad.xyz'

const args = process.argv.slice(2)
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const log = readFileSync(opt('log')!, 'utf8')
const lines = log.split('\n')
const path = opt('path') === 'official' ? 'official' : 'harness-fallback'
const rpc = opt('rpc') ?? LIVE_RPC

// workflow summary: harness prints "[result] {json}"; the CRE simulator prints the handler's return value as a JSON
// string literal on the line after "Workflow Simulation Result:".
let summary: any = null
for (let i = 0; i < lines.length && !summary; i++) {
  const l = lines[i]
  try {
    if (l.startsWith('[result] ')) summary = JSON.parse(l.slice(9))
    else if (l.includes('Workflow Simulation Result:')) {
      const next = lines.slice(i + 1).find((x) => x.trim() !== '')
      if (next) summary = JSON.parse(JSON.parse(next.trim()))
    }
  } catch {
    summary = null
  }
}
const confirms = lines.filter((l) => /^0x[0-9a-f]{64} block \d+ status=/.test(l))
const runnerSays = lines.filter((l) => /^\[\d{4}-\d\d-\d\dT[\d:]+Z\] /.test(l) && !l.includes('[settle-job]')).map((l) => l.replace(/^\[[^\]]+\] /, ''))
const test = lines.find((l) => l.startsWith('[TEST] '))
const outcomes: any[] = summary?.outcomes ?? []
const sent = outcomes.filter((o) => o.txHash && !/^0x0+$/.test(o.txHash))

const record = {
  job: 'xyz.isotherm.cre-settle',
  startedAt: opt('started'),
  finishedAt: new Date().toISOString(),
  path,
  pathLabel:
    path === 'official'
      ? 'OFFICIAL: cre workflow simulate ./settle -T testnet --broadcast (CRE engine running the compiled WASM; one local node, MockKeystoneForwarder + v1 attestation)'
      : 'HARNESS FALLBACK: the same workflow handler under Bun in the CRE SDK test harness, NOT the CRE engine; same decide() rule, same v1 EIP-712 attestation, same MockKeystoneForwarder call',
  pathReason: opt('why'),
  creLogin: opt('login') === 'yes',
  network: rpc === LIVE_RPC ? 'LIVE Monad testnet 10143' : `anvil fork (${rpc})`,
  testDataRelabel: test ?? null,
  dryRun: opt('dry') === '1',
  exitCode: Number(opt('rc')),
  exitMeaning: ({ 0: 'ok / nothing to do / skipped', 2: 'preflight failed', 3: 'not logged in to CRE (official)', 4: 'a report was sent but NOT accepted on chain' } as Record<string, string>)[opt('rc') ?? ''] ?? 'run failed',
  runner: runnerSays,
  workflow: summary
    ? { triggerTime: summary.triggerTime, ladders: summary.ladders ?? null, paused: summary.paused ?? false, outcomes, skipped: summary.skipped, budget: summary.budget }
    : null,
  reportsSent: sent.map((o) => ({ station: o.station, date: o.date, action: o.action, tmaxC: o.tmaxC ?? null, txHash: o.txHash, confirmed: o.confirmed, sourcesHash: o.sourcesHash })),
  receiptChecks: confirms,
  log: opt('log'),
}
const out = opt('out')!
mkdirSync(out, { recursive: true })
appendFileSync(join(out, 'settle-runs.jsonl'), `${JSON.stringify(record)}\n`)
writeFileSync(join(out, 'LATEST.json'), `${JSON.stringify(record, null, 2)}\n`)
for (const o of sent) writeFileSync(join(out, `settlement-${o.station}-${o.date}-${path}.json`), `${JSON.stringify({ ...record, thisReport: o }, null, 2)}\n`)
console.log(`[evidence] path=${path} exit=${record.exitCode} outcomes=${outcomes.map((o) => `${o.station}/${o.date}:${o.action}${o.tmaxC != null ? `=${o.tmaxC}` : ''}${o.confirmed ? `(${o.confirmed})` : ''}`).join(',') || '-'} -> ${join(out, 'settle-runs.jsonl')}`)
