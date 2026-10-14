import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIAdapter, ProviderError, OPENAI_MAX_OUTPUT_TOKENS, OPENAI_MAX_TOOL_CALLS } from '../src/providers/openai.js';

// These are deterministic synthetic provider fixtures, never live measurements.
const project = { brand: 'Never Inject This Brand', domain: 'https://owned.example', competitors: ['Never Inject This Competitor'], country: 'CZ', city: 'Prague', timezone: 'Europe/Prague', languages: ['Czech'] };
const prompt = { id: 'question-1', text: 'Kde najdu kosmetické ošetření v Praze?', language: 'Czech' };
const citation = { type: 'url_citation', url: 'https://source.example/services', title: 'Source services', start_index: 0, end_index: 21 };
const validResponse = () => ({
  id: 'synthetic-response', status: 'completed', model: 'gpt-4.1-mini-2025-04-14',
  output: [
    { type: 'web_search_call', id: 'synthetic-search', status: 'completed', action: { type: 'search', query: prompt.text, sources: [{ type: 'url', url: citation.url }] } },
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic fixture answer.', annotations: [structuredClone(citation)] }] }
  ],
  usage: { input_tokens: 8021, output_tokens: 51, total_tokens: 8072 }
});
const successFetch = response => async () => ({ ok: true, status: 200, json: async () => response });
const adapterFor = response => createOpenAIAdapter({ apiKey: 'synthetic-test-key', fetchImpl: successFetch(response) });

test('adapter sends an unbranded localized search request and preserves full provenance', async () => {
  let request;
  const raw = validResponse();
  const adapter = createOpenAIAdapter({ apiKey: 'synthetic-test-key', fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => raw };
  } });
  const result = await adapter.collect({ project, prompt });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-test-key');
  assert.equal(request.body.input, prompt.text);
  assert.match(request.body.instructions, /Czech/);
  assert.equal(JSON.stringify(request.body).includes(project.brand), false);
  assert.equal(JSON.stringify(request.body).includes(project.competitors[0]), false);
  assert.deepEqual(request.body.tools, [{ type: 'web_search', search_context_size: 'low', user_location: { type: 'approximate', country: 'CZ', city: 'Prague', timezone: 'Europe/Prague' } }]);
  assert.equal(request.body.tool_choice, 'required');
  assert.equal(request.body.max_tool_calls, OPENAI_MAX_TOOL_CALLS);
  assert.equal(request.body.max_output_tokens, OPENAI_MAX_OUTPUT_TOKENS);
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.include, ['web_search_call.action.sources']);
  assert.deepEqual(result.rawRequest, request.body);
  assert.deepEqual(result.rawResponse, raw);
  assert.deepEqual(result.annotations, [citation]);
  assert.deepEqual(result.citations, [{ url: citation.url, title: citation.title }]);
  assert.equal(result.answer, 'Synthetic fixture answer.');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, raw.model);
  assert.equal(result.method, 'api');
  assert.equal(result.engine, 'OpenAI Responses API · web_search');
  assert.equal(result.analysisVersion, '1.0.0');
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.deepEqual(result.location, { country: 'CZ', city: 'Prague', timezone: 'Europe/Prague' });
  assert.deepEqual(result.usage, raw.usage);
  assert.equal(JSON.stringify(result).includes('synthetic-test-key'), false);
  assert.equal(adapter.provider, 'openai');
  assert.equal(adapter.model, 'gpt-4.1-mini');
  assert.equal(adapter.method, 'api');
});

test('annotations retain offsets, duplicates, unknown types and invalid URLs without creating unsafe links', async () => {
  const raw = validResponse();
  const annotations = [citation, { ...citation, start_index: 40, end_index: 61 }, { type: 'future_citation', extra: { value: 1 } }, { type: 'url_citation', url: 'javascript:alert(1)' }, { type: 'url_citation', url: 'invalid url' }, { type: 'url_citation', url: 'https://user:password@source.example' }];
  raw.output[1].content[0].annotations = annotations;
  const result = await adapterFor(raw).collect({ prompt, project });
  assert.deepEqual(result.annotations, annotations);
  assert.deepEqual(result.rawResponse, raw);
  assert.equal(result.citations.length, 1);
});

