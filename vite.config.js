import { defineConfig, loadEnv } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { answer, sanitizeHistory } from "./worker/chain.js";

/* Dev-only stand-in for the Cloudflare Worker: runs /api/chat through the
   same failover chain, using whichever provider keys are in .env.local
   (never exposed to the client — no VITE_ prefix). Production uses the
   deployed worker instead. */
function chatDevProxy(env) {
  return {
    name: "chat-dev-proxy",
    configureServer(server) {
      /* Dev-only: lets the region painter save straight into the repo, so
         the baking tool and the painter never drift apart. */
      server.middlewares.use("/api/regions", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          try {
            mkdirSync("regions", { recursive: true });
            writeFileSync("regions/simon-regions.json", raw);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, bytes: raw.length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e.message || e) }));
          }
        });
      });

      /* Dev-only: the painter posts the finished deformation here, so what
         gets baked into the model is exactly what was approved on screen
         rather than a second implementation that has to be kept in step. */
      server.middlewares.use("/api/bake", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          try {
            const data = JSON.parse(raw);
            const name = String(data.model || "unknown").replace(/[^a-z0-9_.-]/gi, "");
            mkdirSync("regions", { recursive: true });
            writeFileSync("regions/bake-" + name + ".json", raw);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, file: "regions/bake-" + name + ".json", bytes: raw.length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e.message || e) }));
          }
        });
      });

      server.middlewares.use("/api/chat", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", async () => {
          res.setHeader("content-type", "application/json");
          try {
            const body = JSON.parse(raw || "{}");
            const history = sanitizeHistory(body.messages);
            if (!history.length) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "empty" }));
              return;
            }
            const material = typeof body.material === "string" ? body.material : "";
            const result = await answer(history, material, env);
            /* the trail shows failover happening as you test it */
            console.log(`[chat] ${result.provider ?? "canned"} · ${result.trail.join(" → ") || "no providers configured"}`);
            res.setHeader("x-simon-provider", result.provider ? `${result.provider} ${result.model}` : "canned");
            res.end(JSON.stringify({ reply: result.reply }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e.message || e) }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    // relative base so the built site works from any subpath (GitHub Pages included)
    base: "./",
    plugins: [chatDevProxy(env)],
  };
});
