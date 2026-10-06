// Monad-testnet RPC shim for mm 7.0.0 (real, signed-in use).
//
// Problem: ctx.publicClient(chainId) builds `${infuraRpcBaseUrl}/${chainId}/${projectId}`
// and MetaMask's hosted gateway answers HTTP 400 {"error":"Invalid chainId"} for 10143.
// Fix: run this shim and start mm with
//   MM_INFURA_RPC_BASE_URL=http://127.0.0.1:18790 mm weather quote taipei
// Chain 10143 is served from MONAD_RPC; every other chain is passed through,
// byte for byte, to the real gateway, so built-in commands behave as before.
// The gateway path carries only the projectId (no bearer token), which never
// leaves this machine except to the original upstream.
import http from "node:http";

const PORT = Number(process.env.SHIM_PORT || 18790);
const MONAD_RPC = process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
const UPSTREAM = process.env.MM_GATEWAY_UPSTREAM || "https://agentic-proxy.workers.cx.metamask.io/infura-service/v1";
const SERVE = new Map([[10143, MONAD_RPC]]);

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const m = new URL(req.url, "http://x").pathname.match(/^\/(\d+)\/([^/]+)\/?$/);
    if (!m) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "expected /<chainId>/<projectId>" }));
    }
    const chainId = Number(m[1]);
    const target = SERVE.get(chainId) ?? `${UPSTREAM}/${chainId}/${m[2]}`;
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "GET" ? undefined : raw,
      });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `shim upstream failed: ${String(e?.message || e)}` }));
    }
  })
  .listen(PORT, "127.0.0.1", () =>
    console.error(`rpc-shim on http://127.0.0.1:${PORT}  (10143 -> ${MONAD_RPC}; others -> ${UPSTREAM})`),
  );
