# Mission 1 verification

Run `npm run check` for the Node syntax, analyzer, workspace validation, provider adapter, and HTTP/persistence tests.

The browser suite requires Python 3, [Playwright for Python](https://playwright.dev/python/docs/intro), and Chromium:

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py
```

An installed system `chromium` or `google-chrome` is used automatically. Set `ATLAS_TEST_CHROMIUM` to choose another executable. If neither exists, Playwright uses its downloaded Chromium. Browser dependencies are development tools; they are not application runtime dependencies.

The cloud workspace was verified with Python Playwright 1.62.0 and `/usr/bin/chromium` (Chromium 154). The existing `npm run test:browser` command runs this same script.

The suite starts its own loopback Node servers on available ports, uses temporary runtime directories, and shuts them down afterward. It never reads a configured server API key, calls a live provider, or writes fixture research records into the normal `.runtime/state.json`. Controlled responses and citations are explicitly labeled `TEST FIXTURE`. Passing this suite does not establish live OpenAI access or a real business's visibility.

The browser workflows verify:

- A new workspace has blank business fields, disabled collection, and no inherited analytics.
- Required fields, competitor count, and duplicate questions block invalid onboarding.
- Eight questions, their language, the business URL confirmation, and the reviewed research brief save correctly and survive reload.
- Empty evidence covers every question with a no-data state; a missing server API key disables collection.
- The controlled scan selects questions and exposes collection progress, two successful responses, and a rate-limit failure.
- Failed questions remain no-data and never enter mention/citation denominators. Budget reservations persist after failures.
- Evidence filters, raw provider records, provenance, citation links, and full run downloads remain connected to exact records.
- Competitor and discovery-gap drilldowns lead to their supporting observations. Selecting one run in Evidence lab does not hide another run's supporting records when inspecting an all-history opportunity.
- Owner-reviewable action creation and completion persist. Settings warn about clearing research data, and cancellation preserves evidence.
- Drawers take focus, make the background inert, trap forward/reverse tabbing, close with Escape, and restore focus.
- Onboarding, review, empty dashboards, scan drawers, partial evidence, and raw evidence drawers have no page-level horizontal overflow at 320px and 390px.
- No uncaught browser JavaScript errors occur during these workflows.

To save screenshots for visual review, run `ATLAS_QA_SCREENSHOTS=1 python tests/browser_smoke.py`. Images are written to ignored `.runtime/qa/`; filenames beginning `fixture-` contain controlled test responses.

This validates a local research MVP. It does not validate production authentication, tenant isolation, hosted database durability, live provider billing, accessibility conformance, or deployment readiness. Authentication, tenant security, and production data storage must be implemented and verified before deployment.

## Hosted candidate checks

Run `npm run test:hosted-browser` for login, Secure/HttpOnly cookies, organization creation, sign-out, read-only roles, history empty state and mobile account UX. Auth is a test fixture. Run `npm run test:db` for the actual Postgres migration, RLS isolation/forbidden mutation, role changes, durable jobs, retention and pg_dump/restore. These do not validate the remote project's Auth/Storage settings; use `docs/SUPABASE.md` for the live acceptance checks.
