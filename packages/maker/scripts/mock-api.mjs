// Tiny stand-in for apps/api POST /api/snapshot (bearer check + record), for fork runs only.
//   node scripts/mock-api.mjs <port> <out.jsonl> <token>
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const [port, out, token] = process.argv.slice(2);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const ok = req.headers.authorization === `Bearer ${token}`;
    appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, auth: ok, bytes: body.length, ladders: (() => { try { return JSON.parse(body).ladders?.length; } catch { return null; } })() }) + "\n");
    if (ok && req.method === "POST") writeFileSync(out.replace(/\.jsonl$/, ".last.json"), body);
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true } : { error: "unauthorized" }));
  });
}).listen(Number(port), "127.0.0.1");
