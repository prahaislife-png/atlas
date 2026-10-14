import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertLocalRuntime} from '../src/deployment.js';
import {createAtlasServer} from '../server.js';

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

test('the Vercel build command refuses the unready release with actionable blockers', () => {
  const command = fileURLToPath(new URL('../scripts/vercel-build.js', import.meta.url));
  const result = spawnSync(process.execPath, [command], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ATLAS deployment blocked/);
  assert.match(result.stderr, /authentication/);
  assert.match(result.stderr, /Managed Postgres/);
  assert.equal(result.stdout, '');
});
