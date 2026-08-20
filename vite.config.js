import { defineConfig, loadEnv } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { cannedBusyReply, cannedLimitReply, cleanReply, groqPayload } from "./worker/persona.js";

/* Dev-only stand-in for the Cloudflare Worker: proxies /api/chat to Groq
   using GROQ_API_KEY from .env.local (never exposed to the client — no
   VITE_ prefix). Production uses the deployed worker instead. */
function chatDevProxy(apiKey) {
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
            if (!apiKey) throw new Error("GROQ_API_KEY missing from .env.local");
            const body = JSON.parse(raw || "{}");
            const history = (Array.isArray(body.messages) ? body.messages : [])
              .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
              .slice(-10)
              .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));
            const callGroq = () =>
              fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(
                  groqPayload(history, typeof body.material === "string" ? body.material : "")
                ),
              });
            let upstream = await callGroq();
            if (upstream.status >= 500) {
              await new Promise((r) => setTimeout(r, 500));
              upstream = await callGroq();
            }
            if (upstream.status >= 500) {
              res.end(JSON.stringify({ reply: cannedBusyReply() }));
              return;
            }
            if (upstream.status === 429) {
              const errText = await upstream.text();
              const daily = /per day|TPD|RPD/i.test(errText);
              const lightUser = history.filter((m) => m.role === "user").length <= 2;
              res.end(JSON.stringify({ reply: cannedLimitReply(daily, lightUser) }));
              return;
            }
            if (!upstream.ok) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: `groq ${upstream.status}` }));
              return;
            }
            const data = await upstream.json();
            res.end(JSON.stringify({ reply: cleanReply(data.choices?.[0]?.message?.content) || "…" }));
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
    plugins: [chatDevProxy(env.GROQ_API_KEY)],
  };
});
