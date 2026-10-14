import fs from 'node:fs/promises';

const version = '202610140001';
const migrationFile = new URL('../../supabase/migrations/202610140001_tenant_foundations.sql',import.meta.url);
const fail = message => new Error(message);

// Separate operator capability: project API keys cannot execute schema changes.
// This module is never imported by the deployed web handler.
export async function applySupabaseMigration({env = process.env,fetchImpl = fetch} = {}) {
  if (!env.SUPABASE_ACCESS_TOKEN) throw fail('Configure SUPABASE_ACCESS_TOKEN securely to apply the database migration automatically.');
  let project;
  try { project = new URL(env.SUPABASE_URL); } catch { throw fail('Configure the Supabase project URL before applying a migration.'); }
  const match=project.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/);
  if(project.protocol!=='https:' || !match || project.username || project.password || project.port || project.pathname!=='/' || project.search || project.hash) throw fail('Use a valid HTTPS Supabase project origin.');
  const endpoint=`https://api.supabase.com/v1/projects/${match[1]}/database/query`;
  async function query(sql) {
    let response;
    try { response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(60000),redirect:'error'}); }
    catch { throw fail('The migration request could not be confirmed. Check the remote migration version before retrying.'); }
    if(!response.ok)throw fail(`The management API rejected the migration request (HTTP ${response.status}). Check account permission and migration state.`);
    let result;
    try { result=await response.json(); } catch { throw fail('The management API returned an unreadable result. Verify remote state before retrying.'); }
    if(!Array.isArray(result))throw fail('Unexpected migration response. Verify remote state before retrying.');
    return result;
  }
  const present=await query("select to_regclass('public.atlas_schema_migrations') is not null as exists");
  if(present.length!==1 || typeof present[0].exists!=='boolean')throw fail('Could not establish the remote migration state.');
  if(present[0].exists){
    const versions=await query('select version from public.atlas_schema_migrations order by version');
    if(versions.some(row=>row.version===version))return{status:'already_applied',version};
    throw fail('A different ATLAS migration history exists. Review it before applying schema changes.');
  }
  const sql=await fs.readFile(migrationFile,'utf8');
  await query(sql);
  const applied=await query(`select version from public.atlas_schema_migrations where version='${version}'`);
  if(applied.length!==1 || applied[0].version!==version)throw fail('Migration persistence was not confirmed. Inspect remote state before retrying.');
  return{status:'applied',version};
}
