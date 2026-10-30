const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { stop } = require('./zip-io');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function createZipEditor(options) {
  const records = new Map(), active = new Set(); let disposed = false;
  async function open(reference, settings = {}) {
    if (disposed) throw new Error('Archivbearbeitung wurde geschlossen.');
    const controller = new AbortController(); active.add(controller);
    const abort = () => controller.abort(); settings.signal?.addEventListener('abort', abort, { once: true }); if (settings.signal?.aborted) abort();
    let directory, password;
    try {
      directory = await fs.mkdtemp(path.join(options.temporaryRoot || os.tmpdir(), 'zip-edit-'));
      const target = path.join(directory, 'entry' + path.extname(reference.name || reference.archiveEntry));
      const output = await fs.open(target, 'wx', 0o600), digest = crypto.createHash('sha256');
      try {
        for await (const chunk of options.read(reference, { signal: controller.signal, onPassword: async request => { password = await settings.onPassword?.(request); return password; } })) {
          stop(controller.signal); digest.update(chunk); await output.writeFile(chunk);
        }
      } finally { await output.close(); }
      stop(controller.signal);
      records.set(path.resolve(target), { directory, reference: { ...reference }, digest: digest.digest('hex'), password, onPassword: settings.onPassword, pending: Promise.resolve() });
      return target;
    } catch (error) { if (directory) await fs.rm(directory, { recursive: true, force: true }); throw error; }
    finally { active.delete(controller); settings.signal?.removeEventListener('abort', abort); }
  }
  function saved(value) {
    const target = path.resolve(value), record = records.get(target);
    if (!record || disposed) return Promise.resolve();
    const operation = record.pending.catch(() => {}).then(async () => {
      if (disposed || record.closing) return;
      const bytes = await fs.readFile(target), digest = hash(bytes);
      if (digest === record.digest || !await options.confirm(record.reference)) return;
      if (disposed || record.closing) return;
      try {
        const result = await options.write(record.reference, bytes, { password: record.password, onPassword: record.onPassword });
        record.reference.revision = result.revision; record.digest = digest; record.unverified = false;
      } catch (error) {
        if (error.committedResult?.revision) { record.reference.revision = error.committedResult.revision; record.digest = digest; record.unverified = true; }
        throw error;
      }
    });
    record.pending = operation; return operation;
  }
  async function close(value) {
    const target = path.resolve(value), record = records.get(target); if (!record) return;
    record.closing = true; await record.pending.catch(() => {});
    if (records.get(target) !== record) return; records.delete(target); record.password = undefined;
    let unchanged;
    try { unchanged = hash(await fs.readFile(target)) === record.digest; } catch (error) { if (error.code !== 'ENOENT') { options.retain?.(target); throw error; } unchanged = true; }
    if (unchanged && !record.unverified) await fs.rm(record.directory, { recursive: true, force: true });
    else options.retain?.(target);
  }
  async function dispose() {
    disposed = true; for (const controller of active) controller.abort();
    await Promise.all([...records.keys()].map(close));
  }
  return { open, saved, close, dispose, has: value => records.has(path.resolve(value)) };
}
module.exports = { createZipEditor };
