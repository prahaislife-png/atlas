import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
const name = 'atlas-db-test-' + crypto.randomBytes(5).toString('hex');
const image = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
function run(args,input) {
  const result = spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:8*1024*1024});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Docker failed');
  return result.stdout;
}
try {
  run(['run','--detach','--rm','--name',name,'--network','none','--env','POSTGRES_HOST_AUTH_METHOD=trust',image]);
  for (let attempt=0;attempt<100;attempt++) {
    const ready=spawnSync('docker',['exec',name,'pg_isready','-U','postgres'],{encoding:'utf8'});
    const logs=spawnSync('docker',['logs',name],{encoding:'utf8'});
    if(ready.status===0 && (logs.stdout+logs.stderr).includes('PostgreSQL init process complete; ready for start up.')) break;
    if(attempt===99) throw new Error('Test Postgres did not start');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  for (const file of ['tests/db/bootstrap.sql','supabase/migrations/202610140001_tenant_foundations.sql','tests/db/isolation.sql']) {
    const result=run(['exec','--interactive',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres'],fs.readFileSync(file));
    if(file.endsWith('isolation.sql')) process.stdout.write(result);
  }
  // Exercise a real dump/restore in the same isolated Postgres server.
  const dump=run(['exec',name,'pg_dump','-U','postgres','--no-owner','postgres']);
  run(['exec',name,'createdb','-U','postgres','atlas_restore']);
  run(['exec','--interactive',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres','atlas_restore'],dump);
  const restored=run(['exec',name,'psql','-At','-U','postgres','atlas_restore','-c',"select count(*) from atlas_audit_log where event='organization.deletion_requested'"]);
  if(restored.trim()!=='1')throw new Error('Backup/restore audit history mismatch');
  console.log('PASS: Postgres migration + isolation checks + actual pg_dump/restore');
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {spawnSync('docker',['rm','--force',name],{stdio:'ignore'});}
