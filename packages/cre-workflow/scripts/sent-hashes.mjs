#!/usr/bin/env node
// Prints the report transactions a settle run's log shows it sent and the chain accepted for delivery, one hash per
// line (unsorted, may repeat). Used by run-official.sh step 6 (--confirm) and the VPS tripwire, vps/settle-vps.sh 4b.
//
// Two sources, because the CRE simulator can stop before the workflow's last log line reaches its output (live run
// 2026-10-11 18:05 UTC: "context canceled", and no "<ICAO> <date>: tx 0x… -> resolved" line although the report was
// sent and accepted):
//   1. the log lines "tx 0x… ->" (official path, settle/workflow.ts) and, without --confirm, "tx 0x… status=" (harness)
//   2. the official result JSON (the line after "Workflow Simulation Result:"): each outcome's txHash whose writeReport
//      succeeded. A failed writeReport (reason "writeReport status …") is left out here as it is in source 1: its
//      "writeReport <status>" log line is what settle-vps.sh counts as a report that may have used a nonce.
//
//   node scripts/sent-hashes.mjs [--confirm] <log>
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('usage: sent-hashes.mjs [--confirm] <log>')
  process.exit(2)
}
const HASH = /^0x[0-9a-f]{64}$/
const out = []
const add = (h) => { if (typeof h === 'string' && HASH.test(h) && !/^0x0+$/.test(h)) out.push(h) }

const lines = readFileSync(file, 'utf8').split('\n')
const lineRe = confirm ? /tx (0x[0-9a-f]{64}) ->/g : /tx (0x[0-9a-f]{64})(?: ->| status=)/g
for (const l of lines) for (const m of l.matchAll(lineRe)) add(m[1])
lines.forEach((l, i) => {
  if (!l.includes('Workflow Simulation Result:')) return
  const next = lines.slice(i + 1).find((x) => x.trim())
  if (!next) return
  let summary
  try { summary = JSON.parse(JSON.parse(next.trim())) } catch { return }
  for (const o of summary?.outcomes ?? []) if (!String(o?.reason ?? '').startsWith('writeReport status')) add(o?.txHash)
})
if (out.length) console.log(out.join('\n'))
