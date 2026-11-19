# Repository Guidelines

GitDex is a public software demand & solution network (see `docs/GitDex_PRD.md`). Backend on Supabase, pages on Cloudflare Workers. No server-side LLM, ever.

## Layout

- `supabase/migrations/` — Postgres schema.
- `supabase/functions/_shared/` — all business logic. Runtime-agnostic TypeScript: no Deno or Node APIs, relative imports with `.ts` extensions, erasable syntax only (no enums, namespaces or parameter properties) so Node can run it directly in tests.
- `supabase/functions/api/index.ts` — the only Deno-specific file.
- `web/src/` — Cloudflare Worker (Hono + JSX SSR). `web/client/` — browser script bundled by esbuild.
- `tests/` — Node test runner against PGlite.

## Commands

- `npm test` — behavior tests. Run before every hand-off.
- `npm run typecheck` — shared code, tests, worker and client.
- `npm run dev` — local worker on `127.0.0.1:8787`.
- `npm run deploy:api`, `npm run deploy:web`, `npm run db:push` — deploys.

## Rules that must hold

- Add or change an operation in `_shared/operations.ts` only; REST, MCP and OpenAPI derive from it. Never add a rule to only one adapter.
- Every tool description states: when to use, what is needed, side effects, who may call, whether confirmation is required, how to recover (PRD 7.1).
- Authorization, confirmation, idempotency and state transitions are enforced in the services. A prompt or tool description is never the only guard.
- Publishing writes are two-step: without `confirmed` the service returns `CONFIRMATION_REQUIRED` with the exact public preview and writes nothing.
- A proposal never changes a request to `resolved`. Only the original requester's `accepted` verdict does.
- A submitter can never set evidence to `tested`.
- SQL: params are string/number/boolean/null, always cast (`$1::text`); arrays and objects travel as JSON text (`$1::text::jsonb`); read rows through `rows()` so postgres.js and PGlite behave the same.
- New tables: enable RLS and grant nothing to `anon`/`authenticated`.
- User-submitted text is rendered as text only (JSX escaping on the server, `textContent` in the browser). Outbound links are `https` only with `rel="nofollow ugc noopener noreferrer"`.
- Interface strings go in `web/src/i18n.ts` in both `en` and `zh`.
- Record text is bilingual (`_shared/languages.ts`): a record has one `language` and the other one in `translations`. A new free-text field on software, requests or proposals goes in `TRANSLATABLE`; pages show one version through `localize()`, never both.
- Images are submitter-supplied `https` URLs. The server never fetches them; pages load them with `referrerpolicy="no-referrer"`.
- Edits append, never overwrite (`_shared/revisions.ts`): an update saves the replaced version with `saveRevision` and bumps `version`. Only the author edits; a request freezes once it has a proposal, a proposal once it has a verdict. A new content field goes in `VERSIONED_FIELDS`.
- Moderation (`_shared/moderation.ts`) is for `is_admin` accounts in a browser session only: never an MCP tool, never reachable with an API token or OAuth client. Every action is audited and notifies the author.
- Analytics (GA4) loads only on gitdex.ai and never on `noindex` pages. Keep `web/src/legal.tsx` in sync when data handling changes.

## Tests

Changed business logic needs a test in `tests/` that goes through the HTTP app (`createHarness`). Cover the confirmation, unauthorized, duplicate and idempotent-retry cases for any new write.

## Secrets

Keep secrets in `.env` / `web/.dev.vars` (both ignored). Deployment-specific values (Supabase project, region, analytics ID, domains) live in `web/wrangler.jsonc`, which is ignored too; `web/wrangler.example.jsonc` is the tracked template, so a new worker variable goes in both. Never commit a project ref, account subdomain or other identifier of the live deployment.
