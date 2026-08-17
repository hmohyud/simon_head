import { defineConfig, loadEnv } from "vite";
import { cannedBusyReply, cannedLimitReply, cleanReply, groqPayload } from "./worker/persona.js";

/* Dev-only stand-in for the Cloudflare Worker: proxies /api/chat to Groq
   using GROQ_API_KEY from .env.local (never exposed to the client — no
   VITE_ prefix). Production uses the deployed worker instead. */
function chatDevProxy(apiKey) {
  return {
    name: "chat-dev-proxy",
    configureServer(server) {
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
