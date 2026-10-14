# ATLAS | Founder product specification

## One-sentence pitch

ATLAS identifies high-intent AI discovery questions where local businesses are absent, shows the actual available evidence, organizes truthful improvements, and measures visibility alongside real commercial outcomes.

## Not a chatbot

The hero experience is a **discovery gap card**, not a chat window. Every card should answer: What question? Which engine? Which city/locale? How many observations? Which brands were named? What sources were cited? What concrete evidence-backed next action is worth reviewing? Who owns it? What happened after the fix?

## First ICP / wedge

Founder-led beauty and wellness businesses in Prague with an existing site, multiple genuine services, a functioning booking method, and 1–2 staff willing to approve corrections. Buyers: owner or manager. Job: increase discoverability and bookings from credible search experiences. Don't claim that visibility alone proves revenue.

## V1 product screens

1. **Command center**: source-labeled coverage trend, measured citation rate, market map by services (not invented query volume), 3 next actions, scans in progress.
2. **Evidence lab**: each answer and its actual cited URLs, collection method, location, time, stable run identifier and raw-data download.
3. **Opportunities**: filter by business service and intent, absence across repeated observations, competitor comparison, source-gap diagnostics with confidence label.
4. **Execution workspace**: draft changes with checklists, review/approve/assign/publish, evidence attachment, before/after comparison; nothing publishes without authorization.
5. **Attribution**: optional connect Search Console, GA4, booking provider or tracked links; show referred sessions, leads and appointments with data source and caveats.
6. **Agency workspaces**: multiple clients, roles, individual domains and separate billing limits.

## Unique moments we want

- Enter a business URL; receive a transparent analysis of what was verified, what was missing, and what could not be verified.
- “Competitor X appears in 9/12 comparable observations. Here are exact evidence records.” No black-box certainty.
- A single reviewed action moves from suggestion to implemented change to follow-up test; the full audit trail remains accessible.
- One-click client report suitable for a serious business meeting, with date, provenance and clear caveats.

## V0 (this repo)

Local single-workspace skeleton already implements the UI and a subset of measurement flows. It does not implement provider parity, historical cohorts, billing, site audit, multi-tenancy, customer authorization, or outcome attribution. Preserve honesty about those gaps.

## Non-goals

- Guaranteed top placement in organic AI answers.
- Unpermitted consumer ChatGPT scraping.
- Fabricated or incentivized deceptive reviews.
- Self-publishing unapproved claims about clients.
- Passing LLM explanations off as verifiable model ranking factors.
- Selling AI query-volume estimates as measured ChatGPT traffic.

## Product quality bar

No task is complete unless it includes loading, empty, success and error states; tenant-access rules if hosted; at least one positive and one negative test; and documentation of how measurement is collected.
