import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAtlasServer } from '../server.js';
import { ProviderError } from '../src/providers/openai.js';

// The real local HTTP/persistence layers are exercised against a controlled
// provider fixture. These tests do not claim successful external API access.
const TEST_KEY = 'test-key-not-a-real-api-secret';
const questions = [
  'Which Prague salons offer facial treatments for sensitive skin?',
  'Where can I book an English-speaking beauty therapist in Prague?',
  'What should I compare when choosing a Prague facial salon?',
  'Which Prague beauty studios provide transparent treatment prices?',
  'Where can I find evening facial appointments in Prague?',
  'Which Prague salons explain their skincare consultation process?',
  'Where can I book a relaxing facial near central Prague?',
  'How should I choose a professional beauty salon in Prague?'
];

function onboarding(overrides = {}) {
  return {
    brand: 'Real Salon', domain: 'https://example.com', urlConfirmed: true,
    country: 'CZ', city: 'Prague', languages: ['English'], timezone: 'Europe/Prague',
    competitors: ['Rival Studio', 'Other Salon'],
    prompts: questions.map(text => ({ text, language: 'English', intent: 'High intent' })),
    ...overrides
  };
}

function evidence({ prompt, project }) {
  const answer = `${project.brand} and Rival Studio offer relevant treatments. Check the cited official information.`;
  const annotations = [{ type: 'url_citation', url: `${project.domain}/services`, title: 'Official services', start_index: 0, end_index: project.brand.length }];
  const rawRequest = { model: 'gpt-4.1-mini', input: prompt.text, tools: [{ type: 'web_search' }], tool_choice: 'required' };
  const rawResponse = {
    id: `fixture-${prompt.id}`, object: 'response', model: 'gpt-4.1-mini', status: 'completed',
    output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', query: prompt.text } },
      { type: 'message', status: 'completed', content: [{ type: 'output_text', text: answer, annotations }] }],
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 }
  };
  return {
    provider: 'openai', model: 'gpt-4.1-mini', method: 'api', engine: 'OpenAI Responses API · web_search',
    observedAt: '2026-10-14T09:00:00.000Z',
    location: { country: project.country, city: project.city, timezone: project.timezone },
    rawRequest, rawResponse, answer, annotations,
    citations: annotations.map(({ url, title }) => ({ url, title })),
    analysisVersion: '1.0.0', usage: rawResponse.usage
  };
}

function adapter(collect = async args => evidence(args)) {
  return { provider: 'openai', model: 'gpt-4.1-mini', method: 'api', engine: 'OpenAI Responses API · web_search', collect };
}

async function serve(t, options = {}) {
  const runtimeDir = options.runtimeDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-http-test-'));
  const server = createAtlasServer({ runtimeDir, adapter: adapter(), env: { OPENAI_API_KEY: TEST_KEY }, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  t.after(async () => {
    await close();
    if (!options.runtimeDir) await fs.rm(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', body, headers = {} } = {}) {
    // fetch controls Host itself; use node:http to exercise Host validation.
    if (headers.Host) return new Promise((resolve, reject) => {
      const req = httpRequest(base + route, { method, headers }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          let data;
          try { data = JSON.parse(text); } catch { data = text; }
          resolve({ status: response.statusCode, data, text, headers: response.headers });
        });
      });
      req.once('error', reject);
      req.end();
    });
    const response = await fetch(base + route, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text, headers: response.headers };
  }
  return { request, close, runtimeDir, base };
}

async function onboard(request, value = onboarding()) {
  const result = await request('/api/onboarding', { method: 'POST', body: value });
  assert.equal(result.status, 200, `onboarding failed: ${result.text}`);
  const state = (await request('/api/state')).data;
  assert.equal(state.project.brand, value.brand);
  return state;
}

async function scan(request, promptIds) {
  return request('/api/scan', { method: 'POST', body: { promptIds } });
}

function message(result) {
  return typeof result.data?.error === 'string' ? result.data.error : result.data?.error?.message ?? result.text;
}

test('new workspace and reviewed onboarding never inherit sample metrics', async t => {
  const { request } = await serve(t);
  const initial = await request('/api/state');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.metrics.source, 'empty');
  assert.equal(initial.data.metrics.observations, 0);
  assert.deepEqual(initial.data.observations, []);
  assert.deepEqual(initial.data.runs, []);
  const state = await onboard(request);
  assert.equal(state.project.prompts.length, 8);
  assert.equal(state.project.urlConfirmed, true);
  assert.deepEqual(state.project.languages, ['English']);
  assert.deepEqual(state.project.competitors, ['Rival Studio', 'Other Salon']);
  assert.equal(new Set(state.project.prompts.map(prompt => prompt.id)).size, 8);
  assert.equal(state.metrics.source, 'empty');
  assert.equal(state.metrics.observations, 0);
  assert.deepEqual(state.observations, []);
  assert.deepEqual(state.runs, []);
  assert.equal(JSON.stringify(state).includes(TEST_KEY), false);
});

