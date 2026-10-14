import crypto from 'node:crypto';
import {isIP} from 'node:net';
import {brandMentioned, normalize} from './analyze.js';

const COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const INTENTS = new Set(['High intent', 'Discovery', 'Comparison']);
const NONPUBLIC_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'private', 'corp', 'lan', 'home', 'home.arpa', 'test', 'invalid', 'example', 'onion', 'arpa'];
const ISO_LANGUAGES = ('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' ');
const languageNames = new Intl.DisplayNames('en', {type: 'language', fallback: 'none'});
const regionNames = new Intl.DisplayNames('en', {type: 'region', fallback: 'none'});
const scriptNames = new Intl.DisplayNames('en', {type: 'script', fallback: 'none'});
const LANGUAGE_BY_CODE = new Map(ISO_LANGUAGES.map(code => {
  const canonical = new Intl.Locale(code).language;
  return [canonical, languageNames.of(canonical)];
}));
const LANGUAGE_BY_NAME = new Map([...LANGUAGE_BY_CODE.values()].filter(Boolean).map(name => [normalize(name), name]));

function error(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

function text(value, label, max) {
  if (typeof value !== 'string') throw error(`${label} must be text.`);
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!result || result.length > max || /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(result)) {
    throw error(`${label} must contain 1–${max} characters without hidden control characters.`);
  }
  return result;
}

function publicWebsite(value) {
  const website = text(value, 'Business URL', 2048);
  let url;
  try { url = new URL(website); } catch { throw error('Business URL must be a complete HTTP(S) URL, preferably https://.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw error('Business URL must use HTTP(S) and cannot contain a username or password.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const address = hostname.replace(/^\[|\]$/gu, '');
  const labels = hostname.split('.');
  if (isIP(address) || labels.length < 2 || hostname.length > 253 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      !/[a-z]/u.test(labels.at(-1)) ||
      NONPUBLIC_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)) ||
      ['metadata.google.internal', 'metadata.aws.internal', 'metadata.azure.internal', 'instance-data.ec2.internal'].includes(hostname)) {
    throw error('Business URL must use a public website hostname; IP addresses, local/private names and metadata hosts are not allowed.');
  }
  // This is an owner-confirmed address, never a fetch or proof of site ownership.
  // A future site audit must also validate DNS and every redirect before fetching.
  url.hostname = hostname;
  url.hash = '';
  return url.href;
}

// Language becomes a provider instruction. Accept language identifiers only,
// never arbitrary prose, private-use tags, variants or instruction-like text.
// Names are standard English names for ISO 639-1 languages; tags may add a
// recognized script and/or country/UN region (e.g. cs, en-US, zh-Hans, es-419).
export function validateResearchLanguage(value, label = 'Research language') {
  const language = text(value, label, 40);
  const knownName = LANGUAGE_BY_NAME.get(normalize(language));
  if (knownName) return knownName;
  const invalid = () => error(`${label} must be a recognized language name or language code, such as Czech, English, cs or en-US. Do not include instructions.`);
  if (!/^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/iu.test(language)) throw invalid();
  let locale;
  try { locale = new Intl.Locale(language); } catch { throw invalid(); }
  const canonicalName = LANGUAGE_BY_CODE.get(locale.language);
  if (!canonicalName || (locale.script && (!scriptNames.of(locale.script) || locale.script === 'Zzzz')) ||
      (locale.region && (locale.region.length === 2 ? !COUNTRIES.has(locale.region) : !regionNames.of(locale.region)))) throw invalid();
  return locale.script || locale.region ? locale.toString() : canonicalName;
}

export function validatePrompt(input, project) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Each buyer question must include text and language.');
  const promptText = text(input.text, 'Buyer question', 350);
  const language = validateResearchLanguage(input.language, 'Question language');
  const selectedLanguage = project.languages.find(item => normalize(item) === normalize(language));
  if (!selectedLanguage) throw error('Every question language must be one of the workspace languages.');
  const intent = input.intent === undefined ? 'Discovery' : text(input.intent, 'Question intent', 40);
  if (!INTENTS.has(intent)) throw error('Question intent must be High intent, Discovery or Comparison.');
  if (brandMentioned(promptText, [project.brand, ...project.competitors])) {
    throw error('Buyer questions must be unbranded. Remove your business and competitor names from the question.');
  }
  return {id: crypto.randomUUID(), text: promptText, language: selectedLanguage, intent, area: project.city};
}

