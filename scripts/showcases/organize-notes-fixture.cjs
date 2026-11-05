const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

async function createOrganizeNotesFixture(parent, { timeout = 15000, interval = 50 } = {}) {
  const base = await fs.realpath(parent);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('Invalid fixture parent.');
  const root = await fs.mkdtemp(path.join(base, 'showcase-notes-'));
  const left = path.join(root, 'Drafts'), right = path.join(root, 'Handover');
  const marker = path.join(root, '.showcase-notes'), token = crypto.randomUUID();
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(marker, token, { flag: 'wx' });
  const sources = ['Draft-A.txt', 'Draft-B.txt'].map(name => path.join(left, name));
  const moved = ['Draft-A.txt', 'Draft-B.txt'].map(name => path.join(right, name));
  const renamed = ['Draft-A_1.txt', 'Draft-B_2.txt'].map(name => path.join(right, name));
  const fixed = new Map();
  for (const item of [root, left, right, marker]) fixed.set(item, identity(await fs.lstat(item, { bigint: true })));
  let stage = 'initial', busy = false, failed = false, files = new Map();
  async function intact(item, expected) {
    const stat = await fs.lstat(item, { bigint: true });
    if (stat.isSymbolicLink() || identity(stat) !== expected || !same(await fs.realpath(item), item)) throw new Error('Showcase fixture identity changed.');
    return stat;
  }
  async function assertRoot() {
    for (const [item, id] of fixed) await intact(item, id);
    if (await fs.readFile(marker, 'utf8') !== token) throw new Error('Showcase fixture marker changed.');
    if (JSON.stringify((await fs.readdir(root)).sort()) !== JSON.stringify(['.showcase-notes', 'Drafts', 'Handover'].sort())) throw new Error('Unexpected files in showcase fixture.');
  }
  async function validateFile(file, id) {
    const stat = id ? await intact(file, id) : await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !same(await fs.realpath(file), file) || (await fs.readFile(file)).length !== 0) throw new Error('Invalid showcase note.');
    return identity(stat);
  }
  async function inventory(expectedLeft, expectedRight) {
    await assertRoot();
    const names = async dir => (await fs.readdir(dir)).sort();
    if (JSON.stringify(await names(left)) !== JSON.stringify(expectedLeft.map(x => path.basename(x)).sort()) ||
        JSON.stringify(await names(right)) !== JSON.stringify(expectedRight.map(x => path.basename(x)).sort())) throw new Error('Unexpected files in showcase fixture.');
    for (const [file, id] of files) await validateFile(file, id);
  }
  const selection = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && expected.every(item => actual.filter(value => same(value, item)).length === 1);
  const pairs = [['Draft-A.txt', 'Draft-A_1.txt'], ['Draft-B.txt', 'Draft-B_2.txt']];
  async function validate(action, s) {
    if (stage === 'initial') await inventory([], []);
    else if (stage === 'created') await inventory(sources, []);
    else if (stage === 'moved') await inventory([], moved);
    else await inventory([], renamed);
    if (!s || s.controlReady !== true) throw new Error('The operation does not match the authorized fixture action.');
    if (action === 'create-notes' && stage === 'initial' && same(s.activeDirectory, left) && same(s.targetDirectory, left) && selection(s.selected, []) && s.dialog === 'New text file' && s.input === 'Draft-A.txt|Draft-B.txt') return;
    if (action === 'move-notes' && stage === 'created' && same(s.activeDirectory, left) && same(s.otherDirectory, right) && same(s.transferSource, left) && selection(s.selected, sources) && s.dialog === 'Move' && same(s.input, right) && s.filter === '*.*' && s.policy === 'ask' && s.individualNames === false) return;
    if (action === 'batch-rename' && stage === 'moved' && same(s.activeDirectory, right) && selection(s.selected, moved) && s.dialog === 'Multi-rename' && s.mask === '[N]_[C]' && s.counter === '1' && s.search === '' && s.replacement === '' && s.casing === 'keep' && JSON.stringify(s.preview) === JSON.stringify(pairs)) return;
    throw new Error('The operation does not match the authorized fixture action.');
  }
  async function verifyResult(action) {
    const expectedLeft = action === 'create-notes' ? sources : [];
    const expectedRight = action === 'move-notes' ? moved : action === 'batch-rename' ? renamed : [];
    await assertRoot();
    if (JSON.stringify((await fs.readdir(left)).sort()) !== JSON.stringify(expectedLeft.map(x => path.basename(x)).sort()) ||
        JSON.stringify((await fs.readdir(right)).sort()) !== JSON.stringify(expectedRight.map(x => path.basename(x)).sort())) return false;
    const newFiles = new Map();
    for (const file of [...expectedLeft, ...expectedRight]) newFiles.set(file, await validateFile(file));
    files = newFiles;
    return true;
  }
  async function confirm(action, snapshot, trigger) {
    if (busy || failed || stage === 'renamed') throw new Error('Fixture action is busy, failed, or already completed.');
    if (typeof trigger !== 'function') throw new Error('A confirmation trigger is required.');
    busy = true;
    try {
      await validate(action, snapshot);
      try {
        await trigger();
        const deadline = Date.now() + timeout;
        do {
          try { if (await verifyResult(action)) { stage = ({ 'create-notes': 'created', 'move-notes': 'moved', 'batch-rename': 'renamed' })[action]; return; } }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await new Promise(resolve => setTimeout(resolve, interval));
        } while (Date.now() < deadline);
        throw new Error('The expected fixture result was not observed.');
      } catch (error) { failed = true; throw error; }
    } finally { busy = false; }
  }
  async function cleanup() {
    if (busy) throw new Error('Fixture action is busy.');
    await inventory(stage === 'created' ? sources : [], stage === 'moved' ? moved : stage === 'renamed' ? renamed : []);
    for (const file of files.keys()) await fs.unlink(file);
    await fs.unlink(marker); await fs.rmdir(left); await fs.rmdir(right); await fs.rmdir(root);
  }
  return { root, left, right, sources, moved, renamed, confirm, cleanup };
}

module.exports = { createOrganizeNotesFixture };
