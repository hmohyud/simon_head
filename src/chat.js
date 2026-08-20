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
/* Dev talks to Vite's local proxy first (instant persona iteration), then
   falls back to the deployed worker — so a loaded page keeps working even
   if the dev server is stopped. Production goes straight to the worker. */
const WORKER_URL = import.meta.env.VITE_CHAT_URL || "";
const ENDPOINTS = (import.meta.env.DEV ? ["/api/chat", WORKER_URL] : [WORKER_URL]).filter(Boolean);
const STORE_KEY = "simon-chat-history";
const MAX_STORED = 200;

export function initChat({ onThinking, onReply, onSpeaking, getMaterial } = {}) {
  const root = document.getElementById("chat");
  if (!root) return;
  if (!ENDPOINTS.length) {
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

  /* the send button lights up only when there's something to send */
  const syncSend = () => root.classList.toggle("has-text", input.value.trim().length > 0);
  input.addEventListener("input", syncSend);
  syncSend();

  const THINKING_HTML = '<span class="dots"><i></i><i></i><i></i></span>';
  const slowMotionOff = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Type the reply out rather than dumping it. Punctuation gets a longer
     beat, which is most of what makes it read as speech instead of a
     progress bar. onTyping brackets the whole run, so the eyes can be lit
     for exactly as long as he is talking. */
  /* The eyes come up the moment a message is sent and stay up until two
     seconds after the answer has finished typing. Held here rather than in
     the typing loop, so the light covers the wait for the reply as well —
     and so a second message during the hold keeps it lit instead of
     letting it drop. */
  let litTimer = null;
  const setLit = (on, holdMs = 0) => {
    clearTimeout(litTimer);
    if (on) {
      onSpeaking?.(true);
    } else {
      litTimer = setTimeout(() => onSpeaking?.(false), holdMs);
    }
  };

  let typingRun = 0;
  function typeOut(text) {
    const run = ++typingRun;
    if (slowMotionOff) {
      replyEl.textContent = text;
      return Promise.resolve();
    }
    replyEl.textContent = "";
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (run !== typingRun) return resolve(); // a newer reply took over
        replyEl.textContent = text.slice(0, ++i);
        if (i >= text.length) return resolve();
        const ch = text[i - 1];
        const beat = ".!?".includes(ch) ? 390 : ",;:".includes(ch) ? 195 : 27;
        setTimeout(step, beat);
      };
      step();
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    syncSend();
    busy = true;
    setLit(true); // lit from the moment they hit send
    root.classList.add("busy");
    replyEl.innerHTML = THINKING_HTML;
    replyEl.classList.add("show");
    onThinking?.();

    history.push({ role: "user", content: text });
    save();
    if (historyEl.classList.contains("open")) renderLog();

    const payload = JSON.stringify({
      messages: history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      material: getMaterial ? getMaterial() : "",
    });
    let reply = "";
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        const data = await res.json();
        if (res.ok && data.reply) {
          reply = data.reply;
          break;
        }
      } catch {
        /* endpoint unreachable — try the next one */
      }
    }
    if (!reply) reply = "…the stone is tired. try again in a bit.";
    history.push({ role: "assistant", content: reply });
    save();
    if (historyEl.classList.contains("open")) renderLog();
    onReply?.();
    root.classList.remove("busy");
    busy = false;
    input.focus();
    await typeOut(reply);
    setLit(false, 2000); // linger a beat after the last character
  });
}
