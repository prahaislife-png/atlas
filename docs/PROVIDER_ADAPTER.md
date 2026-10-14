# OpenAI web-search observations

ATLAS collects authorized **OpenAI Responses API observations with web search**. This does not reproduce consumer ChatGPT search, a signed-in user's personalization, or an organic ranking. The adapter never adds the workspace brand, aliases, URL, or competitors to the buyer question. The original question becomes `input`; a separate instruction requests its configured language. Approximate country/city/timezone is passed to the documented web-search location field. The model and low search-context setting affect results and should remain consistent in comparisons.

## Interface

```js
import { createOpenAIAdapter } from '../src/providers/openai.js';

const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1-mini',
  fetchImpl: fetch, // Optional injection for deterministic tests.
  timeoutMs: 90000,
  maxOutputTokens: 1200 // Integer 1–2000; server quotas must cover this bound.
});
const evidence = await adapter.collect({ prompt, project });
```

The adapter exposes `provider`, `model`, `method`, and `engine`. `prompt` supplies `text` and `language`; `project` supplies `country`, `city`, `timezone`, and fallback `languages` or `language`. The server owns project validation, immutable run IDs, prompt versions, state persistence, workspace limits and request reservations. Credentials are server-only; missing credentials fail before any network operation.

On success the adapter returns:

| Field | Evidence contract |
| --- | --- |
| `rawRequest` | Exact JSON body submitted, excluding authentication headers. |
| `rawResponse` | Entire parsed provider JSON, including search calls, source list, annotations and usage. |
| `answer` | Text from returned message `output_text` blocks, joined with newlines. |
| `annotations` | All original message-content annotations, preserving citation offsets, duplicate citations, unknown types and invalid URLs for audit. |
| `citations` | Deduplicated HTTP(S) links and supplied titles derived from URL annotations. Invalid URLs and URLs with embedded credentials are excluded from clickable links. |
| `provider`, `model`, `method`, `engine` | `openai`, actual returned model snapshot when available, `api`, `OpenAI Responses API · web_search`. Requested model remains in `rawRequest`. |
| `observedAt`, `location` | UTC completion timestamp and country/city/timezone snapshot. Raw response retains provider creation time when supplied. |
| `analysisVersion`, `usage` | `1.0.0` and unmodified provider usage, or `null` if absent. Usage tokens do not independently establish an invoice total. |

The adapter accepts a response only when its top-level status is `completed`, it has at least one completed `web_search_call`, every returned search call is completed, and it contains nonblank answer text. An incomplete or failed search, a refusal, an ordinary answer without search, or malformed data cannot become a measured observation. A completed answer with zero citations may be observed honestly as uncited; sources are never invented.

When an HTTP-success JSON response is ineligible, the thrown error exposes `error.evidence` with `rawRequest`, `rawResponse`, `observedAt`, `location`, `provider`, `model`, `method`, `engine`, `analysisVersion`, and `usage`. The server can explicitly save that snapshot on the **unsuccessful run result** for inspection/export. It must remain excluded from measured observations and metrics. The property is nonenumerable to keep generic error serialization/logging from accidentally publishing raw evidence. HTTP error bodies such as a 401 response are always discarded; they do not have an evidence snapshot.

## Request bounds and failures

Requests use one built-in tool call (`max_tool_calls: 1`), `tool_choice: 'required'`, `search_context_size: 'low'`, a default 1,200 output tokens, `store: false`, and `include: ['web_search_call.action.sources']`. ATLAS retains its own raw evidence locally. The response may be incomplete when a request bound is reached; that creates a visible question failure instead of an observation.

Errors are `ProviderError` objects with a static, actionable message, `code`, `retryable`, `provider`, `model`, and HTTP `status` where applicable. HTTP error bodies and transport exception messages are never surfaced, logged or embedded as causes. Invalid credentials (`INVALID_API_KEY`) direct the owner to fix the server key. `RATE_LIMITED` explains both rate and billing quota checks. Timeouts, unavailable transport, incomplete responses, empty answers and absent search have distinct codes. There are **no automatic retries**: even a timeout or failed request can incur provider charges. The server must retain its reservation and obtain a new authorized reservation before another request.

The API key is sent only in an authentication header, never in the model input or returned request snapshot. Provider response data is preserved exactly rather than heuristically stripped: application content may contain sensitive user-supplied text. Treat all raw evidence as private workspace data, render it as text, and never log full adapter errors or raw snapshots. The local server's deployment prohibition remains in force until authentication, tenant authorization and production storage are implemented.

Workspace spend caps enforce conservative **local request reservations**, not a guarantee about the provider invoice. The server restricts the priced model and bounds prompt input, output and tool calls. Provider prices and billing behavior can change. Configure an OpenAI project budget/limits separately and reconcile actual provider usage. Adding a provider or model requires a supported adapter, fixture tests and updated pricing/reservation assumptions.

## Verification and official references

Run `node --test tests/openai.test.js`. Tests inject `fetch`; synthetic fixtures are never reported as real observations. They exercise raw provenance, unbranded requests, safe citations, authentication, rate limits, timeout/body timeout, no-search answers, incomplete/refused/malformed responses, error sanitization and request bounds.

Official documentation:

- [Responses API — create](https://platform.openai.com/docs/api-reference/responses/create)
- [Web search guide](https://platform.openai.com/docs/guides/tools-web-search)
- [OpenAI API pricing](https://openai.com/api/pricing/)

This implementation uses the documented Responses/web-search request shape. During this build, the environment's HTTPS proxy returned CONNECT 403 when retrieving current OpenAI documentation. A real OpenAI API call was not performed without an injected API key. The adapter's externally billed integration remains unverified until an authorized key and provider network access are available; fixture tests establish local behavior only.
