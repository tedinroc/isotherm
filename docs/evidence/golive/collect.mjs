// Re-checks every go-live tx receipt on chain and writes live-txs.tsv + balances-after.txt (read-only).
import { createPublicClient, http, formatEther, formatUnits } from '../../../packages/maker/node_modules/viem/_esm/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const pub = createPublicClient({ transport: http('https://testnet-rpc.monad.xyz') });
const rows = [];
for (const l of readFileSync('fund-log.tsv', 'utf8').trim().split('\n')) { const c = l.split('\t'); rows.push({ t: c[0], who: 'deployer', what: `fund ${c[1]} ${c[3]} MON`, hash: c[4] }); }
for (const l of readFileSync(homedir() + '/isotherm-live/packages/maker/var/txs.jsonl', 'utf8').trim().split('\n')) { const j = JSON.parse(l); rows.push({ t: j.t, who: j.role, what: j.label.replace(/\s+/g, ' '), hash: j.hash }); }
const extra = JSON.parse(readFileSync('smoke-txs.json', 'utf8'));
for (const e of extra) rows.push(e);
rows.sort((a, b) => a.t.localeCompare(b.t));
const out = ['block_time_utc\tsigner\taction\ttx\tblock\tstatus\tgasUsed'];
const recs = [];
for (const r of rows) {
  const rc = await pub.getTransactionReceipt({ hash: r.hash });
  const b = await pub.getBlock({ blockNumber: rc.blockNumber });
  recs.push([new Date(Number(b.timestamp) * 1000).toISOString(), r.who, r.what, r.hash, rc.blockNumber, rc.status, rc.gasUsed]);
}
recs.sort((a, b) => (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0));
for (const r of recs) out.push(r.join('\t'));
writeFileSync('live-txs.tsv', out.join('\n') + '\n');
console.log(`${rows.length} txs, all success: ${out.slice(1).every((l) => l.split('\t')[5] === 'success')}`);
const AUSD = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
const erc = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const who = { deployer: '0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11', operator: '0x602dbf3937558B1d18d76315635fD5410089bd51', maker: '0xd572638F07829D1c3636400FB73CF34Ca6c7448a', relayer: '0xb0b9F5E93C4D4Bb448eC96191393bf35C9E8429f', guardian: '0x30C8E371719Ff00577284dd9c10587Fa89357d50', attester: '0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9', smokeDevWallet: '0xd42A0b394F09df88BB2120D0973569b845f2D79c' };
const bl = [`block ${await pub.getBlockNumber()} at ${new Date().toISOString()}`];
for (const [k, a] of Object.entries(who)) {
  const [m, u] = await Promise.all([pub.getBalance({ address: a }), pub.readContract({ address: AUSD, abi: erc, functionName: 'balanceOf', args: [a] })]);
  bl.push(`${k.padEnd(15)} ${a}  MON ${Number(formatEther(m)).toFixed(4)}  AUSD ${Number(formatUnits(u, 6)).toFixed(2)}`);
}
writeFileSync('balances-after.txt', bl.join('\n') + '\n');
console.log(bl.join('\n'));
