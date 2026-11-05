const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zip = require('@zip.js/zip.js');

const content = 'Project handover notes for the showcase.\n';
const same = (a, b) => typeof a === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

async function createArchiveStoryFixture(parent, { timeout = 15000, interval = 50 } = {}) {
  const base = await fs.realpath(parent);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('Invalid fixture parent.');
  const root = await fs.mkdtemp(path.join(base, 'showcase-archive-'));
  const left = path.join(root, 'left'), right = path.join(root, 'right'), unpacked = path.join(root, 'unpacked');
  for (const directory of [left, right, unpacked]) await fs.mkdir(directory);
  const source = path.join(left, 'Project-Plan.md'), archive = path.join(right, 'Project-Plan.zip'), extracted = path.join(unpacked, 'Project-Plan.md');
  await fs.writeFile(source, content, { flag: 'wx' });
  const identities = new Map();
  for (const item of [root, left, right, unpacked, source]) identities.set(item, identity(await fs.lstat(item, { bigint: true })));
  const completed = new Set(); let busy = false, failed = false, archiveIdentity, archiveHash;
  async function intact() {
    for (const [item, expected] of identities) {
      const stat = await fs.lstat(item, { bigint: true });
      if (stat.isSymbolicLink() || identity(stat) !== expected || !same(await fs.realpath(item), item)) throw new Error('Showcase fixture identity changed.');
    }
    if (await fs.readFile(source, 'utf8') !== content) throw new Error('Showcase source changed.');
  }
  async function absent(file) {
    try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  async function verifyArchive() {
    await intact();
    const stat = await fs.lstat(archive, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !same(await fs.realpath(archive), archive)) throw new Error('Invalid showcase archive.');
    const bytes = await fs.readFile(archive), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (archiveIdentity && (archiveIdentity !== identity(stat) || archiveHash !== hash)) throw new Error('Showcase archive changed.');
    const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes), { useWebWorkers: false, checkCrc32: true });
    try {
      const entries = await reader.getEntries();
      if (entries.length !== 1 || entries[0].filename !== 'Project-Plan.md' || entries[0].directory || entries[0].encrypted || await entries[0].getData(new zip.TextWriter(), { checkCrc32: true }) !== content) throw new Error('Unexpected showcase archive contents.');
    } finally { await reader.close(); }
    return { identity: identity(stat), hash };
  }
  async function confirm(action, state, trigger) {
    if (busy || failed || completed.has(action)) throw new Error('Fixture action is busy, failed, or already completed.');
    if (typeof trigger !== 'function') throw new Error('A confirmation trigger is required.');
    await intact();
    const selected = target => Array.isArray(state?.selected) && state.selected.length === 1 && same(state.selected[0], target);
    const pack = action === 'pack' && state?.controlReady === true && same(state.activeDirectory, left) && same(state.otherDirectory, right) && selected(source) && state.dialog === 'Pack selection' && same(state.input, archive) && state.paths === true && state.recursive === true && state.move === false && state.encryption === 'none' && await absent(archive);
    const unpack = action === 'unpack' && completed.has('pack') && state?.controlReady === true && same(state.activeDirectory, right) && selected(archive) && state.dialog === 'Unpack archive' && same(state.input, unpacked) && state.paths === true && state.overwrite === false && state.separate === false && state.filter === '*.*' && await absent(extracted);
    if (!pack && !unpack) throw new Error('The operation does not match the authorized fixture action.');
    if (unpack) await verifyArchive();
    busy = true;
    try {
      await trigger();
      const deadline = Date.now() + timeout;
      do {
        try {
          if (pack) { const verified = await verifyArchive(); archiveIdentity = verified.identity; archiveHash = verified.hash; completed.add(action); return; }
          const stat = await fs.lstat(extracted);
          if (stat.isFile() && !stat.isSymbolicLink() && same(await fs.realpath(extracted), extracted) && await fs.readFile(extracted, 'utf8') === content) { await verifyArchive(); completed.add(action); return; }
        } catch (error) { if (error.code !== 'ENOENT' && !pack) throw error; }
        await new Promise(resolve => setTimeout(resolve, interval));
      } while (Date.now() < deadline);
      throw new Error('The expected fixture result was not observed.');
    } catch (error) { failed = true; throw error; } finally { busy = false; }
  }
  async function validateOpen(state) {
    if (!completed.has('pack') || !state?.controlReady || state.realFilesystem !== true || !same(state.activeDirectory, right) ||
      !Array.isArray(state.selected) || state.selected.length !== 1 || !same(state.selected[0], archive) ||
      state.entryName !== 'Project-Plan.zip' || state.dialog !== 'file-list') throw new Error('The selected archive is not the authorized showcase archive.');
    await verifyArchive();
  }
  async function validateLeave(state) {
    if (!completed.has('pack') || !state?.controlReady || !state.realFilesystem || !state.parentSelected ||
      !same(state.archive, archive) || !same(state.parent, right)) throw new Error('The archive navigation is not authorized.');
    await verifyArchive();
  }
  async function validateUnpackInput(state) {
    if (!completed.has('pack') || !state?.controlReady || !same(state.activeDirectory, right) || !Array.isArray(state.selected) || state.selected.length !== 1 || !same(state.selected[0], archive) ||
      state.dialog !== 'Unpack archive' || state.paths !== true || state.overwrite !== false || state.separate !== false || state.filter !== '*.*' || !await absent(extracted)) throw new Error('The unpack input is not authorized.');
    await verifyArchive();
  }
  async function validatePathEdit(state) {
    if (!completed.has('unpack') || !state?.controlReady || !state.realFilesystem || !same(state.activeDirectory, left)) throw new Error('The extracted folder navigation is not authorized.');
    await verifyArchive();
    const stat = await fs.lstat(extracted);
    if (!stat.isFile() || stat.isSymbolicLink() || !same(await fs.realpath(extracted), extracted) || await fs.readFile(extracted, 'utf8') !== content) throw new Error('The extracted fixture file changed.');
  }
  async function validateShow(state) {
    await validatePathEdit(state);
    if (!same(state.input, unpacked)) throw new Error('The extracted folder navigation is not authorized.');
  }
  return { root, left, right, unpacked, source, archive, extracted, confirm, verifyArchive, validateOpen, validateLeave, validateUnpackInput, validatePathEdit, validateShow };
}

module.exports = { createArchiveStoryFixture };
