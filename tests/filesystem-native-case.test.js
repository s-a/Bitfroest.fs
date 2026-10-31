const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const { renameCase } = require('../native-rename');
async function fixture(t, options = {}) {
  const root = (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-case-provider-')))).replace(/\\/g, '/');
  t.after(async () => { assert.ok(root.startsWith((await fs.realpath(os.tmpdir())).replace(/\\/g, '/'))); await fs.rm(root, { recursive: true, force: true }); });
  const left = `${root}/left`, right = `${root}/right`;
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/lower.txt`, 'ORIGINAL');
  return { left, right, provider: createProvider({ roots: [left, right], ...options }) };
}
test('provider atomically changes a filename case', { skip: process.platform !== 'win32' }, async t => {
  const { provider, left } = await fixture(t);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left][0].name = 'LOWER.txt';
  const result = await provider.apply(before, after);
  assert.equal(result.folders[left][0].name, 'LOWER.txt');
  assert.equal(await fs.readFile(`${left}/LOWER.txt`, 'utf8'), 'ORIGINAL');
});
test('provider changes a prepared directory case and keeps its descendants', { skip: process.platform !== 'win32' }, async t => {
  const { provider, left } = await fixture(t);
  await fs.mkdir(`${left}/docs`); await fs.writeFile(`${left}/docs/item.txt`, 'CHILD');
  const before = await provider.load({ recursive: true }), after = structuredClone(before);
  after.folders[left].find(file => file.name === 'docs').name = 'DOCS';
  after.folders[`${left}/DOCS`] = after.folders[`${left}/docs`]; delete after.folders[`${left}/docs`];
  const result = await provider.apply(before, after);
  assert.ok(result.folders[left].some(file => file.name === 'DOCS'));
  assert.equal(await fs.readFile(`${left}/DOCS/item.txt`, 'utf8'), 'CHILD');
});
test('provider does not replace external bytes exchanged before the native call', { skip: process.platform !== 'win32' }, async t => {
  let exchanged = false;
  const { provider, left } = await fixture(t, { renameCase: async input => {
    if (!exchanged) { exchanged = true; await fs.rename(input.source, `${input.source}.original`); await fs.writeFile(input.source, 'EXTERNAL'); }
    return renameCase(input);
  } });
  const before = await provider.load(), after = structuredClone(before); after.folders[left][0].name = 'LOWER.txt';
  await assert.rejects(provider.apply(before, after), /changed|geändert/);
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'EXTERNAL');
  assert.equal(await fs.readFile(`${left}/lower.txt.original`, 'utf8'), 'ORIGINAL');
});

test('a later native failure rolls an earlier case rename back without Node replacement', { skip: process.platform !== 'win32' }, async t => {
  let calls = 0;
  const { provider, left } = await fixture(t, { renameCase: async input => {
    if (++calls === 2) throw new Error('Second rename stopped');
    return renameCase(input);
  } });
  await fs.writeFile(`${left}/other.txt`, 'OTHER');
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left].forEach(file => { file.name = file.name.toUpperCase(); });
  await assert.rejects(provider.apply(before, after), /Second rename stopped/);
  assert.deepEqual(await fs.readdir(left), ['lower.txt', 'other.txt']);
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
});

test('a source changed after snapshot validation cannot be accepted as a fresh expected source', { skip: process.platform !== 'win32' }, async t => {
  let injected = false;
  const { provider, left } = await fixture(t, { renameCase: async input => {
    injected = true;
    await fs.writeFile(input.source, 'EXTERNAL');
    return renameCase(input);
  } });
  const before = await provider.load(), after = structuredClone(before); after.folders[left][0].name = 'LOWER.txt';
  await assert.rejects(provider.apply(before, after), /geändert|changed/);
  assert.equal(injected, true);
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'EXTERNAL');
  assert.deepEqual(await fs.readdir(left), ['lower.txt']);
});

test('case rollback retains a subsequently changed file and reports incomplete recovery', { skip: process.platform !== 'win32' }, async t => {
  let calls = 0, firstTarget;
  const { provider, left } = await fixture(t, { renameCase: async input => {
    if (++calls === 1) { firstTarget = input.target; return renameCase(input); }
    if (calls === 2) { await fs.writeFile(firstTarget, 'EXTERNAL'); throw new Error('Second rename stopped'); }
    return renameCase(input);
  } });
  await fs.writeFile(`${left}/other.txt`, 'OTHER');
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left].forEach(file => { file.name = file.name.toUpperCase(); });
  await assert.rejects(provider.apply(before, after), /Wiederherstellung unvollständig/);
  const names = await fs.readdir(left);
  assert.ok(names.includes('LOWER.TXT'), JSON.stringify(names));
  assert.equal(await fs.readFile(`${left}/LOWER.txt`, 'utf8'), 'EXTERNAL');
});

test('provider opt-in callback commits a case rename through the packaged native API', { skip: process.platform !== 'win32' }, async t => {
  const { createNativeApi } = require('../native-api');
  const nativeApi = createNativeApi(require('../native/binding.node'));
  try {
    const { provider, left } = await fixture(t, { renameCase: input => renameCase(input, { nativeApi }) });
    const before = await provider.load(), after = structuredClone(before);
    after.folders[left][0].name = 'LOWER.txt';
    const result = await provider.apply(before, after);
    assert.equal(result.folders[left][0].name, 'LOWER.txt');
    assert.deepEqual(await fs.readdir(left), ['LOWER.txt']);
    assert.equal(await fs.readFile(`${left}/LOWER.txt`, 'utf8'), 'ORIGINAL');
  } finally { nativeApi.shutdown(); }
});

test('provider rolls back a committed native case rename after the next callback fails', { skip: process.platform !== 'win32' }, async t => {
  const { createNativeApi } = require('../native-api');
  const nativeApi = createNativeApi(require('../native/binding.node'));
  let calls = 0;
  try {
    const { provider, left } = await fixture(t, { renameCase: input => {
      calls++;
      if (calls === 2) throw new Error('Second native callback stopped.');
      return renameCase(input, { nativeApi });
    } });
    await fs.writeFile(`${left}/other.txt`, 'OTHER');
    const before = await provider.load(), after = structuredClone(before);
    after.folders[left].forEach(file => { file.name = file.name.toUpperCase(); });
    await assert.rejects(provider.apply(before, after), /Second native callback stopped/);
    assert.equal(calls, 3);
    assert.deepEqual((await fs.readdir(left)).sort(), ['lower.txt', 'other.txt']);
    assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  } finally { nativeApi.shutdown(); }
});
