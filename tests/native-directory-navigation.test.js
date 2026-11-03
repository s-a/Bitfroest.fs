const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
const { createDirectoryReader } = require('../native-directory');
const { createNativeApi } = require('../native-api');

const windows = { skip: process.platform !== 'win32' };
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

for (const side of [0, 1]) test(`native parent navigation in panel ${side} retains the opposite child listing`, windows, async t => {
  const root = (await fs.mkdtemp(path.join(os.tmpdir(), 'native-navigation-'))).replaceAll('\\', '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directories = [`${root}/left`, `${root}/right`];
  for (const directory of directories) {
    await fs.mkdir(directory);
    await fs.writeFile(`${directory}/keep.txt`, 'preserved content');
  }
  const reader = createDirectoryReader({ apiFactory: () => createNativeApi(require(binary)) });
  t.after(() => reader.dispose());
  const reads = [];
  const provider = createProvider({ roots: [root], readDirectory: (directory, signal) => {
    reads.push(directory); return reader.readDirectory(directory, signal);
  } });
  const before = await provider.load({ directories, visibleOnly: true });
  before.panes.forEach((pane, index) => { pane.tabs = [directories[index]]; pane.tab = 0; });
  const other = directories[1 - side], expected = structuredClone(before.folders[other]);
  assert.equal(expected.length, 1);
  reads.length = 0;
  const visible = [...directories]; visible[side] = root;
  const after = await provider.prepare(before, { navigation: true, directories: [root], visibleDirectories: visible });
  assert.deepEqual(reads, [root], 'navigation must enumerate only the requested parent');
  assert.deepEqual(after.folders[other], expected, 'unchanged child contents must not become an empty placeholder');
  assert.equal(after.unloadedFolders.includes(other), false);
  assert.deepEqual(after.folders[root].map(row => row.name).sort(), ['left', 'right']);
  assert.equal(await fs.readFile(`${other}/keep.txt`, 'utf8'), 'preserved content');
});

test('native directory metadata uses the same mode as Node filesystem metadata', windows, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-directory-mode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'folder'));
  const reader = createDirectoryReader({ apiFactory: () => createNativeApi(require(binary)) });
  t.after(() => reader.dispose());
  const listing = await reader.readDirectory(root);
  const actual = listing.entries.find(entry => entry.name === 'folder').stat;
  const expected = await fs.lstat(path.join(root, 'folder'), { bigint: true });
  assert.equal(actual.mode, expected.mode);
});
