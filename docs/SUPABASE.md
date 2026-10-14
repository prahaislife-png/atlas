# Supabase hosted candidate

Selected project: `https://pznsarkpjaykanxlmqix.supabase.co`. The actual project records migration `202610140001` and a private `atlas-evidence` bucket. On 14 October 2026, 31 live checks passed through the hosted handler and Supabase Auth/Postgres/Storage: password login, Secure/HttpOnly cookies, refresh/logout, cross-tenant RLS and forged organization rejection, direct write denial, viewer restrictions, and private/foreign/public object access. Three temporary admin-confirmed QA users, two clearly labelled QA organizations and one fixture object were removed afterward. No paid searches or customer observations were created. The migration was already recorded when checked; this setup did not apply it remotely.

## Apply the schema

Open the project's SQL Editor and apply `supabase/migrations/202610140001_tenant_foundations.sql` once. The migration is transactional and records version `202610140001`. It creates only ATLAS application tables/functions and the private `atlas-evidence` bucket/policy; it relies on Supabase's existing Auth and Storage schemas. It revokes public schema creation from untrusted roles. Review existing bucket policies before release because unrelated permissive policies can widen access.

For automatic setup, securely configure an operator `SUPABASE_ACCESS_TOKEN` for `api.supabase.com`, then run `npm run apply:supabase`. Project API keys cannot execute schema changes. The command applies only the checked-in initial migration, confirms its recorded version, skips an already applied version and refuses an unknown history. It does not log upstream response bodies or credentials. This token is for operator setup only; the web runtime does not use it. Manual SQL Editor setup remains available without an account access token.

For future changes, add a new versioned migration; do not rerun/edit an already applied migration. This initial migration was tested on isolated Postgres 17 with test-only implementations of Supabase's Auth/Storage schema interfaces. Real Auth, Storage and project policy behavior still need live verification.

## Secure configuration

Configure these in both the Codex cloud environment (for real-service validation) and Vercel (for runtime). The two platforms do not synchronize settings.

| Name | Setting |
| --- | --- |
| `SUPABASE_URL` | `https://pznsarkpjaykanxlmqix.supabase.co` |
| `SUPABASE_ANON_KEY` | Fresh publishable key (`sb_publishable_…`); secure settings only |
| `SUPABASE_SERVICE_ROLE_KEY` | Fresh secret key (`sb_secret_…`); server only, secure settings only |
| `SUPABASE_KEY_MODE` | `modern` for the publishable/secret pair |
| `ATLAS_APP_URL` | Exact final HTTPS application origin assigned by Vercel/custom domain |
| `ATLAS_OPENAI_API_KEY` | A replacement OpenAI key entered securely; cloud supports this alias |
| `OPENAI_MODEL` | `gpt-4.1-mini`, the model covered by the reservation policy |

The key field names retain compatibility with the existing secure settings form: put the publishable key in `SUPABASE_ANON_KEY` and the private secret key in `SUPABASE_SERVICE_ROLE_KEY`, with `SUPABASE_KEY_MODE=modern`. Canonical `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` names are also accepted and select modern mode by default. Never configure two different pairs at once. Legacy anon/service-role JWTs still work with explicit `SUPABASE_KEY_MODE=legacy`. Keys are never returned by an ATLAS endpoint. Do not use browser/public prefixes for the private key.

Modern keys are carried in the `apikey` header. A real user's JWT is sent as Authorization for their RLS-scoped requests; a modern API key is never substituted for that user JWT. Explicit mode works with opaque proxy-injected credentials. This header contract has local tests and was checked against the official Supabase JavaScript SDK source (2.117.3); actual new-key access remains unverified until secure bindings are configured.

The service-role JWT and modern secret key shared in chat/screenshots are exposed. Revoke/replace the modern secret. Disable the exposed legacy keys or follow Supabase's JWT-secret rotation procedure so the old privileged JWT is unusable; creating a new modern key alone does not revoke it. Keep replacement values in the secure settings fields.

