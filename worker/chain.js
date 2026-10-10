/**
 * The failover chain: Simon's persona sent to each configured provider in
 * turn until one answers in character. Shared by the Cloudflare Worker and
 * the Vite dev proxy, so testing locally exercises exactly what ships.
 *
 * Every way a provider can fail lands somewhere specific: a retired model
 * is swapped for the newest in its family and retried, a bad key or an
 * exhausted quota benches the provider so later messages skip it without
 * waiting, and a reply that breaks character falls through to the next
 * provider. Only when every provider has failed does Simon fall back to a
 * canned line — still in character, never an error.
 */
import { buildMessages, cannedBusyReply, cannedLimitReply, cleanReply } from "./persona.js";
import { PROVIDERS } from "./providers.js";

const REPLY_TOKENS = 300;
const TEMPERATURE = 0.9;

/* A human is watching three dots. The whole chain gets a ceiling, and a
   slice of it is held back for the last provider standing — otherwise two
   slow failures up front use the time the backstop exists to have. */
const BUDGET_MS = 12000;
const RESERVE_MS = 4000;
const MIN_ATTEMPT_MS = 1200; // don't start an attempt that can't finish
const ATTEMPT_MS = 5000; // default for providers that don't set timeoutMs
const LIST_MS = 2500;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

/* How long a provider sits out after each kind of failure. */
const BENCH_MS = {
  auth: 60 * 60 * 1000, // bad or revoked key: nothing will change soon
  daily: 60 * 60 * 1000, // out for the day (or out of credit); look again hourly
  config: 10 * 60 * 1000, // it rejects the request itself
  model: 10 * 60 * 1000, // no model in the family could be found
  rate: 30 * 1000, // per-minute limit; a Retry-After header wins if given
  down: 20 * 1000, // 5xx, timeout, network
};

/* Per-isolate memory. Free and instant; it resets whenever Cloudflare
   recycles the isolate, which only means a provider is retried a little
   sooner than it strictly needed to be. KV would cost a read on every
   message to save a few timeouts a day. */
const resolved = new Map(); // provider id -> { id, at }
const benched = new Map(); // provider id -> { until, why }

/* Only what the client legitimately controls: a short window of plain
   user/assistant turns. Leading assistant turns are dropped and repeated
   roles merged, because several providers reject a conversation that
   doesn't start with the user or doesn't alternate. */
export function sanitizeHistory(messages) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  const merged = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content += "\n" + t.content;
    else merged.push(t);
  }
  return merged;
}

/* Models that share a family name but aren't for conversation. */
const NOT_FOR_CHAT = /guard|safeguard|embed|whisper|tts|orpheus|vision|-vl\b|coder|math|audio/i;

const paramsOf = (id) => {
  const m = /(\d+(?:\.\d+)?)b\b/i.exec(id);
  return m ? parseFloat(m[1]) : null;
};

/* The newest active chat model in the provider's family. Small variants are
   skipped so a new 4B release can't win just by being newest. */
export function newestInFamily(list, provider, avoid) {
  const best = (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.id === "string" && m.active !== false && m.id !== avoid)
    .filter((m) => provider.family.test(m.id) && !NOT_FOR_CHAT.test(m.id))
    .filter((m) => !Array.isArray(m.output_modalities) || m.output_modalities.includes("text"))
    .filter((m) => (paramsOf(m.id) ?? Infinity) >= (provider.minParamsB ?? 14))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || (paramsOf(b.id) ?? 0) - (paramsOf(a.id) ?? 0))[0];
  return best ? best.id : null;
}

const configured = (p, env) => (p.binding ? Boolean(env[p.binding]) : Boolean(env[p.secret]));

/* GROQ_MODEL, CFAI_MODEL, GROQ_OSS_MODEL, ... — pin a model by hand, live in seconds via
   `wrangler secret put`, no deploy. Mostly for Workers AI, which has no
   model list to resolve from. */
const pinnedBy = (p, env) => env[`${p.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODEL`] || null;

