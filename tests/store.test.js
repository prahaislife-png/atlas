import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore, emptyState} from '../src/store.js';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-store-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('atomic transactions serialize mutations and failed mutations do not alter evidence', async t => {
  const root = await directory(t);
  const store = createStore(root);
  t.after(() => store.close());
  await Promise.all(Array.from({length: 10}, (_, i) => store.transaction(async state => {
    await new Promise(resolve => setTimeout(resolve, 1));
    state.actions.push({id: String(i)});
  })));
  assert.equal((await store.read()).actions.length, 10);
  await assert.rejects(store.transaction(state => {
    state.actions = [];
    throw new Error('Invalid update');
  }), /Invalid update/);
  assert.equal((await store.read()).actions.length, 10);
  await store.close();
  const restored = createStore(root);
  t.after(() => restored.close());
  assert.equal((await restored.read()).actions.length, 10);
});

test('restart finalizes interrupted runs without inventing observations or refunding budget', async t => {
  const root = await directory(t);
  const before = emptyState();
  before.usage.push({date: '2026-10-14', runId: 'interrupted', reservedUsd: 0.1});
  before.observations.push({id: 'real-evidence', runId: 'interrupted', answer: 'Preserved'});
  before.runs.push({id: 'interrupted', status: 'running', results: [
    {promptId: 'p1', status: 'succeeded', observationId: 'real-evidence'},
    {promptId: 'p2', status: 'pending'}
  ]});
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(before));
  const store = createStore(root);
  t.after(() => store.close());
  const restored = await store.read();
  assert.equal(restored.runs[0].status, 'partial');
  assert.equal(restored.runs[0].results[1].error.code, 'PROCESS_INTERRUPTED');
  assert.equal(restored.observations.length, 1);
  assert.equal(restored.observations[0].answer, 'Preserved');
  assert.deepEqual(restored.usage, before.usage);
  assert.ok(restored.runs[0].finishedAt);
});

test('legacy demo fixtures are archived and never enter the real workspace', async t => {
  const root = await directory(t);
  const legacy = {project: {brand: 'Fictional'}, observations: [{mode: 'sample', answer: 'Fixture'}]};
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(legacy));
  const store = createStore(root);
  t.after(() => store.close());
  const restored = await store.read();
  assert.deepEqual(restored.observations, []);
  assert.equal(restored.project.onboarded, false);
  const archive = (await fs.readdir(root)).find(name => name.startsWith('legacy-fixtures-'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, archive), 'utf8')), legacy);
});

test('unmigrated measured history and corrupt JSON fail closed without overwriting the original', async t => {
  const root = await directory(t);
  const file = path.join(root, 'state.json');
  const legacy = JSON.stringify({observations: [{mode: 'live', answer: 'Existing measured history'}]});
  await fs.writeFile(file, legacy);
  await assert.rejects(createStore(root).read(), /Legacy measured data/);
  assert.equal(await fs.readFile(file, 'utf8'), legacy);
  await fs.writeFile(file, '{broken json');
  await assert.rejects(createStore(root).read(), SyntaxError);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken json');
});
