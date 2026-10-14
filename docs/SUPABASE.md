# Supabase hosted candidate

Selected project: `https://pznsarkpjaykanxlmqix.supabase.co`. HTTPS reachability was observed (401 without credentials). No project data, schema or Auth account has been changed remotely during this work.

## Apply the schema

Open the project's SQL Editor and apply `supabase/migrations/202610140001_tenant_foundations.sql` once. The migration is transactional and records version `202610140001`. It creates only ATLAS application tables/functions and the private `atlas-evidence` bucket/policy; it relies on Supabase's existing Auth and Storage schemas. It revokes public schema creation from untrusted roles. Review existing bucket policies before release because unrelated permissive policies can widen access.

For future changes, add a new versioned migration; do not rerun/edit an already applied migration. This initial migration was tested on isolated Postgres 17 with test-only implementations of Supabase's Auth/Storage schema interfaces. Real Auth, Storage and project policy behavior still need live verification.

## Secure configuration

Configure these in both the Codex cloud environment (for real-service validation) and Vercel (for runtime). The two platforms do not synchronize settings.

| Name | Setting |
| --- | --- |
| `SUPABASE_URL` | `https://pznsarkpjaykanxlmqix.supabase.co` |
| `SUPABASE_ANON_KEY` | Project's legacy `anon` JWT key; secure settings only |
| `SUPABASE_SERVICE_ROLE_KEY` | Project's legacy `service_role` JWT key; server only, secure settings only |
| `ATLAS_APP_URL` | Exact final HTTPS application origin assigned by Vercel/custom domain |
| `ATLAS_OPENAI_API_KEY` | A replacement OpenAI key entered securely; cloud supports this alias |
| `OPENAI_MODEL` | `gpt-4.1-mini`, the model covered by the reservation policy |

The Supabase keys are available under the project's API keys settings (legacy `anon` / `service_role` JWT keys). They are never returned by an ATLAS endpoint. Do not use browser/public environment-variable prefixes. New `sb_*` API key formats are not claimed verified by this implementation; use the documented JWT keys until separately tested.

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
npm run verify:supabase
```

The database command starts an isolated Docker container with no published port/network, applies the migration and runs RLS, forbidden writes, owner rules, immutable history, durable job, audited deletion and real dump/restore checks. Docker removes the test container afterward; no production credentials are used. Python Playwright and Chromium are needed for browser checks.

After applying the actual migration and configuring secure settings, the read-only probe must confirm the schema version and private bucket. Before releasing, verify two actual user accounts in separate organizations: login/refresh/logout, cross-organization ID forgery, forbidden exports/mutations and private object access; then authorize a small paid OpenAI observation and inspect raw provenance. Set the exact Vercel origin and verify worker duration/headers on the target. Until these checks pass, keep the build guard enabled and do not deploy publicly.
