#!/usr/bin/env node
// Markdown table of every transaction the plugin sent in a harness run: step, gas estimate, limit (billed on Monad),
// gas used on the fork, and MON billed at Monad testnet's 102 gwei. Usage: node harness/tx-table.mjs evidence/harness-v1
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const rows = [];
for (const f of readdirSync(dir).filter((f) => /^\d\d-.*\.txt$/.test(f)).sort()) {
  const text = readFileSync(join(dir, f), "utf8");
  const cmd = text.split("\n")[0].replace(/^\$ /, "").replace(/ --json$/, "");
  // commands that ended in an error report confirmed steps only as host notices (no gas figures)
  if (text.includes('{"_error"')) {
    for (const line of text.split("\n")) {
      if (!line.startsWith('{"_notice"')) continue;
      const n = JSON.parse(line)._notice;
      if (n.txHash) rows.push({ f, cmd, label: n.summary, gasEstimate: "-", gasLimit: null, gasUsed: null, status: `${n.status} (command then failed: see ${f})` });
    }
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"_summary"')) continue;
    const s = JSON.parse(line)._summary;
    for (const st of s.steps ?? []) if (st && typeof st === "object" && st.gasLimit) rows.push({ f, cmd, ...st });
  }
  // pretty single-document results
  if (text.includes('\n{\n')) {
    try {
      const d = JSON.parse(text.slice(text.indexOf("\n{\n") + 1)).data ?? {};
      for (const st of d.steps ?? []) if (st && typeof st === "object" && st.gasLimit) rows.push({ f, cmd, ...st });
    } catch {}
  }
}
const mon = (lim) => (lim === null ? "-" : ((Number(lim) * 102e9) / 1e18).toFixed(4));
console.log("| # | command | step (intent sent to MetaMask) | gas est. | gas limit (billed) | gas used (fork) | MON @102 gwei | status |");
console.log("|---|---|---|---|---|---|---|---|");
let tot = 0;
rows.forEach((r, i) => {
  tot += Number(r.gasLimit ?? 0);
  console.log(`| ${i + 1} | \`${r.cmd.replace(/\|/g, "\\|").slice(0, 110)}\` | ${r.label} | ${r.gasEstimate} | ${r.gasLimit ?? "-"} | ${r.gasUsed ?? "-"} | ${mon(r.gasLimit)} | ${r.status} |`);
});
const priced = rows.filter((r) => r.gasLimit !== null).length;
console.log(`\n${rows.length} confirmed transactions listed; total gas limit of the ${priced} with gas figures: ${tot} = ${mon(tot)} MON at 102 gwei (Monad bills the limit).`);
console.log("Not listed: transactions that did not confirm (a reverted or denied step appears in the stub log, stub.log).");
