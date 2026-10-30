const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const slash = value => value.replace(/\\/g, '/');
async function fixture(t, deletePath) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-delete-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const left = slash(path.join(directory, 'left')), right = slash(path.join(directory, 'right'));
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(`${left}/a.txt`, 'a'); await fs.writeFile(`${left}/b.txt`, 'b');
  await fs.mkdir(`${left}/child`); await fs.writeFile(`${left}/child/inside.txt`, 'inside');
  return { left, right, provider: createProvider({ roots: [left, right], deletePath }) };
}

test('trash deletion passes the original name and trash option to the native adapter', async t => {
  const calls = [];
  const { provider, left } = await fixture(t, async (target, options) => { calls.push({ target, options }); await fs.unlink(target); });
  const before = await provider.load();
  const after = await provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true });
  assert.deepEqual(calls, [{ target: `${left}/a.txt`, options: { recursive: true, useTrash: true } }]);
  assert.ok(!after.folders[left].some(row => row.name === 'a.txt'));
  assert.equal(await fs.readFile(`${left}/b.txt`, 'utf8'), 'b');
});

test('unsupported or failed trash leaves files intact and never invokes a permanent fallback', async t => {
  for (const adapter of [undefined, async () => { throw new Error('Trash unavailable'); }]) {
    const { provider, left } = await fixture(t, adapter), before = await provider.load();
    await assert.rejects(provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true }));
    assert.equal(await fs.readFile(`${left}/a.txt`, 'utf8'), 'a');
  }
});

test('all deletion paths and snapshot metadata are validated before invoking the adapter', async t => {
  const calls = [], { provider, left, right } = await fixture(t, async target => calls.push(target));
  let before = await provider.load();
  for (const paths of [[], [left], [`${left}/a.txt`, `${left}/../escape`], [`${left}/missing`], [`${left}/child`], [`${left}/a.txt`, right]]) await assert.rejects(provider.remove(before, { paths, useTrash: true }));
  assert.deepEqual(calls, []);
  await fs.writeFile(`${left}/b.txt`, 'external');
  await assert.rejects(provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true }), /veraltet|geändert/);
  assert.deepEqual(calls, []);
  before = await provider.load();
  const stale = { ...before, snapshotId: 'fake' };
  await assert.rejects(provider.remove(stale, { paths: [`${left}/a.txt`], useTrash: true }));
});

test('prepared directory deletion removes a whole selected tree with one native call', async t => {
  const calls = [], { provider, left } = await fixture(t, async target => { calls.push(target); await fs.rm(target, { recursive: true }); });
  const before = await provider.load({ recursive: true });
  const after = await provider.remove(before, { paths: [`${left}/child`, `${left}/child/inside.txt`], useTrash: false });
  assert.deepEqual(calls, [`${left}/child`]);
  assert.equal(after.folders[`${left}/child`], undefined);
});

test('partial native deletion reports the completed count and invalidates its stale snapshot', async t => {
  let calls = 0;
  const { provider, left } = await fixture(t, async target => { if (++calls === 2) throw new Error('Locked'); await fs.unlink(target); });
  const before = await provider.load();
  await assert.rejects(provider.remove(before, { paths: [`${left}/a.txt`, `${left}/b.txt`], useTrash: true }), /1/);
  assert.equal(await fs.readFile(`${left}/b.txt`, 'utf8'), 'b');
  await assert.rejects(provider.remove(before, { paths: [`${left}/b.txt`], useTrash: true }));
});
