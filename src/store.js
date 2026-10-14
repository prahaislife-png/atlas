import fs from 'node:fs/promises';
import path from 'node:path';
import {acquireRuntimeLock} from './runtime-lock.js';

export function emptyState() {
  return {
    schemaVersion: 2,
    project: {brand: '', aliases: [], domain: '', city: '', country: 'CZ', languages: [],
      timezone: 'Europe/Prague', competitors: [], prompts: [], onboarded: false},
    observations: [], runs: [], actions: [], usage: [], createdAt: new Date().toISOString()
  };
}

// Serialized transactions and atomic rename protect this single-process local workspace.
// This is deliberately development storage, not a hosted database.
export function createStore(runtimeDir) {
  const file = path.join(runtimeDir, 'state.json');
  let current;
  let queue = Promise.resolve();
  let releaseLock;
  let closing;
  const ready = (async () => {
    await fs.mkdir(runtimeDir, {recursive: true, mode: 0o700});
    releaseLock = await acquireRuntimeLock(runtimeDir);
    try {
      current = JSON.parse(await fs.readFile(file, 'utf8'));
      if (current.schemaVersion !== 2) {
        if ((current.observations ?? []).some(o => o.mode !== 'sample')) {
          throw new Error('Legacy measured data found. Export and migrate it before using Mission 1; the original state was preserved.');
        }
        await fs.copyFile(file, path.join(runtimeDir, `legacy-fixtures-${Date.now()}.json`));
        current = emptyState();
        await write(current);
      }
      if (!Array.isArray(current.usage) || !Array.isArray(current.runs) || !Array.isArray(current.observations)) {
        throw new Error('Invalid local state. Restore a backup; refusing to overwrite evidence.');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      current = emptyState();
      await write(current);
    }
    // Interrupted requests may have been billed. Retain their entire reservation.
    let interrupted = false;
    for (const run of current.runs) {
      if (run.status !== 'running') continue;
      interrupted = true;
      run.finishedAt = new Date().toISOString();
      for (const result of run.results) {
        if (result.status !== 'pending') continue;
        result.status = 'failed';
        result.error = {code: 'PROCESS_INTERRUPTED', message: 'Collection was interrupted. No answer was recorded; its budget reservation is retained.'};
      }
      run.status = run.results.some(r => r.status === 'succeeded') ? 'partial' : 'failed';
    }
    if (interrupted) await write(current);
  })().catch(async error => { await releaseLock?.(); throw error; });
  ready.catch(() => {});

  async function write(state) {
    const temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), {mode: 0o600});
    await fs.rename(temporary, file);
  }
  return {
    async read() { await ready; await queue; return structuredClone(current); },
    close() {
      closing ||= (async () => { await ready.catch(() => {}); await queue; await releaseLock?.(); })();
      return closing;
    },
    transaction(fn) {
      const operation = queue.then(async () => {
        await ready;
        const draft = structuredClone(current);
        const result = await fn(draft);
        await write(draft);
        current = draft;
        return structuredClone(result);
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}
