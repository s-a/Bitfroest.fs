const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');
const transfer = require('../media/commander-transfer');

async function fixture(t) {
  const temporary = process.platform === 'win32' ? 'C:/tmp' : os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporary, 'remaining-reference-test-')));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), (await fs.realpath(temporary)).toLowerCase());
    assert.ok(path.basename(root).startsWith('remaining-reference-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const left = path.join(root, 'left').replace(/\\/g, '/'), right = path.join(root, 'right').replace(/\\/g, '/');
  await fs.mkdir(left); await fs.mkdir(right);
  return { left, right, provider: createProvider({ roots: [left, right] }) };
}

test('append timestamps describe changed combined contents while empty appends preserve the existing target time', async t => {
  for (const mode of ['copy', 'move']) for (const empty of [false, true]) {
    const { provider, left, right } = await fixture(t);
    const original = Buffer.from([0, 255, 4]), incoming = empty ? Buffer.alloc(0) : Buffer.from([255, 0, 8]);
    await fs.writeFile(`${left}/a.bin`, incoming); await fs.writeFile(`${right}/a.bin`, original);
    await fs.utimes(`${left}/a.bin`, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    await fs.utimes(`${right}/a.bin`, new Date('2002-01-01T00:00:00Z'), new Date('2002-01-01T00:00:00Z'));
    const targetTime = (await fs.stat(`${right}/a.bin`)).mtimeMs;
    const before = await provider.load(), after = structuredClone(before), source = after.folders[left][0];
    const started = Date.now();
    const planned = await transfer.execute({ folders: after.folders, sourcePath: left, targetPath: right, ids: [source.id], mode, onConflict: () => ({ action: 'append' }) });
    assert.equal(planned.completed, 1);
    await provider.apply(before, after, { signal: new AbortController().signal, transfer: { mode, sourcePath: left, sourceSide: 0, ids: [source.id] } });
    assert.deepEqual(await fs.readFile(`${right}/a.bin`), Buffer.concat([original, incoming]));
    const modified = (await fs.stat(`${right}/a.bin`)).mtimeMs;
    if (empty) assert.equal(modified, targetTime);
    else assert.ok(modified >= started - 2000 && modified <= Date.now() + 2000, `append mtime ${modified} must describe the actual content change`);
    assert.equal(await fs.stat(`${left}/a.bin`).then(() => true, () => false), mode === 'copy');
    if (mode === 'copy') assert.deepEqual(await fs.readFile(`${left}/a.bin`), incoming);
  }
});

test('empty-target copies and repeated wildcard folder masks commit real bytes through the transfer contract', async t => {
  const { provider, left, right } = await fixture(t);
  await fs.writeFile(`${left}/a.txt`, 'original');
  await fs.mkdir(`${left}/docs.old`); await fs.writeFile(`${left}/docs.old/child.bin`, Buffer.from([0, 255, 7]));
  let before = await provider.load({ recursive: true });
  for (const [name, targetPath, mode, policy] of [['a.txt', '', 'copy', 'autorename-source'], ['docs.old', `${right}/****`, 'move', 'ask']]) {
    const after = structuredClone(before), source = after.folders[left].find(row => row.name === name);
    const planned = await transfer.execute({ folders: after.folders, sourcePath: left, targetPath, ids: [source.id], mode, policy });
    assert.equal(planned.errors.length, 0);
    before = await provider.apply(before, after, { signal: new AbortController().signal, transfer: { mode, sourcePath: left, sourceSide: 0, ids: [source.id] } });
  }
  assert.equal(await fs.readFile(`${left}/a.txt`, 'utf8'), 'original');
  assert.equal(await fs.readFile(`${left}/a (2).txt`, 'utf8'), 'original');
  assert.deepEqual(await fs.readFile(`${right}/docs/child.bin`), Buffer.from([0, 255, 7]));
  await assert.rejects(fs.stat(`${left}/docs.old`), { code: 'ENOENT' });
});
