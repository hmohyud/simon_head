# simon-chat worker

Proxy that keeps the Groq API key out of the public site.

Deploy (from this `worker/` directory — needs a free Cloudflare account):

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROQ_API_KEY
```

(`secret put` prompts for the key — paste it there.)

`wrangler deploy` prints the worker URL, e.g.
`https://simon-chat.<your-subdomain>.workers.dev`. Put that URL in
`.env.production` at the repo root:

```
VITE_CHAT_URL=https://simon-chat.<your-subdomain>.workers.dev
```

then commit and push — the next Pages deploy picks it up and the chat
appears on the live site. (Until then the chat UI simply hides itself in
production; local dev uses a built-in proxy instead and needs only
`GROQ_API_KEY` in `.env.local`.)
