# GitDex

[![mcptry](https://mcptry.com/badge/ai.gitdex/gitdex)](https://mcptry.com/servers/ai.gitdex/gitdex)

AI-native software demand & solution network. People look for software from their own AI client; if nothing fits they publish the need as a request; creators find or build software and propose it; the requester decides whether it is solved.

Product spec: [docs/GitDex_PRD.md](docs/GitDex_PRD.md) ([中文](docs/GitDex_PRD.zh.md)). Principles: **AI Client First · Web Second · API Native · No Server-side LLM**.

## Architecture

```text
ChatGPT / Claude / Codex / any MCP client          Browser
              │                                       │
              ▼                                       ▼
   Cloudflare Worker (web/)  ── server-rendered directory pages, forms
     /mcp, /api/v1/*  ─────────── proxied ───────────┐
     /ai/*.md, /openapi.json, /llms.txt              │
                                                     ▼
                              Supabase Edge Function `api` (supabase/functions/api)
                                 REST adapter + MCP adapter
                                          │
                                 shared domain services (supabase/functions/_shared)
                                 auth · validation · idempotency · rate limits · audit
                                          │
                                 Supabase Postgres (supabase/migrations)   Supabase Auth
```

- **One operation registry** (`_shared/operations.ts`) defines every business operation once. The REST routes, the MCP tools and `/openapi.json` are generated from it, so they cannot drift.
- **All rules live on the server**, not in prompts: sign-in for writes, `confirmed: true` only after a server-generated preview, idempotency keys, duplicate detection, "a proposal never resolves a request", "only the original requester's acceptance resolves", "a proposer cannot accept their own proposal".
- **Tables are closed to PostgREST** (RLS on, no policies, grants revoked). Only the Edge Function touches data.
- **No LLM** is called anywhere.

| Path | What |
|---|---|
| `supabase/migrations/` | Schema (PRD §8) |
| `supabase/functions/_shared/` | Domain services, operation registry, REST + MCP adapters, OpenAPI, agent guide |
| `supabase/functions/api/` | Edge Function entry (postgres.js + Supabase Auth token check) |
| `web/src/` | Cloudflare Worker: Hono SSR pages, i18n (EN/中文), proxies |
| `web/client/` | Browser script: sign-in, forms with preview-then-confirm, account, OAuth consent |
| `tests/` | Behavior tests against real Postgres (PGlite) through the real HTTP app |

## Surfaces

| Surface | URL |
|---|---|
| MCP (Streamable HTTP, sign-in) | `/mcp` |
| MCP (read-only, anonymous) | `/mcp/public` |
| REST | `/api/v1/*` |
| OpenAPI | `/openapi.json` |
| Agent guide and workflows | `/ai/guide.md`, `/ai/{find,request,submit,solve,confirm}.md` |
| Web | `/`, `/software`, `/requests`, `/solutions/{id}`, `/users/{id}`, `/history/{type}/{id}`, `/connect`, `/account`, `/admin` |

Authentication for writes: a Supabase session (web), an OAuth access token issued by Supabase's OAuth 2.1 server (remote MCP clients), or a personal API token `gdx_…` created on `/account`.

## Develop

```bash
npm install
npm test            # behavior tests: REST, MCP, state machine, idempotency, auth, moderation
npm run typecheck
```

These two need no account, credentials, Docker or network: tests run the real migrations on in-process Postgres (PGlite) and call the same `createApp` handler the Edge Function serves.

`npm run dev` starts the worker at `http://127.0.0.1:8787`, but it proxies to a deployed API, so it needs a Supabase project of your own (see Deploy):

1. Copy `web/wrangler.example.jsonc` to `web/wrangler.jsonc` and fill in your project's URL, publishable key and region.
2. Create `web/.dev.vars` with `GITDEX_PROXY_SECRET=<same value as the function secret>`.

## Deploy

One Supabase project and one Cloudflare Worker. `web/wrangler.jsonc` and `.env` hold the values of your deployment and are not tracked; start from `web/wrangler.example.jsonc` and `.env.example`.

```bash
supabase link --project-ref <project-ref>
npm run db:push        # apply migrations
npm run deploy:api     # Edge Function
supabase config push   # auth settings from supabase/config.toml
npm run deploy:web     # Cloudflare Worker + static assets
```

Function secrets: `GITDEX_BASE_URL`, `GITDEX_PROXY_SECRET`. Worker secret: `GITDEX_PROXY_SECRET` (same value). See `.env.example`.

### One-time setup still done by hand

1. **OAuth server for MCP sign-in** — Supabase dashboard → Authentication → OAuth Server: enable, authorization path `/oauth/consent`, allow dynamic client registration. (`config push` from CLI 2.x does not sync this block.)
2. **GitHub / Google sign-in** — create the OAuth apps with callback `https://<project-ref>.supabase.co/auth/v1/callback`, put the credentials in `.env`, set `enabled = true` under `[auth.external.github]` / `[auth.external.google]`, run `supabase config push`, then set `AUTH_PROVIDERS` to `github,google` in `web/wrangler.jsonc` and redeploy.
3. **Email sign-in at scale** — configure custom SMTP in Supabase Auth; the built-in mailer is rate limited and only meant for testing.
4. **Custom domain** — put the zone on Cloudflare and attach the worker to it through `routes` in `web/wrangler.jsonc`. Add the domain to `site_url` / `additional_redirect_urls` in `supabase/config.toml`.

## Moderation

Records are published first and handled afterwards. Any signed-in user can report a record; moderators work through reports and new listings at `/admin`, where they can remove or restore records, clear images or history, and suspend accounts. Every action is audited and notifies the author.

Moderation works only for accounts with `profiles.is_admin = true` (set in SQL; there is no way to grant it through the API) and only from a signed-in browser session: never through MCP, an API token or an OAuth client.

## Not in V1

Email delivery of notifications (in-app only; the preference is stored), software claiming.

## Security and license

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). The code is released under the [MIT License](LICENSE); the GitDex name and logo are not covered by it.