export function validateProject(input, {maxPrompts = 15} = {}) {
  if (!Number.isInteger(maxPrompts) || maxPrompts < 8 || maxPrompts > 15) throw error('Workspace question limit must be between 8 and 15.', 500);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Enter a business profile before scanning.');
  const brand = text(input.brand, 'Business name', 200);
  const domain = publicWebsite(input.domain);
  if (input.urlConfirmed !== true) throw error('Confirm that the business URL is correct before continuing. This confirmation does not verify site ownership.');
  const country = text(input.country, 'Country', 2).toUpperCase();
  if (!COUNTRIES.has(country)) throw error('Country must be a valid two-letter ISO country code, such as CZ.');
  const city = text(input.city, 'City', 120);
  const timezone = text(input.timezone === undefined ? 'Europe/Prague' : input.timezone, 'Timezone', 100);
  try { new Intl.DateTimeFormat('en', {timeZone: timezone}).format(); }
  catch { throw error('Timezone must be a valid IANA timezone, such as Europe/Prague.'); }
  if (!Array.isArray(input.languages) || input.languages.length < 1 || input.languages.length > 5) throw error('Select 1–5 research languages.');
  const languages = input.languages.map(language => validateResearchLanguage(language));
  if (new Set(languages.map(normalize)).size !== languages.length) throw error('Research languages must be unique.');
  if (!Array.isArray(input.competitors) || input.competitors.length < 2 || input.competitors.length > 5) throw error('Enter 2–5 real competitor names.');
  const competitors = input.competitors.map(name => text(name, 'Competitor name', 100));
  if (new Set(competitors.map(normalize)).size !== competitors.length || competitors.some(name => normalize(name) === normalize(brand))) {
    throw error('Competitor names must be unique and different from your business name.');
  }
  if (!Array.isArray(input.prompts) || input.prompts.length < 8 || input.prompts.length > maxPrompts) throw error(`Review 8–${maxPrompts} unbranded buyer questions before continuing.`);
  const project = {brand, domain, urlConfirmed: true, urlVerification: {method: 'owner_confirmation', confirmedAt: new Date().toISOString()}, country, city, languages, timezone, competitors};
  const prompts = input.prompts.map(prompt => validatePrompt(prompt, project));
  if (new Set(prompts.map(prompt => `${normalize(prompt.language)}\u0000${normalize(prompt.text)}`)).size !== prompts.length) {
    throw error('Buyer questions must be unique within each language.');
  }
  return {...project, prompts, aliases: [], onboarded: true};
}

function setting(env, name, fallback, {min = 0, max = Number.MAX_SAFE_INTEGER / 100, integer = false, exclusiveMin = false} = {}) {
  if (env[name] === undefined) return fallback;
  const raw = env[name];
  const value = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim())) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || (exclusiveMin ? value <= min : value < min) || value > max) {
    throw error(`Invalid ${name}: configure ${integer ? 'a whole number' : 'a finite number'} ${exclusiveMin ? 'greater than' : 'at least'} ${min}${max < Number.MAX_SAFE_INTEGER / 100 ? ` and no more than ${max}` : ''}.`, 500);
  }
  return value;
}

