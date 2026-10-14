import {createSupabase,supabaseConfig} from '../src/hosted/supabase.js';
try {
  const client=createSupabase(supabaseConfig());
  const versions=await client.call('/rest/v1/atlas_schema_migrations?select=version',{service:true});
  if(!versions.some(v=>v.version==='202610140001'))throw new Error('Expected schema version missing');
  const bucket=await client.call('/storage/v1/bucket/atlas-evidence',{service:true});
  if(bucket.public!==false)throw new Error('Evidence bucket must be private');
  console.log('PASS: configured project responds, expected migration is recorded, evidence bucket is private.');
  console.log('Live user login, cross-tenant access and provider billing still require their own functional checks. No production readiness claim is made by this probe.');
} catch { console.error('Supabase verification failed. Check secure bindings, the applied migration, project connectivity and private bucket configuration. No credential values were logged.');process.exitCode=1; }
