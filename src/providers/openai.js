// This adapter collects developer API evidence, not consumer ChatGPT observations.
export const OPENAI_MAX_OUTPUT_TOKENS = 1200;
export const OPENAI_MAX_TOOL_CALLS = 1;
const ENGINE = 'OpenAI Responses API · web_search';
const ENDPOINT = 'https://api.openai.com/v1/responses';

export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status, model } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.provider = 'openai';
    this.model = model;
    if (status !== undefined) this.status = status;
  }
}

function httpError(status, model) {
  const options = { status, model };
  // Never expose upstream error bodies: they may contain a submitted secret.
  if (status === 401) return new ProviderError('INVALID_API_KEY', 'OpenAI rejected the API key. Set a valid OPENAI_API_KEY on the server and restart before retrying.', options);
  if (status === 403) return new ProviderError('PROVIDER_ACCESS_DENIED', 'OpenAI denied access. Check this API project’s permissions and access to the configured model and web search.', options);
  if (status === 404) return new ProviderError('MODEL_UNAVAILABLE', 'The configured OpenAI model is unavailable. Check OPENAI_MODEL and this API project’s model access.', options);
  if (status === 429) return new ProviderError('RATE_LIMITED', 'OpenAI rate or billing quota limit reached. Check API billing and limits, then retry after capacity is available.', { ...options, retryable: true });
  if (status === 408 || status === 504) return new ProviderError('PROVIDER_TIMEOUT', 'OpenAI timed out. This question has no completed observation; retry later after checking provider usage.', { ...options, retryable: true });
  if (status >= 500) return new ProviderError('PROVIDER_UNAVAILABLE', 'OpenAI is temporarily unavailable. This question has no completed observation; retry later.', { ...options, retryable: true });
  return new ProviderError('PROVIDER_REJECTED', 'OpenAI rejected the search request. Check the configured model’s Responses API and web_search support.', options);
}

function snapshotLocation(project) {
  return {
    country: typeof project?.country === 'string' ? project.country : null,
    city: typeof project?.city === 'string' ? project.city : null,
    timezone: typeof project?.timezone === 'string' ? project.timezone : null
  };
}

function parseEvidence(response, model) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.output)) {
    throw new ProviderError('INVALID_PROVIDER_RESPONSE', 'OpenAI returned an invalid response. No measured evidence was saved; check provider status before retrying.', { model, retryable: true });
  }
  if (response.status !== 'completed') {
    throw new ProviderError('INCOMPLETE_RESPONSE', 'OpenAI did not complete this response. No measured evidence was saved; check provider usage and retry this question.', { model, retryable: true });
  }
  const searches = response.output.filter(item => item?.type === 'web_search_call');
  if (!searches.length || searches.some(item => item.status !== 'completed')) {
    throw new ProviderError('WEB_SEARCH_NOT_COMPLETED', 'OpenAI did not complete web search. This answer is excluded from measurements; check model web_search support before retrying.', { model });
  }
  const messages = response.output.filter(item => item?.type === 'message');
  if (messages.some(item => item.status && item.status !== 'completed')) {
    throw new ProviderError('INCOMPLETE_RESPONSE', 'OpenAI did not complete this answer. No measured evidence was saved; retry this question after checking provider usage.', { model, retryable: true });
  }
  const content = messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
  const answer = content.filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n');
  if (!answer.trim()) {
    throw new ProviderError('EMPTY_RESPONSE', 'OpenAI returned no answer text. This question has no measured observation; review the question and retry.', { model });
  }
  // Keep all annotations intact, including character offsets and future types.
  const annotations = content.flatMap(item => Array.isArray(item?.annotations) ? item.annotations : []);
  const citations = [];
  const seen = new Set();
  for (const annotation of annotations) {
    if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string') continue;
    try {
      const url = new URL(annotation.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      citations.push({ url: url.href, title: typeof annotation.title === 'string' && annotation.title ? annotation.title : url.hostname });
    } catch { /* Invalid citations stay in raw annotations but are not links. */ }
  }
  return { answer, annotations, citations };
}

