// LOCAL TEST HARNESS ONLY — a stand-in for MetaMask's backend so the real
// `mm` 7.0.0 binary can exercise the plugin's walletExecutor path against an
// anvil fork without a MetaMask account. It never talks to MetaMask servers.
//
// What it stubs (paths read from @metamask/agent-wallet 7.0.0 dist):
//   POST /v1/projects/:pid/wallets/byok/challenge        BYOK registration challenge
//   POST /v1/projects/:pid/wallets/byok                  BYOK registration
//   GET|PUT|POST /v1/projects/:pid/wallets/:addr/mode    trading mode (Guard)
//   POST /v1/projects/:pid/transaction-requests          signed tx -> eth_sendRawTransaction on anvil
//   GET  /v1/projects/:pid/transaction-requests/:id      job status
//   POST /rpc/:chainId/:pid                              EVM gateway shim (ctx.publicClient)
// A toy "Guard" allowlist mimics the policy hop: txs to non-allowlisted `to`
// addresses are DENIED, so the demo shows the executor really routes through
// the backend before broadcast.
import http from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const PORT = Number(process.env.STUB_PORT || 19288);
const ANVIL = process.env.ANVIL_RPC || "http://127.0.0.1:19251";
const LOG = process.env.STUB_LOG || new URL("./logs/stub.log", import.meta.url).pathname;
const ALLOW = new Set((process.env.STUB_ALLOWLIST || "").toLowerCase().split(",").filter(Boolean));
const jobs = new Map();
// Real response of GET https://agentic-mimir-service.api.cx.metamask.io/v1/supportedNetworks (captured 2026-10-06).
const MIMIR_NETWORKS = readFileSync(new URL("./fixtures/mimir-supported-networks.2026-10-06.json", import.meta.url), "utf8");

function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  appendFileSync(LOG, line + "\n");
}

async function rpc(method, params) {
  const r = await fetch(ANVIL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = raw;
  }
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const auth = req.headers.authorization ? "Bearer <redacted>" : "none";
  try {
    // EVM gateway shim used by ctx.publicClient(chainId): /rpc/<chainId>/<projectId>
    let m = p.match(/^\/rpc\/(\d+)\/[^/]+$/);
    if (m) {
      const chainId = Number(m[1]);
      log({ kind: "gateway", chainId, method: Array.isArray(body) ? body.map((b) => b.method) : body?.method });
      if (chainId !== 10143) return send(res, 400, { error: "Invalid chainId" });
      const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(await r.text());
    }

    if (p === "/v1/supportedNetworks" && req.method === "GET") {
      log({ kind: "mimir-supported-networks" });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(MIMIR_NETWORKS);
    }
    // Mirror of the real hosted gateway's behaviour (measured with curl): 400 {"error":"Invalid chainId"} for 10143.
    let g = p.match(/^\/gw-real\/(\d+)\/[^/]+$/);
    if (g) {
      log({ kind: "gateway-real-mirror", chainId: Number(g[1]) });
      return send(res, 400, { error: "Invalid chainId" });
    }
    if (p === "/introspect" && req.method === "POST") {
      log({ kind: "introspect", jti: body?.jti });
      return send(res, 200, { active: true });
    }
    m = p.match(/^\/v1\/projects\/([^/]+)\/wallets\/byok\/challenge$/);
    if (m && req.method === "POST") {
      log({ kind: "byok-challenge", address: body?.address, auth });
      return send(res, 200, { challengeId: "stub-challenge-1", message: `Isotherm local stub: register ${body?.address}` });
    }
    m = p.match(/^\/v1\/projects\/([^/]+)\/wallets\/byok$/);
    if (m && req.method === "POST") {
      log({ kind: "byok-register", address: body?.address, hasSignature: !!body?.signature, auth });
      return send(res, 200, { address: body?.address, type: "byok" });
    }
    m = p.match(/^\/v1\/projects\/([^/]+)\/wallets\/([^/]+)\/mode$/);
    if (m) {
      log({ kind: "trading-mode", method: req.method, wallet: m[2], body });
      return send(res, 200, { mode: body?.mode ?? "guard", applied: true, mfaRequired: false });
    }
    m = p.match(/^\/v1\/projects\/([^/]+)\/transaction-requests$/);
    if (m && req.method === "POST") {
      const { requestId, chainId, tx, txIntent, signedTransaction } = body || {};
      log({ kind: "tx-request", requestId, chainId, to: tx?.to, gas: tx?.gas, intent: txIntent, signed: !!signedTransaction, auth });
      if (ALLOW.size && !ALLOW.has(String(tx?.to || "").toLowerCase())) {
        const job = { requestId, status: "DENIED", chainId, failureCode: "GUARD_ALLOWLIST", failureDescription: `stub Guard: ${tx?.to} not on allowlist` };
        jobs.set(requestId, job);
        log({ kind: "tx-denied", requestId, to: tx?.to });
        return send(res, 200, job);
      }
      if (!signedTransaction) return send(res, 400, { code: "STUB_NEEDS_SIGNED_TX", message: "stub only supports BYOK" });
      const t0 = Date.now();
      const hash = await rpc("eth_sendRawTransaction", [signedTransaction]);
      // Like the real service, answer with a non-terminal job; the CLI then polls GET .../:id.
      const job = { requestId, kind: "transaction", status: "BROADCASTING", chainId, namespace: "eip155", tx: { ...tx, chainId }, txHash: hash, submittedAt: new Date().toISOString() };
      jobs.set(requestId, job);
      log({ kind: "tx-broadcast", requestId, hash, txKeys: tx ? Object.keys(tx) : [], ms: Date.now() - t0 });
      return send(res, 200, job);
    }
    m = p.match(/^\/v1\/projects\/([^/]+)\/transaction-requests\/([^/]+)$/);
    if (m && req.method === "GET") {
      const job = jobs.get(m[2]);
      if (job && job.txHash && job.status === "BROADCASTING") {
        const receipt = await rpc("eth_getTransactionReceipt", [job.txHash]);
        if (receipt) {
          job.status = receipt.status === "0x1" ? "CONFIRMED" : "FAILED";
          job.gasUsed = receipt.gasUsed;
          if (receipt.status !== "0x1") job.failureDescription = "reverted on chain";
        }
      }
      log({ kind: "tx-status", requestId: m[2], status: job?.status, gasUsed: job?.gasUsed });
      return job ? send(res, 200, job) : send(res, 404, { code: "NOT_FOUND" });
    }
    log({ kind: "unhandled", method: req.method, path: p, bodyKeys: body && typeof body === "object" ? Object.keys(body) : typeof body });
    return send(res, 404, { code: "STUB_UNHANDLED", path: p });
  } catch (e) {
    log({ kind: "error", path: p, error: String(e?.message || e) });
    return send(res, 500, { code: "STUB_ERROR", message: String(e?.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => log({ kind: "listening", port: PORT, anvil: ANVIL, allowlist: [...ALLOW] }));
