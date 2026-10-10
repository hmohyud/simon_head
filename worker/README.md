# simon-chat worker

Keeps every API key out of the public site, and keeps Simon talking when a
provider doesn't. Each message goes down a chain of providers until one
answers in character; if they all fail, Simon gives a canned in-character
line rather than an error.

| order | provider | model | cost | needs |
| --- | --- | --- | --- | --- |
| 1 | Groq | Qwen 3.8 | free | `GROQ_API_KEY` |
| 2 | Cloudflare Workers AI | Qwen 3.8 | free | nothing — the `[ai]` binding in `wrangler.toml` |
| 3 | Cloudflare Workers AI | Mistral Small 3.1 | free | nothing |
| 4 | Groq | gpt-oss-120b | free | the same `GROQ_API_KEY` |
| — | OpenRouter | Qwen 3.8 | paid, ~$0.0002 a reply | commented out in `providers.js` |

Two hosts, two models on each, so neither one host nor one model can take
Simon down. Groq rate-limits each model separately, so its second model is
real extra capacity; the two Workers AI models share one allowance (10,000
neurons a day on the Free plan, which simply stops — it can't bill).

Every model was tested against the real persona before going in, and the
order is voice first. Most other free models answer with a polite,
sanitized Simon; gpt-oss stays in character but won't swear, so it's last.
The table lives in `providers.js`; the logic in `chain.js`, which the Vite
dev proxy shares, so local testing exercises what ships.

To turn on the paid backstop: uncomment the OpenRouter entry in
`providers.js`, then add its key (below).

## Deploy

From this `worker/` directory (needs a free Cloudflare account):

```bash
npx wrangler login
npx wrangler deploy
```

## Adding or replacing a key

A provider switches on as soon as its secret exists — no code change, no
redeploy:

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

(`secret put` prompts for the value — paste it there.) Add the same line to
`.env.local` at the repo root so the dev site uses it too; a key that is only
in one place works in one place.

## When a model is retired

Usually nothing to do: the worker reads each provider's model list and uses
the newest release in the model's family that it serves. To pin one by hand
— or for Workers AI, which has no list to read — set `GROQ_MODEL`,
`CFAI_MODEL`, `CFAI_MISTRAL_MODEL` or `GROQ_OSS_MODEL` with
`wrangler secret put`; it takes effect in seconds.

## Is it healthy?

```
https://simon-chat.hmohyud.workers.dev/health
```

Answers `200` when every configured provider is usable and `503` the moment
one isn't — a bad key, or a model no longer served — naming which and why.
It spends no tokens, so point a free uptime monitor (UptimeRobot,
Better Stack) at it and you hear about a broken link before the chain runs
out. Workers AI is listed but not probed: each probe would spend its free
allowance.

Every reply also logs which provider answered and what failed on the way,
in `npx wrangler tail` and the Cloudflare dashboard.

## Local secrets

`npx wrangler dev` reads keys from `worker/.dev.vars`, which is gitignored.