For the initial controlled pilot, provision verified password accounts through Supabase's admin dashboard. Public signup, invitation callback processing and password recovery are not provided by ATLAS. Account provisioning/reset remains an operator task using Supabase's supported tools. Never paste passwords or service credentials into chat. Do not disable email confirmation to make login pass.

## Runtime and ownership

`api/index.js` routes to the hosted handler. Every protected request asks the project's Auth service to verify the session and confirmation state. Tokens are sent only as Secure HttpOnly cookies, with same-origin checks on all mutations. The handler obtains the actor ID from the verified user, checks the selected organization's membership and uses the user JWT for RLS reads. A viewer can inspect/export but cannot change research, roles or queued work.

Private mutation RPCs require the server service credential **and** an actor who is an owner/editor of the selected organization. Membership changes/deletion require an owner; the last owner cannot be removed. Browser JWTs have no direct mutation permission on research tables or worker functions. Organization creation derives its owner from `auth.uid()` and constructs a canonical empty workspace in SQL; client-supplied initial metrics are ignored. Verified users may create at most three active organizations.

Postgres serializes revisions and persists quota reservations. New runs and their question jobs are committed together. Workers claim individual jobs with a lease; a second instance cannot claim the same active job. Raw data is written once to `atlas-evidence/<org>/<run>/<observation>.json` before an observation is accepted. A failed storage write cannot produce a measured observation. Expired leases become visible failures without another paid request. Queued work advances while a permitted browser is open and resumes after reopening; there is no periodic unattended worker.

Changing the active research brief archives its prior state. Hosted exports for prior versions are available through History; local JSON behavior remains unchanged. All organization members share access to its project/history; granular per-project permissions within an organization are not implemented.

## Operator and owner endpoints

- `GET /api/auth/session`: own verified user and organizations.
- `POST /api/organizations`: create an empty organization.
- `POST /api/organizations/select`: select only an organization the actor belongs to.
- `GET/POST /api/organizations/members`: owner-only roster and role changes for existing verified user IDs; POST `{userId,role}`, with `role:null` to remove. Account IDs come from the operator's verified user records; there is no global user-search endpoint.
- `GET /api/project-versions` and `GET /api/project-versions/:id/export`: own organization history.
- `POST /api/worker/tick`: process one permitted queued/expired question.
- `DELETE /api/organizations/current` with `{confirm:"DELETE"}`: owner-requested audited deletion.

Mutations require the exact configured Origin and JSON content type. Raw object paths are never accepted as authorization. Owner/editor/viewer and raw export checks have local HTTP and real Postgres tests.

## Local reproduction and remote validation

```sh
npm run check
npm run test:db
npm run test:browser
npm run test:hosted-browser
npm run apply:supabase       # Operator action; requires a secure account access token
npm run verify:supabase      # Read-only project/schema/bucket probe
```

The database command starts an isolated Docker container with no published port/network, applies the migration and runs RLS, forbidden writes, owner rules, immutable history, durable job, audited deletion and real dump/restore checks. Docker removes the test container afterward; no production credentials are used. Python Playwright and Chromium are needed for browser checks.

The schema/private-bucket probe and actual login/session/two-tenant/private-object checks have passed for this project. Recheck after credential or policy changes. The cloud machine requires `NODE_USE_ENV_PROXY=1` for Node HTTPS requests through its supported proxy; the currently injected pair was verified with `SUPABASE_KEY_MODE=legacy`. Fresh publishable/secret credentials use modern mode. These cloud bindings do not transfer automatically to Vercel. `npm run vercel-build` checks the configured schema, private bucket, Auth connection, budget settings and read-only OpenAI model access before publishing. After deployment, verify the exact HTTPS origin, session cookies, rewrites and headers on Vercel. A deliberately reviewed paid observation and managed backup/restore checks remain outstanding; no full production-readiness claim follows from the build probe.
