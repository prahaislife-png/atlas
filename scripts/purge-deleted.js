import {createSupabase,supabaseConfig} from '../src/hosted/supabase.js';
import {purgeDeletedOrganizations} from '../src/hosted/retention.js';
try {
  const result=await purgeDeletedOrganizations(createSupabase(supabaseConfig(process.env,{requireAppOrigin:false})));
  console.log(`Purged ${result.purged} expired deleted organization(s).`);
} catch { console.error('Retention task failed. Review service access and the documented retention procedure; no credentials were logged.');process.exitCode=1; }