test('onboarding validates reviewed business and unbranded discovery questions atomically', async t => {
  const { request } = await serve(t);
  const cases = [
    ['unconfirmed website', { urlConfirmed: false }],
    ['invalid URL', { domain: 'javascript:alert(1)' }],
    ['URL with credentials', { domain: 'https://user:password@realsalon.example' }],
    ['missing country', { country: '' }],
    ['missing city', { city: '' }],
    ['no languages', { languages: [] }],
    ['one competitor', { competitors: ['Rival Studio'] }],
    ['too many competitors', { competitors: ['A', 'B', 'C', 'D', 'E', 'F'] }],
    ['too few questions', { prompts: onboarding().prompts.slice(0, 7) }],
    ['too many questions', { prompts: Array.from({ length: 16 }, (_, index) => ({ text: `Which Prague salon offers treatment number ${index}?`, language: 'English', intent: 'Discovery' })) }],
    ['branded question', { prompts: onboarding().prompts.map((prompt, index) => index ? prompt : { ...prompt, text: 'Why choose Real Salon in Prague?' }) }],
    ['duplicate question', { prompts: onboarding().prompts.map((prompt, index, all) => index ? prompt : all[1]) }]
  ];
  for (const [label, overrides] of cases) {
    const result = await request('/api/onboarding', { method: 'POST', body: onboarding(overrides) });
    assert.equal(result.status, 400, `${label}: ${result.text}`);
    assert.ok(message(result).length > 0, label);
  }
  const clean = (await request('/api/state')).data;
  assert.equal(clean.metrics.source, 'empty');
  assert.equal(clean.observations.length, 0);
  assert.equal(clean.runs.length, 0);
  await onboard(request);
});

test('measured run retains raw evidence, provenance and export by immutable run ID', async t => {
  const received = [];
  const { request } = await serve(t, { adapter: adapter(async args => { received.push(structuredClone(args)); return evidence(args); }) });
  const state = await onboard(request);
  const ids = state.project.prompts.slice(0, 2).map(prompt => prompt.id);
  const result = await scan(request, ids);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.recorded, 2);
  assert.equal(result.data.failed, 0);
  assert.equal(result.data.run.status, 'completed');
  const runId = result.data.run.id;
  assert.equal(typeof runId, 'string');
  const run = await request(`/api/runs/${runId}`);
  assert.equal(run.status, 200);
  assert.equal(run.data.run.id, runId);
  assert.equal(run.data.observations.length, 2);
  assert.deepEqual(received.map(item => item.prompt.id), ids);
  assert.equal(received[0].prompt.text, questions[0]);
  assert.equal(received[0].project.city, 'Prague');
  for (const observation of run.data.observations) {
    assert.equal(observation.runId, runId);
    assert.equal(observation.mode, 'live');
    assert.equal(observation.provider, 'openai');
    assert.equal(observation.method, 'api');
    assert.equal(observation.model, 'gpt-4.1-mini');
    assert.match(observation.engine, /Responses API/);
    assert.equal(observation.location.country, 'CZ');
    assert.equal(observation.location.city, 'Prague');
    assert.ok(Number.isFinite(Date.parse(observation.observedAt ?? observation.createdAt)));
    assert.ok(observation.analysisVersion);
    assert.equal(observation.brandMentioned, true);
    assert.equal(observation.targetCited, true);
    assert.deepEqual(observation.competitorsMentioned, ['Rival Studio']);
    assert.deepEqual(observation.annotations, evidence({ prompt: received.find(item => item.prompt.id === observation.promptId).prompt, project: state.project }).annotations);
    assert.ok(observation.rawResponse.output.some(item => item.type === 'web_search_call'));
    assert.equal(observation.rawRequest.input, observation.prompt);
    const detail = await request(`/api/observations/${observation.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.observation ?? detail.data, observation);
  }
  const exported = await request(`/api/runs/${runId}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /application\/json/);
  assert.deepEqual(exported.data.observations, run.data.observations);
  assert.equal(exported.data.run.id, runId);
  assert.equal(exported.text.includes(TEST_KEY), false);
  const snapshot = structuredClone(run.data);
  const second = await scan(request, [ids[0]]);
  assert.equal(second.status, 200);
  assert.notEqual(second.data.run.id, runId);
  assert.deepEqual((await request(`/api/runs/${runId}`)).data, snapshot);
  const fresh = (await request('/api/state')).data;
  assert.equal(fresh.metrics.source, 'live');
  assert.equal(fresh.observations.length, 3);
  assert.equal(fresh.observations.some(observation => observation.mode === 'sample'), false);
  const update = await request(`/api/observations/${run.data.observations[0].id}`, { method: 'PATCH', body: { answer: 'Altered' } });
  assert.ok([404, 405].includes(update.status));
  assert.deepEqual((await request(`/api/runs/${runId}`)).data, snapshot);
});

