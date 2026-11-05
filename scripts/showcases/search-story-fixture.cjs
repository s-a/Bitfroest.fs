const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const contents = '# Project plan\n\nLaunch checklist: review the delivery date.\n';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

async function createSearchStoryFixture(base) {
  if (!path.isAbsolute(base)) throw new Error('The showcase fixture parent must be absolute.');
  const stat = await fs.lstat(base, { bigint: true }), parent = await fs.realpath(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same(parent, base)) throw new Error('The showcase fixture parent is unavailable or redirected.');
  const parentIdentity = identity(stat), root = await fs.mkdtemp(path.join(parent, 'search-story-'));
  const left = path.join(root, 'project'), right = path.join(root, 'destination');
  const marker = path.join(root, '.showcase-search'), token = crypto.randomUUID();
  await fs.mkdir(left); await fs.mkdir(right);
  const documents = path.join(left, 'documents');
  await fs.mkdir(documents);
  const file = path.join(documents, 'Project-Plan.md'), checklist = path.join(left, 'Checklist.txt');
  await fs.writeFile(file, contents, { flag: 'wx' });
  await fs.writeFile(checklist, 'Handover checklist.\n', { flag: 'wx' });
  await fs.writeFile(marker, token, { flag: 'wx' });
  const identities = new Map();
  for (const item of [root, left, right, documents, file, checklist, marker]) identities.set(item, identity(await fs.lstat(item, { bigint: true })));
  async function assertIntact() {
    const currentParent = await fs.lstat(parent, { bigint: true });
    if (currentParent.isSymbolicLink() || identity(currentParent) !== parentIdentity || !same(await fs.realpath(parent), parent)) throw new Error('The showcase fixture parent identity changed.');
    for (const [item, expected] of identities) {
      const observed = await fs.lstat(item, { bigint: true });
      if (observed.isSymbolicLink() || identity(observed) !== expected || !same(await fs.realpath(item), item)) throw new Error('The showcase fixture identity changed.');
    }
    if (await fs.readFile(marker, 'utf8') !== token || await fs.readFile(file, 'utf8') !== contents || await fs.readFile(checklist, 'utf8') !== 'Handover checklist.\n') throw new Error('The showcase file changed.');
    const entries = async folder => (await fs.readdir(folder)).sort();
    if (JSON.stringify(await entries(root)) !== JSON.stringify(['.showcase-search', 'destination', 'project'].sort()) ||
        JSON.stringify(await entries(left)) !== JSON.stringify(['Checklist.txt', 'documents'].sort()) ||
        JSON.stringify(await entries(documents)) !== JSON.stringify(['Project-Plan.md']) || (await entries(right)).length) throw new Error('Unexpected files in showcase fixture.');
  }
  return {
    root, left, right, file, query: 'Project-Plan.md', findText: 'delivery date',
    async verify(results) {
      if (!Array.isArray(results) || results.length !== 1 || !same(results[0], file)) throw new Error('Unexpected search results.');
      await assertIntact();
    },
    async cleanup() {
      await assertIntact();
      await fs.unlink(file); await fs.unlink(checklist); await fs.unlink(marker);
      await fs.rmdir(documents); await fs.rmdir(left); await fs.rmdir(right); await fs.rmdir(root);
    }
  };
}

module.exports = { createSearchStoryFixture };
