import crypto from 'node:crypto';
import {createOpenAIAdapter} from '../providers/openai.js';
import {evaluate} from '../analyze.js';
import {readLimits} from '../workspace.js';

const safeError = error => {
  const recognized = ['API_KEY_MISSING','INVALID_API_KEY','PROVIDER_ACCESS_DENIED','MODEL_UNAVAILABLE','RATE_LIMITED','PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE','PROVIDER_REJECTED','INVALID_PROVIDER_RESPONSE','INCOMPLETE_RESPONSE','EMPTY_RESPONSE','WEB_SEARCH_NOT_COMPLETED'];
  return recognized.includes(error.code) ? {code: error.code, message: error.message} : {code: 'COLLECTION_FAILED', message: 'Collection or evidence storage failed. No measured response was accepted; the reservation remains counted.'};
};

// One leased question per invocation. The durable queue and reservation live in
// Postgres; expired attempts fail visibly instead of silently repeating paid calls.
export async function processOneJob({client, store, orgId, actorId, env, adapter}) {
  const job = await client.rpc('atlas_claim_job', {p_org_id: orgId, p_actor_id: actorId}, {service: true});
  if (!job) return {processed: false};
  let observation = null, error = null, failedEvidence = null;
  if (job.expired) error = {code: 'PROCESS_INTERRUPTED', message: 'The previous worker was interrupted. This question has no accepted response; its reservation is retained.'};
  else {
    try {
      const state = await store.read();
      const run = state.runs.find(r => r.id === job.run_id);
      const prompt = run?.prompts.find(p => p.id === job.prompt_id);
      if (!prompt) throw new Error('Unknown job context');
      const collector = adapter || createOpenAIAdapter({apiKey: env.ATLAS_OPENAI_API_KEY || env.OPENAI_API_KEY, model: env.OPENAI_MODEL || 'gpt-4.1-mini', timeoutMs: 45000, maxOutputTokens: readLimits(env).maxOutputTokens});
      const evidence = await collector.collect({prompt, project: run.projectSnapshot});
      const evaluated = evaluate(evidence.rawResponse, run.projectSnapshot, prompt);
      const rawRef = await client.storeRaw(orgId, run.id, evaluated.id, evidence);
      observation = {...evaluated, runId: run.id, rawRef, provider: evidence.provider, model: evidence.model, method: evidence.method, engine: evidence.engine,
        observedAt: evidence.observedAt, createdAt: evidence.observedAt, location: evidence.location, analysisVersion: evidence.analysisVersion, usage: evidence.usage};
    } catch (failure) {
      error = safeError(failure);
      if (failure.evidence) {
        try { failedEvidence = await client.storeRaw(orgId, job.run_id, crypto.randomUUID(), failure.evidence); }
        catch { error = {code: 'STORAGE_UNAVAILABLE', message: 'The provider response could not be stored. This question is excluded from measurements; its reservation remains counted.'}; }
      }
    }
  }
  await client.rpc('atlas_finish_job', {p_job_id: job.id, p_lease_token: job.lease_token, p_actor_id: actorId, p_observation: observation, p_error: error, p_failed_evidence: failedEvidence}, {service: true});
  return {processed: true, succeeded: Boolean(observation)};
}