const headersFor = (p, env) => ({ authorization: `Bearer ${env[p.secret]}`, ...(p.headers ?? {}) });

/* Workers AI's catalog, reshaped like an OpenAI model list. Models that
   need the paid Workers plan are marked inactive rather than discovered by
   failing (and so can never start a bill), as are ones past their
   deprecation date. */
const catalogProp = (m, id) => (m.properties ?? []).find((x) => x.property_id === id)?.value;
export function catalogToList(all, now = Date.now()) {
  return (Array.isArray(all) ? all : [])
    .filter((m) => m && typeof m.name === "string" && m.task?.name === "Text Generation")
    .map((m) => ({
      id: m.name,
      created: Date.parse(`${String(m.created_at).replace(" ", "T")}Z`) || 0,
      active:
        String(catalogProp(m, "require_workers_paid")) !== "true" &&
        !(Date.parse(catalogProp(m, "planned_deprecation_date")) <= now),
    }));
}

async function listModels(p, env, fetchImpl, ms) {
  if (p.binding) {
    /* AI.models() isn't on the binding's docs page, but it's on the binding
       and it's how wrangler lists the catalog; if it ever goes away this
       throws and the pinned model is used, as with any unreadable list */
    const all = await withTimeout(env[p.binding].models({}), ms);
    return { status: 200, list: catalogToList(all) };
  }
  const res = await fetchImpl(`${p.base}/models`, {
    headers: headersFor(p, env),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) return { status: res.status, body: await res.text() };
  const data = await res.json();
  return { status: res.status, list: Array.isArray(data?.data) ? data.data : [] };
}

/* Which model to ask. A hand pin wins; otherwise the newest in the family,
   cached per isolate. `force` re-reads the list (skipping `avoid`, the model
   that just died) and ignores a pin, because a dead pin helps nobody. The
   lookup spends from the request's budget like everything else. */
async function pickModel(p, env, fetchImpl, now, { force = false, avoid, within = LIST_MS } = {}) {
  const pin = pinnedBy(p, env);
  if (pin && !force) return pin;
  if (!p.family) return pin ?? p.model;
  const cached = resolved.get(p.id);
  if (!force && cached && now() - cached.at < MODEL_TTL_MS) return cached.id;
  const ms = Math.min(LIST_MS, within - MIN_ATTEMPT_MS);
  if (ms >= 300) {
    try {
      const { list } = await listModels(p, env, fetchImpl, ms);
      const best = list && newestInFamily(list, p, avoid);
      if (best) {
        resolved.set(p.id, { id: best, at: now() });
        return best;
      }
    } catch {
      /* list unreachable: fall back below */
    }
  }
  return cached && cached.id !== avoid ? cached.id : p.model;
}

export function classify(status, body) {
  const text = String(body ?? "");
  if (
    status === 404 ||
    /model_not_found|model.{0,60}(not found|does not exist|decommissioned|no longer (available|supported))/i.test(text)
  )
    return "model";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return /per ?day|daily|\bTPD\b|\bRPD\b/i.test(text) ? "daily" : "rate";
  if (status === 402) return "daily"; // out of credit: same as out for the day
  if (status >= 500) return "down";
  return "config";
}

/* Workers AI throws instead of returning a status. 3036 is the exhausted
   daily allowance; 5035 is a model the account's plan can't use, which is
   as permanent as a retired one; 3040 (capacity) and the rest are
   transient. */
export function classifyThrown(e) {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  if (/\b3036\b|daily free allocation|neurons/i.test(text)) return "daily";
  if (/\b5035\b|not available on the workers \w+ plan|no such model|model.{0,40}(not found|does not exist)/i.test(text))
    return "model";
  return "down";
}

const bodyFor = (p, model, messages) => ({
  model,
  messages,
  [p.tokenField ?? "max_tokens"]: p.maxTokens ?? REPLY_TOKENS,
  temperature: TEMPERATURE,
  ...p.params,
});

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
    promise.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });

