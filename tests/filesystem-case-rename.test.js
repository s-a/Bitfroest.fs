const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const slash = value => value.replace(/\\/g, '/');
async function setup(t, fsOverride) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-case-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const left = slash(path.join(parent, 'left')), right = slash(path.join(parent, 'right'));
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/lower.txt`, 'keep bytes');
  await fs.mkdir(`${left}/docs`); await fs.writeFile(`${left}/docs/nested.txt`, 'nested');
  return { left, right, provider: createProvider({ roots: [left, right], fs: fsOverride }) };
}
const clone = value => JSON.parse(JSON.stringify(value));
test('a provider copy retains the old source modification time in the destination', async t => {
  const { provider, left, right } = await setup(t);
  const oldTime = new Date('2001-01-02T03:04:05.000Z'); await fs.utimes(`${left}/lower.txt`, oldTime, oldTime);
  const before = await provider.load(), after = clone(before);
  const original = after.folders[left].find(row => row.name === 'lower.txt');
  after.folders[right].push({ ...original, id: 'copy' });
  await provider.apply(before, after);
  assert.equal((await fs.stat(`${right}/lower.txt`)).mtimeMs, (await fs.stat(`${left}/lower.txt`)).mtimeMs);
});


