import {createSupabase, supabaseConfig} from './supabase.js';
import {readLimits} from '../workspace.js';

// Read-only deployment checks. These do not create observations, call Responses,
// or substitute for the real tenant/session tests documented in SECURITY.md.
export async function verifyHostedBuild({env = process.env, fetchImpl = fetch} = {}) {
  const providerKey = env.ATLAS_OPENAI_API_KEY || env.OPENAI_API_KEY;
  const missing = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY)', env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)', env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY],
    ['ATLAS_APP_URL', env.ATLAS_APP_URL],
    ['ATLAS_OPENAI_API_KEY (or OPENAI_API_KEY)', providerKey]
  ].filter(([,value]) => typeof value !== 'string' || !value.trim()).map(([name]) => name);
  if (missing.length) throw new Error('Configure production environment variables: ' + missing.join(', ') + '.');
  const config = supabaseConfig(env);
  readLimits(env);
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  if (model !== 'gpt-4.1-mini') throw new Error('OPENAI_MODEL must be gpt-4.1-mini, the model covered by the reservation policy.');
  const client = createSupabase(config, fetchImpl);
  let versions;
  try { versions = await client.call('/rest/v1/atlas_schema_migrations?select=version', {service:true}); }
  catch { throw new Error('Supabase schema verification failed. Check the server credential and applied migration.'); }
  if (!Array.isArray(versions) || !versions.some(row => row.version === '202610140001')) throw new Error('Apply the required Supabase migration 202610140001 before deployment.');
  let bucket;
  try { bucket = await client.call('/storage/v1/bucket/atlas-evidence', {service:true}); }
  catch { throw new Error('Supabase evidence storage verification failed. Check the private bucket and server credential.'); }
  if (bucket?.id !== 'atlas-evidence' || bucket.public !== false) throw new Error('The atlas-evidence storage bucket must exist and be private.');
  try { await client.call('/auth/v1/settings'); }
  catch { throw new Error('Supabase Auth verification failed. Check the project and publishable/anon credential.'); }
  // Model retrieval verifies authentication/access without a paid generation.
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/models/gpt-4.1-mini', {
      headers:{Authorization:`Bearer ${providerKey}`}, signal:AbortSignal.timeout(8000), redirect:'error'
    });
    if (!response.ok || (await response.json())?.id !== model) throw new Error();
  } catch { throw new Error('OpenAI model access verification failed. Check the production API key and model permissions. No paid search was run.'); }
  return {appOrigin:config.appOrigin, schemaVersion:'202610140001', evidenceBucketPrivate:true, model};
}
