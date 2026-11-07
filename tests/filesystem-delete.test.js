const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const slash = value => value.replace(/\\/g, '/');

test('explicit current-folder deletion permits a visible scan boundary while preserving configured roots', async t => {
  const calls = [], { provider, left, right } = await fixture(t, async target => { calls.push(target); await fs.rm(target, { recursive: true }); });
  const child = `${left}/child`;
  const rootView = await provider.load({ left, right, visibleOnly: true, directories: [left, right] });
  await assert.rejects(provider.remove(rootView, { paths: [left], useTrash: true, currentDirectory: left }));
  const before = await provider.load({ left: child, right, visibleOnly: true, directories: [child, right], visibleDirectories: [child, right] });
  await assert.rejects(provider.remove(before, { paths: [child], useTrash: true }));
  await assert.rejects(provider.remove(before, { paths: [left], useTrash: true, currentDirectory: left }));
  await assert.rejects(provider.remove(before, { paths: [child], useTrash: true, currentDirectory: right }));
  assert.deepEqual(calls, []);
  await provider.remove(before, { paths: [child], useTrash: true, currentDirectory: child });
  assert.deepEqual(calls, [child]);
  await assert.rejects(fs.stat(child), { code: 'ENOENT' });
  assert.equal(await fs.readFile(`${left}/a.txt`, 'utf8'), 'a');
});
async function fixture(t, deletePath) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-delete-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const left = slash(path.join(directory, 'left')), right = slash(path.join(directory, 'right'));
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(`${left}/a.txt`, 'a'); await fs.writeFile(`${left}/b.txt`, 'b');
  await fs.mkdir(`${left}/child`); await fs.writeFile(`${left}/child/inside.txt`, 'inside');
  return { left, right, provider: createProvider({ roots: [left, right], deletePath }) };
}

test('deleting a folder from its deferred parent works while the folder is open in the other pane', async t => {
  const calls = [], { provider, left, right } = await fixture(t, async target => {
    calls.push(target);
    await fs.rm(target, { recursive: true });
  });
  const child = `${left}/child`;
  await provider.load({ directories: [left, right], visibleOnly: true });
  const before = await provider.load({
    left, right: child, directories: [child], deferredDirectories: [left], visibleOnly: true,
    visibleDirectories: [child]
  });
  const row = before.folders[left].find(row => row.name === 'child');
  assert.equal(row?.fsSource, child);

  const after = await provider.remove(before, { paths: [row.fsSource], useTrash: true });

  assert.deepEqual(calls, [child]);
  assert.equal(after.folders[left].some(row => row.name === 'child'), false);
  assert.equal(await fs.readFile(`${left}/a.txt`, 'utf8'), 'a');
});

test('deleting the only folder tab in the opposite pane opens its parent there', async t => {
  const { provider, left, right } = await fixture(t, target => fs.rm(target, { recursive: true }));
  const parent = `${right}/parent`, child = `${parent}/child`;
  await fs.mkdir(child, { recursive: true });
  await fs.writeFile(`${parent}/keep.txt`, 'keep');
  const before = await provider.load({
    left: parent, right: child, visibleOnly: true, directories: [parent, child], visibleDirectories: [parent, child]
  });
  assert.notEqual(parent, left);
  assert.deepEqual(before.panes[1].tabs, [child]);

  const after = await provider.remove(before, { paths: [child], useTrash: true });

  assert.deepEqual(after.panes.map(pane => pane.tabs[pane.tab]), [parent, parent]);
  assert.deepEqual(after.panes[1].tabs, [parent]);
  assert.deepEqual(after.folders[parent].map(row => row.name), ['keep.txt']);
  assert.equal(Object.hasOwn(after.folders, child), false);
});

test('trash deletion passes the original name and trash option to the native adapter', async t => {
  const calls = [];
  const { provider, left } = await fixture(t, async (target, options) => { calls.push({ target, options }); await fs.unlink(target); });
  const before = await provider.load();
  const progress = [];
  const after = await provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true }, { onProgress: event => progress.push(event) });
  assert.deepEqual(progress.map(event => event.overall.completed), [0, 1]);
  assert.ok(progress.every(event => event.version === 1 && event.overall.total === 1));
  assert.deepEqual(calls, [{ target: `${left}/a.txt`, options: { recursive: true, useTrash: true } }]);
  assert.ok(!after.folders[left].some(row => row.name === 'a.txt'));
  assert.equal(await fs.readFile(`${left}/b.txt`, 'utf8'), 'b');
});

test('cancelling deletion preserves the remaining selected roots after the active native call', async t => {
  const controller = new AbortController();
  const { provider, left } = await fixture(t, async target => { await fs.unlink(target); controller.abort(); });
  const before = await provider.load();
  await assert.rejects(provider.remove(before, { paths: [`${left}/a.txt`, `${left}/b.txt`], useTrash: false }, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(await fs.readFile(`${left}/b.txt`, 'utf8'), 'b');
  await assert.rejects(fs.stat(`${left}/a.txt`), { code: 'ENOENT' });
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
  for (const paths of [[], [left], [`${left}/a.txt`, `${left}/../escape`], [`${left}/missing`], [`${left}/a.txt`, right]]) await assert.rejects(provider.remove(before, { paths, useTrash: true }));
  assert.deepEqual(calls, []);
  await fs.writeFile(`${left}/a.txt`, 'external');
  await assert.rejects(provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true }), /veraltet|geändert/);
  assert.deepEqual(calls, []);
  before = await provider.load();
  const stale = { ...before, snapshotId: 'fake' };
  await assert.rejects(provider.remove(stale, { paths: [`${left}/a.txt`], useTrash: true }));
});

