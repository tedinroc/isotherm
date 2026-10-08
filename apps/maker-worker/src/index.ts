// Isotherm market maker on Cloudflare (Monad testnet 10143 only).
//
//   cron "* * * * *" -> MakerDO /kick: re-arms the Durable Object's own alarm if it is missing or overdue; the DO
//   ticks on that alarm (quotes, daily roll, close-time kill switch, settlement watcher, snapshot).
//
// No public surface: wrangler.toml has workers_dev = false, preview_urls = false and no routes, and fetch() below
// answers 404 to everything. Operators talk to it through the control KV (scripts/control.mjs); it talks to the API
// Worker through the service binding API. It starts in SHADOW mode and sends nothing until both live switches are on.
import type { Env } from "./env.ts";

export { MakerDO } from "./maker-do.ts";

const stub = (env: Env) => env.MAKER.get(env.MAKER.idFromName("maker"));

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const at = new Date(event.scheduledTime).toISOString();
    ctx.waitUntil(
      stub(env)
        .fetch("https://maker.internal/kick", { method: "POST" })
        .then(async (r) => {
          const body = await r.text();
          console.log(`[cron] ${at} kick ${r.status} ${body}`);
          // visible to the operator even if the Durable Object is wedged (scripts/control.mjs cron)
          await env.MAKER_KV?.put("cron:last", JSON.stringify({ at, status: r.status, body: body.slice(0, 300) }));
        })
        .catch(async (e) => {
          console.error(`[cron] ${at} kick failed: ${String(e)}`);
          await env.MAKER_KV?.put("cron:last", JSON.stringify({ at, error: String(e).slice(0, 300) })).catch(() => undefined);
        }),
    );
  },
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
