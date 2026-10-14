# ATLAS | Copy-and-run Codex build missions

Each mission is deliberately scoped. Start Codex in this repository, paste a single mission, inspect the diff, run tests, commit, then continue. The instructions in AGENTS.md take priority.

## First prompt to paste in Codex today

```text
You are ATLAS's founding product engineer. First read AGENTS.md, README.md, PRODUCT_SPEC.md, ARCHITECTURE.md and GO_TO_MARKET.md. Inspect the whole repo and run npm run check. Then implement Mission 1 below only. Keep sample observations visually and mathematically separate from real API data. Preserve the existing visual language instead of replacing it with a generic dashboard. Add tests and end with: files changed, tests run, known limitations, and a 5-minute human QA script. Do not deploy or claim consumer-ChatGPT scraping.
```

## Mission 1: Turn the starter into a reliable research instrument

```text
MISSION 1 — Evidence quality + onboarding. Build a professional first-run onboarding screen that accepts brand, verified URL, country, city, language(s), 2-5 competitors and 8-15 unbranded buyer questions. Let users review and edit everything before the first scan. Add an immutable scan-run identifier, provider/model/method/timestamp/location metadata for every observation, with clean empty/loading/error/partial-failure states. Refactor the scan into an adapter with a documented interface; for now only implement the documented OpenAI Responses API web_search adapter. Preserve raw response and citation annotations. Add server-side daily spend caps and max prompts/runs per workspace. Do not treat the API output as the consumer ChatGPT UI. Explicitly mark prompts that have no data. Add unit/integration tests and ensure npm run check passes.
ACCEPTANCE: a brand-new real business has no inherited sample metrics; scan results can be inspected and exported by run; partial failures are visible; user cannot exceed a configurable spend cap; invalid API key produces useful error.
```

## Mission 2: Safely make the product multi-client

```text
MISSION 2 — Hosted SaaS foundations. Migrate storage from the local JSON file to managed Postgres/Supabase using versioned migrations. Add users, organizations, role-based project memberships, real login, organization-scoped data access, Postgres RLS, audited deletes, durable scan jobs and storage for raw results. Implement tenant-isolation tests proving user A cannot read/modify B. Provide local docker/dev instructions. Do not ship to the public until authorization and security checklist are complete. Preserve historical prompt/project versions instead of wiping production evidence.
ACCEPTANCE: two organizations operate independently; no client-supplied org ID can bypass access controls; secrets stay server-side; tests cover forbidden access and migrations.
```

## Mission 3: Build the advantage Otterly-like dashboards lack

```text
MISSION 3 — Evidence-backed Opportunity Engine. Given a prompt cohort and observed answers, detect which relevant competitors are cited/mentioned and which user-approved services appear missing from the business's public pages. Show EXACT observed records supporting each finding. Produce hypotheses only, with confidence and verification checklist. Add a change ledger: proposed, owner-reviewed, published, retested, observed. Add comparison windows matching prompt/engine/locale/method and indicate inadequate sample size. Do not claim to reverse engineer ranking weights or give unmeasured search volumes.
ACCEPTANCE: every finding links to evidence or clearly states it is inferred; sample size visible; no automated publishing without approval; before/after comparison excludes fixture data.
```

## Mission 4: Site evidence diagnostics

```text
MISSION 4 — Auditable website audit. Add secure website inspection (allowlisted owner-approved domains, hardened SSRF protections, redirect and DNS revalidation, time/size limits). Check robots.txt, important status codes, canonical, titles, factual public service pages and LocalBusiness JSON-LD presence. Fetch robots metadata for documented crawlers without promising impact on rankings. Distinguish a directly measured fault from a content recommendation. Let users export a remediation report and mark owner approval.
ACCEPTANCE: checks never access localhost/private/cloud metadata addresses; every audit states URL, status, timestamp and test method; unsupported checks show unknown, not failure; no fabricated claims.
```

## Mission 5: Prove impact in money, not vanity charts

```text
MISSION 5 — Referral and conversion attribution. Build authorized connections for GA4/Search Console or an upload-based alternative. Store source provenance and match windows to search visibility cohorts. Add lead/booking import via a simple CSV before attempting bespoke integrations. Dashboard shows referral sessions, qualified enquiries, bookings and revenue only when data exists, with measured vs estimated labels. Provide privacy controls and deletion workflows.
ACCEPTANCE: business metrics cannot appear from invented fixtures in real workspace; attribution caveats visible; disconnection works; unit tests cover bad imports.
```

## Mission 6: Agency-grade commercial layer

```text
MISSION 6 — Agency workspaces + billing. Add permissioned agency/client roles, branding settings, shareable read-only reports with expiring links, subscription billing (provider webhooks verified server side), configurable prompt quotas, compute budget alerts, billing reconciliation and an admin audit log. Finalize accessibility, mobile QA, onboarding and observability. Run a security review and document all residual risks before deployment.
ACCEPTANCE: verified payment and subscription state; monthly quota usage visible and enforced; client only sees own projects; export links expire; no hard-coded demo analytics.
```

## If Codex tries to overbuild

Say: “Implement only the smallest vertical slice that passes the mission's acceptance checks. Do not change the product positioning, tech stack, or dashboard style without explaining why. Show me the measurable user benefit of every new screen.”

## Manual QA checklist for every mission

- New workspace cannot inherit fictional/other-client answers.
- A missing API key gives actionable feedback; no browser exposure of secrets.
- Data collection shows engine/provider/model/method/time/location and exact raw evidence.
- Competitor name collision and invalid citation URLs don't crash the app.
- Mobile layout works; keyboard, form and empty states work.
- `npm run check` passes; relevant integration tests pass.
- Browser explicitly distinguishes live API search from consumer ChatGPT search.