/* A provider's own "I declined" is cheaper and surer than any regex. */
function readReply(data) {
  const choice = data?.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === "content_filter") return { kind: "ok", text: "" };
  return { kind: "ok", text: choice?.message?.content ?? data?.response ?? "" };
}

async function call(p, model, messages, env, ms, fetchImpl) {
  try {
    if (p.binding) {
      /* No signal option on AI.run: the race gets the visitor their time
         back, though the call itself runs on (and still spends neurons). */
      const { model: _, ...input } = bodyFor(p, model, messages);
      return readReply(await withTimeout(env[p.binding].run(model, input), ms));
    }
    const res = await fetchImpl(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headersFor(p, env) },
      body: JSON.stringify(bodyFor(p, model, messages)),
      signal: AbortSignal.timeout(ms),
    });
    const body = await res.text();
    if (!res.ok) return { kind: classify(res.status, body), retryAfter: res.headers.get("retry-after") };
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      /* a 200 that isn't JSON counts as an empty reply */
    }
    return readReply(data);
  } catch (e) {
    return { kind: p.binding ? classifyThrown(e) : "down" };
  }
}

/* A 200 can still be a failure: empty, or the model stepping out of
   character to refuse or announce what it is. Those fall through to the
   next provider rather than reaching the visitor. Fuzzier "tone feels off"
   signals are deliberately not attempted — they'd misfire on real replies
   and walk the chain toward a canned line. */