test('a genuinely uncited completed answer remains eligible without fabricated citation evidence', async () => {
  const raw = validResponse();
  raw.output[1].content[0].annotations = [];
  const result = await adapterFor(raw).collect({ prompt, project });
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.annotations, []);
});

test('multiple output text blocks and message annotations are retained', async () => {
  const raw = validResponse();
  raw.output[1].content.push({ type: 'output_text', text: 'Second paragraph.', annotations: [{ ...citation, url: 'https://second.example/' }] });
  const result = await adapterFor(raw).collect({ prompt, project });
  assert.equal(result.answer, 'Synthetic fixture answer.\nSecond paragraph.');
  assert.equal(result.annotations.length, 2);
  assert.equal(result.citations.length, 2);
});

test('missing API key prevents any network call', async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter({ apiKey: '  ', fetchImpl: async () => { calls += 1; } });
  await assert.rejects(adapter.collect({ prompt, project }), error => error instanceof ProviderError && error.code === 'API_KEY_MISSING' && error.retryable === false && /OPENAI_API_KEY/.test(error.message));
  assert.equal(calls, 0);
});

test('invalid question prevents any network call', async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter({ apiKey: 'test-key', fetchImpl: async () => { calls += 1; } });
  await assert.rejects(adapter.collect({ prompt: { text: ' ' }, project }), { code: 'INVALID_PROMPT' });
  assert.equal(calls, 0);
});

