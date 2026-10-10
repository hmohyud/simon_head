/**
 * Cloudflare Worker: the proxy between the public site and the language
 * models, so every API key stays server-side. Deploy with wrangler (see
 * worker/README.md); keys are Worker secrets, one per provider.
 *
 *   POST /        a visitor message -> { reply }
 *   GET  /health  which providers are usable right now, without spending
 *                 a token — 503 the moment any one of them breaks, so an
 *                 uptime monitor pointed here hears about it first
 */
import { answer, health, sanitizeHistory } from "./chain.js";
import { cannedLimitReply } from "./persona.js";

/* The site's own origins. A browser on any other origin gets
   ALLOWED_ORIGINS[0] echoed back, which won't match, so it blocks the
   response. That only stops browsers — curl ignores CORS entirely — which
   is why the rate limit below exists. The github.io entry stays because
   Pages keeps serving (and redirecting) the old project URL. */
const ALLOWED_ORIGINS = [
  "https://smartestass.com",
  "https://www.smartestass.com",
  "https://hmohyud.github.io",
  "http://localhost:5173",
];

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Expose-Headers": "x-simon-provider, x-simon-trail",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      const report = await health(env);
      return json(report, report.ok ? 200 : 503, cors);
    }
    if (request.method !== "POST") {
      return new Response("simon only answers POST", { status: 405, headers: cors });
    }

    /* Per visitor, in front of every provider at once. Without it, anyone
       with curl can drain the free tiers and then the paid backstop. The
       counter is per Cloudflare location and approximate by design — a
       brake, not an accounting system. A person chatting never gets near
       it; someone hitting it hears about it from Simon, not an error. */
    if (env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) {
        console.log(JSON.stringify({ served: "rate-limited" }));
        return json({ reply: cannedLimitReply(false, false) }, 200, { ...cors, "x-simon-provider": "rate-limited" });
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad json" }, 400, cors);
    }
    const history = sanitizeHistory(body.messages);
    if (!history.length) return json({ error: "empty" }, 400, cors);
    const material = typeof body.material === "string" ? body.material : "";

    const result = await answer(history, material, env);
    /* one line per message: which provider answered and everything that
       failed on the way — visible in `wrangler tail` and the dashboard */
    console.log(JSON.stringify({ served: result.provider ?? "canned", model: result.model, trail: result.trail }));
    return json({ reply: result.reply }, 200, {
      ...cors,
      "x-simon-provider": result.provider ? `${result.provider} ${result.model}` : "canned",
      "x-simon-trail": result.trail.join(" > "),
    });
  },
};