/**
 * collect({ prompt, project }) returns a complete, traceable provider observation.
 * Authentication headers are never part of rawRequest or saved evidence.
 * Rejected HTTP-success payloads attach a nonenumerable evidence snapshot.
 * No implicit retries: a failed request may still incur provider charges.
 */
export function createOpenAIAdapter({ apiKey, model = 'gpt-4.1-mini', fetchImpl = globalThis.fetch, timeoutMs = 90000, maxOutputTokens = OPENAI_MAX_OUTPUT_TOKENS } = {}) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 2000) {
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'OpenAI maxOutputTokens must be an integer between 1 and 2000.', { model });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'OpenAI timeoutMs must be a positive integer.', { model });
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  return {
    provider: 'openai', model, method: 'api', engine: ENGINE,
    async collect({ prompt, project } = {}) {
      if (!key) throw new ProviderError('API_KEY_MISSING', 'Set OPENAI_API_KEY on the server and restart to collect real API search observations.', { model });
      if (!prompt || typeof prompt.text !== 'string' || !prompt.text.trim()) {
        throw new ProviderError('INVALID_PROMPT', 'Choose a nonempty buyer discovery question before collecting evidence.', { model });
      }
      const language = prompt.language || project?.languages?.[0] || project?.language || 'English';
      const location = snapshotLocation(project);
      const userLocation = { type: 'approximate', ...Object.fromEntries(Object.entries(location).filter(([, value]) => value)) };
      const rawRequest = {
        model,
        store: false,
        instructions: `Answer the buyer discovery question in ${language}. Use web search to support the answer with sources.`,
        input: prompt.text,
        tools: [{ type: 'web_search', search_context_size: 'low', user_location: userLocation }],
        tool_choice: 'required',
        max_tool_calls: OPENAI_MAX_TOOL_CALLS,
        max_output_tokens: maxOutputTokens,
        include: ['web_search_call.action.sources']
      };
      const controller = new AbortController();
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderError('PROVIDER_TIMEOUT', 'OpenAI did not finish before the timeout. No measured evidence was saved; check provider usage before retrying.', { model, retryable: true }));
        }, timeoutMs);
      });
      const request = async () => {
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(rawRequest),
          signal: controller.signal
        });
        if (!response.ok) throw httpError(response.status, model);
        try { return await response.json(); }
        catch { throw new ProviderError('INVALID_PROVIDER_RESPONSE', 'OpenAI returned unreadable response data. No measured evidence was saved; check provider status before retrying.', { model, retryable: true }); }
      };
      let rawResponse;
      try {
        rawResponse = await Promise.race([request(), timedOut]);
      } catch (error) {
        if (controller.signal.aborted) throw new ProviderError('PROVIDER_TIMEOUT', 'OpenAI did not finish before the timeout. No measured evidence was saved; check provider usage before retrying.', { model, retryable: true });
        if (error instanceof ProviderError) throw error;
        // Do not use error.message, cause or stack from the network provider.
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'Could not connect to OpenAI. Check network access to api.openai.com and retry after checking provider usage.', { model, retryable: true });
      } finally { clearTimeout(timer); }
      const snapshot = {
        rawResponse, rawRequest,
        provider: 'openai', model: typeof rawResponse?.model === 'string' ? rawResponse.model : model,
        method: 'api', engine: ENGINE,
        observedAt: new Date().toISOString(), location,
        analysisVersion: '1.0.0', usage: rawResponse?.usage ?? null
      };
      try { return { ...snapshot, ...parseEvidence(rawResponse, model) }; }
      catch (error) {
        if (error instanceof ProviderError) {
          // Save explicitly on the unsuccessful run result, never as a measured
          // observation or inside a generic JSON error response/log entry.
          Object.defineProperty(error, 'evidence', { value: snapshot, enumerable: false });
        }
        throw error;
      }
    }
  };
}
