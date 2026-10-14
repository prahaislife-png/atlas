import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertLocalRuntime} from '../src/deployment.js';
import {createAtlasServer} from '../server.js';
import {verifyHostedBuild} from '../src/hosted/readiness.js';

test('local development remains usable while hosted and production runtimes fail closed', () => {
  assert.doesNotThrow(() => assertLocalRuntime({}));
  assert.doesNotThrow(() => assertLocalRuntime({NODE_ENV: 'development'}));
  for (const env of [{VERCEL: '1'}, {NODE_ENV: 'production'}, {VERCEL: '1', NODE_ENV: 'development'}]) {
    assert.throws(() => assertLocalRuntime(env), error => error.code === 'DEPLOYMENT_NOT_READY' && /tenant-isolation/.test(error.message));
  }
});

test('hosted startup is rejected before touching private local data or credentials', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-deployment-'));
  const runtimeDir = path.join(parent, 'must-not-create');
  try {
    assert.throws(() => createAtlasServer({runtimeDir, env: {VERCEL: '1', OPENAI_API_KEY: 'fixture-secret-must-not-be-logged'}}), error => {
      assert.equal(error.code, 'DEPLOYMENT_NOT_READY');
      assert.equal(error.message.includes('fixture-secret-must-not-be-logged'), false);
      return true;
    });
    await assert.rejects(fs.access(runtimeDir), {code: 'ENOENT'});
  } finally { await fs.rm(parent, {recursive: true, force: true}); }
});

test('the Vercel build command refuses missing production configuration', () => {
  const command = fileURLToPath(new URL('../scripts/vercel-build.js', import.meta.url));
  const result = spawnSync(process.execPath, [command], {encoding: 'utf8', env:{}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ATLAS deployment blocked/);
  assert.match(result.stderr, /SUPABASE_URL/);
  assert.match(result.stderr, /ATLAS_OPENAI_API_KEY/);
  assert.equal(result.stdout, '');
});

const buildEnv = {SUPABASE_URL:'https://fixture-project.supabase.co', SUPABASE_ANON_KEY:'fixture-public', SUPABASE_SERVICE_ROLE_KEY:'fixture-private', SUPABASE_KEY_MODE:'modern', ATLAS_APP_URL:'https://atlas.example.com', ATLAS_OPENAI_API_KEY:'fixture-provider'};
function buildFetch(overrides = {}, requests = []) {
  return async (url, options) => {
    requests.push({url, options});
    const route = new URL(url).pathname;
    const data = overrides[route] ?? ({
      '/rest/v1/atlas_schema_migrations':[{version:'202610140001'}],
      '/storage/v1/bucket/atlas-evidence':{id:'atlas-evidence',public:false},
      '/auth/v1/settings':{},
      '/v1/models/gpt-4.1-mini':{id:'gpt-4.1-mini'}
    })[route];
    if (data instanceof Error) throw data;
    if (data instanceof Response) return data;
    assert.notEqual(data, undefined, 'No unexpected endpoint, including paid Responses calls');
    return new Response(JSON.stringify(data));
  };
}

test('hosted build verifies real-service interfaces using only read-only requests', async () => {
  const requests=[];
  const result=await verifyHostedBuild({env:buildEnv,fetchImpl:buildFetch({},requests)});
  assert.deepEqual(result,{appOrigin:'https://atlas.example.com',schemaVersion:'202610140001',evidenceBucketPrivate:true,model:'gpt-4.1-mini'});
  assert.equal(requests.length,4);
  assert.ok(requests.every(({options}) => !options.method || options.method === 'GET'));
  assert.equal(JSON.stringify(result).includes('fixture-private'),false);
  assert.equal(JSON.stringify(result).includes('fixture-provider'),false);
});
test('hosted build blocks missing migrations, public evidence and unavailable Auth', async () => {
  for (const [route,value,expected] of [
    ['/rest/v1/atlas_schema_migrations',[],/required Supabase migration/],
    ['/storage/v1/bucket/atlas-evidence',{id:'atlas-evidence',public:true},/must exist and be private/],
    ['/auth/v1/settings',new Response('{}',{status:401}),/Supabase Auth verification failed/]
  ]) await assert.rejects(verifyHostedBuild({env:buildEnv,fetchImpl:buildFetch({[route]:value})}),expected);
});
test('hosted build blocks invalid limits or unsupported models before contacting services', async () => {
  const fetchImpl=()=>assert.fail('Invalid configuration must not make network requests');
  await assert.rejects(verifyHostedBuild({env:{...buildEnv,ATLAS_MAX_RUNS_PER_DAY:'-1'},fetchImpl}),/ATLAS_MAX_RUNS_PER_DAY/);
  await assert.rejects(verifyHostedBuild({env:{...buildEnv,OPENAI_MODEL:'other-model'},fetchImpl}),/reservation policy/);
});
test('hosted build sanitizes credential and transport failures', async () => {
  for (const route of ['/rest/v1/atlas_schema_migrations','/v1/models/gpt-4.1-mini']) {
    await assert.rejects(verifyHostedBuild({env:buildEnv,fetchImpl:buildFetch({[route]:new Error('fixture-secret-upstream')})}),error=>!error.message.includes('fixture-secret-upstream'));
  }
  await assert.rejects(verifyHostedBuild({env:buildEnv,fetchImpl:buildFetch({'/v1/models/gpt-4.1-mini':new Response('{"secret":"fixture-secret-upstream"}',{status:401})})}),/OpenAI model access verification failed/);
});
