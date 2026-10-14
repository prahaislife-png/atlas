import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function processIdentity(pid) {
  if (process.platform !== 'linux') return null;
  const [stat, boot] = await Promise.all([
    fs.readFile(`/proc/${pid}/stat`, 'utf8'),
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
  ]);
  return `${boot.trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
}

async function alive(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid runtime ownership metadata; refusing to risk evidence.');
  try {
    process.kill(owner.pid, 0);
    if (owner.identity && process.platform === 'linux') return owner.identity === await processIdentity(owner.pid);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH' || e.code === 'ENOENT') return false;
    throw e;
  }
}

// Every contender publishes its unique ownership file before checking others.
// A later contender always sees the earlier live owner and refuses to write.
// Simultaneous contenders may both refuse: safe failure is preferable to two writers.
// Files are never taken over/deleted by another process. Dead entries are ignored;
// boot/start identities prevent a recycled Linux PID from blocking a new machine.
export async function acquireRuntimeLock(runtimeDir) {
  const owners = path.join(runtimeDir, 'owners');
  await fs.mkdir(owners, {recursive: true, mode: 0o700});
  const ownerFile = path.join(owners, `${process.pid}-${crypto.randomUUID()}.json`);
  const identity = await processIdentity(process.pid);
  await fs.writeFile(ownerFile, JSON.stringify({pid: process.pid, identity}), {flag: 'wx', mode: 0o600});
  try {
    for (const entry of await fs.readdir(owners)) {
      const other = path.join(owners, entry);
      if (other === ownerFile) continue;
      let contents;
      try { contents = await fs.readFile(other, 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const owner = JSON.parse(contents);
      if (await alive(owner)) throw Object.assign(new Error('This runtime directory already has an active ATLAS server. Stop it before starting another; concurrent writers would bypass quotas.'), {status: 503});
    }
  } catch (e) {
    await fs.unlink(ownerFile).catch(() => {});
    throw e;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.unlink(ownerFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
  };
}