test('partial failures retain success and identify no-data prompts with useful errors', async t => {
  let count = 0;
  const { request } = await serve(t, { adapter: adapter(async args => {
    count += 1;
    if (count === 2) throw new ProviderError('RATE_LIMITED', 'OpenAI rate or billing quota limit reached. Check billing and retry later.', { retryable: true });
    return evidence(args);
  }) });
  const state = await onboard(request);
  const ids = state.project.prompts.slice(0, 3).map(prompt => prompt.id);
  const result = await scan(request, ids);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.run.status, 'partial');
  assert.equal(result.data.recorded, 2);
  assert.equal(result.data.failed, 1);
  const details = (await request(`/api/runs/${result.data.run.id}`)).data;
  assert.equal(details.observations.length, 2);
  assert.equal(details.observations.some(item => item.promptId === ids[1]), false);
  const failed = details.run.results.find(item => item.promptId === ids[1]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'RATE_LIMITED');
  assert.match(failed.error.message, /billing|quota|rate/i);
  const fresh = (await request('/api/state')).data;
  assert.equal(fresh.metrics.observations, 2);
  assert.equal(fresh.observations.length, 2);
});

test('invalid API key records a failed run without fabricated observations or key disclosure', async t => {
  const { request } = await serve(t, { adapter: adapter(async () => {
    throw new ProviderError('INVALID_API_KEY', 'OpenAI rejected the API key. Set a valid OPENAI_API_KEY on the server and restart.');
  }) });
  const state = await onboard(request);
  const result = await scan(request, [state.project.prompts[0].id]);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.run.status, 'failed');
  assert.equal(result.data.recorded, 0);
  assert.equal(result.data.failed, 1);
  const failure = result.data.run.results[0];
  assert.equal(failure.error.code, 'INVALID_API_KEY');
  assert.match(failure.error.message, /OPENAI_API_KEY/);
  const current = await request('/api/state');
  assert.equal(current.data.metrics.source, 'empty');
  assert.deepEqual(current.data.observations, []);
  assert.equal(result.text.includes(TEST_KEY), false);
  assert.equal(current.text.includes(TEST_KEY), false);
});

test('missing API key blocks before creating a run or calling the adapter', async t => {
  let called = 0;
  const { request } = await serve(t, { env: {}, adapter: adapter(async args => { called += 1; return evidence(args); }) });
  const state = await onboard(request);
  const result = await scan(request, [state.project.prompts[0].id]);
  assert.equal(result.status, 400, result.text);
  assert.match(message(result), /OPENAI_API_KEY/);
  assert.equal(called, 0);
  const current = (await request('/api/state')).data;
  assert.deepEqual(current.runs, []);
  assert.deepEqual(current.observations, []);
});