for (const [status, code, retryable] of [[400, 'PROVIDER_REJECTED', false], [401, 'INVALID_API_KEY', false], [403, 'PROVIDER_ACCESS_DENIED', false], [404, 'MODEL_UNAVAILABLE', false], [408, 'PROVIDER_TIMEOUT', true], [429, 'RATE_LIMITED', true], [500, 'PROVIDER_UNAVAILABLE', true], [504, 'PROVIDER_TIMEOUT', true]]) {
  test(`HTTP ${status} returns a sanitized actionable error and no implicit retry`, async () => {
    let calls = 0;
    let bodyRead = false;
    const adapter = createOpenAIAdapter({ apiKey: 'test-secret', fetchImpl: async () => {
      calls += 1;
      return { ok: false, status, json: async () => { bodyRead = true; return { error: { message: 'test-secret private raw error' } }; } };
    } });
    await assert.rejects(adapter.collect({ prompt, project }), error => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, status);
      assert.equal(error.provider, 'openai');
      assert.equal(error.model, 'gpt-4.1-mini');
      assert.equal(error.evidence, undefined);
      assert.equal(JSON.stringify(error).includes('test-secret'), false);
      assert.equal(error.stack.includes('private raw error'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(bodyRead, false);
  });
}

test('network failures cannot leak upstream exception text or credentials', async () => {
  const adapter = createOpenAIAdapter({ apiKey: 'test-secret', fetchImpl: async () => { throw new Error('test-secret private upstream error'); } });
  await assert.rejects(adapter.collect({ prompt, project }), error => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable && !error.stack.includes('test-secret') && !error.stack.includes('private upstream error'));
});

test('timeout aborts the network operation and returns a useful retryable failure', async () => {
  let signal;
  const adapter = createOpenAIAdapter({ apiKey: 'test-key', timeoutMs: 5, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private transport details')), { once: true }));
  } });
  await assert.rejects(adapter.collect({ prompt, project }), error => error.code === 'PROVIDER_TIMEOUT' && error.retryable);
  assert.equal(signal.aborted, true);
});

test('timeout covers response body reads, even when an injected transport ignores abort', async () => {
  const adapter = createOpenAIAdapter({ apiKey: 'test-key', timeoutMs: 5, fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
  await assert.rejects(adapter.collect({ prompt, project }), { code: 'PROVIDER_TIMEOUT' });
});

test('unreadable and malformed provider data are rejected', async () => {
  const adapter = createOpenAIAdapter({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('secret body'); } }) });
  await assert.rejects(adapter.collect({ prompt, project }), { code: 'INVALID_PROVIDER_RESPONSE' });
  for (const raw of [null, {}, { output: 'not an array' }]) {
    await assert.rejects(adapterFor(raw).collect({ prompt, project }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
});

test('incomplete responses never count as observations, even if answer text exists', async () => {
  for (const status of ['incomplete', 'failed', 'queued', 'in_progress', undefined]) {
    const raw = validResponse();
    raw.status = status;
    await assert.rejects(adapterFor(raw).collect({ prompt, project }), { code: 'INCOMPLETE_RESPONSE' });
  }
  const raw = validResponse();
  raw.output[1].status = 'incomplete';
  await assert.rejects(adapterFor(raw).collect({ prompt, project }), { code: 'INCOMPLETE_RESPONSE' });
});

test('an ordinary model answer without a completed web search is excluded from measurements', async () => {
  const noSearch = validResponse();
  noSearch.output = noSearch.output.filter(item => item.type !== 'web_search_call');
  await assert.rejects(adapterFor(noSearch).collect({ prompt, project }), { code: 'WEB_SEARCH_NOT_COMPLETED' });
  for (const status of ['failed', 'in_progress', undefined]) {
    const raw = validResponse();
    raw.output[0].status = status;
    await assert.rejects(adapterFor(raw).collect({ prompt, project }), { code: 'WEB_SEARCH_NOT_COMPLETED' });
  }
});

test('HTTP-success incomplete and no-search responses retain unsuccessful raw snapshots without producing observations', async () => {
  for (const kind of ['incomplete', 'no-search']) {
    const raw = validResponse();
    if (kind === 'incomplete') {
      raw.status = 'incomplete';
      raw.incomplete_details = { reason: 'max_output_tokens' };
    } else raw.output = raw.output.filter(item => item.type !== 'web_search_call');
    let returnedObservation = false;
    try {
      await adapterFor(raw).collect({ prompt, project });
      returnedObservation = true;
      assert.fail('Ineligible response must throw instead of returning an observation');
    } catch (error) {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, kind === 'incomplete' ? 'INCOMPLETE_RESPONSE' : 'WEB_SEARCH_NOT_COMPLETED');
      assert.deepEqual(error.evidence.rawResponse, raw);
      assert.equal(error.evidence.rawRequest.input, prompt.text);
      assert.equal(error.evidence.provider, 'openai');
      assert.equal(error.evidence.model, raw.model);
      assert.equal(error.evidence.method, 'api');
      assert.equal(error.evidence.engine, 'OpenAI Responses API · web_search');
      assert.equal(error.evidence.analysisVersion, '1.0.0');
      assert.ok(Number.isFinite(Date.parse(error.evidence.observedAt)));
      assert.deepEqual(error.evidence.location, { country: 'CZ', city: 'Prague', timezone: 'Europe/Prague' });
      assert.deepEqual(error.evidence.usage, raw.usage);
      assert.equal('answer' in error.evidence, false);
      assert.equal('citations' in error.evidence, false);
      assert.equal(JSON.stringify(error.evidence).includes('synthetic-test-key'), false);
      // Generic error serialization must not accidentally publish raw evidence.
      assert.equal(JSON.stringify(error).includes('Synthetic fixture answer'), false);
    }
    assert.equal(returnedObservation, false);
  }
});

test('empty answers and refusals do not create fabricated observations', async () => {
  for (const content of [[], [{ type: 'output_text', text: '  ', annotations: [] }], [{ type: 'refusal', refusal: 'Synthetic refusal' }]]) {
    const raw = validResponse();
    raw.output[1].content = content;
    await assert.rejects(adapterFor(raw).collect({ prompt, project }), { code: 'EMPTY_RESPONSE' });
  }
});

test('budget-related request bounds are configurable only within safe limits', async () => {
  for (const maxOutputTokens of [0, -1, 2001, 1.5, '1200']) {
    assert.throws(() => createOpenAIAdapter({ maxOutputTokens }), { code: 'INVALID_PROVIDER_CONFIG' });
  }
  for (const timeoutMs of [0, -1, 1.5]) {
    assert.throws(() => createOpenAIAdapter({ timeoutMs }), { code: 'INVALID_PROVIDER_CONFIG' });
  }
  const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxOutputTokens: 500, fetchImpl: successFetch(validResponse()) });
  const result = await adapter.collect({ prompt, project });
  assert.equal(result.rawRequest.max_output_tokens, 500);
});

test('project language is the fallback and location snapshot never shares mutable project state', async () => {
  const result = await adapterFor(validResponse()).collect({ prompt: { text: prompt.text }, project });
  assert.match(result.rawRequest.instructions, /Czech/);
  const previousCity = project.city;
  project.city = 'Changed city';
  assert.equal(result.location.city, previousCity);
  project.city = previousCity;
});
