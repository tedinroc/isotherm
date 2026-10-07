// Retired main chunks of builds deployed before 2026-10-07 16:01 UTC. Those builds called the API on its former
// hostname, and Cloudflare's edge cache kept serving their immutable /assets/* files from https://isotherm.pages.dev
// after newer deployments replaced them. public/_routes.json routes exactly these paths (and /api/*) to Functions,
// which run in front of that cache, so they now answer 404 instead of the stale file. Every other /assets/* request
// never reaches this Function: it is served as a static file.

export const RETIRED_CHUNKS: ReadonlySet<string> = new Set([
  'index-BJ2g1e3Y.js',
  'index-CIjHIjYB.js',
  'index-ChjCNmYB.js',
  'index-D6Cfp9Hz.js',
  'index-Dl6lo4gH.js',
  'index-sVKTc5nx.js',
]);

export const onRequest = (ctx: { params: { name?: string | string[] }; next: () => Promise<Response> }): Promise<Response> | Response => {
  const name = Array.isArray(ctx.params.name) ? ctx.params.name.join('/') : (ctx.params.name ?? '');
  if (!RETIRED_CHUNKS.has(name)) return ctx.next();
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
};