test('invalid prompt selections and unknown evidence IDs cannot manufacture data', async t => {
  let called = 0;
  const { request } = await serve(t, { adapter: adapter(async args => { called += 1; return evidence(args); }) });
  const state = await onboard(request);
  for (const ids of [[], ['nonexistent'], [state.project.prompts[0].id, 'nonexistent'], [state.project.prompts[0].id, state.project.prompts[0].id]]) {
    const result = await scan(request, ids);
    assert.equal(result.status, 400, result.text);
  }
  assert.equal(called, 0);
  for (const route of ['/api/runs/nonexistent', '/api/runs/nonexistent/export', '/api/observations/nonexistent']) {
    assert.equal((await request(route)).status, 404);
  }
});

test('local API blocks foreign hosts and cross-origin mutations', async t => {
  const { request } = await serve(t);
  const foreignHost = await request('/api/state', { headers: { Host: 'atlas.attacker.example' } });
  assert.equal(foreignHost.status, 403);
  const foreignOrigin = await request('/api/onboarding', { method: 'POST', body: onboarding(), headers: { Origin: 'https://attacker.example' } });
  assert.equal(foreignOrigin.status, 403);
  const state = (await request('/api/state')).data;
  assert.equal(state.metrics.source, 'empty');
  assert.deepEqual(state.observations, []);
});

test('prompt and per-run caps reject excess work before any provider call', async t => {
  let called = 0;
  const { request } = await serve(t, {
    limits: { maxPrompts: 8, maxPromptsPerRun: 2 },
    adapter: adapter(async args => { called += 1; return evidence(args); })
  });
  const tooMany = await request('/api/onboarding', { method: 'POST', body: onboarding({
    prompts: [...onboarding().prompts, { text: 'Which Prague salon offers weekend appointments?', language: 'English', intent: 'Discovery' }]
  }) });
  assert.ok([400, 429].includes(tooMany.status), tooMany.text);
  const state = await onboard(request);
  const extra = await request('/api/prompts', { method: 'POST', body: {
    text: 'Which Prague salon offers weekend appointments?', language: 'English', intent: 'Discovery'
  } });
  assert.ok([400, 429].includes(extra.status), extra.text);
  const oversized = await scan(request, state.project.prompts.slice(0, 3).map(prompt => prompt.id));
  assert.equal(oversized.status, 429, oversized.text);
  assert.equal(called, 0);
  const current = (await request('/api/state')).data;
  assert.equal(current.project.prompts.length, 8);
  assert.deepEqual(current.runs, []);
});

test('daily spend reservation and run allowance survive a process restart', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-budget-test-'));
  const limits = { dailySpendCapUsd: 0.05, reservationPerPromptUsd: 0.05, maxRunsPerDay: 5 };
  let called = 0;
  const mock = adapter(async args => { called += 1; return evidence(args); });
  const first = await serve(t, { runtimeDir, limits, adapter: mock });
  const state = await onboard(first.request);
  const ids = state.project.prompts.slice(0, 2).map(prompt => prompt.id);
  const oversized = await scan(first.request, ids);
  assert.equal(oversized.status, 429, oversized.text);
  assert.match(message(oversized), /spend|budget|cap/i);
  assert.equal(called, 0);
  const allowed = await scan(first.request, [ids[0]]);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(called, 1);
  const denied = await scan(first.request, [ids[1]]);
  assert.equal(denied.status, 429, denied.text);
  await first.close();
  const restarted = await serve(t, { runtimeDir, limits, adapter: mock });
  const persisted = (await restarted.request('/api/state')).data;
  assert.equal(persisted.observations.length, 1);
  assert.equal(persisted.runs.length, 1);
  const afterRestart = await scan(restarted.request, [ids[1]]);
  assert.equal(afterRestart.status, 429, afterRestart.text);
  assert.equal(called, 1);
  await restarted.close();
  // Raise the spend cap so this restart specifically proves the run allowance
  // is persisted, independently of the exhausted monetary reservation.
  const runLimited = await serve(t, { runtimeDir, limits: { ...limits, dailySpendCapUsd: 1, maxRunsPerDay: 1 }, adapter: mock });
  const dailyRunLimit = await scan(runLimited.request, [ids[1]]);
  assert.equal(dailyRunLimit.status, 429, dailyRunLimit.text);
  assert.match(message(dailyRunLimit), /scan limit|run|quota/i);
  assert.equal(called, 1);
  await runLimited.close();
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

test('unexpected provider errors remain actionable without disclosing upstream secrets', async t => {
  const { request } = await serve(t, { adapter: adapter(async () => {
    throw new Error(`network detail: Authorization Bearer ${TEST_KEY}`);
  }) });
  const state = await onboard(request);
  const result = await scan(request, [state.project.prompts[0].id]);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.run.status, 'failed');
  assert.equal(result.data.run.results[0].error.code, 'COLLECTION_FAILED');
  assert.match(result.data.run.results[0].error.message, /config|retry/i);
  assert.equal(result.text.includes(TEST_KEY), false);
  const exported = await request(`/api/runs/${result.data.run.id}/export`);
  assert.equal(exported.text.includes(TEST_KEY), false);
  assert.equal((await request('/api/state')).text.includes(TEST_KEY), false);
});

