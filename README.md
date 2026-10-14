# ATLAS · Evidence-first AI discovery

ATLAS includes the tested Mission 1 local research workflow and a Supabase/Vercel hosted implementation. It preserves the forest-green/lime design and dependency-free Node/browser architecture. Actual Supabase Auth, tenant isolation and private storage have passed live checks. Vercel production deployment is configured at `https://atlas-gray-six.vercel.app`; operational readiness is tracked in [docs/SECURITY.md](docs/SECURITY.md).

For hosted setup, read [docs/SUPABASE.md](docs/SUPABASE.md), [docs/VERCEL.md](docs/VERCEL.md) and [docs/SECURITY.md](docs/SECURITY.md). The separate hosted entry point is `api/index.js`; it never uses local JSON storage. `npm run vercel-build` validates production configuration, the actual Supabase schema/Auth/private bucket and read-only OpenAI model access. It fails closed with an actionable error; it never runs a paid search. The local entry point still rejects hosted/production startup; use `npm run dev` for local research.

## Run locally

Requires Node.js 22+ (verified with 24.19.0). There are no runtime or npm dependencies to install.

```sh
cd /workspace/atlas
npm run check
npm run dev
```

The server binds to `127.0.0.1`, port 3000 by default. Use the local browser for development. No API key is needed for onboarding, reviewing the empty workspace, managing manual actions or tests.

To collect paid API observations, create a local `.env` from `.env.example`, enter `OPENAI_API_KEY` securely and restart the server. In cloud environment settings use the supported `ATLAS_OPENAI_API_KEY` secret binding instead; it takes precedence over `OPENAI_API_KEY`. Neither is accepted by a browser form or included in stored request evidence. Network access to `api.openai.com` is required. Codex authentication does not provide this API credential or credits.

## Implemented in Mission 1

- Three-step onboarding: business identity and locale → 8–15 unbranded buyer questions → editable review. It accepts 1–5 research languages and 2–5 competitors. Saving does not start a paid scan.
- Official-URL **human confirmation**, with timestamp and method. This is not proof of ownership, availability or website contents. No website fetch or crawl is performed.
- A real business starts with **no fixture evidence, metrics, recommendations or fabricated trends**. Empty rates display as unknown. Failed and unobserved questions explicitly show no data.
- Versioned OpenAI Responses API `web_search` adapter. It sends the reviewed question without injecting the target or competitor names, with approximate country/city/timezone and a language instruction. API results are not consumer ChatGPT results.
- Stable UUIDs for scan runs and observations. Runs retain project/question snapshots, requested model, provider/method/location/start/end time, per-question successes and failures, and reserved budget. Observations retain the actual returned model, analysis version, exact request body, complete response, original citation annotations, usage and completion time.
- Strict evidence eligibility: only completed responses with a completed search and nonempty answer become observations. A completed uncited answer remains honestly uncited. HTTP-success responses that fail validation are retained on failed run results and excluded from metrics. HTTP error bodies are discarded to protect credentials.
- Inspect full provenance and raw JSON in the Evidence lab; filter by run; export a complete run with its raw evidence as JSON, or measured observation summaries as CSV. Completed records have no update endpoint. This is API-level immutability, not tamper-proof local storage.
- Partial failures preserve successful questions immediately and identify each failed question separately. Invalid keys, access problems, rate limits, timeouts and unsupported responses have actionable errors. There are no automatic paid retries.
- Competitor name counts and discovery-gap cards link to exact supporting observations. Matches are deterministic, require identity review and do not establish ranking causes, market share or revenue. The manual action queue publishes nothing and enforces no production approval roles.
- Atomic local writes, serialized mutations, a single-writer runtime guard, in-flight scan/edit protection, persisted reservations and restart recovery for interrupted scans. Local Host/Origin checks, CSP, safe citation links and CSV formula escaping reduce local-browser risks; they are not authentication or tenant security.
- Keyboard forms, explicit loading/error/empty states, focus-managed drawers and responsive layouts.

