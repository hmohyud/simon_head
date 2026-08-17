/**
 * Talk to the bust. A minimal chat line under the sculpture: the visitor
 * types, Simon (via the worker/dev proxy) answers in character, one reply
 * at a time. History rides along client-side so he keeps context.
 *
 * In dev the endpoint is Vite's built-in proxy; in production it's the
 * deployed Cloudflare Worker (VITE_CHAT_URL). No URL configured → the
 * whole chat UI stays hidden.
 */
const ENDPOINT = import.meta.env.DEV ? "/api/chat" : import.meta.env.VITE_CHAT_URL || "";

export function initChat({ onThinking, onReply } = {}) {
  const root = document.getElementById("chat");
  if (!root) return;
  if (!ENDPOINT) {
    root.remove();
    return;
  }
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const replyEl = document.getElementById("chat-reply");

  const history = [];
  let busy = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    busy = true;
    root.classList.add("busy");
    replyEl.textContent = "…";
    replyEl.classList.add("show", "thinking");
    onThinking?.();

    history.push({ role: "user", content: text });
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-10) }),
      });
      const data = await res.json();
      const reply = res.ok && data.reply ? data.reply : "…the stone is tired. try again in a bit.";
      history.push({ role: "assistant", content: reply });
      replyEl.textContent = reply;
      onReply?.();
    } catch {
      replyEl.textContent = "…the stone is tired. try again in a bit.";
    } finally {
      replyEl.classList.remove("thinking");
      root.classList.remove("busy");
      busy = false;
      input.focus();
    }
  });
}
