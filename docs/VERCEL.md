# Vercel hosted candidate

Target repository: `prahaislife-png/atlas`. The user-selected team is `govinds-projects-12315c65`; project name requested: `atlas`. A repository import URL does not give this machine Vercel account access.

## Implemented

- `api/index.js` is the hosted Node entry point. `vercel.json` routes `/api/*` through it, serves `public/`, sets security/cache headers and declares a 120-second function duration.
- The hosted handler uses Supabase Auth, organization membership checks, Postgres/RLS, private evidence objects and durable per-question jobs. It does not call `createStore` or write customer data to the Vercel filesystem.
- `server.js` remains a separate loopback/local JSON development entry point. It refuses `VERCEL` and production startup. Removing that check or using `/tmp` is not a hosted migration.
- `.vercelignore` excludes environment files, local runtime state and logs from CLI deployment uploads.
- The build guard deliberately refuses release until the actual Supabase project and deployment configuration are verified. It has not been removed merely because fixture tests pass.

## Steps still needed before a public release

1. Revoke the OpenAI key pasted into chat and create a replacement. It was not copied into application code, files, commands or tests.
2. Apply `supabase/migrations/202610140001_tenant_foundations.sql` to the selected project through its SQL Editor. See `docs/SUPABASE.md`.
3. Configure secure server variables: `SUPABASE_URL`, legacy JWT `SUPABASE_ANON_KEY`, legacy JWT `SUPABASE_SERVICE_ROLE_KEY`, replacement `ATLAS_OPENAI_API_KEY` (or `OPENAI_API_KEY` on Vercel), and exact HTTPS `ATLAS_APP_URL`. Codex cloud and Vercel settings are separate; configure both when this machine must validate the live service. Never use browser/public variable prefixes for a secret.
4. Provision verified pilot password accounts through Supabase's admin tools. Public signup, invitation callbacks and password-recovery callbacks are not implemented. Do not disable verification to bypass login checks.
5. Establish Vercel project/account access. CLI 64.0.2 was installed and reports logged out. Use the supported login flow or a securely injected scoped `VERCEL_TOKEN`; do not paste it into chat. In this cloud machine the CLI global configuration lives outside the checkout at `/workspace/.vercel-auth`. The existing web browser's Vercel login is not automatically shared with the CLI.
6. Confirm source is committed/pushed to the chosen branch, and select that exact commit. Verify the assigned domain rather than guessing a `.vercel.app` name. Set it as `ATLAS_APP_URL`; ensure the actual plan supports the configured function duration. Creating/importing the project may currently show the deliberate build-gate error.
7. Run local suites and the real-service probe, then actual login/refresh/logout, two-user/two-organization forbidden-access checks, private object access and a deliberately authorized small paid observation. Verify target routing/security headers and managed backup/restore. Complete `docs/SECURITY.md` before lifting the guard and deploying.

## Commands

```sh
npm run check
npm run test:browser
npm run test:hosted-browser
npm run test:db
npm run verify:supabase
```

The first four commands are repeatable local checks. The last requires actual secure settings and an applied schema; it verifies migration version and bucket privacy, not complete production readiness. `npm run vercel-build` currently exits 1 intentionally and lists pending live/release checks.

For the cloud CLI, use a writable global configuration/cache, for example:

```sh
XDG_CACHE_HOME=/workspace/.cache npm_config_cache=/workspace/.cache/npm npm exec --yes --package=vercel@64.0.2 -- vercel whoami --global-config /workspace/.vercel-auth
```

A logged-out result is not permission to use a temporary public deployment. No public deployment or claim link was created. Use the user's specified team after supported account authorization. Publishing the Codex development snapshot is a separate operation from deploying the SaaS.

## Verified scope

Local Node/HTTP tests, browser fixtures and real isolated Postgres migration/RLS/backup-restore checks pass. The Supabase URL responds to HTTPS with 401 without a key. Actual Supabase credentials, migration state, Auth sessions, storage operations, managed restore and Vercel runtime behavior remain unverified until their prerequisites are supplied. Durable jobs currently progress while an authorized workspace browser is open, with restart recovery; there is no unattended scheduler.
