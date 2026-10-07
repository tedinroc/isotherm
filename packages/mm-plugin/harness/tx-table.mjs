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
const mon = (lim) => ((Number(lim) * 102e9) / 1e18).toFixed(4);
console.log("| # | command | step (intent sent to MetaMask) | gas est. | gas limit (billed) | gas used (fork) | MON @102 gwei | status |");
console.log("|---|---|---|---|---|---|---|---|");
let tot = 0;
rows.forEach((r, i) => {
  tot += Number(r.gasLimit);
  console.log(`| ${i + 1} | \`${r.cmd.replace(/\|/g, "\\|").slice(0, 90)}\` | ${r.label} | ${r.gasEstimate} | ${r.gasLimit} | ${r.gasUsed ?? "-"} | ${mon(r.gasLimit)} | ${r.status} |`);
});
console.log(`\n${rows.length} transactions, total gas limit ${tot} = ${mon(tot)} MON at 102 gwei (Monad bills the limit).`);
