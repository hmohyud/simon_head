/**
 * Cloudflare Worker: tiny proxy between the public site and Groq, so the
 * API key stays server-side. Deploy with wrangler (see worker/README.md);
 * the key is stored as a Worker secret named GROQ_API_KEY.
 */
import { cannedLimitReply, cleanReply, groqPayload } from "./persona.js";

const ALLOWED_ORIGINS = ["https://hmohyud.github.io", "http://localhost:5173"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") {
      return new Response("simon only answers POST", { status: 405, headers: cors });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: cors });
    }

    /* sanitize: client controls only a short window of user/assistant turns */
    const history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));
    if (!history.length) {
      return new Response(JSON.stringify({ error: "empty" }), { status: 400, headers: cors });
    }

    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(groqPayload(history)),
    });

    if (upstream.status === 429) {
      /* Rate limited. Daily vs per-minute comes from Groq's error text;
         whether to blame THIS visitor comes from how much they've said. */
      const errText = await upstream.text();
      const daily = /per day|TPD|RPD/i.test(errText);
      const lightUser = history.filter((m) => m.role === "user").length <= 2;
      return new Response(JSON.stringify({ reply: cannedLimitReply(daily, lightUser) }), {
        headers: { ...cors, "content-type": "application/json" },
      });
    }
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `groq ${upstream.status}` }), {
        status: 502,
        headers: { ...cors, "content-type": "application/json" },
      });
    }
    const data = await upstream.json();
    const reply = cleanReply(data.choices?.[0]?.message?.content) || "…";
    return new Response(JSON.stringify({ reply }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  },
};
