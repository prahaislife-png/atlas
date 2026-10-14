import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {evaluate, summarize} from './src/analyze.js';
import {createStore} from './src/store.js';
import {createOpenAIAdapter} from './src/providers/openai.js';
import {assertLocalRuntime} from './src/deployment.js';
import {validateProject, validateResearchLanguage, readLimits, budgetFor, reserveRun} from './src/workspace.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 100_000;
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};
const httpError = (status, message) => Object.assign(new Error(message), {status});
const send = (res, status, data) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(data));
};
async function body(req) {
  let bytes = 0;
  const parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > MAX_BODY) throw httpError(413, 'Request too large');
    parts.push(part);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw httpError(400, 'Request must be a JSON object'); }
}

function localRequest(req) {
  const host = req.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
const safeFailure = e => {
  const codes = new Set(['API_KEY_MISSING', 'INVALID_API_KEY', 'RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED', 'PROVIDER_ACCESS_DENIED', 'MODEL_UNAVAILABLE', 'INVALID_PROVIDER_RESPONSE', 'INCOMPLETE_RESPONSE', 'EMPTY_RESPONSE', 'WEB_SEARCH_NOT_COMPLETED']);
  return codes.has(e.code)
    ? {code: e.code, message: e.message, retryable: Boolean(e.retryable)}
    : {code: 'COLLECTION_FAILED', message: 'The provider request failed. Check server configuration and retry; the reservation is retained.', retryable: true};
};
const validString = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;

export function createAtlasHandler({store, env = process.env, adapter, limits: limitOverrides = {}, hosted = false, context = {}, hydrateObservation = async o => o, hydrateRun = async r => r} = {}) {
  const limits = {...readLimits(env), ...limitOverrides};
  const apiKey = env.ATLAS_OPENAI_API_KEY || env.OPENAI_API_KEY;
  const collector = adapter ?? createOpenAIAdapter({apiKey, model: env.OPENAI_MODEL || 'gpt-4.1-mini', maxOutputTokens: limits.maxOutputTokens, ...(hosted ? {timeoutMs: 45000} : {})});
  let scanLock = false;

  function ensureEditable() {
    if (scanLock) throw httpError(409, 'Wait for the current scan to finish before changing this workspace.');
  }
  function requireProject(state) {
    if (!state.project.onboarded) throw httpError(400, 'Complete and review business onboarding before collecting evidence.');
  }
  async function api(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = await store.read();
      const observations = state.observations.map(({rawResponse, rawRequest, annotations, ...summary}) => summary);
      return send(res, 200, {...state, observations, metrics: summarize(state.observations, state.project), configured: Boolean(apiKey), limits, budget: budgetFor(state, limits), scanInProgress: scanLock || state.runs.some(r => r.status === 'running'), ...context});
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)(\/export)?$/);
    if (req.method === 'GET' && runMatch) {
      const state = await store.read();
      const run = state.runs.find(r => r.id === runMatch[1]);
      if (!run) throw httpError(404, 'Scan run not found');
      if (runMatch[2]) res.setHeader('Content-Disposition', `attachment; filename="atlas-run-${run.id}.json"`);
      return send(res, 200, {run: await hydrateRun(run), observations: await Promise.all(state.observations.filter(o => o.runId === run.id).map(hydrateObservation))});
    }
    const obsMatch = url.pathname.match(/^\/api\/observations\/([a-zA-Z0-9-]+)$/);
    if (req.method === 'GET' && obsMatch) {
      const observation = (await store.read()).observations.find(o => o.id === obsMatch[1]);
      if (!observation) throw httpError(404, 'Observation not found');
      return send(res, 200, await hydrateObservation(observation));
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const state = await store.read();
      const cell = value => {
        let v = String(value ?? '');
        if (/^[\s]*[=+@-]/.test(v)) v = "'" + v;
        return '"' + v.replace(/"/g, '""') + '"';
      };
      const csv = ['run_id,observation_id,timestamp,provider,model,method,country,city,language,prompt,brand_mentioned,target_cited,competitors,analysis_version',
        ...state.observations.filter(o => o.mode === 'live').map(o => [o.runId, o.id, o.observedAt, o.provider, o.model, o.method, o.location?.country, o.location?.city, o.language, o.prompt, o.brandMentioned, o.targetCited, (o.competitorsMentioned || []).join('|'), o.analysisVersion].map(cell).join(','))].join('\n');
      res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="atlas-observations.csv"', 'Cache-Control': 'no-store'});
      return res.end(csv);
    }
    if ((req.method === 'POST' && url.pathname === '/api/onboarding') || (req.method === 'PATCH' && url.pathname === '/api/project')) {
      const value = await body(req);
      const project = validateProject(value, {maxPrompts: limits.maxPrompts});
      ensureEditable();
      const result = await store.transaction(state => {
        ensureEditable();
        if (hosted && state.runs.some(r => r.status === 'running')) throw httpError(409, 'Finish or recover active scans before editing the research brief.');
        if (url.pathname === '/api/onboarding' && state.project.onboarded) throw httpError(409, 'This workspace is already onboarded. Use workspace settings to review changes.');
        // Identity changes clear this local research workspace. Budget is never reset.
        state.project = project;
        state.observations = [];
        state.runs = [];
        state.actions = [];
        return {ok: true, reset: true, project};
      });
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/prompts') {
      const value = await body(req);
      ensureEditable();
      await store.transaction(state => {
        ensureEditable(); requireProject(state);
        if (hosted && state.runs.some(r => r.status === 'running')) throw httpError(409, 'Finish active scans before editing questions.');
        if (state.project.prompts.length >= limits.maxPrompts) throw httpError(429, `Maximum ${limits.maxPrompts} monitored questions per workspace.`);
        const project = validateProject({...state.project, prompts: [...state.project.prompts, value]}, {maxPrompts: limits.maxPrompts});
        state.project.prompts.push(project.prompts.at(-1));
      });
      return send(res, 201, {ok: true});
    }
    if (req.method === 'POST' && url.pathname === '/api/actions') {
      const v = await body(req);
      if (!validString(v.title, 160) || !validString(v.detail, 1200)) throw httpError(400, 'Provide an action title and factual acceptance criteria.');
      await store.transaction(state => {
        requireProject(state);
        if (state.actions.length >= 100) throw httpError(429, 'Maximum 100 local actions');
        state.actions.unshift({id: crypto.randomUUID(), title: v.title.trim(), detail: v.detail.trim(), category: 'Manual', priority: 'Unscored', impact: 'Unscored', effort: 'Unscored', done: false});
      });
      return send(res, 201, {ok: true});
    }
    if (req.method === 'POST' && url.pathname === '/api/actions/toggle') {
      const v = await body(req);
      await store.transaction(state => {
        const action = state.actions.find(a => a.id === v.id);
        if (!action) throw httpError(404, 'Action not found');
        action.done = !action.done;
      });
      return send(res, 200, {ok: true});
    }
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const value = await body(req);
      if (scanLock) throw httpError(409, 'A scan is already running.');
      if (!apiKey) throw httpError(400, 'Set OPENAI_API_KEY in the server environment or .env (ATLAS_OPENAI_API_KEY in cloud settings), then restart. Never paste keys into the browser.');
      if (collector.model !== 'gpt-4.1-mini') throw httpError(400, 'Budget estimates currently support OPENAI_MODEL=gpt-4.1-mini only. Other models require a reviewed pricing policy.');
      const ids = value.promptIds;
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw httpError(400, 'Select unique existing question IDs.');
      if (ids.length > limits.maxPromptsPerRun) throw httpError(429, `Select at most ${limits.maxPromptsPerRun} questions per scan.`);
      scanLock = true;
      let run;
      try {
        run = await store.transaction(state => {
          requireProject(state);
          if (hosted && state.runs.some(r => r.status === 'running')) throw httpError(409, 'A scan is already queued or running for this organization.');
          const selected = ids.map(id => state.project.prompts.find(p => p.id === id));
          if (selected.some(p => !p)) throw httpError(400, 'One or more selected questions no longer exist. Review the cohort and try again.');
          for (const prompt of selected) validateResearchLanguage(prompt.language);
          const id = crypto.randomUUID();
          const amount = reserveRun(state, limits, selected.length, id);
          const saved = {id, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
            provider: collector.provider, model: collector.model, method: collector.method, engine: collector.engine,
            location: {country: state.project.country, city: state.project.city, timezone: state.project.timezone},
            projectSnapshot: structuredClone(state.project), prompts: structuredClone(selected), reservedUsd: amount.reservedUsd,
            results: selected.map(p => ({promptId: p.id, prompt: p.text, language: p.language, status: 'pending'}))};
          state.runs.push(saved);
          return saved;
        });
        if (hosted) return send(res, 200, {ok: true, queued: true, run, recorded: 0, failed: 0});
        for (const prompt of run.prompts) {
          let observation, failure, failedEvidence;
          try {
            const evidence = await collector.collect({prompt, project: run.projectSnapshot});
            observation = {...evaluate(evidence.rawResponse, run.projectSnapshot, prompt),
              runId: run.id, provider: evidence.provider, model: evidence.model, method: evidence.method, engine: evidence.engine,
              observedAt: evidence.observedAt, createdAt: evidence.observedAt, location: evidence.location,
              rawResponse: evidence.rawResponse, rawRequest: evidence.rawRequest, annotations: evidence.annotations,
              analysisVersion: evidence.analysisVersion, usage: evidence.usage ?? null};
          } catch (e) { failure = safeFailure(e); failedEvidence = e.evidence; }
          await store.transaction(state => {
            const saved = state.runs.find(r => r.id === run.id);
            const result = saved.results.find(r => r.promptId === prompt.id);
            if (observation) {
              state.observations.push(observation);
              Object.assign(result, {status: 'succeeded', observationId: observation.id});
            } else {
              Object.assign(result, {status: 'failed', error: failure});
              if (failedEvidence) result.evidence = failedEvidence;
            }
          });
        }
        const completed = await store.transaction(state => {
          const saved = state.runs.find(r => r.id === run.id);
          const successes = saved.results.filter(r => r.status === 'succeeded').length;
          saved.status = successes === saved.results.length ? 'completed' : successes ? 'partial' : 'failed';
          saved.finishedAt = new Date().toISOString();
          return saved;
        });
        const recorded = completed.results.filter(r => r.status === 'succeeded').length;
        return send(res, 200, {ok: recorded > 0, run: completed, recorded, failed: completed.results.length - recorded});
      } finally { scanLock = false; }
    }
    throw httpError(404, 'Unknown API endpoint');
  }

  return async (req, res) => {
    try {
      if (!hosted && !localRequest(req)) throw httpError(403, 'Local-only research tool. Cross-origin access is forbidden; authentication and tenant isolation are required before hosting.');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (hosted) throw httpError(404, 'Unknown API endpoint');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
      const resource = path.resolve(PUBLIC, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!resource.startsWith(PUBLIC + path.sep)) throw httpError(403, 'Forbidden');
      const data = await fs.readFile(resource);
      res.writeHead(200, {'Content-Type': TYPES[path.extname(resource)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'});
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      const status = e.code === 'ENOENT' ? 404 : e.status || 500;
      send(res, status, {error: status === 500 ? 'Local storage or server failure. Evidence was not overwritten. Check the runtime directory and restart.' : e.message});
    }
  };
}

export function createAtlasServer({runtimeDir = path.join(ROOT, '.runtime'), env = process.env, ...options} = {}) {
  assertLocalRuntime(env);
  const store = createStore(runtimeDir);
  const server = http.createServer(createAtlasHandler({...options, env, store}));
  const close = server.close.bind(server);
  server.close = callback => close(error => {
    store.close().then(() => callback?.(error), failure => callback?.(error || failure));
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createAtlasServer();
  server.listen(port, '127.0.0.1', () => console.log(`ATLAS local research server listening on port ${server.address().port}`));
}
