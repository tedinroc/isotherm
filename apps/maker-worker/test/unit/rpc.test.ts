// src/rpc.ts: several RPC endpoints behind one viem client -- per-endpoint token bucket, retry with backoff on
// rate-limit / 5xx, fallback in order with no ranking, cool-down, chain-id check per endpoint, writes to one endpoint.
// A fake fetch plays the providers (the official RPC's real 429 body, a 200 with a JSON-RPC rate-limit error, ...).
import { describe, expect, it } from "vitest";
import { classifyRpcError, makeRpc, TokenBucket } from "../../src/rpc.ts";

type Reply = { status?: number; result?: unknown; error?: { code: number; message: string }; raw?: string; throws?: string };
function fakeNet(script: Record<string, (method: string, n: number) => Reply>) {
  const calls: { host: string; method: string }[] = [];
  const count: Record<string, number> = {};
  const fetchFn = (async (url: string, init: RequestInit) => {
    const host = new URL(url).host;
    const body = JSON.parse(String(init.body));
    calls.push({ host, method: body.method });
    count[host] = (count[host] ?? 0) + 1;
    const r = script[host](body.method, count[host]);
    if (r.throws) throw new TypeError(r.throws);
    const text = r.raw ?? JSON.stringify(r.error ? { jsonrpc: "2.0", id: body.id, error: r.error } : { jsonrpc: "2.0", id: body.id, result: r.result });
    const json = (() => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    })();
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": json ? "application/json" : "text/plain" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const A = "https://rpc.ankr.com/monad_testnet", T = "https://10143.rpc.thirdweb.com", O = "https://testnet-rpc.monad.xyz";
const ok = (method: string): Reply => ({ result: method === "eth_chainId" ? "0x279f" : "0x10" });
const QUICKNODE_429: Reply = { status: 429, raw: '{"code":-32007,"message":"50/second request limit reached - reduce calls per second or upgrade your account at https://dashboard.quicknode.com/billing/plan"}' };
function clock() {
  let now = 1_000_000;
  const slept: number[] = [];
  return { now: () => now, sleep: async (ms: number) => void (slept.push(ms), (now += ms)), slept, advance: (ms: number) => (now += ms) };
}

describe("classifyRpcError", () => {
  it("tells provider throttling and server errors from real answers", async () => {
    const c = clock();
    const net = fakeNet({
      "rpc.ankr.com": (m) => (m === "eth_chainId" ? ok(m) : QUICKNODE_429),
      "10143.rpc.thirdweb.com": (m) => (m === "eth_chainId" ? ok(m) : { error: { code: -32000, message: "requests limited to 15/sec" } }),
      "testnet-rpc.monad.xyz": (m) => (m === "eth_chainId" ? ok(m) : { error: { code: 3, message: "execution reverted: NotStale(...)" } }),
    });
    const errOf = async (url: string) => {
      const rpc = makeRpc([url], { retries: 0, now: c.now, sleep: c.sleep, fetchFn: net.fetchFn, random: () => 0 });
      try {
        await rpc.pub.getBlockNumber({ cacheTime: 0 });
      } catch (e) {
        return e;
      }
      throw new Error("no error");
    };
    expect(classifyRpcError(await errOf(A))).toBe("rate"); // HTTP 429, QuickNode -32007 body
    expect(classifyRpcError(await errOf(T))).toBe("rate"); // HTTP 200, a JSON-RPC error "requests limited to 15/sec"
    expect(classifyRpcError(await errOf(O))).toBeNull(); // a revert is an answer, never retried elsewhere
    expect(classifyRpcError(Object.assign(new Error("HTTP request failed."), { status: 503 }))).toBe("transient");
    expect(classifyRpcError(new Error("nonce too low"))).toBeNull();
  });
});

describe("makeRpc", () => {
  it("retries a rate-limited endpoint with exponential backoff, then falls through to the next and cools the first down", async () => {
    const c = clock();
    const net = fakeNet({ "rpc.ankr.com": (m) => (m === "eth_chainId" ? ok(m) : QUICKNODE_429), "10143.rpc.thirdweb.com": ok });
    const rpc = makeRpc([A, T], { retries: 2, baseDelayMs: 250, cooldownMs: 30_000, now: c.now, sleep: c.sleep, fetchFn: net.fetchFn, random: () => 0 });
    expect(await rpc.verifyAll()).toEqual(["rpc.ankr.com: chain 10143", "10143.rpc.thirdweb.com: chain 10143"]);
    net.calls.length = 0;
    expect(await rpc.pub.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    // 1 try + 2 retries on Ankr (backoff 250 then 500 ms), then thirdweb answers
    expect(net.calls.map((x) => x.host)).toEqual(["rpc.ankr.com", "rpc.ankr.com", "rpc.ankr.com", "10143.rpc.thirdweb.com"]);
    expect(c.slept.filter((ms) => ms === 250 || ms === 500)).toEqual([250, 500]);
    const st = rpc.status();
    expect(st[0]).toMatchObject({ host: "rpc.ankr.com", rateLimited: 3, retries: 2 });
    expect(st[0].coolingDownUntil).toBeGreaterThan(c.now());
    expect(st[0].lastError).not.toMatch(/https?:\/\//); // no URL in the status
    // while Ankr cools down it is skipped (no request reaches it) ...
    net.calls.length = 0;
    await rpc.pub.getBlockNumber({ cacheTime: 0 });
    expect(net.calls.map((x) => x.host)).toEqual(["10143.rpc.thirdweb.com"]);
    // ... and writes go to the first HEALTHY endpoint
    net.calls.length = 0;
    await rpc.writeTransport()({ chain: rpc.chain } as any).request({ method: "eth_blockNumber" });
    expect(net.calls.map((x) => x.host)).toEqual(["10143.rpc.thirdweb.com"]);
    // after the cool-down Ankr is tried first again
    c.advance(31_000);
    net.calls.length = 0;
    await rpc.pub.getBlockNumber({ cacheTime: 0 }).catch(() => undefined);
    expect(net.calls[0].host).toBe("rpc.ankr.com");
  });

  it("never retries or fails over a revert; the last endpoint is tried even while cooling down", async () => {
    const c = clock();
    const net = fakeNet({ "rpc.ankr.com": (m) => (m === "eth_chainId" ? ok(m) : { error: { code: 3, message: "execution reverted" } }), "10143.rpc.thirdweb.com": ok });
    const rpc = makeRpc([A, T], { now: c.now, sleep: c.sleep, fetchFn: net.fetchFn, random: () => 0 });
    await rpc.verifyAll();
    net.calls.length = 0;
    await expect(rpc.pub.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" })).rejects.toThrow(/reverted/);
    expect(net.calls.map((x) => x.host)).toEqual(["rpc.ankr.com"]);
    // a single endpoint that is cooling down is still used (there is nothing else)
    const one = fakeNet({ "rpc.ankr.com": (m, n) => (m === "eth_chainId" ? ok(m) : n <= 2 ? { status: 503, raw: "busy" } : ok(m)) });
    const r1 = makeRpc([A], { retries: 0, now: c.now, sleep: c.sleep, fetchFn: one.fetchFn, random: () => 0 });
    await expect(r1.pub.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(r1.status()[0].coolingDownUntil).not.toBeNull();
    expect(await r1.pub.getBlockNumber({ cacheTime: 0 })).toBe(16n);
  });

  it("checks the chain id of every endpoint: one answering another chain is excluded for good; none answering 10143 refuses", async () => {
    const c = clock();
    const net = fakeNet({ "rpc.ankr.com": (m) => (m === "eth_chainId" ? { result: "0x8f" } : ok(m)), "10143.rpc.thirdweb.com": ok, "testnet-rpc.monad.xyz": () => ({ throws: "fetch failed" }) });
    const rpc = makeRpc([A, T, O], { retries: 0, now: c.now, sleep: c.sleep, fetchFn: net.fetchFn, random: () => 0 });
    const lines = await rpc.verifyAll();
    expect(lines[0]).toMatch(/rpc.ankr.com: RPC rpc.ankr.com answers chain 143, not Monad testnet 10143: excluded/);
    expect(lines[1]).toBe("10143.rpc.thirdweb.com: chain 10143");
    expect(lines[2]).toMatch(/^testnet-rpc.monad.xyz: /);
    expect(lines.at(-1)).toBe("EXCLUDED: rpc.ankr.com (chain 143)");
    expect(rpc.status().map((s) => s.verified)).toEqual(["wrong-chain", "ok", "unknown"]);
    net.calls.length = 0;
    await rpc.pub.getBlockNumber({ cacheTime: 0 });
    expect(net.calls.map((x) => x.host)).toEqual(["10143.rpc.thirdweb.com"]); // the mainnet-answering endpoint is never used
    const bad = fakeNet({ "rpc.ankr.com": () => ({ result: "0x1" }) });
    await expect(makeRpc([A], { now: c.now, sleep: c.sleep, fetchFn: bad.fetchFn }).verifyAll()).rejects.toThrow(/refusing: no RPC endpoint answered Monad testnet 10143/);
  });

  it("writes: past a rate-limit refusal (not processed) to the next endpoint; a 5xx / timeout is never replayed elsewhere", async () => {
    const c = clock();
    const raw = "0x02f8";
    const mk = (first: (m: string) => Reply) => {
      const net = fakeNet({ "rpc.ankr.com": (m) => (m === "eth_chainId" ? ok(m) : first(m)), "10143.rpc.thirdweb.com": (m) => (m === "eth_sendRawTransaction" ? { result: "0x" + "ab".repeat(32) } : ok(m)) });
      return { net, rpc: makeRpc([A, T], { retries: 1, now: c.now, sleep: c.sleep, fetchFn: net.fetchFn, random: () => 0 }) };
    };
    const send = async (rpc: ReturnType<typeof makeRpc>) => rpc.writeTransport()({ chain: rpc.chain } as any).request({ method: "eth_sendRawTransaction", params: [raw] });
    let t = mk(() => QUICKNODE_429);
    await t.rpc.verifyAll();
    t.net.calls.length = 0;
    expect(await send(t.rpc)).toBe("0x" + "ab".repeat(32));
    expect(t.net.calls.map((x) => `${x.host} ${x.method}`)).toEqual(["rpc.ankr.com eth_sendRawTransaction", "rpc.ankr.com eth_sendRawTransaction", "10143.rpc.thirdweb.com eth_sendRawTransaction"]);
    t = mk(() => ({ status: 502, raw: "bad gateway" }));
    await t.rpc.verifyAll();
    t.net.calls.length = 0;
    await expect(send(t.rpc)).rejects.toThrow();
    expect(t.net.calls.every((x) => x.host === "rpc.ankr.com")).toBe(true); // retried on the same endpoint only
  });

  it("an endpoint that was down at startup is verified lazily before its first request", async () => {
    const c = clock();
    const net = fakeNet({ "rpc.ankr.com": ok });
    const rpc = makeRpc([A], { now: c.now, sleep: c.sleep, fetchFn: net.fetchFn });
    await rpc.pub.getBlockNumber({ cacheTime: 0 });
    expect(net.calls.map((x) => x.method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    expect(rpc.status()[0].verified).toBe("ok");
  });

  it("throttles each endpoint with a token bucket (default 8 requests/s)", async () => {
    const c = clock();
    const b = new TokenBucket(8, 8, c.now, c.sleep);
    const t0 = c.now();
    await Promise.all(Array.from({ length: 24 }, () => b.take()));
    expect(c.now() - t0).toBeGreaterThanOrEqual(2000 - 1); // 8 at once, then 16 more at 8/s
    expect(c.now() - t0).toBeLessThan(2300);
    const net = fakeNet({ "rpc.ankr.com": ok });
    const rpc = makeRpc([A], { rps: 2, now: c.now, sleep: c.sleep, fetchFn: net.fetchFn });
    const t1 = c.now();
    for (let i = 0; i < 5; i++) await rpc.pub.getBlockNumber({ cacheTime: 0 }); // + 1 eth_chainId = 6 requests at 2/s
    expect(c.now() - t1).toBeGreaterThanOrEqual(2000 - 1);
  });
});
