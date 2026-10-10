/**
 * Every provider Simon can speak through, in the order they are tried.
 *
 * A provider is only used when it is configured — its secret is present, or
 * for Workers AI its binding — so keys can be added one at a time with
 * `npx wrangler secret put <NAME>` in worker/ (and a line in .env.local for
 * dev), with no code change.
 *
 * `family` pins the line of models known to hold Simon's voice. The newest
 * active model matching it is picked at runtime from the provider's own
 * model list, so a retirement or a new release needs no edit here. Setting
 * `<ID>_MODEL` (e.g. GROQ_MODEL, CFAI_MISTRAL_MODEL) as a secret or var pins
 * one by hand instead. `model` is only the fallback when the list can't be
 * read — and the only option for Workers AI, which has no list.
 *
 * ORDER IS VOICE FIRST. Every model here was tested against the real
 * persona before going in. Most free models are heavily aligned and answer
 * with a polite, sanitized Simon — an HTTP 200 nobody would notice was a
 * failure — so they were left out. Results (Oct 2026, 4 hostile/identity
 * prompts each):
 *   qwen3.8 on Groq / on Workers AI   in character 4/4, swears   (the voice)
 *   mistral-small-3.1 on Workers AI   in character 4/4, swears
 *   gpt-oss-120b on Groq              in character 4/4, no swearing (tamer)
 *   llama-3.3-70b on Workers AI       4/4 but generic; redundant with mistral
 *   deepseek-v4, kimi-k2.6            not on the Workers Free plan
 *   glm-5.3                           reasoning can't be turned off
 *
 * `host` groups providers that share a key or an allowance: a bad Groq key
 * benches both Groq links at once, and so does Workers AI running out of
 * its daily allowance (`sharedQuota`). Everything else is per model —
 * Groq rate-limits each model separately, which is why its second model is
 * real extra capacity rather than a duplicate.
 */

/* Dense, size-suffixed Qwen releases only: qwen3.8-27b, a future qwen4-32b.
   Deliberately not /^qwen\/qwen/, which on a billed host matches the
   "max-prime" variant at ~9x the price and would win by being newest. */
const QWEN_DENSE = /^qwen\/qwen\d+(\.\d+)?-\d+b$/i;

export const PROVIDERS = [
  {
    id: "groq", // free, ~200ms — the voice
    host: "groq",
    secret: "GROQ_API_KEY",
    base: "https://api.groq.com/openai/v1",
    family: QWEN_DENSE,
    model: "qwen/qwen3.8-27b",
    timeoutMs: 4000,
    /* Qwen reasons by default and spends the token budget deliberating about
       how to be rude instead of being rude. Banter needs vibes. */
    params: { reasoning_effort: "none" },
  },
  {
    id: "cfai", // free, no key — same voice on a different host
    host: "cfai",
    sharedQuota: true, // 10k neurons/day across every Workers AI model
    binding: "AI",
    model: "@cf/qwen/qwen3.8-27b",
    /* measured 1-28s, median ~2s: worth waiting for briefly, not for long */
    timeoutMs: 6000,
    tokenField: "max_completion_tokens",
    /* Workers AI has no reasoning_effort "none" (it defaults to xhigh, which
       eats the whole reply budget); this is its off switch. */
    params: { chat_template_kwargs: { enable_thinking: false } },
  },
  {
    id: "cfai-mistral", // free — a different model, for when Qwen itself has a bad day
    host: "cfai",
    sharedQuota: true,
    binding: "AI",
    model: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    timeoutMs: 5000, // measured 0.4-1.6s; no reasoning to switch off
  },
  {
    id: "groq-oss", // free, its own Groq quota — tamer, but still Simon
    host: "groq",
    secret: "GROQ_API_KEY",
    base: "https://api.groq.com/openai/v1",
    family: /^openai\/gpt-oss-\d+b$/i, // 120b over 20b; never the -safeguard model
    model: "openai/gpt-oss-120b",
    timeoutMs: 4000,
    /* it can't switch reasoning off, only down — and that reasoning counts
       against the token cap, so this one gets a bigger cap */
    maxTokens: 600,
    tokenField: "max_completion_tokens",
    params: { reasoning_effort: "low" },
  },

  // Paid backstop — off for now. To turn it on: uncomment this entry, then
  // `npx wrangler secret put OPENROUTER_API_KEY` (prepaid credits, auto
  // top-up off). Same Qwen voice at ~$0.0002 a reply, from up to 17 hosts.
  //
  // {
  //   id: "openrouter",
  //   host: "openrouter",
  //   secret: "OPENROUTER_API_KEY",
  //   base: "https://openrouter.ai/api/v1",
  //   family: QWEN_DENSE,
  //   model: "qwen/qwen3.8-27b",
  //   timeoutMs: 6000,
  //   headers: { "HTTP-Referer": "https://smartestass.com", "X-Title": "Simon" },
  //   params: {
  //     // Thinks by default here too (xhigh), and "none" isn't among its
  //     // supported efforts — `enabled: false` is the off switch it accepts.
  //     // Checked against OpenRouter's model data, not yet tested live.
  //     reasoning: { enabled: false },
  //     provider: {
  //       // Cloudflare is one of its upstreams — skip it, or this link can
  //       // route straight back to the host that just failed above.
  //       ignore: ["cloudflare"],
  //       // everything but fp4, which flattens the voice
  //       quantizations: ["fp16", "bf16", "fp8", "unknown"],
  //     },
  //   },
  // },
];
