const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');

test('an interrupted metadata read cannot replace the snapshot of a completed copy', async t => {
  const root = (await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-read-priority-'))).replaceAll('\\', '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = `${root}/left`, right = `${root}/right`, slow = `${left}/slow`;
  await fs.mkdir(slow, { recursive: true }); await fs.mkdir(right);
  await fs.writeFile(`${left}/source.txt`, 'original bytes'); await fs.writeFile(`${slow}/pending.txt`, 'unrelated bytes');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const provider = createProvider({ roots: [left, right], fs: { ...fs, lstat: async (target, ...args) => {
    if (String(target).replaceAll('\\', '/') === `${slow}/pending.txt`) { enter(); await barrier; }
    return fs.lstat(target, ...args);
  } } });
  const before = await provider.load({ directories: [left, right], visibleOnly: true });
  const controller = new AbortController();
  const reading = provider.prepare(before, { navigation: true, directories: [slow], visibleDirectories: [slow, right], signal: controller.signal });
  reading.catch(() => {}); await entered;
  let copied;
  try {
    controller.abort();
    const source = before.folders[left].find(row => row.name === 'source.txt');
    const changes = [{ kind: 'put', source: source.fsSource, target: right + '/source.txt' }];
    copied = await provider.apply(before, undefined, { transfer: { mode: 'copy', sourcePath: left, targetPath: right, sourceSide: 0, ids: [source.id], changes } });
    assert.equal(await fs.readFile(`${right}/source.txt`, 'utf8'), 'original bytes');
  } finally { release(); await assert.rejects(reading, { name: 'AbortError' }); }
  const next = await provider.apply(copied, structuredClone(copied));
  assert.ok(next.folders[right].some(row => row.name === 'source.txt'));
  assert.equal(await fs.readFile(`${left}/source.txt`, 'utf8'), 'original bytes');
});
