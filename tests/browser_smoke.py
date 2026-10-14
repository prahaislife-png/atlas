#!/usr/bin/env python3
"""Mission 1 browser workflows; isolated fixtures, never a paid provider call.

Requires Python Playwright and Chromium. Run from any directory:
  python tests/browser_smoke.py
Use ATLAS_TEST_CHROMIUM=/path/to/chromium to select an installed browser.
Set ATLAS_QA_SCREENSHOTS=1 to save ignored visual review images in .runtime/qa.
"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = [
    "Which Prague salons offer facials for sensitive skin?",
    "Where can I book an English-speaking beauty therapist in Prague?",
    "What should I compare when choosing a Prague facial salon?",
    "Which Prague beauty studios publish treatment prices?",
    "Where can I find evening facial appointments in Prague?",
    "Which Prague salons explain their skincare consultation process?",
    "Where can I book a relaxing facial near central Prague?",
    "How should I choose a professional beauty salon in Prague?",
]
PROFILE = {
    "brand": "Research Salon",
    "domain": "https://researchsalon.cz/",
    "country": "CZ",
    "city": "Prague",
    "languages": ["English"],
    "timezone": "Europe/Prague",
    "competitors": ["Rival Studio", "Other Salon"],
    "urlConfirmed": True,
    "prompts": [
        {"text": question, "language": "English", "intent": "Discovery"}
        for question in QUESTIONS
    ],
}

SERVER = r"""
import {createAtlasServer} from './server.js';
const [runtimeDir, mode] = process.argv.slice(1);
let call = 0;
// The adapter is injected only into this temporary test process. Nothing here
// replaces application code, reaches a provider, or uses the regular runtime.
const fixture = {
  provider:'TEST FIXTURE', model:'gpt-4.1-mini', method:'api',
  engine:'TEST FIXTURE — no external API call',
  async collect({prompt, project}) {
    const index = call++;
    await new Promise(resolve => setTimeout(resolve, 80));
    if (index === 1) throw Object.assign(new Error('TEST FIXTURE: simulated rate limit.'), {code:'RATE_LIMITED', retryable:true});
    const text = index === 0
      ? `TEST FIXTURE: ${project.brand} and Rival Studio are mentioned in this controlled answer.`
      : 'TEST FIXTURE: Rival Studio appears in this controlled answer; no other business is mentioned.';
    const annotations = [{type:'url_citation', url:index === 0 ? `${project.domain}services` : 'https://rivalstudio.cz/services', title:'TEST FIXTURE citation', start_index:0, end_index:12}];
    const rawResponse = {id:`test-fixture-${index}`, model:'gpt-4.1-mini', status:'completed',
      output:[{type:'web_search_call', status:'completed', action:{type:'search', query:prompt.text}},
      {type:'message', content:[{type:'output_text', text, annotations}]}],
      usage:{input_tokens:100,output_tokens:25,total_tokens:125}};
    return {provider:this.provider, model:this.model, method:this.method, engine:this.engine,
      observedAt:'2026-10-14T09:00:00.000Z', location:{country:project.country,city:project.city,timezone:project.timezone},
      rawRequest:{model:this.model,input:prompt.text,fixture:true}, rawResponse, annotations,
      analysisVersion:'browser-fixture-v1', usage:rawResponse.usage};
  }
};
const options = {runtimeDir,env:{}};
if (mode === 'fixture') Object.assign(options,{adapter:fixture,env:{OPENAI_API_KEY:'test-fixture-not-a-real-secret'}});
const server = createAtlasServer(options);
server.listen(0,'127.0.0.1',() => console.log(`READY ${server.address().port}`));
process.on('SIGTERM',() => server.close(() => process.exit(0)));
"""


@contextmanager
def server(mode="no-key"):
    with tempfile.TemporaryDirectory(prefix="atlas-browser-") as runtime:
        proc = subprocess.Popen(
            ["node", "--input-type=module", "-e", SERVER, runtime, mode],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            readable, _, _ = select.select([proc.stdout], [], [], 15)
            if not readable:
                raise AssertionError("Browser fixture server did not become ready within 15 seconds")
            line = proc.stdout.readline().strip()
            if not line.startswith("READY "):
                raise AssertionError(f"Browser fixture server failed: {line}")
            yield f"http://127.0.0.1:{int(line.split()[1])}"
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            stderr = proc.stderr.read()
            if proc.returncode not in (0, -15) and stderr:
                print(stderr)


def state(page):
    response = page.request.get("/api/state")
    assert response.ok, response.text()
    return response.json()


def assert_no_overflow(page, description):
    dimensions = page.evaluate("""() => ({
      viewport:innerWidth, document:document.documentElement.scrollWidth,
      body:document.body.scrollWidth
    })""")
    assert max(dimensions["document"], dimensions["body"]) <= dimensions["viewport"] + 1, (
        f"Horizontal page overflow in {description}: {dimensions}"
    )


def capture(page, name):
    if os.environ.get("ATLAS_QA_SCREENSHOTS") == "1":
        output = ROOT / ".runtime" / "qa"
        output.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(output / f"{name}.png"), full_page=True)


def assert_mobile_layout(page, description):
    for width in (320, 390):
        page.set_viewport_size({"width": width, "height": 844})
        assert_no_overflow(page, f"{description} at {width}px")
    page.set_viewport_size({"width": 1440, "height": 1000})


def fill_business(page):
    for key in ("brand", "domain", "country", "city", "timezone"):
        page.locator(f"#{key}").fill(PROFILE[key])
    page.locator("#languages").fill(", ".join(PROFILE["languages"]))
    page.locator("#competitors").fill("\n".join(PROFILE["competitors"]))
    page.locator("#urlConfirmed").check()


def fill_questions(page):
    for index, question in enumerate(QUESTIONS):
        page.locator(f"#question-{index}").fill(question)
        page.locator(f"#language-{index}").select_option("English")


def assert_drawer_keyboard(page, trigger="#scanBtn"):
    expect(page.locator("#drawer")).to_be_visible()
    assert page.evaluate("document.querySelector('.shell').inert"), "Background is not inert"
    assert page.evaluate("document.querySelector('#drawer').contains(document.activeElement)"), "Drawer does not take focus"
    page.locator("#closeDrawer").focus()
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("document.querySelector('#drawer').contains(document.activeElement)"), "Reverse tab escaped drawer"
    page.keyboard.press("Tab")
    expect(page.locator("#closeDrawer")).to_be_focused()
    page.keyboard.press("Escape")
    expect(page.locator("#drawer")).not_to_be_visible()
    expect(page.locator(trigger)).to_be_focused()
    assert not page.evaluate("document.querySelector('.shell').inert")


def onboarding_and_no_key(browser):
    with server() as base:
        context = browser.new_context(base_url=base, viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("/")
        expect(page.locator("#brand")).to_be_visible()
        expect(page.locator("#brand")).to_have_value("")
        expect(page.locator("#scanBtn")).to_be_disabled()
        assert state(page)["metrics"]["source"] == "empty"
        capture(page, "onboarding-desktop")
        assert_mobile_layout(page, "first business step")
        page.set_viewport_size({"width": 390, "height": 844})
        capture(page, "onboarding-mobile")
        page.set_viewport_size({"width": 1440, "height": 1000})

        # Native required validation must prevent advancing an empty profile.
        page.locator("#continueSetup").click()
        expect(page.locator("#brand")).to_be_focused()
        expect(page.locator("#brand")).to_be_visible()
        assert not state(page)["project"]["onboarded"]
        fill_business(page)
        page.locator("#competitors").fill("Rival Studio")
        page.locator("#continueSetup").click()
        expect(page.locator("#formError")).to_contain_text("2–5")
        expect(page.locator("#formError")).to_be_focused()
        page.locator("#competitors").fill("\n".join(PROFILE["competitors"]))
        page.locator("#continueSetup").click()
        expect(page.locator("#question-0")).to_be_visible()
        assert page.locator("[data-question]").count() == 8
        assert_mobile_layout(page, "question step")
        fill_questions(page)
        page.locator("#question-1").fill(QUESTIONS[0])
        page.locator("#continueSetup").click()
        expect(page.locator("#formError")).to_contain_text("distinct")
        page.locator("#question-1").fill(QUESTIONS[1])
        page.locator("#continueSetup").click()
        expect(page.locator(".review-identity")).to_contain_text(PROFILE["brand"])
        expect(page.locator(".review-identity")).to_contain_text(PROFILE["domain"])
        assert page.locator(".review-questions li").count() == 8
        assert_mobile_layout(page, "review step")
        capture(page, "review-desktop")
        page.locator("#continueSetup").click()
        expect(page.locator(".statgrid")).to_be_visible()
        saved = state(page)
        assert saved["project"]["brand"] == PROFILE["brand"]
        assert len(saved["project"]["prompts"]) == 8
        assert saved["observations"] == [] and saved["runs"] == []
        assert saved["metrics"]["observations"] == 0
        expect(page.locator(".stat-value").nth(0)).to_have_text("—")
        expect(page.locator("#exportBtn")).to_be_disabled()
        assert_mobile_layout(page, "empty command center")
        capture(page, "empty-overview-desktop")

        page.locator('[data-view="evidence"]').click()
        assert page.locator(".coverage-row").count() == 8
        assert page.locator(".coverage-row .status").all_text_contents() == ["NO DATA"] * 8
        assert_mobile_layout(page, "empty evidence lab")
        page.locator("#scanBtn").click()
        expect(page.locator("#drawer")).to_contain_text("Server API key required")
        expect(page.locator("#runScanNow")).to_be_disabled()
        assert page.locator('#drawer input[type="password"]').count() == 0
        assert_mobile_layout(page, "missing-key scan drawer")
        assert_drawer_keyboard(page)
        page.reload()
        expect(page.locator(".statgrid")).to_be_visible()
        assert state(page)["project"]["onboarded"]
        assert not errors, f"Browser JavaScript errors: {errors}"
        context.close()
    print("PASS browser: first-run validation, reviewed onboarding, no inherited analytics, no-data coverage, missing-key state, persistence, keyboard, 320/390px layouts")


def measured_fixture_workflows(browser):
    with server("fixture") as base:
        context = browser.new_context(base_url=base, viewport={"width": 1440, "height": 1000}, accept_downloads=True)
        response = context.request.post("/api/onboarding", data=PROFILE)
        assert response.ok, response.text()
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("/")
        expect(page.locator(".statgrid")).to_be_visible()
        page.locator("#scanBtn").click()
        checkboxes = page.locator('#scanForm input[type="checkbox"]')
        for checkbox in checkboxes.all():
            checkbox.uncheck()
        expect(page.locator("#runScanNow")).to_be_disabled()
        for checkbox in checkboxes.all()[:3]:
            checkbox.check()
        expect(page.locator("#scanSelection")).to_contain_text("3/5")
        page.locator("#runScanNow").click()
        expect(page.locator("#scanProgress")).to_be_visible()
        expect(page.locator("#runPicker")).to_be_visible(timeout=15000)
        expect(page.locator(".run-summary")).to_contain_text("PARTIAL")
        result = state(page)
        assert len(result["runs"]) == 1
        run = result["runs"][0]
        assert run["status"] == "partial"
        assert [item["status"] for item in run["results"]] == ["succeeded", "failed", "succeeded"]
        assert len(result["observations"]) == 2
        assert result["metrics"]["mentionRate"] == 50
        assert result["metrics"]["citationRate"] == 50
        assert result["budget"]["reservedUsd"] == 0.15
        coverage = page.locator(".coverage-row .status").all_text_contents()
        assert coverage == ["1 OBSERVATION", "FAILED · NO DATA", "1 OBSERVATION"] + ["NO DATA"] * 5
        assert_mobile_layout(page, "partial-run evidence")
        capture(page, "fixture-partial-evidence-desktop")
        page.set_viewport_size({"width": 390, "height": 844})
        capture(page, "fixture-partial-evidence-mobile")
        page.set_viewport_size({"width": 1440, "height": 1000})

        # Each evidence filter must preserve the failed-question no-data state.
        for label, expected in (("Mentions", 1), ("Missing", 1), ("Cited", 1), ("All", 2)):
            page.locator(f'[data-filter="{label}"]').click()
            expect(page.locator(".filter-count")).to_have_text(f"{expected} successful records")
            expect(page.locator(".coverage-row .status").nth(1)).to_have_text("FAILED · NO DATA")

        page.locator('[data-obs]').first.click()
        expect(page.locator("#drawer")).to_contain_text("TEST FIXTURE")
        expect(page.locator("#drawer")).to_contain_text("browser-fixture-v1")
        expect(page.locator("#drawer")).to_contain_text(run["id"])
        expect(page.locator("#drawer .source-link")).to_have_count(1)
        page.locator("#drawer summary", has_text="Raw provider response").click()
        expect(page.locator("#drawer")).to_contain_text("test-fixture-")
        assert_mobile_layout(page, "raw evidence drawer")
        page.keyboard.press("Escape")

        page.locator('.run-summary [data-run]').click()
        expect(page.locator("#drawer")).to_contain_text("RATE_LIMITED")
        expect(page.locator("#drawer")).to_contain_text("No observation recorded")
        with page.expect_download() as download_event:
            page.locator("#drawer a[download]").click()
        exported = json.loads(Path(download_event.value.path()).read_text())
        assert exported["run"]["id"] == run["id"]
        assert len(exported["observations"]) == 2
        assert all("rawResponse" in observation and "rawRequest" in observation for observation in exported["observations"])
        assert "test-fixture-not-a-real-secret" not in json.dumps(exported)
        page.keyboard.press("Escape")

        page.locator('[data-view="overview"]').click()
        expect(page.locator(".stat-value").nth(0)).to_have_text("50%")
        expect(page.locator(".stat-value").nth(1)).to_have_text("50%")
        capture(page, "fixture-overview-desktop")
        page.locator('[data-competitor="Rival Studio"]').click()
        expect(page.locator("#drawer")).to_contain_text("2/2 successful responses")
        expect(page.locator("#drawer [data-obs]")).to_have_count(2)
        page.keyboard.press("Escape")
        page.locator('[data-view="opportunities"]').click()
        expect(page.locator(".opp")).to_have_count(1)
        page.locator(".opp [data-prompt]").click()
        expect(page.locator("#drawer")).to_contain_text("1 of 1 observed responses")
        expect(page.locator("#drawer [data-obs]")).to_have_count(1)
        page.keyboard.press("Escape")

        page.locator('[data-view="actions"]').click()
        page.locator("#addAction").click()
        page.locator("#newActionTitle").fill("Review the cited service information with the owner")
        page.locator("#newActionDetail").fill("Check the exact source against the observed answer before approving a factual website change.")
        page.locator('#newActionForm button[type="submit"]').click()
        expect(page.locator(".action-row")).to_have_count(1)
        page.locator("[data-action]").click()
        expect(page.locator("[data-action]")).to_have_attribute("aria-pressed", "true")
        page.locator('[data-view="settings"]').click()
        expect(page.locator(".settings-warning")).to_contain_text("clears local observations")
        expect(page.locator("#brand")).to_have_value(PROFILE["brand"])
        page.locator('[data-goto="overview"]').click()
        assert len(state(page)["observations"]) == 2
        page.reload()
        expect(page.locator(".statgrid")).to_be_visible()
        assert len(state(page)["runs"]) == 1
        assert state(page)["actions"][0]["done"] is True

        # Evidence's run filter must not silently narrow an all-history gap.
        # Repeat the same absent-brand question, select the first evidence run,
        # then verify Opportunities opens both supporting responses.
        page.locator("#scanBtn").click()
        checkboxes = page.locator('#scanForm input[type="checkbox"]')
        for checkbox in checkboxes.all():
            checkbox.uncheck()
        checkboxes.nth(2).check()
        page.locator("#runScanNow").click()
        expect(page.locator("#runPicker")).to_be_visible(timeout=15000)
        assert len(state(page)["runs"]) == 2
        page.locator("#runPicker").select_option(run["id"])
        expect(page.locator(".filter-count")).to_have_text("2 successful records")
        page.locator('[data-view="opportunities"]').click()
        expect(page.locator(".opp")).to_have_count(1)
        expect(page.locator(".opp")).to_contain_text("2 of 2 observed answers")
        page.locator(".opp [data-prompt]").click()
        expect(page.locator("#drawer")).to_contain_text("2 of 2 observed responses")
        expect(page.locator("#drawer [data-obs]")).to_have_count(2)
        page.keyboard.press("Escape")
        assert not errors, f"Browser JavaScript errors: {errors}"
        context.close()
    print("PASS browser: controlled scan, partial failures, denominator integrity, evidence filters, provenance/raw records, run export, competitor/gap drilldown, reviewed action persistence")


def main():
    executable = os.environ.get("ATLAS_TEST_CHROMIUM") or shutil.which("chromium") or shutil.which("google-chrome")
    with sync_playwright() as playwright:
        options = {"headless": True, "args": ["--no-sandbox"]}
        if executable:
            options["executable_path"] = executable
        browser = playwright.chromium.launch(**options)
        try:
            onboarding_and_no_key(browser)
            measured_fixture_workflows(browser)
        finally:
            browser.close()
    print("All browser smoke workflows passed. Provider responses were isolated TEST FIXTURES; no live API request was made.")


if __name__ == "__main__":
    main()
