import {applySupabaseMigration} from '../src/hosted/migrations.js';
try {
  const result=await applySupabaseMigration();
  console.log(`Supabase migration ${result.version}: ${result.status}.`);
} catch(error) { console.error(error.message);process.exitCode=1; }