const OFF_SCRIPT = [
  /\bas an ai (language )?(model|assistant)\b/i,
  /\bI(?:'|’)m (?:just |only )?(?:an? )?(?:ai|artificial intelligence|language model|ai assistant|chatbot)\b/i,
  /^(?:I(?:'|’)m sorry,? but|sorry,? but I|I apologi[sz]e)/i,
  /^I (?:can(?:'|’)?t|cannot|won(?:'|’)t|am unable to|(?:'|’)m (?:not able|unable) to) (?:help|assist|comply|provide|engage|continue|do that)/i,
];
export const inCharacter = (reply) => reply.length > 0 && !OFF_SCRIPT.some((re) => re.test(reply));

/* A bad key fails every provider using it, and an exhausted shared
   allowance (Workers AI) fails every model drawing on it, so those bench
   the whole host. Everything else is per model: Groq limits each model
   separately, and a model at capacity says nothing about its neighbours. */
const hostKey = (p) => `host:${p.host ?? p.id}`;
const hostWide = (p, kind) => kind === "auth" || (kind === "daily" && p.sharedQuota);

function bench(p, kind, retryAfter, now) {
  let ms = BENCH_MS[kind] ?? BENCH_MS.down;
  const seconds = Number(retryAfter);
  if (kind === "rate" && seconds > 0) ms = Math.min(seconds * 1000, 5 * 60 * 1000);
  benched.set(hostWide(p, kind) ? hostKey(p) : p.id, { until: now() + ms, why: kind });
}

const benchedNow = (p, now) => {
  for (const key of [p.id, hostKey(p)]) {
    const b = benched.get(key);
    if (b && b.until > now()) return b;
  }
  return null;
};

/**
 * Answer one visitor message. Resolves to { reply, provider, model, trail }
 * — provider and model are null when Simon fell back to a canned line, and
 * trail records every attempt in order, for logs.
 */
export async function answer(history, material, env, opts = {}) {
  const { providers = PROVIDERS, now = Date.now } = opts;
  const fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
  const messages = buildMessages(history, material);
  const lightUser = history.filter((m) => m.role === "user").length <= 2;
  const start = now();
  const trail = [];
  const failures = [];

  const live = providers.filter((p) => configured(p, env));
  /* re-checked each step: a failure here can bench a later provider (a bad
     Groq key benches both Groq links), and the reserve should move to
     whoever is actually still standing */
  const lastStanding = () => [...live].reverse().find((p) => !benchedNow(p, now));

  for (const p of live) {
    const b = benchedNow(p, now);
    if (b) {
      trail.push(`${p.id}:benched(${b.why})`);
      failures.push(b.why);
      continue;
    }
    const reserve = p === lastStanding() ? 0 : RESERVE_MS;
    const left = () => BUDGET_MS - (now() - start) - reserve;
    if (left() < MIN_ATTEMPT_MS) {
      /* not enough time for this one — but keep going: the reserve is
         still there for the last provider */
      trail.push(`${p.id}:no-time`);
      failures.push("budget");
      continue;
    }

    let model = await pickModel(p, env, fetchImpl, now, { within: left() });
    let kind = "budget";
    for (let tries = 0; tries < 2; tries++) {
      if (left() < MIN_ATTEMPT_MS) break;
      const r = await call(p, model, messages, env, Math.min(p.timeoutMs ?? ATTEMPT_MS, left()), fetchImpl);
      if (r.kind === "ok") {
        const reply = cleanReply(r.text);
        if (inCharacter(reply)) {
          benched.delete(p.id);
          benched.delete(hostKey(p));
          trail.push(`${p.id}:ok`);
          return { reply, provider: p.id, model, trail };
        }
        kind = "off-script"; // one declined prompt isn't a broken provider: no bench
        break;
      }
      /* Retired model: ask the provider what it serves now and go again. */
      if (r.kind === "model" && tries === 0 && p.family) {
        const fresh = await pickModel(p, env, fetchImpl, now, { force: true, avoid: model, within: left() });
        if (fresh && fresh !== model) {
          trail.push(`${p.id}:${model} gone, now ${fresh}`);
          model = fresh;
          continue;
        }
      }
      kind = r.kind;
      bench(p, r.kind, r.retryAfter, now);
      break;
    }
    trail.push(`${p.id}:${kind}`);
    failures.push(kind);
  }

  /* Everyone failed. Rate limits get the "I ran out of words" lines; the
     daily variant only if every limit hit was a daily one. */
  const limits = failures.filter((k) => k === "rate" || k === "daily");
  const reply = limits.length
    ? cannedLimitReply(limits.every((k) => k === "daily"), lightUser)
    : cannedBusyReply();
  return { reply, provider: null, model: null, trail };
}

/**
 * What each provider looks like right now, without spending a token: is
 * the key accepted, and is a model in the family being served. ok is true
 * only when every provider that can be checked passes, so an uptime monitor
 * pointed here hears about one broken link before the chain runs out —
 * the check that would have caught the retired-model outage.
 */
export async function health(env, opts = {}) {
  const { providers = PROVIDERS, now = Date.now } = opts;
  const fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
  const report = [];
  for (const p of providers) {
    const row = { id: p.id, configured: configured(p, env) };
    if (!row.configured) {
      report.push(row);
      continue;
    }
    row.benched = benchedNow(p, now)?.why ?? null;
    const pin = pinnedBy(p, env);
    if (pin) row.pinned = pin;
    if (p.binding) {
      /* The catalog is free to read, so whether the model exists (and is
         on this plan) is checked. Running it isn't: every probe would
         spend free neurons, and a monitor polling this would eat a real
         share of the daily allowance. */
      row.note = "model checked in the catalog; not run";
    }
    try {
      const { status, list, body } = await listModels(p, env, fetchImpl, LIST_MS);
      if (list) {
        const want = pin ?? (p.family ? newestInFamily(list, p) : p.model);
        /* listed isn't enough: a retired or paid-only model is listed too */
        row.model = want && list.some((m) => m.id === want && m.active !== false) ? want : null;
        row.ok = Boolean(row.model);
        if (!row.ok) row.problem = pin || !p.family ? `${want} is not usable` : "nothing in the model family is usable";
      } else {
        row.ok = false;
        row.problem = `${classify(status, body)} (HTTP ${status})`;
      }
    } catch {
      row.ok = false;
      row.problem = "unreachable";
    }
    report.push(row);
  }
  const used = report.filter((r) => r.configured);
  const ok = used.length > 0 && used.every((r) => r.ok !== false);
  return { ok, providers: report };
}
