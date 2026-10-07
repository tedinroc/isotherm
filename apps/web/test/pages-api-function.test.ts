import { describe, expect, it } from 'vitest';
import { onRequest, type Env } from '../functions/api/[[path]]';
import { API_URL } from '../src/config';

describe('Pages Function /api/* -> isotherm-api service binding', () => {
  it('forwards the incoming Request object unchanged and returns the Worker response as is', async () => {
    const req = new Request('https://isotherm.pages.dev/api/drip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', origin: 'https://isotherm.pages.dev' },
      body: JSON.stringify({ address: '0x1' }),
    });
    const seen: Request[] = [];
    const workerRes = new Response('{"ok":false,"error":"bad address"}', { status: 400, headers: { 'x-from': 'worker' } });
    const env: Env = { API: { fetch: async (r) => (seen.push(r), workerRes) } };
    const res = await onRequest({ request: req, env });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(req); // same object: method, URL, headers (incl. CF-Connecting-IP) and body untouched
    expect(res).toBe(workerRes);
  });

  it('answers 503 JSON (not the SPA page) when the binding is missing', async () => {
    const res = await onRequest({ request: new Request('https://isotherm.pages.dev/api/health'), env: {} });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: false, error: 'API binding not configured' });
  });
});

describe('API origin', () => {
  it('defaults to same origin (no separate API hostname baked into the bundle)', () => {
    expect(API_URL).toBe('');
  });
});

describe('Pages Function /assets/[name] (retired chunks only)', async () => {
  const { onRequest: assets, RETIRED_CHUNKS } = await import('../functions/assets/[name]');
  const routes = (await import('../public/_routes.json')).default as { include: string[]; exclude: string[] };

  it('answers 404 no-store for a retired chunk and passes anything else to the static asset', async () => {
    const stat = new Response('static');
    const next = async () => stat;
    const gone = await assets({ params: { name: 'index-Dl6lo4gH.js' }, next });
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toBe('no-store');
    expect(await assets({ params: { name: 'index-current.js' }, next })).toBe(stat);
  });

  it('_routes.json sends only /api/* and the retired chunks to Functions', () => {
    expect(routes.include).toEqual(['/api/*', ...[...RETIRED_CHUNKS].map((n) => `/assets/${n}`)]);
    expect(routes.exclude).toEqual([]);
  });
});