## Limits and accounting

Limits are validated on the server at startup and cannot be raised through browser requests. Invalid settings fail closed.

| Server setting | Default | Constraint |
| --- | --- | --- |
| `ATLAS_DAILY_SPEND_CAP_USD` | `1` | Positive USD daily reservation limit |
| `ATLAS_MAX_RUNS_PER_DAY` | `5` | Positive whole number |
| `ATLAS_MAX_PROMPTS` | `15` | 8–15 monitored questions |
| `ATLAS_MAX_PROMPTS_PER_RUN` | `5` | 1–workspace question limit |
| `ATLAS_RESERVATION_PER_PROMPT_USD` | `0.05` | At least $0.05; rounded up to cents |
| `ATLAS_MAX_OUTPUT_TOKENS` | `1200` | 1–2000 |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Only this model is covered by the current pricing policy |

Each scan reserves its entire allowance **before** a provider request. Reservations remain counted after a failure, timeout or restart because provider charges may already have occurred. Quotas use UTC calendar days. Changing the business/cohort does not reset daily usage. Output tokens and tool calls are bounded (one hosted search call per request). A different model is rejected before collection until its reservation policy is reviewed.

The spend cap enforces conservative **local request reservations**, not a verified provider invoice limit. The $0.05 allowance is a conservative policy for the bounded mini-model request, not a live price quote. Provider prices/billing can change; configure provider-side project limits and reconcile actual usage separately. No actual charge or revenue is invented in the UI.

## Tests

```sh
npm run check          # Node syntax checks + unit and real local HTTP integration tests
npm run test:browser   # Isolated browser workflows; needs Python Playwright + Chromium
```

The browser suite is documented in [docs/QA.md](docs/QA.md). This cloud machine has Python Playwright 1.62.0 and system Chromium. Tests use temporary storage and controlled provider responses; fixtures never enter customer metrics. Live Supabase checks are documented in [docs/SUPABASE.md](docs/SUPABASE.md). No completed paid OpenAI search is claimed; read-only model access does not prove search results or billing availability.

Node tests cover reviewed onboarding, invalid profiles/URLs/questions, brand injection, evidence parsing, raw provenance, missing/invalid credentials, partial failures, secret sanitization, strict search eligibility, budget/run/prompt caps, concurrency, restart persistence, interrupted runs and legacy/corrupt state handling. Browser tests exercise the actual forms, empty workspace, scan states, evidence/competitor drilldowns, exports, keyboard drawers and small screens.

## Storage and ownership

`.runtime/state.json` belongs to the single local operator; it has no user or tenant authorization. It is ignored by Git and written with restrictive permissions. Back it up/export before changing the business or cohort: the review screen warns that the current evidence, runs and action list will be cleared. The workspace-wide usage ledger is retained. A second server using the same runtime directory refuses access so it cannot bypass quotas or overwrite evidence. Dead ownership entries are ignored; Linux boot/process-start identity supports restart and snapshot recovery. This guard does not turn local storage into a production database.

Legacy starter fixtures are archived under `.runtime/legacy-fixtures-*.json` and replaced with a clean first-run workspace. Legacy measured history without Mission 1 provenance is never silently rewritten: startup fails closed and preserves the original file for an explicit migration/export. Production history migration belongs to Mission 2.

## Supabase hosted foundations

- Real Auth-service verification on every protected request; only confirmed accounts are accepted. Access/refresh credentials are held in Secure, HttpOnly, SameSite cookies, not browser storage. Password sign-in, refresh and sign-out are implemented; account provisioning/password recovery remain operator-managed in Supabase.
- Organizations with owner/editor/viewer roles, membership checks on every request, database-enforced RLS, service-only mutation RPCs that independently check actor membership, and owner-only membership changes. A supplied organization ID cannot authorize access.
- Managed Postgres persistence with compare-and-swap revisions, immutable completed evidence, project snapshots archived before research changes, and historical raw-data exports. There is one active project per organization; all members share that organization's project permissions.
- Durable per-question jobs with leases and private immutable raw-result objects. Expired attempts are marked failed rather than repeating potentially billed requests. The browser advances one queued question per request while open; closed/interrupted sessions resume on reopening. There is no unattended scheduler yet.
- Database-backed request limits, per-organization quota reservations across instances, audit records, owner-requested deletion and an operator retention task. Deletion hides the organization immediately; raw objects/data become eligible for permanent deletion after 30 days. Pseudonymous audit records use a 90-day retention window.
- Vercel API routing and security headers. The configured function duration is 120 seconds; the actual account/plan must support this before release.