export function readLimits(env = process.env) {
  const maxPrompts = setting(env, 'ATLAS_MAX_PROMPTS', 15, {min: 8, max: 15, integer: true});
  return {
    dailySpendCapUsd: setting(env, 'ATLAS_DAILY_SPEND_CAP_USD', 1, {exclusiveMin: true}),
    maxPrompts,
    maxPromptsPerRun: setting(env, 'ATLAS_MAX_PROMPTS_PER_RUN', Math.min(5, maxPrompts), {min: 1, max: maxPrompts, integer: true}),
    maxRunsPerDay: setting(env, 'ATLAS_MAX_RUNS_PER_DAY', 5, {min: 1, integer: true}),
    reservationPerPromptUsd: setting(env, 'ATLAS_RESERVATION_PER_PROMPT_USD', 0.05, {min: 0.05, max: Number.MAX_SAFE_INTEGER / 1500}),
    maxOutputTokens: setting(env, 'ATLAS_MAX_OUTPUT_TOKENS', 1200, {min: 1, max: 2000, integer: true})
  };
}

function today(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw error('Cannot determine the current daily budget window.', 500);
  return now.toISOString().slice(0, 10);
}

// All reservations use cents, rounded up, so accounting cannot lose small charges
// through floating-point summation. A failed/timed-out request retains its reserve.
function cents(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) throw error('Usage reservation is invalid; scanning is disabled until the local ledger is repaired.', 500);
  const result = Math.ceil(Number((value * 100).toPrecision(15)));
  if (!Number.isSafeInteger(result)) throw error('Usage reservation is too large.', 500);
  return result;
}

export function budgetFor(state, limits, now = new Date()) {
  const date = today(now);
  if (state.usage !== undefined && !Array.isArray(state.usage)) throw error('Usage ledger is invalid; scanning is disabled until it is repaired.', 500);
  const usage = state.usage ?? [];
  let reservedCents = 0;
  let runs = 0;
  const runIds = new Set();
  for (const entry of usage) {
    if (!entry || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.date) || !Number.isFinite(Date.parse(`${entry.date}T00:00:00.000Z`)) || new Date(`${entry.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== entry.date || typeof entry.runId !== 'string' || !entry.runId || runIds.has(entry.runId)) {
      throw error('Usage ledger is invalid; scanning is disabled until it is repaired.', 500);
    }
    runIds.add(entry.runId);
    const reserved = cents(entry.reservedUsd);
    if (reserved === 0) throw error('Usage ledger contains an invalid zero reservation.', 500);
    if (entry.date === date) { reservedCents += reserved; runs++; }
  }
  if (!Number.isSafeInteger(reservedCents)) throw error('Usage ledger total is invalid.', 500);
  return {date, reservedUsd: reservedCents / 100, remainingUsd: Math.max(0, Number((limits.dailySpendCapUsd - reservedCents / 100).toFixed(10))), runs};
}

export function reserveRun(state, limits, promptCount, runId, now = new Date()) {
  if (!Number.isInteger(promptCount) || promptCount < 1 || promptCount > limits.maxPromptsPerRun) throw error(`Select 1–${limits.maxPromptsPerRun} questions per scan.`);
  if (typeof runId !== 'string' || !runId) throw error('A scan identifier is required.', 500);
  const budget = budgetFor(state, limits, now);
  if ((state.usage ?? []).some(entry => entry.runId === runId)) throw error('This scan already has a budget reservation.', 409);
  if (budget.runs >= limits.maxRunsPerDay) throw error(`Daily scan limit reached (${limits.maxRunsPerDay}). The next budget window begins at 00:00 UTC.`, 429);
  const reservedCents = cents(limits.reservationPerPromptUsd) * promptCount;
  if (!Number.isSafeInteger(reservedCents)) throw error('Scan reservation is too large.', 500);
  const reservedUsd = reservedCents / 100;
  if (reservedUsd > budget.remainingUsd) throw error(`Daily spend cap reached. This scan needs a $${reservedUsd.toFixed(2)} reservation; $${budget.remainingUsd.toFixed(2)} remains today.`, 429);
  state.usage ??= [];
  state.usage.push({date: budget.date, runId, reservedUsd});
  return {reservedUsd, budget: budgetFor(state, limits, now)};
}