test('failed provider requests still consume their conservative daily reservation', async t => {
  let called = 0;
  const { request } = await serve(t, {
    limits: { dailySpendCapUsd: 0.05, reservationPerPromptUsd: 0.05 },
    adapter: adapter(async () => {
      called += 1;
      throw new ProviderError('PROVIDER_TIMEOUT', 'OpenAI timed out; review provider usage before retrying.');
    })
  });
  const state = await onboard(request);
  const first = await scan(request, [state.project.prompts[0].id]);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.run.status, 'failed');
  const retry = await scan(request, [state.project.prompts[0].id]);
  assert.equal(retry.status, 429, retry.text);
  assert.equal(called, 1);
  assert.equal((await request('/api/state')).data.metrics.source, 'empty');
});

test('concurrent scans and business edits cannot race quota reservation or rewrite scan context', { timeout: 10000 }, async t => {
  let signalStarted;
  let release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let called = 0;
  const { request } = await serve(t, {
    limits: { maxRunsPerDay: 1 },
    adapter: adapter(async args => {
      called += 1;
      signalStarted();
      await gate;
      return evidence(args);
    })
  });
  const state = await onboard(request);
  const first = scan(request, [state.project.prompts[0].id]);
  await started;
  try {
    const raced = await scan(request, [state.project.prompts[1].id]);
    assert.equal(raced.status, 409, raced.text);
    const edit = await request('/api/project', { method: 'PATCH', body: onboarding({ brand: 'Changed Salon' }) });
    assert.equal(edit.status, 409, edit.text);
    const replace = await request('/api/onboarding', { method: 'POST', body: onboarding({ brand: 'Changed Salon' }) });
    assert.equal(replace.status, 409, replace.text);
    const prompt = await request('/api/prompts', { method: 'POST', body: {
      text: 'Which Prague salon offers a first consultation?', language: 'English', intent: 'Discovery'
    } });
    assert.equal(prompt.status, 409, prompt.text);
  } finally {
    release();
    await first;
  }
  const current = (await request('/api/state')).data;
  assert.equal(current.project.brand, 'Real Salon');
  assert.equal(current.runs.length, 1);
  assert.equal(current.observations.length, 1);
  assert.equal(current.observations[0].brandMentioned, true);
  const afterComplete = await scan(request, [state.project.prompts[1].id]);
  assert.equal(afterComplete.status, 429, afterComplete.text);
  assert.match(message(afterComplete), /run|limit|quota/i);
  assert.equal(called, 1);
});

