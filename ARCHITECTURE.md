# ATLAS | Architecture and transition to SaaS

## Implemented local architecture

`browser → Node HTTP server → local JSON state`, with optional `server → OpenAI Responses API (web_search)`.

- `server.js`: local-only HTTP handlers, state writes, response collection.
- `src/analyze.js`: response parsing, citation normalization, deterministic name matching and summary metrics.
- `public`: fast, dependency-free UI. Samples are clearly labeled.
- `.runtime/state.json`: local dev persistence, deliberately excluded from Git.

The API key only lives in `.env` on the server. This implementation binds to loopback and is not suitable for public deployment.

## V1 production system recommendation

- Web: Next.js, TypeScript, Tailwind + accessible component primitives. Preserve distinctive current UI direction.
- Database: managed Postgres (e.g. Supabase), migrations, schema constraints, backups.
- Auth: verified users, organizations, memberships and role-checked service endpoints.
- Row isolation: Postgres Row-Level Security with documented tests, never rely solely on a `workspace_id` passed from browser.
- Workers: durable job queue for scans and parsing, idempotent run IDs, concurrency/usage caps, retries with exponential backoff and explicit partial failures.
- Providers: versioned adapters for authorized OpenAI API search and separately licensed providers; tests against fixtures for each.
- Storage: immutable raw-result snapshots in object storage with scoped access and retention policy.
- Audit logging: user approvals, edits, source versions, provider/method changes.
- Monitoring: errors, spend per client, collection success %, parsing accuracy, retention, job queue status.

## Minimal entity model

```
organizations(id, name, plan)
users(id, auth_subject)
organization_memberships(org_id, user_id, role)
projects(id, org_id, legal_brand, aliases, domain, city, country, language)
competitors(id, project_id, canonical_name, known_domains)
prompts(id, project_id, text, language, location_context, intent, version, active)
scan_jobs(id, project_id, started_at, finished_at, status, provider, cost_estimate)
observations(id, scan_job_id, prompt_id, provider, model, method, observed_at, location_json, raw_ref, answer_text, sample)
citations(id, observation_id, url, host, title, position_if_observable)
mentions(id, observation_id, entity_id, detection_method, confidence, reviewed_by)
actions(id, project_id, category, proposed_change, evidence_json, status, approved_by, implemented_at)
outcomes(id, project_id, source, event_type, occurred_at, value, currency, attribution_notes)
```

All history retains project and prompt versions. Do not wipe real client history once multi-tenancy is built. The current starter resets local state on a project identity change to avoid cross-client contamination, which is appropriate only for the single-workspace prototype.

## Metrics

- **Mention rate:** number of eligible observed responses containing target brand / number of eligible observations. Show numerator, denominator, date range, prompt cohort and method.
- **Citation rate:** number of responses citing verified owned-domain URLs / eligible observations.
- **Competitor coverage:** per-competitor brand detection in the same cohort.
- **Weighted prominence:** optional experiment only with an explicit, auditable rubric. Never invent an organic position if the answer is unranked.
- **Change analysis:** compare matched prompts + methods + location + engines + window and report sample sizes. Uncertainty and model drift must be mentioned.
- **Business outcome:** bookings or enquiries from customer-connected systems. Never imply causality from timing alone.

## Endpoint and worker concerns

Validate hostnames and URLs; prevent SSRF in future site auditing (private network/loopback/metadata/redirect checks). Validate API provider rate limits and per-client spending. Avoid storing raw personal conversations. Keep retention configurable, access logged, and external providers in privacy notice.

## Launch security gate

No internet hosting until at least: auth, scoped authorization, RLS test coverage, CSRF/origin protection for cookie-based auth, validation and abuse limits, secret management, billing webhook verification, backup/restore test, access logs, deletion/retention path and documented incident procedure.

## Hosted candidate implementation update

A Supabase/Vercel candidate now exists in `src/hosted`, `api/index.js` and `supabase/migrations`. It preserves the vanilla UI and Node stack while introducing verified Auth-service requests, HttpOnly sessions, organization roles/RLS, server-only mutation RPCs, a versioned JSONB research aggregate, immutable private raw snapshots, durable leased question jobs, archives, audit and retention paths. `docs/SUPABASE.md` documents ownership and differences from the normalized long-term recommendation above.

Local JSON development remains supported independently. Hosted runtime does not use local JSON; external service configuration and live authorization/storage/backup checks are still required before public release. The release guard intentionally remains enabled. Local tests are not a claim of real cloud readiness.
