const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const content = 'Project handover notes for the showcase.\n';
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const equalPath = (a, b) => typeof a === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b));

async function createStoryFixture(parent, { timeout = 15000, interval = 50 } = {}) {
  const parentPath = await fs.realpath(parent);
  if (!(await fs.stat(parentPath)).isDirectory()) throw new Error('Invalid fixture parent.');
  const root = await fs.mkdtemp(path.join(parentPath, 'showcase-story-'));
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  const token = crypto.randomUUID(), marker = path.join(root, '.showcase-story');
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(marker, token, { flag: 'wx' });
  const folder = path.join(right, 'Handover');
  const source = path.join(left, 'Project-Plan.md'), copy = path.join(folder, 'Project-Plan.md');
  const renamed = path.join(folder, 'Handover-Plan.md');
  await fs.writeFile(source, content, { flag: 'wx' });
  const identities = new Map();
  for (const item of [root, left, right, marker, source]) identities.set(item, identity(await fs.lstat(item, { bigint: true })));
  const completed = new Set(); let busy = false, failed = false;
  async function intact(item) {
    const stat = await fs.lstat(item, { bigint: true });
    if (stat.isSymbolicLink() || identity(stat) !== identities.get(item) || !equalPath(await fs.realpath(item), item)) throw new Error('Showcase fixture identity changed.');
  }
  async function safeRoot() {
    for (const item of [root, left, right, marker, source]) await intact(item);
    if (completed.has('mkdir')) await intact(folder);
    if (await fs.readFile(marker, 'utf8') !== token || await fs.readFile(source, 'utf8') !== content) throw new Error('Showcase fixture contents changed.');
  }
  async function absent(item) {
    try { await fs.lstat(item); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  const selected = (snapshot, expected) => Array.isArray(snapshot.selected) && snapshot.selected.length === expected.length && snapshot.selected.every((value, i) => equalPath(value, expected[i]));
  async function validate(action, snapshot) {
    await safeRoot();
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid fixture snapshot.');
    if (action === 'mkdir' && snapshot.controlReady === true && equalPath(snapshot.activeDirectory, right) && equalPath(snapshot.targetDirectory, right) && selected(snapshot, []) && snapshot.dialog === 'New folder' && snapshot.input === 'Handover' && await absent(folder)) return;
    if (action === 'open' && snapshot.controlReady === true && completed.has('mkdir') && equalPath(snapshot.activeDirectory, right) && selected(snapshot, [folder]) && snapshot.entryType === 'folder' && snapshot.dialog === 'folder-list') return;
    if (action === 'copy' && snapshot.controlReady === true && completed.has('open') && equalPath(snapshot.activeDirectory, left) && equalPath(snapshot.otherDirectory, folder) && equalPath(snapshot.transferSource, left) && selected(snapshot, [source]) && snapshot.dialog === 'Copy' && equalPath(snapshot.input, folder) && snapshot.filter === '*.*' && snapshot.policy === 'ask' && snapshot.individualNames === false && await absent(copy)) return;
    if (action === 'rename' && snapshot.controlReady === true && completed.has('copy') && equalPath(snapshot.activeDirectory, folder) && selected(snapshot, [copy]) && snapshot.dialog === 'inline-rename' && snapshot.input === 'Handover-Plan.md' && await absent(renamed)) {
      await intact(copy);
      const stat = await fs.lstat(copy);
      if (!stat.isFile() || stat.isSymbolicLink() || !equalPath(await fs.realpath(copy), copy) || await fs.readFile(copy, 'utf8') !== content) throw new Error('Invalid fixture source.');
      return;
    }
    throw new Error('The operation does not match the authorized fixture action.');
  }
  async function result(action, observed) {
    await safeRoot();
    if (action === 'open') return equalPath(observed?.activeDirectory, folder);
    if (action === 'mkdir') { const stat = await fs.lstat(folder); return stat.isDirectory() && !stat.isSymbolicLink() && equalPath(await fs.realpath(folder), folder); }
    const file = action === 'copy' ? copy : renamed;
    const stat = await fs.lstat(file, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && equalPath(await fs.realpath(file), file) && await fs.readFile(file, 'utf8') === content && (action !== 'rename' || await absent(copy));
  }
  async function confirm(action, snapshot, trigger) {
    if (busy || failed || completed.has(action)) throw new Error('Fixture action is busy, failed, or already completed.');
    if (typeof trigger !== 'function') throw new Error('A confirmation trigger is required.');
    busy = true;
    try {
      await validate(action, snapshot);
      try {
        const observed = await trigger();
        const deadline = Date.now() + timeout;
        do {
          try { if (await result(action, observed)) {
            if (action === 'mkdir' || action === 'copy') {
              const item = action === 'mkdir' ? folder : copy;
              identities.set(item, identity(await fs.lstat(item, { bigint: true })));
              await intact(item);
            }
            completed.add(action); return;
          } } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await new Promise(resolve => setTimeout(resolve, interval));
        } while (Date.now() < deadline);
        throw new Error('The expected fixture result was not observed.');
      } catch (error) { failed = true; throw error; }
    } finally { busy = false; }
  }
  return { root, left, right, folder, confirm };
}

module.exports = { createStoryFixture };