## Verification commands

```sh
npm run check                  # Unit + HTTP tests, including hosted authorization/queues
npm run test:browser           # Original local workflow
npm run test:hosted-browser    # Login/org/role UX using isolated Auth fixtures
npm run test:db                # Docker: real Postgres migration/RLS/jobs/roles/restore
npm run verify:supabase        # Read-only real-service probe; requires secure config
npm run apply:supabase         # Apply the checked-in SQL; requires an operator access token
```

The database suite uses checksum-pinned Postgres 17 with no published port. It supplies test-only Auth/Storage schema interfaces, then runs the actual migration, forbidden-access checks and a real pg_dump/restore. It does not claim to test a live Supabase Auth service. Hosted HTTP/browser tests use isolated fixtures. `verify:supabase` checks remote schema version and bucket privacy; it does not replace live login and cross-tenant tests.

## Deployment gate and remaining work

Vercel CLI is authenticated and linked to `govinds-projects-12315c65/atlas`. At the user's explicit request, the supplied credentials were stored as server-only, sensitive Production variables; no credential was written into source or local environment files. The supplied Supabase JWT pair uses `SUPABASE_KEY_MODE=legacy`. The live schema/Auth/tenant/storage checks passed, and the actual Vercel build verified schema/Auth/private storage and read-only OpenAI model access. Vercel reported a successful production deployment on 14 October 2026. The keys shared in chat still require rotation. Managed backup/restore, target HTTPS session/routing checks and a reviewed paid observation remain outstanding operational checks; deployment success does not establish full SaaS production readiness.

The implementation does not provide billing, public self-service account registration, a password-recovery callback, unattended scheduling, analytics attribution or website auditing. Provision verified password accounts through Supabase for the initial controlled pilot. Production account/privacy operations and the incident procedure are in `docs/SECURITY.md`. Hosted organization storage currently uses a versioned JSONB research aggregate, which should be paginated/normalized before large-history workloads. Local research still uses `.runtime/state.json`; local and hosted storage are separate workflows.

## Five-minute human QA

1. Start `npm run dev`. Confirm first launch shows business setup rather than sample salon metrics.
2. Enter a real business URL, country/city/languages, two competitors and eight unbranded customer questions. Confirm an invalid URL or a branded question is rejected. Review the brief, use both edit links and save.
3. Confirm the command center has unknown rates, zero observations and no invented opportunities. Evidence lab should show all eight questions as **NO DATA**.
4. Open the scan panel. Without a key it explains server-only configuration and disables collection. With an authorized key/network access, choose a small question set and review the reservation before collecting (this step incurs charges).
5. Inspect a run, its exact question outcomes, provider/model/method/location/time and raw answer/citations. Download its JSON. Failed questions must not lower the mention rate or fabricate an absent response. Check a competitor's supporting records, Escape/focus behavior and a narrow mobile layout. A live-provider failure is a failed check, not a successful measurement.

See [docs/PROVIDER_ADAPTER.md](docs/PROVIDER_ADAPTER.md) for the adapter contract and measurement limits, and the supplied product/architecture/task documents for later phases.

Supabase modern publishable/secret keys are supported with `SUPABASE_KEY_MODE=modern`; the existing secure fields `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` accept that pair. See `docs/SUPABASE.md` for aliases, legacy mode, exposed-key rotation and migration automation. Credential values from chat were not written into source, files or saved instructions.
