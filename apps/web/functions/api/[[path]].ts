// Cloudflare Pages Function: https://isotherm.pages.dev/api/* is the public API. It forwards the incoming Request
// unchanged (method, path, query, headers including CF-Connecting-IP, body) to the `isotherm-api` Worker through the
// service binding `API` (apps/web/wrangler.toml), so the Worker needs no public hostname of its own. CORS, bearer auth
// and the per-network rate limits all stay in the Worker; this file adds nothing and strips nothing.
// Only /api/* invokes a Function (wrangler generates _routes.json from this directory); static assets never do.

export interface ApiBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  API?: ApiBinding;
}

export const onRequest = async (ctx: { request: Request; env: Env }): Promise<Response> => {
  if (!ctx.env.API) {
    return new Response(JSON.stringify({ ok: false, error: 'API binding not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return ctx.env.API.fetch(ctx.request);
};
