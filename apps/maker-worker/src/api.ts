// The API Worker `isotherm-api` through the service binding `API` (wrangler.toml [[services]]): no URL, no public
// hostname. The maker only uses two of its routes:
//   GET  /api/snapshot   the latest published snapshot (another writer's, for the interlock; the Mac's, for the shadow
//                        comparison)
//   POST /api/snapshot   publish ours (Bearer SNAPSHOT_TOKEN), LIVE mode only: a shadow snapshot would overwrite the
//                        live maker's and show quotes that are not on the books.
import type { ServiceBinding } from "./env.ts";

export interface ApiReply {
  ok: boolean;
  status: number;
  body?: any;
  error?: string;
}

export interface ApiClient {
  getSnapshot(): Promise<ApiReply>;
  postSnapshot(snapshot: unknown, token: string): Promise<ApiReply>;
}

const ORIGIN = "https://isotherm-api.internal"; // any host: the binding routes by path

export function bindingApi(binding: ServiceBinding | undefined): ApiClient {
  const call = async (path: string, init: RequestInit): Promise<ApiReply> => {
    if (!binding) return { ok: false, status: 0, error: "API service binding not configured" };
    try {
      const res = await binding.fetch(new Request(`${ORIGIN}${path}`, init));
      const text = await res.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { ok: res.ok, status: res.status, body, ...(res.ok ? {} : { error: typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200) }) };
    } catch (e) {
      return { ok: false, status: 0, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  };
  return {
    getSnapshot: () => call("/api/snapshot", { method: "GET", headers: { accept: "application/json" } }),
    postSnapshot: (snapshot, token) =>
      call("/api/snapshot", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(snapshot) }),
  };
}