test('deletion tolerates unrelated changes and changed contents of the same selected folder', async t => {
  const calls = [], { provider, left } = await fixture(t, async target => { calls.push(target); await fs.rm(target, { recursive: true }); });
  let before = await provider.load();
  await fs.writeFile(`${left}/b.txt`, 'unrelated');
  await provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true });
  assert.deepEqual(calls, [`${left}/a.txt`]);
  before = await provider.load({ recursive: true });
  await fs.writeFile(`${left}/child/inside.txt`, 'externally changed descendant');
  await provider.remove(before, { paths: [`${left}/child`], useTrash: true });
  assert.deepEqual(calls, [`${left}/a.txt`, `${left}/child`]);
});

test('an unloaded folder is deleted without enumerating or reading any descendants', async t => {
  const { left, right } = await fixture(t);
  let deleting = false;
  const calls = [];
  const provider = createProvider({ roots: [left, right], fs: { ...fs,
    readdir: async (target, ...args) => {
      assert.equal(deleting && slash(String(target)).startsWith(`${left}/child`), false, 'no target inventory');
      return fs.readdir(target, ...args);
    },
    lstat: async (target, ...args) => {
      assert.equal(deleting && slash(String(target)).startsWith(`${left}/child/`), false, 'no descendant metadata');
      const stat = await fs.lstat(target, ...args);
      return deleting && slash(String(target)) === `${left}/child` && args[0]?.bigint
        ? Object.assign(Object.create(stat), { mtimeNs: 0n, ctimeNs: 0n }) : stat;
    }
  }, deletePath: async (target, options) => { calls.push({ target, options }); await fs.rm(target, { recursive: true }); } });
  const before = await provider.load();
  assert.ok(before.unloadedFolders.includes(`${left}/child`));
  deleting = true;
  const after = await provider.remove(before, { paths: [`${left}/child`], useTrash: true });
  assert.deepEqual(calls, [{ target: `${left}/child`, options: { recursive: true, useTrash: true } }]);
  assert.equal(after.folders[left].some(row => row.name === 'child'), false);
  assert.equal(await fs.readFile(`${left}/b.txt`, 'utf8'), 'b');
});

test('directory deletion rejects identity changes and links before the native call', async t => {
  const { left, right } = await fixture(t);
  for (const change of ['identity', 'link', 'parent-link']) {
    let checking = false;
    const calls = [];
    const provider = createProvider({ roots: [left, right], fs: { ...fs, lstat: async (target, ...args) => {
      const stat = await fs.lstat(target, ...args), value = slash(String(target));
      if (!checking) return stat;
      if (change === 'parent-link' && value === left || change === 'link' && value === `${left}/child`) return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
      if (change === 'identity' && value === `${left}/child` && args[0]?.bigint) return Object.assign(Object.create(stat), { ino: stat.ino + 1n });
      return stat;
    } }, deletePath: async target => calls.push(target) });
    const before = await provider.load(); checking = true;
    await assert.rejects(provider.remove(before, { paths: [`${left}/child`], useTrash: false }));
    assert.deepEqual(calls, []);
  }
});

test('cancellation during the final target identity read prevents the native deletion', async t => {
  const { left, right } = await fixture(t);
  const controller = new AbortController(), calls = [];
  let deleting = false, reads = 0;
  const provider = createProvider({ roots: [left, right], fs: { ...fs, lstat: async (target, ...args) => {
    const stat = await fs.lstat(target, ...args);
    if (deleting && slash(String(target)) === `${left}/child` && args[0]?.bigint && ++reads === 2) controller.abort();
    return stat;
  } }, deletePath: async target => calls.push(target) });
  const before = await provider.load(); deleting = true;
  await assert.rejects(provider.remove(before, { paths: [`${left}/child`], useTrash: true }, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, []);
});

test('a removed optional view cannot turn a completed native deletion into a reported failure', async t => {
  const { provider, left } = await fixture(t, target => fs.unlink(target));
  const before = await provider.load({ directories: [`${left}/child`] });
  await fs.unlink(`${left}/child/inside.txt`); await fs.rmdir(`${left}/child`);
  const result = await provider.remove(before, { paths: [`${left}/a.txt`], useTrash: true });
  assert.equal(result.folders[left].some(row => row.name === 'a.txt'), false);
  assert.equal(Object.hasOwn(result.folders, `${left}/child`), false);
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
  await assert.rejects(provider.remove(before, { paths: [`${left}/a.txt`, `${left}/b.txt`], useTrash: true }), {
    deletedCount: 1, deleteTarget: { path: `${left}/b.txt`, folder: false }
  });
  assert.equal(await fs.readFile(`${left}/b.txt`, 'utf8'), 'b');
  await assert.rejects(provider.remove(before, { paths: [`${left}/b.txt`], useTrash: true }));
});
