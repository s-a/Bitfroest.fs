const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const equalPath = (a, b) => typeof a === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b));

async function createDeletionStoryFixture(parent, { timeout = 15000, interval = 50 } = {}) {
  const base = await fs.realpath(parent);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('Invalid fixture parent.');
  const root = await fs.mkdtemp(path.join(base, 'showcase-delete-'));
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  const marker = path.join(root, '.showcase-delete'), token = crypto.randomUUID();
  const discard = path.join(left, 'Discard.tmp'), recycle = path.join(left, 'Recycle.tmp'), keep = path.join(left, 'Keep.txt'), other = path.join(left, 'Other.txt');
  const contents = new Map([[discard, 'Disposable showcase file.\n'], [recycle, 'Showcase file for the Recycle Bin.\n'], [keep, 'Keep this project note.\n'], [other, 'Keep this second note.\n'], [marker, token]]);
  await fs.mkdir(left); await fs.mkdir(right);
  for (const [file, data] of contents) await fs.writeFile(file, data, { flag: 'wx' });
  const identities = new Map();
  for (const item of [root, left, right, ...contents.keys()]) identities.set(item, identity(await fs.lstat(item, { bigint: true })));
  const removed = new Set(); let busy = false, failed = false;
  async function intact(item) {
    const stat = await fs.lstat(item, { bigint: true });
    if (stat.isSymbolicLink() || identity(stat) !== identities.get(item) || !equalPath(await fs.realpath(item), item)) throw new Error('Showcase fixture identity changed.');
    if (contents.has(item) && (!stat.isFile() || await fs.readFile(item, 'utf8') !== contents.get(item))) throw new Error('Showcase fixture contents changed.');
  }
  async function absent(item) {
    try { await fs.lstat(item); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  async function inspect(deleted) {
    for (const item of [root, left, right, marker, keep, other]) await intact(item);
    for (const item of [discard, recycle]) {
      if (deleted.has(item)) { if (!await absent(item)) throw new Error('The disposable file still exists.'); }
      else await intact(item);
    }
    const rootNames = (await fs.readdir(root)).sort();
    const leftNames = (await fs.readdir(left)).sort();
    const expected = [discard, recycle, keep, other].filter(item => !deleted.has(item)).map(item => path.basename(item)).sort();
    if (JSON.stringify(rootNames) !== JSON.stringify(['.showcase-delete', 'left', 'right'].sort()) ||
        JSON.stringify(leftNames) !== JSON.stringify(expected) || (await fs.readdir(right)).length) throw new Error('Unexpected files in showcase fixture.');
  }
  async function verifyAfterDelete() { await inspect(new Set([...removed, discard])); }
  async function verifyAfterTrash() { await inspect(new Set([...removed, recycle])); }
  async function confirm(action, snapshot, trigger) {
    const item = action === 'delete-permanent' ? discard : action === 'trash' ? recycle : null;
    const title = action === 'trash' ? 'Move to Trash?' : 'Delete permanently?';
    if (busy || failed || removed.has(item)) throw new Error('Fixture action is busy, failed, or already completed.');
    if (typeof trigger !== 'function') throw new Error('A confirmation trigger is required.');
    busy = true;
    try {
      await inspect(removed);
      if (!item || !snapshot || snapshot.controlReady !== true ||
          !equalPath(snapshot.activeDirectory, left) || snapshot.dialog !== title ||
          !Array.isArray(snapshot.selected) || snapshot.selected.length !== 1 || !equalPath(snapshot.selected[0], item) ||
          !Array.isArray(snapshot.dialogFiles) || snapshot.dialogFiles.length !== 1 || snapshot.dialogFiles[0] !== path.basename(item)) {
        throw new Error('The operation does not match the authorized fixture action.');
      }
      try {
        await trigger();
        const deadline = Date.now() + timeout;
        do {
          if (await absent(item)) { await inspect(new Set([...removed, item])); removed.add(item); return; }
          await new Promise(resolve => setTimeout(resolve, interval));
        } while (Date.now() < deadline);
        throw new Error('The expected fixture deletion was not observed.');
      } catch (error) { failed = true; throw error; }
    } finally { busy = false; }
  }
  async function cleanup() {
    if (busy) throw new Error('Fixture action is busy.');
    const deleted = new Set();
    for (const item of [discard, recycle]) if (await absent(item)) deleted.add(item);
    await inspect(deleted);
    for (const item of [discard, recycle]) if (!deleted.has(item)) await fs.unlink(item);
    await fs.unlink(keep); await fs.unlink(other); await fs.unlink(marker);
    await fs.rmdir(left); await fs.rmdir(right); await fs.rmdir(root);
  }
  return { root, left, right, discard, recycle, keep, other, confirm, verifyAfterDelete, verifyAfterTrash, cleanup,
    get remainingNames() { return [discard, recycle, keep, other].filter(item => !removed.has(item)).map(item => path.basename(item)); } };
}

module.exports = { createDeletionStoryFixture };
