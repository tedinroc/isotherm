// Thin CLI over kuru.ts.  RPC_URL defaults to live testnet. Keys come from ~/.config/isotherm/<name>.key.
//   npx tsx cli.ts book <market> [depth]
//   npx tsx cli.ts open <market> <owner>
//   npx tsx cli.ts create <yesToken>                         (KEY=deployer)
//   npx tsx cli.ts quote <market> "0.40:100,0.39:50" "0.44:100" [cancelIds comma list]   (KEY=maker)
//   npx tsx cli.ts cancel-all <market>                       (KEY=maker)
//   npx tsx cli.ts buy <market> <ausd>                       (KEY=taker1)
//   npx tsx cli.ts sell <market> <yesToken> <yes>            (KEY=taker1)
import type { Address } from "viem";
import { clients, loadKey, createMarket, placeQuotes, cancelAll, marketBuy, marketSell, getBook, getOpenOrders, fmtBook, txLog, type Quote } from "./kuru.ts";

const [cmd, ...a] = process.argv.slice(2);
const { pub, wallet } = clients();
const w = () => wallet(loadKey(process.env.KEY ?? (cmd === "create" ? "deployer" : cmd === "buy" || cmd === "sell" ? "taker1" : "maker")));
const quotes = (s?: string): Quote[] => (s ? s.split(",").filter(Boolean).map((x) => ({ price: Number(x.split(":")[0]), size: Number(x.split(":")[1]) })) : []);
const show = () => txLog.forEach((r) => console.log(`${r.status} ${r.label} gasLimit=${r.gasLimit} (${r.costMonAt102Gwei.toFixed(5)} MON) ${r.hash}`));

async function main() {
  switch (cmd) {
    case "book": {
      const b = await getBook(pub, a[0] as Address, a[1] ? Number(a[1]) : undefined);
      console.log(fmtBook(b));
      break;
    }
    case "open":
      console.log(await getOpenOrders(pub, a[0] as Address, a[1] as Address));
      break;
    case "create":
      console.log((await createMarket(pub, w(), a[0] as Address)).market);
      break;
    case "quote": {
      const r = await placeQuotes(pub, w(), a[0] as Address, quotes(a[1]), quotes(a[2]), a[3] ? a[3].split(",").map(BigInt) : []);
      console.log("new order ids:", r.created.map((c) => c.id.toString()).join(","));
      break;
    }
    case "cancel-all":
      await cancelAll(pub, w(), a[0] as Address);
      break;
    case "buy":
      await marketBuy(pub, w(), a[0] as Address, Number(a[1]));
      break;
    case "sell":
      await marketSell(pub, w(), a[0] as Address, a[1] as Address, Number(a[2]));
      break;
    default:
      console.log("commands: book | open | create | quote | cancel-all | buy | sell (see header)");
  }
  show();
}
main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
