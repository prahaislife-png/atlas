import {apiRequest, renderAccountGate, renderAccountChrome, canEdit} from './account.js';
let STATE = null;
let view = 'overview';
let evidenceFilter = 'All';
let selectedRun = 'all';
let search = '';
let draft = null;
let onboardingStep = 1;
let editing = false;
let drawerReturnFocus = null;
let drawerVersion = 0;
let scanBusy = false;
let scanRefreshTimer = null;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const data = () => (STATE?.observations || []).filter(o => o.mode === 'live');
const money = n => new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:3}).format(Number(n) || 0);
const date = value => value ? new Intl.DateTimeFormat('en-GB', {dateStyle:'medium', timeStyle:'short', timeZone:'Europe/Prague'}).format(new Date(value)) + ' · Prague time' : 'Not recorded';
const locationText = location => typeof location === 'string' ? location : [location?.city, location?.country, location?.timezone].filter(Boolean).join(' · ');
const shortId = id => String(id || '').slice(0,8);
const normalized = value => String(value).normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/gu,' ');
const perPromptReservation = () => Math.ceil(Number((Number(STATE.limits?.reservationPerPromptUsd || 0)*100).toPrecision(15)))/100;
const isOnboarded = () => STATE?.project?.onboarded === true;
function safeUrl(value) { try { const parsed = new URL(value); return ['https:','http:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; } }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.remove('hidden'); clearTimeout(window.__toastTimeout); window.__toastTimeout = setTimeout(() => node.classList.add('hidden'), 6500); }
const request = apiRequest;
let workspaceEpoch = 0;
let hostedWorkerBusy = false;
async function switchWorkspace() { workspaceEpoch++; clearTimeout(scanRefreshTimer); closeDrawer(); STATE = null; draft = null; selectedRun = 'all'; view = 'overview'; await start(); }

function openDrawer(content) {
  drawerVersion++;
  if ($('#drawer').classList.contains('hidden')) drawerReturnFocus = document.activeElement;
  $('#drawerBody').innerHTML = content;
  $('#drawerBackdrop').classList.remove('hidden');
  $('#drawer').classList.remove('hidden');
  $('.shell').inert = true;
  document.body.classList.add('drawer-open');
  const heading = $('#drawerBody h2');
  if (heading) { heading.tabIndex = -1; heading.focus(); } else $('#closeDrawer').focus();
  wireEvidenceLinks($('#drawerBody'));
}
function closeDrawer() {
  drawerVersion++;
  $('#drawerBackdrop').classList.add('hidden');
  $('#drawer').classList.add('hidden');
  $('.shell').inert = false;
  document.body.classList.remove('drawer-open');
  if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus();
}
function setView(next) {
  if (!isOnboarded()) { view = 'onboarding'; render(); return; }
  if (next === 'settings') { editing = true; draft = projectDraft(); onboardingStep = 1; }
  view = next;
  updateChrome(); render(); window.scrollTo({top:0, behavior:'smooth'});
}
function updateChrome() {
  const brand = STATE.project.brand || 'Your new workspace';
  $('#side-brand').textContent = brand;
  $('#workspaceAvatar').textContent = STATE.project.brand ? STATE.project.brand.split(/\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase() : 'A';
  $('#crumb-brand').textContent = STATE.project.brand ? brand.toUpperCase() : 'GET STARTED';
  $('#crumb-section').textContent = ({overview:'COMMAND CENTER', evidence:'EVIDENCE LAB', opportunities:'OPPORTUNITIES', actions:'ACTION PLANS', settings:'SETTINGS', onboarding:'ONBOARDING'})[view] || 'ONBOARDING';
  const live = data().length > 0;
  $('#modeBadge').textContent = live ? 'REAL API OBSERVATIONS' : 'NO OBSERVATIONS YET';
  $('#modeBadge').classList.toggle('live', live);
  $('#scanBtn').disabled = !isOnboarded() || scanBusy || STATE.scanInProgress || !canEdit(STATE);
  $('#scanBtn').innerHTML = scanBusy || STATE.scanInProgress ? '<span class="spinner"></span> Scan in progress' : '<span class="scan-dot"></span> Run search scan';
  $('#exportBtn').disabled = !live;
  $$('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.disabled = !isOnboarded(); if (button.dataset.view === view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
}
async function load() {
  const epoch = workspaceEpoch;
  const incoming = await request('/api/state');
  if (epoch !== workspaceEpoch) return;
  STATE = incoming;
  if (!isOnboarded()) { view = 'onboarding'; editing = false; draft ||= projectDraft(); }
  updateChrome(); render(); renderAccountChrome(STATE, switchWorkspace);
  clearTimeout(scanRefreshTimer);
  if (STATE.scanInProgress && !scanBusy) scanRefreshTimer = setTimeout(async () => {
    try {
      if (STATE?.hosted && canEdit(STATE) && !hostedWorkerBusy) { hostedWorkerBusy = true; try { await request('/api/worker/tick', {method:'POST', body:'{}'}); } finally { hostedWorkerBusy = false; } }
      await load();
    } catch (error) { if (!renderAccountGate(error, switchWorkspace)) toast(error.message); }
  }, STATE.hosted ? 1000 : 4000);
}
const top = (eyebrow, title, description, context = '') => `<section class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1 class="page-title" tabindex="-1">${title}</h1><p class="lead">${esc(description)}</p></div>${context ? `<span class="context-pill">${esc(context)}</span>` : ''}</section>`;
const stat = (label, value, foot, symbol) => `<div class="stat"><span class="stat-symbol" aria-hidden="true">${symbol}</span><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-foot">${esc(foot)}</div></div>`;
const empty = (title, description, button = '') => `<div class="empty-state"><span class="empty-mark" aria-hidden="true">◈</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${button}</div>`;
const budgetNote = () => `<div class="budget-strip"><span><strong>${money(STATE.budget?.remainingUsd)}</strong> daily reserved budget remaining</span><span>${money(STATE.budget?.reservedUsd)} reserved / ${money(STATE.limits?.dailySpendCapUsd)} cap · ${STATE.budget?.runs || 0}/${STATE.limits?.maxRunsPerDay || '—'} runs · ${esc(STATE.budget?.date || 'today')} UTC</span></div>`;
function projectDraft() {
  const p = STATE.project;
  return {brand:p.brand || '', domain:p.domain || '', country:p.country || 'CZ', city:p.city || '', timezone:p.timezone || 'Europe/Prague', languages:[...(p.languages || [])].join(', '), competitors:[...(p.competitors || [])].join('\n'), urlConfirmed:false, prompts:p.prompts?.length ? p.prompts.map(x => ({text:x.text, language:x.language, intent:x.intent || 'Discovery'})) : Array.from({length:8}, () => ({text:'', language:'', intent:'Discovery'}))};
}
const questionLimit = () => Math.min(15, Math.max(8, Number(STATE.limits?.maxPrompts) || 15));
const draftLanguages = () => [...new Set(draft.languages.split(',').map(x => x.trim()).filter(Boolean))];
function identityFields() {
  return `<div class="form-grid"><div class="field"><label for="brand">Business name</label><input id="brand" name="brand" maxlength="200" required autocomplete="organization" value="${esc(draft.brand)}" placeholder="The name your customers know"/></div><div class="field"><label for="domain">Official website URL</label><input id="domain" name="domain" type="url" maxlength="200" required value="${esc(draft.domain)}" placeholder="https://your-business.cz"/></div><div class="field"><label for="country">Country code</label><input id="country" name="country" minlength="2" maxlength="2" required pattern="[A-Za-z]{2}" value="${esc(draft.country)}" aria-describedby="countryHelp"/><small id="countryHelp">Two-letter ISO code, e.g. CZ, DE, GB.</small></div><div class="field"><label for="city">City</label><input id="city" name="city" required maxlength="120" value="${esc(draft.city)}" placeholder="Prague" autocomplete="address-level2"/></div><div class="field"><label for="languages">Research languages</label><input id="languages" name="languages" required maxlength="200" value="${esc(draft.languages)}" placeholder="Czech, English" aria-describedby="languagesHelp"/><small id="languagesHelp">Use language names such as Czech, English or German, or codes such as cs, en-US or de. Separate with commas.</small></div><div class="field"><label for="timezone">Research timezone</label><input id="timezone" name="timezone" required maxlength="80" value="${esc(draft.timezone)}" placeholder="Europe/Prague"/></div><div class="field wide"><label for="competitors">Competitors · 2–5 businesses</label><textarea id="competitors" name="competitors" rows="4" required maxlength="600" placeholder="One business name per line">${esc(draft.competitors)}</textarea><small>Use distinct, real business names in the same market. Name matches will always need human review.</small></div><div class="field wide"><label class="form-check confirmation"><input type="checkbox" name="urlConfirmed" id="urlConfirmed" ${draft.urlConfirmed ? 'checked' : ''} required/><span>I reviewed this URL and confirm it is the business’s official website.<small>This is your confirmation. ATLAS has not crawled the site, verified ownership, or checked its content.</small></span></label></div></div>`;
}
function questionFields() {
  const languages = draftLanguages();
  return `<div class="research-note"><strong>A useful question sounds like a customer.</strong><p>Use unbranded buying or discovery questions about your services and location. Do not add your business or competitor names to influence an answer. Questions are sent exactly as reviewed.</p></div><div id="questionRows">${draft.prompts.map((p,i) => `<fieldset class="question-row"><legend>QUESTION ${String(i+1).padStart(2,'0')}</legend><div class="field"><label for="question-${i}">Buyer question</label><textarea id="question-${i}" data-question="${i}" rows="2" required maxlength="350" placeholder="Which salons in Prague offer facials for sensitive skin?">${esc(p.text)}</textarea></div><div class="question-meta"><div class="field"><label for="language-${i}">Language</label><select id="language-${i}" data-language="${i}" required><option value="">Select language</option>${languages.map(lang => `<option ${p.language === lang ? 'selected' : ''} value="${esc(lang)}">${esc(lang)}</option>`).join('')}</select></div><div class="field"><label for="intent-${i}">Intent</label><select id="intent-${i}" data-intent="${i}">${['Discovery','High intent','Comparison'].map(intent => `<option ${p.intent === intent ? 'selected' : ''}>${intent}</option>`).join('')}</select></div><button type="button" class="text-link remove-question" data-remove-question="${i}" ${draft.prompts.length <= 8 ? 'disabled' : ''} aria-label="Remove question ${i+1}">Remove</button></div></fieldset>`).join('')}</div><div class="question-add"><span>${draft.prompts.length} of 8–${questionLimit()} buyer questions</span><button type="button" id="addQuestion" class="btn btn-ghost" ${draft.prompts.length >= questionLimit() ? 'disabled' : ''}>+ Add a question</button></div>`;
}
function reviewFields() {
  return `<div class="review-identity"><span class="avatar review-avatar">${esc(draft.brand.slice(0,2).toUpperCase())}</span><div><h3>${esc(draft.brand)}</h3><p>${esc(draft.domain)}</p></div><button type="button" class="text-link" data-edit-step="1">Edit business →</button></div><dl class="review-grid"><div><dt>Market</dt><dd>${esc(draft.city)}, ${esc(draft.country.toUpperCase())}</dd></div><div><dt>Languages</dt><dd>${esc(draft.languages)}</dd></div><div><dt>Timezone</dt><dd>${esc(draft.timezone)}</dd></div><div><dt>Competitors</dt><dd>${esc(draft.competitors.split('\n').map(x => x.trim()).filter(Boolean).join(' · '))}</dd></div></dl><div class="review-url"><span class="status yes">HUMAN CONFIRMED</span><span>Official URL reviewed by you. Ownership and site content are unverified.</span></div><div class="section-bar"><h3 class="panel-title">Your exact question cohort</h3><button type="button" class="text-link" data-edit-step="2">Edit questions →</button></div><ol class="review-questions">${draft.prompts.map(p => `<li><span>${esc(p.text)}</span><small>${esc(p.language)} · ${esc(p.intent)}</small></li>`).join('')}</ol><div class="message">Saving creates a clean research workspace with no inherited evidence. You will choose the questions and review the budget before starting your first paid API scan.</div>`;
}
function onboarding() {
  const headings = ['Start with the real business.','Design your discovery baseline.','Every detail, before any data.'];
  const descriptions = ['Set a precise identity, local market and competitive context. Good evidence starts with a good research brief.',`Choose 8–${questionLimit()} questions that your prospective customers might actually ask. Review the wording and language of each one.`,'Review your complete research brief. You stay in control of when the first scan runs.'];
  return top(editing ? 'Workspace research settings' : 'A clear first step', `<em>${headings[onboardingStep-1]}</em>`, descriptions[onboardingStep-1], editing ? 'Edit research brief' : 'YOUR FIRST BASELINE') +
  `<div class="onboarding-layout"><section class="panel onboarding-panel"><ol class="stepper" aria-label="Setup progress">${['Business','Questions','Review'].map((step,i) => `<li class="${i+1 === onboardingStep ? 'current' : i+1 < onboardingStep ? 'complete' : ''}" ${i+1 === onboardingStep ? 'aria-current="step"' : ''}><span>${i+1 < onboardingStep ? '✓' : i+1}</span>${step}</li>`).join('')}</ol>${editing ? `<div class="warning settings-warning">${STATE.hosted ? 'Saving starts a new research version. Previous project data and evidence are retained in the organization archive. Export the current cohort before continuing.' : 'Saving this reviewed brief clears local observations, scan history and action tasks to prevent mixing businesses or cohorts. Export your evidence before continuing. Historical retention requires the production storage phase.'}</div>` : ''}<form id="onboardingForm"><div id="formError" class="error-message hidden" role="alert" tabindex="-1"></div>${onboardingStep === 1 ? identityFields() : onboardingStep === 2 ? questionFields() : reviewFields()}<div class="onboarding-buttons">${onboardingStep > 1 ? '<button type="button" class="btn btn-ghost" id="previousStep">← Back</button>' : editing ? '<button type="button" class="btn btn-ghost" data-goto="overview">Cancel</button>' : '<span class="setup-note">Local workspace · no data sent yet</span>'}<button type="submit" class="btn btn-dark" id="continueSetup">${onboardingStep === 3 ? editing ? 'Save reviewed changes →' : 'Create research workspace →' : onboardingStep === 1 ? 'Build question cohort →' : 'Review research brief →'}</button></div></form></section><aside class="onboarding-aside"><div class="onboarding-statement"><span class="panel-kicker">A research instrument</span><h2>Real answers.<br/><em>Verifiable evidence.</em><br/>Better decisions.</h2><p>No invented visibility scores. No inherited demo results. Just the questions you approve and the responses we actually collect.</p><div class="onboarding-rule"></div><div class="principle"><span>01</span><p><strong>One method, clearly labeled</strong>OpenAI API web search. Results may differ from consumer ChatGPT.</p></div><div class="principle"><span>02</span><p><strong>Every observation traceable</strong>Exact prompts, raw responses, cited URLs and immutable scan identifiers.</p></div><div class="principle"><span>03</span><p><strong>You control the spend</strong>Choose the cohort per run, with enforced daily caps and visible budget reservations.</p></div></div></aside></div>`;
}
function captureDraft() {
  if (onboardingStep === 1) {
    for (const key of ['brand','domain','country','city','languages','timezone','competitors']) draft[key] = $(`#${key}`).value.trim();
    draft.country = draft.country.toUpperCase(); draft.urlConfirmed = $('#urlConfirmed').checked;
    const languages = draftLanguages();
    draft.prompts.forEach(p => { if (!languages.includes(p.language)) p.language = languages.length === 1 ? languages[0] : ''; });
  } else if (onboardingStep === 2) {
    draft.prompts.forEach((p,i) => { p.text = $(`#question-${i}`).value.trim(); p.language = $(`#language-${i}`).value; p.intent = $(`#intent-${i}`).value; });
  }
}
function setupError(message) { const node = $('#formError'); node.textContent = message; node.classList.remove('hidden'); node.focus(); }
function validateDraftStep() {
  if (onboardingStep === 1) {
    if (!safeUrl(draft.domain)) return 'Enter a complete HTTP or HTTPS website URL.';
    if (!draftLanguages().length || draftLanguages().length > 5) return 'Add 1–5 research languages.';
    if (new Set(draftLanguages().map(normalized)).size !== draftLanguages().length) return 'Use each research language once.';
    const competitors = draft.competitors.split('\n').map(x => x.trim()).filter(Boolean);
    if (competitors.length < 2 || competitors.length > 5) return 'Add 2–5 real competitor names, one per line.';
    if (new Set(competitors.map(normalized)).size !== competitors.length || competitors.some(name => normalized(name) === normalized(draft.brand))) return 'Each competitor must be a different business and different from your brand.';
    if (!draft.urlConfirmed) return 'Review the official website URL and confirm it before continuing.';
    try { new Intl.DateTimeFormat('en', {timeZone:draft.timezone}); } catch { return 'Use a valid IANA timezone, such as Europe/Prague.'; }
  }
  if (onboardingStep === 2) {
    if (draft.prompts.length < 8 || draft.prompts.length > questionLimit()) return `Your baseline needs 8–${questionLimit()} buyer questions.`;
    if (new Set(draft.prompts.map(x => `${normalized(x.language)}\u0000${normalized(x.text)}`)).size !== draft.prompts.length) return 'Use a distinct question in each research language.';
    for (const [index,p] of draft.prompts.entries()) {
      if (!p.text || !draftLanguages().includes(p.language)) return `Review question ${index+1} and select its research language.`;
    }
  }
  return '';
}
function promptRows() {
  return STATE.project.prompts.map(p => {
    const rows = data().filter(o => o.promptId === p.id);
    return {...p, observations:rows, missed:rows.filter(o => !o.brandMentioned).length, competitors:[...new Set(rows.flatMap(o => o.competitorsMentioned || []))]};
  });
}
function opportunityCards(max = 15) {
  const rows = promptRows().filter(p => p.missed > 0 && (!search || p.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))).sort((a,b) => b.missed-a.missed).slice(0,max);
  if (!rows.length) return empty(data().length ? 'No observed discovery gaps in this selection.' : 'Your next opportunity starts with evidence.', data().length ? 'An absence is an observation, not a diagnosis. Collect repeat measurements before drawing conclusions.' : 'Run a baseline to see which questions mention your business and its competitors.');
  return rows.map((p,i) => `<article class="opp"><div class="opp-top"><span class="opp-num">GAP ${String(i+1).padStart(2,'0')}</span><span class="chip">${esc(p.intent)}</span></div><h3>${esc(p.text)}</h3><p>${p.missed} of ${p.observations.length} observed answers did not mention your brand.${p.competitors.length ? ` Names detected: ${esc(p.competitors.join(', '))}.` : ''} Review the records before proposing a fix.</p><div class="opp-bottom"><span>${esc(p.language)} · ${esc(STATE.project.city)}</span><button class="text-link" data-prompt="${esc(p.id)}">Inspect evidence →</button></div></article>`).join('');
}
function coverageChart() {
  const rows = data();
  if (!rows.length) return empty('A baseline, not an invented trend.','Mention coverage appears here after your first successful scan. There is no measured history yet.');
  const groups = ['High intent','Comparison','Discovery'].map(label => ({label, rows:rows.filter(x => x.intent === label)})).filter(x => x.rows.length);
  if (!groups.length) return `<p class="panel-desc">${rows.length} observations collected. Open Evidence lab to inspect the exact cohort.</p>`;
  return `<div class="chart"><div class="bars-group">${groups.map(g => { const own = g.rows.filter(o => o.brandMentioned).length; const others = g.rows.filter(o => o.competitorsMentioned?.length).length; return `<div class="bar-group"><div class="bar-value">${own}/${g.rows.length}</div><div class="bar-pair" role="img" aria-label="${esc(g.label)}: your brand mentioned in ${own} of ${g.rows.length} responses; any competitor mentioned in ${others} of ${g.rows.length} responses"><div class="bar" style="height:${100*own/g.rows.length}%" aria-label="Your brand mentioned in ${own} of ${g.rows.length} responses"></div><div class="bar competitor" style="height:${100*others/g.rows.length}%" aria-label="Any competitor mentioned in ${others} of ${g.rows.length} responses"></div></div><span class="bar-name">${esc(g.label)}</span></div>`; }).join('')}</div></div><div class="chart-note"><span><i class="legend"></i>Your brand</span><span><i class="legend grey"></i>Any competitor</span></div>`;
}
function competitorBars() {
  if (!data().length) return empty('The competitive picture is still open.','Competitor counts only appear when their names are detected in captured responses.');
  return STATE.project.competitors.map(name => ({name, observations:data().filter(o => o.competitorsMentioned?.includes(name))})).sort((a,b) => b.observations.length-a.observations.length).map((c,i) => `<div class="row-item"><span class="competitor-number">${String(i+1).padStart(2,'0')}</span><div class="row-main"><div class="row-title">${esc(c.name)}</div><div class="row-sub">${c.observations.length}/${data().length} responses · name match, review required</div></div>${c.observations.length ? `<button class="text-link" data-competitor="${esc(c.name)}" aria-label="Inspect evidence for ${esc(c.name)}">Evidence →</button>` : '<span class="mini-tag muted">NO MENTIONS</span>'}</div>`).join('');
}
function overview() {
  const rows = data(); const mentioned = rows.filter(o => o.brandMentioned).length; const cited = rows.filter(o => o.targetCited).length;
  const latest = STATE.runs?.at(-1);
  return top('Your presence, instrumented','Become <em>the obvious choice.</em>','A clear view of the questions, competitors and sources in your actual AI search observations.',`${STATE.project.city}, ${STATE.project.country} · ${STATE.project.prompts.length} questions`) +
  `<div class="${rows.length ? 'message' : 'research-note'}">${rows.length ? 'Measured with OpenAI Responses API web search. These observations may differ from consumer ChatGPT. Mention detection is name matching, not a verified recommendation or ranking.' : '<strong>Your workspace is ready. Your evidence starts here.</strong><p>Review your questions, configure the server integration and choose your first scan. This business has no inherited sample data.</p>'}</div>` +
  `<div class="statgrid">${stat('Brand mention rate',rows.length ? `${Math.round(100*mentioned/rows.length)}%` : '—',rows.length ? `${mentioned}/${rows.length} observed responses` : 'Awaiting measured responses','→')}${stat('Your domain cited',rows.length ? `${Math.round(100*cited/rows.length)}%` : '—',rows.length ? `${cited}/${rows.length} responses cite your domain` : 'Awaiting citation evidence','⌁')}${stat('Questions monitored',STATE.project.prompts.length,`${promptRows().filter(p => p.observations.length).length} questions have observations`,'◉')}${stat('Captured observations',rows.length,STATE.runs?.length ? `${STATE.runs.length} scan runs · inspect exact records` : 'No scans have been run','▤')}</div>` + budgetNote() +
  `<div class="grid2"><section class="panel"><div class="panel-head"><div><p class="panel-kicker">Observed coverage</p><h2 class="panel-title">Where you show up</h2><p class="panel-desc">Current cohort, grouped by question intent. No measured query volume.</p></div><span class="chip">${rows.length} observations</span></div>${coverageChart()}</section><section class="panel"><div class="panel-head"><div><p class="panel-kicker">Competitive landscape</p><h2 class="panel-title">Who appears alongside you</h2><p class="panel-desc">Exact supporting records, with no market-share claims.</p></div></div>${competitorBars()}</section></div>` +
  (latest ? `<div class="latest-run"><div><span class="panel-kicker">Latest scan · ${esc(latest.status)}</span><p>${esc(date(latest.startedAt))} · <code>${esc(shortId(latest.id))}</code></p></div><button class="btn btn-ghost" data-run="${esc(latest.id)}">Inspect scan run →</button></div>` : '') +
  `<div class="section-bar"><h2 class="section-title">Discovery gaps worth investigating</h2><button class="text-link" data-goto="opportunities">View all gaps →</button></div><div class="opportunity-list">${opportunityCards(3)}</div><div class="insight-banner"><div><div class="label">EVIDENCE BEFORE ASSUMPTIONS</div><h3>See the answer. Understand the context.</h3><p>Every captured response keeps its source, prompt, locale and raw record.</p></div><button class="btn btn-dark" data-goto="evidence">Open Evidence lab →</button></div>`;
}
function opportunities() {
  return top('Discovery gaps','Find the <em>missing demand.</em>','Questions where your brand was absent in collected answers. These are research hypotheses, not proven ranking causes.',`${promptRows().filter(p => p.missed).length} observed gaps`) + `<div class="filterbar"><label class="sr-only" for="opportunitySearch">Search questions</label><input type="search" class="search-input" id="opportunitySearch" placeholder="Search questions…" value="${esc(search)}"/><span class="chip">Ordered by observed absences</span></div><div class="opportunity-list" id="opportunityGrid">${opportunityCards()}</div><div class="research-note section-note"><strong>Turn a gap into a question, not a certainty.</strong><p>One stochastic response cannot explain why a model chose a business. Review exact evidence, verify your public facts and collect repeat observations with a matching method.</p></div>`;
}
function selectedObservations() { return data().filter(o => selectedRun === 'all' || o.runId === selectedRun); }
function runSummary(run) {
  const results = run.results || []; const good = results.filter(r => r.status === 'succeeded').length; const failed = results.filter(r => r.status === 'failed').length;
  return `<div class="run-summary"><div><span class="status ${run.status === 'completed' ? 'yes' : 'sample'}">${esc(run.status.toUpperCase())}</span><h3>Run <code>${esc(shortId(run.id))}</code></h3><p>${good} succeeded · ${failed} failed · ${results.length-good-failed} pending<br/>${esc(date(run.startedAt))}</p></div><div><p>${esc(run.provider)} · ${esc(run.model)} · ${esc(run.method)}<br/>${esc(locationText(run.location))}</p><button class="text-link" data-run="${esc(run.id)}">Full provenance & results →</button></div><a class="btn btn-ghost" href="/api/runs/${encodeURIComponent(run.id)}/export" download>↓ Run JSON</a></div>`;
}
function evidence() {
  const observations = selectedObservations();
  const visible = observations.filter(o => evidenceFilter === 'All' || evidenceFilter === 'Mentions' && o.brandMentioned || evidenceFilter === 'Missing' && !o.brandMentioned || evidenceFilter === 'Cited' && o.targetCited);
  const run = STATE.runs?.find(r => r.id === selectedRun);
  return top('Search intelligence','Every claim has <em>a source.</em>','Exact prompts, raw responses and citations. Every result belongs to a traceable scan run.',`${observations.length} captured records`) +
  `<div class="evidence-toolbar"><div class="field"><label for="runPicker">Observation cohort</label><select id="runPicker"><option value="all">All measured runs (${STATE.runs?.length || 0})</option>${[...(STATE.runs || [])].reverse().map(r => `<option value="${esc(r.id)}" ${r.id === selectedRun ? 'selected' : ''}>${esc(shortId(r.id))} · ${esc(r.status)} · ${esc(date(r.startedAt))}</option>`).join('')}</select></div><button class="btn btn-ghost" data-goto="settings">Review question cohort →</button></div>` +
  (run ? runSummary(run) : '') +
  `<section class="panel coverage-panel"><div class="panel-head"><div><p class="panel-kicker">Research coverage</p><h2 class="panel-title">Every question, including the unknowns</h2><p class="panel-desc">No data means no successful response was captured. Failed requests never count as absence.</p></div></div><div class="question-coverage">${STATE.project.prompts.map(p => {
    const count = observations.filter(o => o.promptId === p.id).length; const result = run?.results?.find(r => r.promptId === p.id);
    return `<div class="coverage-row"><span class="coverage-question">${esc(p.text)}<small>${esc(p.language)} · ${esc(p.intent)}</small></span><div>${count ? `<span class="status yes">${count} OBSERVATION${count === 1 ? '' : 'S'}</span>` : `<span class="status ${result?.status === 'failed' ? 'sample' : 'no'}">${result?.status === 'failed' ? 'FAILED · NO DATA' : result?.status === 'pending' ? 'PENDING · NO DATA' : 'NO DATA'}</span>`}${result?.error ? `<p class="inline-failure">${esc(result.error.message)}</p>` : ''}</div>${count ? `<button class="text-link" data-prompt="${esc(p.id)}">Inspect →</button>` : ''}</div>`;
  }).join('')}</div></section><div class="filterbar" aria-label="Filter observed responses">${['All','Mentions','Missing','Cited'].map(f => `<button class="filterbtn ${evidenceFilter === f ? 'active' : ''}" data-filter="${f}" aria-pressed="${evidenceFilter === f}">${f}</button>`).join('')}<span class="filter-count">${visible.length} successful records</span></div>` +
  (visible.length ? `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Exact buyer question</th><th scope="col">Brand</th><th scope="col">Domain cited</th><th scope="col">Scan run</th><th scope="col">Evidence</th></tr></thead><tbody>${[...visible].reverse().map(o => `<tr><td class="boldcell">${esc(o.prompt)}<small class="cell-sub">${esc(o.language)} · ${esc(o.provider)} · ${esc(o.method)}<br/>${esc(date(o.observedAt || o.createdAt))}</small></td><td><span class="status ${o.brandMentioned ? 'yes' : 'no'}">${o.brandMentioned ? 'MENTIONED' : 'ABSENT'}</span></td><td><span class="status ${o.targetCited ? 'yes' : 'no'}">${o.targetCited ? 'CITED' : 'NOT CITED'}</span></td><td><button class="text-link code-link" data-run="${esc(o.runId)}">${esc(shortId(o.runId))}</button></td><td><button class="btn btn-ghost" data-obs="${esc(o.id)}" aria-label="Inspect response to ${esc(o.prompt)}">Inspect →</button></td></tr>`).join('')}</tbody></table></div>` : empty(observations.length ? 'No responses match this filter.' : 'No captured responses in this cohort.',observations.length ? 'Choose another evidence filter to see the recorded answers.' : 'Select a scan run to inspect its status, or start a scan to collect your baseline.')) +
  `<p class="panel-desc section-note">Method: OpenAI Responses API with web search, not the consumer ChatGPT interface. Counts reflect this prompt cohort only. Observations are stochastic and do not establish ranking causes or conversion.</p>`;
}
function actions() {
  const list = STATE.actions || [];
  return top('Execution workspace','Keep improvements <em>grounded.</em>','Create owner-reviewable tasks from verified information gaps. Task completion is not evidence of AI visibility or bookings.',`${list.filter(a => !a.done).length} open tasks`) + `<div class="grid2"><section><div class="section-bar"><h2 class="section-title">Your improvement queue</h2><button class="btn btn-ghost" id="addAction">+ Add action</button></div>${list.length ? list.map(a => `<div class="action-row"><button class="tick ${a.done ? 'checked' : ''}" data-action="${esc(a.id)}" aria-label="${a.done ? 'Mark incomplete' : 'Mark complete'}: ${esc(a.title)}" aria-pressed="${!!a.done}">✓</button><div class="action-main"><h3 class="${a.done ? 'done' : ''}">${esc(a.title)}</h3><p>${esc(a.detail)}</p><span class="chip">${esc(a.category || 'Manual')}</span></div></div>`).join('') : empty('A clean slate for verified improvements.','Review the evidence, confirm the facts with the owner, then add a specific action. No generic recommendations have been invented for your business.')} </section><aside class="panel"><p class="panel-kicker">Human in the loop</p><h2 class="panel-title">Evidence → review → improvement</h2>${['Inspect the exact observed answer','Check the business facts with the owner','Propose a specific, truthful change','Publish only through authorized channels','Re-measure the same question and method'].map((text,i) => `<div class="row-item"><span class="mini-tag">${String(i+1).padStart(2,'0')}</span><div class="row-title">${text}</div></div>`).join('')}<p class="panel-desc">This local queue does not publish content, enforce approval roles or prove conversion. The production workflow is a later mission.</p></aside></div>`;
}
function settings() { return onboarding(); }
function render() {
  if (!STATE) return;
  if (!canEdit(STATE) && (!isOnboarded() || view === 'settings')) { $('#view').innerHTML = top('Read-only access','Evidence you can <em>inspect.</em>','An owner or editor must configure this research workspace. Your viewer role can inspect existing observations.'); return; }
  const templates = {overview, opportunities, evidence, actions, settings, onboarding};
  $('#view').innerHTML = templates[view]();
  wire();
}
function provenance(o) {
  return `<dl class="provenance"><div><dt>Scan run</dt><dd><code>${esc(o.runId)}</code></dd></div><div><dt>Provider / engine</dt><dd>${esc(o.provider)} / ${esc(o.engine)}</dd></div><div><dt>Model / method</dt><dd>${esc(o.model)} / ${esc(o.method)}</dd></div><div><dt>Observed at (UTC)</dt><dd>${esc(o.observedAt || o.createdAt)}</dd></div><div><dt>Location</dt><dd>${esc(locationText(o.location))}</dd></div><div><dt>Language</dt><dd>${esc(o.language)}</dd></div><div><dt>Analysis version</dt><dd>${esc(o.analysisVersion)}</dd></div><div><dt>Observation ID</dt><dd><code>${esc(o.id)}</code></dd></div></dl>`;
}
async function openObs(id) {
  if (!data().some(item => item.id === id)) return;
  openDrawer('<div class="eyebrow">Evidence record</div><h2>Opening original evidence…</h2><p role="status"><span class="spinner"></span> Loading the immutable raw observation.</p>');
  const version = drawerVersion;
  let o;
  try { const result = await request(`/api/observations/${encodeURIComponent(id)}`); o = result.observation || result; }
  catch (error) { if (version === drawerVersion) openDrawer(`<div class="eyebrow">Evidence unavailable</div><h2>Could not open this record.</h2><div class="error-message" role="alert">${esc(error.message)}</div><p>Your evidence has not been changed. Close this panel and try again.</p>`); return; }
  if (version !== drawerVersion) return;
  openDrawer(`<div class="eyebrow">Immutable evidence record</div><h2>${esc(o.prompt)}</h2><span class="chip olive">MEASURED · API WEB SEARCH</span>${provenance(o)}<div class="evidence-verdict"><span>Brand ${o.brandMentioned ? 'mentioned' : 'absent'}</span><span>Own domain ${o.targetCited ? 'cited' : 'not cited'}</span></div><h3>Captured answer</h3><div class="raw">${esc(o.answer || 'No answer text was captured.')}</div><h3>Recorded citation annotations</h3>${o.citations?.length ? o.citations.map(c => { const href = safeUrl(c.url); return href ? `<a class="source-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(c.title || href)} →<small>${esc(href)}</small></a>` : ''; }).join('') : '<p>No URL citations were recorded. A missing citation does not establish a website fault.</p>'}<details class="raw-details"><summary>Original request payload</summary><pre class="raw">${esc(JSON.stringify(o.rawRequest ?? {},null,2))}</pre></details><details class="raw-details"><summary>Raw provider response</summary><pre class="raw">${esc(JSON.stringify(o.rawResponse ?? {},null,2))}</pre></details><details class="raw-details"><summary>Original annotations</summary><pre class="raw">${esc(JSON.stringify(o.annotations ?? [],null,2))}</pre></details><a class="btn btn-dark drawer-export" href="/api/runs/${encodeURIComponent(o.runId)}/export" download>↓ Export full run JSON</a><div class="warning section-note">API observations can differ from consumer ChatGPT. Name matching can confuse businesses with similar names. Review the full answer; a mention is not a verified ranking, endorsement or booking conversion.</div>`);
}
function evidenceButtons(rows) { return rows.map(o => `<button class="record-link" data-obs="${esc(o.id)}"><span>${esc(o.prompt)}</span><small>${esc(shortId(o.runId))} · ${esc(date(o.observedAt || o.createdAt))} · ${o.brandMentioned ? 'Brand mentioned' : 'Brand absent'}</small><span aria-hidden="true">→</span></button>`).join(''); }
function openPrompt(id) {
  const prompt = STATE.project.prompts.find(p => p.id === id); if (!prompt) return;
  const rows = (view === 'evidence' ? selectedObservations() : data()).filter(o => o.promptId === id);
  const missed = rows.filter(o => !o.brandMentioned).length;
  openDrawer(`<div class="eyebrow">Question evidence</div><h2>${esc(prompt.text)}</h2><span class="chip">${esc(prompt.language)} · ${esc(prompt.intent)}</span><p>${rows.length ? `${missed} of ${rows.length} observed responses did not mention ${esc(STATE.project.brand)}.` : 'No successful responses have been captured for this question in the selected cohort.'}</p><div class="warning">Observed absence is a finding. Any explanation of its cause is a hypothesis requiring verification. Repeat comparable observations before judging a change.</div><h3>Exact supporting records</h3>${evidenceButtons(rows) || '<p>No data. Run this question to collect evidence.</p>'}`);
}
function openCompetitor(name) {
  const rows = data().filter(o => o.competitorsMentioned?.includes(name));
  openDrawer(`<div class="eyebrow">Competitive evidence</div><h2>${esc(name)}</h2><p>This name was detected in <strong>${rows.length}/${data().length} successful responses</strong> from the current question cohort. This is a deterministic name match, not market share or a verified recommendation.</p><div class="warning">Check each answer for business identity, context and ambiguity before drawing a competitive conclusion.</div><h3>Exact supporting records</h3>${evidenceButtons(rows)}`);
}
async function openRun(id) {
  const run = STATE.runs?.find(r => r.id === id); if (!run) return;
  const renderRun = (record, observations) => {
    openDrawer(`<div class="eyebrow">Immutable scan run</div><h2>Research run <em>${esc(shortId(record.id))}</em></h2><span class="status ${record.status === 'completed' ? 'yes' : 'sample'}">${esc(record.status.toUpperCase())}</span><dl class="provenance"><div><dt>Run identifier</dt><dd><code>${esc(record.id)}</code></dd></div><div><dt>Provider / engine</dt><dd>${esc(record.provider)} / ${esc(record.engine)}</dd></div><div><dt>Model / method</dt><dd>${esc(record.model)} / ${esc(record.method)}</dd></div><div><dt>Started (UTC)</dt><dd>${esc(record.startedAt)}</dd></div><div><dt>Finished (UTC)</dt><dd>${esc(record.finishedAt || 'In progress')}</dd></div><div><dt>Location</dt><dd>${esc(locationText(record.location))}</dd></div><div><dt>Reserved budget</dt><dd>${money(record.reservedUsd)} · conservative reservation, not actual charges</dd></div></dl><h3>Per-question results</h3>${(record.results || []).map(result => `<div class="run-result"><span class="status ${result.status === 'succeeded' ? 'yes' : result.status === 'failed' ? 'sample' : 'no'}">${esc(result.status)}</span><p>${esc(result.prompt || record.prompts?.find(p => p.id === result.promptId)?.text || result.promptId)}<small>${esc(result.language || '')}</small></p>${result.error ? `<div class="error-message">${esc(result.error.code)}: ${esc(result.error.message)}</div>` : ''}${result.evidence ? `<details class="raw-details"><summary>Inspect preserved failed response evidence</summary><p>This response failed validation and is excluded from measured observations.</p><pre class="raw">${esc(JSON.stringify(result.evidence,null,2))}</pre></details>` : ''}${result.observationId ? `<button class="text-link" data-obs="${esc(result.observationId)}">Inspect captured response →</button>` : '<small>No observation recorded. This result is excluded from mention metrics.</small>'}</div>`).join('')}<details class="raw-details"><summary>Research brief snapshot</summary><pre class="raw">${esc(JSON.stringify(record.projectSnapshot ?? {},null,2))}</pre></details><a class="btn btn-dark drawer-export" href="/api/runs/${encodeURIComponent(record.id)}/export" download>↓ Export run & raw evidence</a><p>Download includes run metadata, per-question outcomes and captured raw responses. API results are not consumer ChatGPT results.</p>`);
  };
  openDrawer('<div class="eyebrow">Scan run</div><h2>Opening the run snapshot…</h2><p role="status"><span class="spinner"></span> Loading exact run metadata.</p>');
  const version = drawerVersion;
  try { const result = await request(`/api/runs/${encodeURIComponent(id)}`); if (version === drawerVersion) renderRun(result.run || result, result.observations || []); }
  catch (error) { if (version === drawerVersion) openDrawer(`<div class="eyebrow">Run unavailable</div><h2>Could not open this run.</h2><div class="error-message" role="alert">${esc(error.message)}</div><p>Close this panel and try again.</p>`); }
}
function openScan() {
  if (!isOnboarded() || scanBusy || STATE.scanInProgress) return;
  const limit = STATE.limits?.maxPromptsPerRun || 5;
  openDrawer(`<div class="eyebrow">Controlled measurement</div><h2>A deliberate next observation.</h2><p>Choose 1–${limit} approved questions. We will send each exact question to OpenAI Responses API web search with the ${esc(STATE.project.city)}, ${esc(STATE.project.country)} location context. Results may differ from consumer ChatGPT.</p>${!STATE.configured ? '<div class="warning"><strong>Server API key required.</strong><br/>Set OPENAI_API_KEY in the local server .env file, or ATLAS_OPENAI_API_KEY in cloud environment settings, then restart npm run dev. Never paste a secret into the browser. Your Codex login does not provide API measurement credits.</div>' : ''}<div class="scan-budget"><strong>${money(STATE.budget?.remainingUsd)} daily reserved budget remaining</strong><p>${money(perPromptReservation())} reserved per selected question. This conservative ceiling is not a measurement of actual provider charges. Reservations remain counted after failures.</p><small>${STATE.budget?.runs || 0}/${STATE.limits?.maxRunsPerDay} runs used · ${esc(STATE.budget?.date)} UTC</small></div><form id="scanForm"><div id="scanError" class="error-message hidden" role="alert" tabindex="-1"></div><fieldset class="scan-questions"><legend>Questions to observe</legend>${STATE.project.prompts.map((p,i) => `<label class="form-check"><input type="checkbox" name="promptId" value="${esc(p.id)}" ${i < limit ? 'checked' : ''}/><span>${esc(p.text)}<small>${esc(p.language)} · ${esc(p.intent)}</small></span></label>`).join('')}</fieldset><div id="scanSelection" class="scan-selection" aria-live="polite"></div><button class="btn btn-dark drawer-export" id="runScanNow" type="submit" ${!STATE.configured ? 'disabled' : ''}>Collect real evidence →</button><div id="scanProgress" class="scan-progress hidden" role="status"><span class="spinner"></span> Collecting answers. Each question can take up to 90 seconds. Keep this window open.</div></form>`);
  const update = () => { const count = $$('#scanForm input:checked').length; const reserved = count*perPromptReservation(); const exhaustedRuns = (STATE.budget?.runs || 0) >= STATE.limits?.maxRunsPerDay; const exceedsBudget = reserved > (STATE.budget?.remainingUsd || 0); $('#scanSelection').textContent = `${count}/${limit} questions selected · ${money(reserved)} budget reservation${count > limit ? ` · Select at most ${limit} questions.` : exhaustedRuns ? ' · Daily run limit reached. Try again after midnight UTC.' : exceedsBudget ? ' · Selection exceeds remaining daily budget. Choose fewer questions or wait until midnight UTC.' : ''}`; $('#runScanNow').disabled = !STATE.configured || count < 1 || count > limit || count*perPromptReservation() > (STATE.budget?.remainingUsd || 0) || (STATE.budget?.runs || 0) >= STATE.limits?.maxRunsPerDay; };
  $$('#scanForm input').forEach(input => input.onchange = update); update();
  $('#scanForm').onsubmit = async event => {
    event.preventDefault(); const chosen = $$('#scanForm input:checked').map(input => input.value); const button = $('#runScanNow');
    button.disabled = true; button.textContent = 'Collecting…'; $('#scanProgress').classList.remove('hidden'); $('#scanError').classList.add('hidden'); $$('#scanForm input').forEach(input => input.disabled = true); scanBusy = true; updateChrome();
    try {
      const result = await request('/api/scan', {method:'POST', body:JSON.stringify({promptIds:chosen})});
      scanBusy = false; closeDrawer(); selectedRun = result.run?.id || 'all'; view = 'evidence'; await load();
      toast(result.queued ? 'Scan queued securely. Questions will be collected one at a time while this workspace is open; interrupted jobs remain recoverable.' : result.failed ? `${result.recorded} captured · ${result.failed} failed. Inspect per-question errors in this run.` : `${result.recorded} real observations captured. Your run is ready to inspect.`);
    } catch (error) {
      scanBusy = false; updateChrome();
      if ($('#scanForm')) { $('#scanError').textContent = error.message; $('#scanError').classList.remove('hidden'); $('#scanError').focus(); $('#scanProgress').classList.add('hidden'); button.textContent = 'Try scan again →'; $$('#scanForm input').forEach(input => input.disabled = false); update(); }
      else toast(error.message);
    }
  };
}
function openAddAction() {
  openDrawer('<div class="eyebrow">Owner-reviewable improvement</div><h2>Make a specific, truthful change.</h2><p>Record the evidence and what the owner needs to verify. This local task list does not publish content.</p><form id="newActionForm" class="form-grid"><div id="actionError" class="error-message hidden wide" role="alert"></div><div class="field wide"><label for="newActionTitle">Action title</label><input id="newActionTitle" required maxlength="160" placeholder="Confirm service availability on the official website"/></div><div class="field wide"><label for="newActionDetail">Evidence and acceptance criteria</label><textarea id="newActionDetail" rows="5" required maxlength="1200" placeholder="Link the observation, identify the fact to verify and describe the owner-approved change."></textarea></div><button class="btn btn-dark" type="submit">Add action →</button></form>');
  $('#newActionForm').onsubmit = async event => { event.preventDefault(); const button = $('#newActionForm button[type="submit"]'); button.disabled = true; try { await request('/api/actions', {method:'POST', body:JSON.stringify({title:$('#newActionTitle').value, detail:$('#newActionDetail').value})}); closeDrawer(); await load(); toast('Action added for human review.'); } catch (error) { $('#actionError').textContent = error.message; $('#actionError').classList.remove('hidden'); button.disabled = false; } };
}
function wireEvidenceLinks(root = document) {
  root.querySelectorAll('[data-obs]').forEach(button => button.onclick = () => openObs(button.dataset.obs));
  root.querySelectorAll('[data-run]').forEach(button => button.onclick = () => openRun(button.dataset.run));
  root.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => openPrompt(button.dataset.prompt));
  root.querySelectorAll('[data-competitor]').forEach(button => button.onclick = () => openCompetitor(button.dataset.competitor));
}
function wire() {
  $$('[data-goto]').forEach(button => button.onclick = () => setView(button.dataset.goto));
  wireEvidenceLinks($('#view'));
  $$('[data-filter]').forEach(button => button.onclick = () => { evidenceFilter = button.dataset.filter; render(); });
  $('#runPicker')?.addEventListener('change', event => { selectedRun = event.target.value; render(); });
  $('#opportunitySearch')?.addEventListener('input', event => { search = event.target.value; $('#opportunityGrid').innerHTML = opportunityCards(); wireEvidenceLinks($('#opportunityGrid')); });
  $$('[data-action]').forEach(button => button.onclick = async () => { button.disabled = true; try { await request('/api/actions/toggle', {method:'POST', body:JSON.stringify({id:button.dataset.action})}); await load(); } catch (error) { button.disabled = false; toast(error.message); } });
  $('#addAction')?.addEventListener('click', openAddAction);
  if (!canEdit(STATE)) $$('#addAction, [data-action]').forEach(button => button.disabled = true);
  $('#previousStep')?.addEventListener('click', () => { captureDraft(); onboardingStep--; render(); $('.page-title')?.focus(); });
  $$('[data-edit-step]').forEach(button => button.onclick = () => { onboardingStep = Number(button.dataset.editStep); render(); $('.page-title')?.focus(); });
  $('#addQuestion')?.addEventListener('click', () => { captureDraft(); const languages = draftLanguages(); draft.prompts.push({text:'', language:languages.length === 1 ? languages[0] : '', intent:'Discovery'}); render(); $(`#question-${draft.prompts.length-1}`).focus(); });
  $$('[data-remove-question]').forEach(button => button.onclick = () => { captureDraft(); draft.prompts.splice(Number(button.dataset.removeQuestion),1); render(); $('#addQuestion').focus(); });
  $('#onboardingForm')?.addEventListener('submit', async event => {
    event.preventDefault(); captureDraft(); const error = validateDraftStep(); if (error) return setupError(error);
    if (onboardingStep < 3) { onboardingStep++; render(); $('.page-title')?.focus(); return; }
    const button = $('#continueSetup'); button.disabled = true; button.textContent = 'Saving reviewed brief…';
    try {
      await request(editing ? '/api/project' : '/api/onboarding', {method:editing ? 'PATCH' : 'POST', body:JSON.stringify({...draft, languages:draftLanguages(), competitors:draft.competitors.split('\n').map(x => x.trim()).filter(Boolean), prompts:draft.prompts})});
      const wasEditing = editing; draft = null; editing = false; view = 'overview'; selectedRun = 'all'; await load();
      toast(wasEditing ? 'Research brief saved. Review your clean baseline before scanning.' : 'Workspace created. Review your budget and choose your first scan.');
    } catch (error) { setupError(error.message); button.disabled = false; button.textContent = editing ? 'Save reviewed changes →' : 'Create research workspace →'; }
  });
}
$$('[data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
$('#scanBtn').onclick = openScan;
$('#exportBtn').onclick = () => { window.location.href = '/api/export'; };
$('#drawerBackdrop').onclick = closeDrawer;
$('#closeDrawer').onclick = closeDrawer;
document.addEventListener('keydown', event => {
  if ($('#drawer').classList.contains('hidden')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
  if (event.key === 'Tab') {
    const nodes = $$('#drawer button:not(:disabled), #drawer a[href], #drawer input:not(:disabled), #drawer select:not(:disabled), #drawer textarea:not(:disabled), #drawer summary').filter(node => node.offsetParent !== null);
    const first = nodes[0], last = nodes.at(-1);
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
});
async function start() {
  $('#view').innerHTML = '<div class="loading-state" role="status"><span class="spinner"></span><p>Preparing your research workspace…</p></div>';
  try { await load(); } catch (error) { if (renderAccountGate(error, switchWorkspace)) return; $('#view').innerHTML = top('Connection unavailable','Your evidence stays <em>where you left it.</em>','The server could not load your workspace.') + `<div class="error-message" role="alert">${esc(error.message)}</div><button class="btn btn-dark section-note" id="retryLoad">Try again →</button>`; $('#retryLoad').onclick = start; }
}
start();
