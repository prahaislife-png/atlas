# Vercel deployment

The authenticated CLI is linked to `govinds-projects-12315c65/atlas`, project ID `prj_52i3qwULaEnbfoyiZq6Ev7Vta2rO`, using Node 24.x and the Other framework. The repository is `prahaislife-png/atlas`. The project's assigned production origin is `https://atlas-govinds-projects-12315c65.vercel.app`.

## Implemented

- `api/index.js` is the hosted Node entry point. `vercel.json` routes `/api/*` through it, serves `public/`, sets security/cache headers and declares a 120-second function duration.
- The hosted handler uses Supabase Auth, organization membership checks, Postgres/RLS, private evidence objects and durable per-question jobs. It does not call `createStore` or write customer data to the Vercel filesystem.
- `server.js` remains a separate loopback/local JSON development entry point. It refuses `VERCEL` and production startup. Removing that check or using `/tmp` is not a hosted migration.
- `.vercelignore` excludes environment files, local runtime state and logs from CLI deployment uploads.
- The build performs read-only production configuration and service checks. It requires the expected Supabase migration, a private evidence bucket, a working Auth connection and OpenAI model access, without running a paid search. Missing/invalid settings stop deployment without logging credentials or upstream response bodies.

## Production configuration and verification

1. Revoke the OpenAI key pasted into chat and create a replacement. It was not copied into application code, files, commands or tests.
2. The actual Supabase project records migration `202610140001` and a private evidence bucket. Future schema changes need a new migration and operator access; do not rerun/edit the applied initial version. See `docs/SUPABASE.md`.
3. Non-secret Production settings are prepared through the CLI: `SUPABASE_URL=https://pznsarkpjaykanxlmqix.supabase.co`, `SUPABASE_KEY_MODE=modern`, `OPENAI_MODEL=gpt-4.1-mini`, and `ATLAS_APP_URL=https://atlas-govinds-projects-12315c65.vercel.app`. Enter three fresh Production secrets in Vercel: `SUPABASE_ANON_KEY` (publishable), `SUPABASE_SERVICE_ROLE_KEY` (private secret), and `ATLAS_OPENAI_API_KEY` (or `OPENAI_API_KEY`). Canonical Supabase aliases are supported; do not configure conflicting pairs. Cloud proxy-backed bindings cannot be copied into Vercel as raw values, and no Marketplace integration is installed for automatic synchronization. Never use browser/public variable prefixes for a private secret. Legacy JWT pairs require explicit legacy mode; do not reuse the privileged values exposed in chat.
4. Provision verified pilot password accounts through Supabase's admin tools. Public signup, invitation callbacks and password-recovery callbacks are not implemented. Do not disable verification to bypass login checks.
5. Vercel CLI 64.0.2 is authenticated as `prahaislife-png` and linked to the requested project. Its supported global configuration lives outside the checkout at `/workspace/.vercel-auth`. Recheck account access after environment restoration; do not paste tokens into chat.
6. Push the tested source and deploy that exact commit. The assigned domain above came from the actual project listing. If the production domain changes, update `ATLAS_APP_URL`. Vercel must accept the configured function duration for the actual plan.
7. Local suites and actual Supabase login/refresh/logout, two-tenant isolation, viewer restrictions and private object checks have passed. After deployment, verify target HTTPS sessions, routing and security headers. A deliberately reviewed paid observation and managed backup/PITR/restore drill remain outstanding operational checks in `docs/SECURITY.md`; passing the build does not establish full production readiness.

## Commands

```sh
npm run check
npm run test:browser
npm run test:hosted-browser
npm run test:db
npm run verify:supabase
```

The first four commands are repeatable local checks. The last requires actual secure settings and an applied schema; it verifies migration version and bucket privacy. `npm run vercel-build` validates production settings, budget/model limits, schema/private storage/Auth and read-only OpenAI model access. It exits 1 for missing or invalid configuration and never creates a paid observation.

For the cloud CLI, use a writable global configuration/cache, for example:

```sh
NO_UPDATE_NOTIFIER=1 XDG_CACHE_HOME=/workspace/.cache npm_config_cache=/workspace/.cache/npm npm exec --yes --package=vercel@64.0.2 -- vercel whoami --global-config /workspace/.vercel-auth
NO_UPDATE_NOTIFIER=1 XDG_CACHE_HOME=/workspace/.cache npm_config_cache=/workspace/.cache/npm npm exec --yes --package=vercel@64.0.2 -- vercel deploy --prod --yes --scope govinds-projects-12315c65 --global-config /workspace/.vercel-auth
```

A logged-out result is not permission to use a temporary public deployment. No public deployment or claim link was created. Use the user's specified team after supported account authorization. Publishing the Codex development snapshot is a separate operation from deploying the SaaS.

## Verified scope

Local Node/HTTP tests, browser fixtures and isolated Postgres migration/RLS/backup-restore checks pass. Live Supabase testing passed 31 checks covering Auth sessions, tenant isolation, forged organization rejection, viewer restrictions and private object access; all temporary users, organizations and objects were removed. The remaining deployment blocker is missing Production secrets in Vercel. No deployment from this implementation is claimed until the CLI returns success and target checks pass. Managed restore, paid-search behavior and target Vercel HTTPS behavior remain separate checks. Durable jobs progress while an authorized workspace browser is open, with restart recovery; there is no unattended scheduler or billing integration.
