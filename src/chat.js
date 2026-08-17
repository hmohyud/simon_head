/**
 * Talk to the bust. A chat line under the sculpture: the visitor types,
 * Simon (via the worker/dev proxy) answers in character. The conversation
 * is kept ONLY in this browser (localStorage) — a chevron on the input
 * opens the scrollable history.
 *
 * In dev the endpoint is Vite's built-in proxy; in production it's the
 * deployed Cloudflare Worker (VITE_CHAT_URL). No URL configured → the
 * whole chat UI stays hidden.
 */
const ENDPOINT = import.meta.env.DEV ? "/api/chat" : import.meta.env.VITE_CHAT_URL || "";
const STORE_KEY = "simon-chat-history";
const MAX_STORED = 200;

export function initChat({ onThinking, onReply, getMaterial } = {}) {
  const root = document.getElementById("chat");
  if (!root) return;
  if (!ENDPOINT) {
    root.remove();
    return;
  }
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const replyEl = document.getElementById("chat-reply");
  const historyBtn = document.getElementById("chat-history-btn");
  const historyEl = document.getElementById("chat-history");
  const logEl = document.getElementById("chat-log");
  const clearBtn = document.getElementById("chat-clear");

  let history = [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) history = JSON.parse(raw).filter((m) => m && m.role && typeof m.content === "string");
  } catch {
    history = [];
  }
  let busy = false;

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-MAX_STORED)));
    } catch {
      /* storage full or blocked — chat still works, just won't persist */
    }
  };

  const renderLog = () => {
    logEl.innerHTML = "";
    for (const m of history) {
      const row = document.createElement("div");
      row.className = "msg " + (m.role === "user" ? "user" : "simon");
      row.textContent = m.content;
      logEl.appendChild(row);
    }
    logEl.scrollTop = logEl.scrollHeight;
  };

  historyBtn.addEventListener("click", () => {
    const open = historyEl.classList.toggle("open");
    historyBtn.classList.toggle("open", open);
    if (open) renderLog();
  });
  clearBtn.addEventListener("click", () => {
    history = [];
    save();
    renderLog();
    replyEl.classList.remove("show");
  });

  const THINKING_HTML = '<span class="dots"><i></i><i></i><i></i></span>';

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    busy = true;
    root.classList.add("busy");
    replyEl.innerHTML = THINKING_HTML;
    replyEl.classList.add("show");
    onThinking?.();

    history.push({ role: "user", content: text });
    save();
    if (historyEl.classList.contains("open")) renderLog();

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
          material: getMaterial ? getMaterial() : "",
        }),
      });
      const data = await res.json();
      const reply = res.ok && data.reply ? data.reply : "…the stone is tired. try again in a bit.";
      history.push({ role: "assistant", content: reply });
      save();
      replyEl.textContent = reply;
      if (historyEl.classList.contains("open")) renderLog();
      onReply?.();
    } catch {
      replyEl.textContent = "…the stone is tired. try again in a bit.";
    } finally {
      root.classList.remove("busy");
      busy = false;
      input.focus();
    }
  });
}