test('a changed business gets empty evidence without resetting the workspace daily run allowance', async t => {
  const { request } = await serve(t, { limits: { maxRunsPerDay: 1 } });
  const original = await onboard(request);
  const measured = await scan(request, [original.project.prompts[0].id]);
  assert.equal(measured.status, 200, measured.text);
  const runId = measured.data.run.id;
  const changed = await request('/api/project', { method: 'PATCH', body: onboarding({
    brand: 'New Business', domain: 'https://example.org', city: 'Brno'
  }) });
  assert.equal(changed.status, 200, changed.text);
  const state = (await request('/api/state')).data;
  assert.equal(state.project.brand, 'New Business');
  assert.equal(state.metrics.source, 'empty');
  assert.deepEqual(state.observations, []);
  assert.deepEqual(state.runs, []);
  assert.equal((await request(`/api/runs/${runId}`)).status, 404);
  const blocked = await scan(request, [state.project.prompts[0].id]);
  assert.equal(blocked.status, 429, blocked.text);
});

test('a second server cannot share writable runtime state or bypass the persisted daily quota', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-owner-test-'));
  const handles = [];
  let called = 0;
  const options = {
    runtimeDir, limits: { maxRunsPerDay: 1 },
    adapter: adapter(async args => { called += 1; return evidence(args); })
  };
  try {
    const first = await serve(t, options);
    handles.push(first);
    const initial = await onboard(first.request);
    const ids = [initial.project.prompts[0].id];
    const second = await serve(t, options);
    handles.push(second);
    const blockedState = await second.request('/api/state');
    assert.ok([500, 503].includes(blockedState.status), blockedState.text);
    assert.equal((await first.request('/api/state')).status, 200);
    const measured = await scan(first.request, ids);
    assert.equal(measured.status, 200, measured.text);
    assert.equal(measured.data.recorded, 1);
    const blockedScan = await scan(second.request, ids);
    assert.ok([500, 503].includes(blockedScan.status), blockedScan.text);
    assert.equal(called, 1);

    await first.close();
    // An instance that failed ownership acquisition does not silently recover
    // with an uninitialized or stale copy of the persisted evidence.
    assert.ok([500, 503].includes((await second.request('/api/state')).status));
    await second.close();
    const restarted = await serve(t, options);
    handles.push(restarted);
    const retained = await restarted.request('/api/state');
    assert.equal(retained.status, 200, retained.text);
    assert.equal(retained.data.runs.length, 1);
    assert.equal(retained.data.runs[0].id, measured.data.run.id);
    assert.equal(retained.data.observations.length, 1);
    assert.equal(retained.data.budget.runs, 1);
    const blockedAfterRestart = await scan(restarted.request, ids);
    assert.equal(blockedAfterRestart.status, 429, blockedAfterRestart.text);
    assert.equal(called, 1);
  } finally {
    // Close every contender before deleting ownership files, including failures.
    await Promise.all(handles.map(handle => handle.close()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test('runtime ownership also blocks a separate process and recovers after that process exits', { timeout: 10000 }, async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-process-owner-test-'));
  const source = `import {createAtlasServer} from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
    const server = createAtlasServer({runtimeDir:${JSON.stringify(runtimeDir)},env:{}});
    server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const handles = [];
  async function stopChild() {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  try {
    let timer;
    let ready;
    try {
      ready = await Promise.race([
        new Promise((resolve, reject) => {
          child.once('message', resolve);
          child.once('error', reject);
          child.once('exit', code => reject(new Error(`Owner process exited before startup (${code}).`)));
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owner process did not start.')), 5000); })
      ]);
    } finally { clearTimeout(timer); }
    const childState = await fetch(`http://127.0.0.1:${ready.port}/api/state`);
    assert.equal(childState.status, 200);
    const blocked = await serve(t, { runtimeDir });
    handles.push(blocked);
    const blockedState = await blocked.request('/api/state');
    assert.ok([500, 503].includes(blockedState.status), blockedState.text);
    await blocked.close();
    // Terminate without a graceful server.close, leaving its ownership entry.
    await stopChild();
    const recovered = await serve(t, { runtimeDir });
    handles.push(recovered);
    const recoveredState = await recovered.request('/api/state');
    assert.equal(recoveredState.status, 200, recoveredState.text);
    assert.equal(recoveredState.data.metrics.source, 'empty');
    assert.deepEqual(recoveredState.data.observations, []);
  } finally {
    await Promise.all(handles.map(handle => handle.close()));
    await stopChild();
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
