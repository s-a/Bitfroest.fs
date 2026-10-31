const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');

const slash = value => value.replace(/\\/g, '/');
const clone = value => JSON.parse(JSON.stringify(value));

async function setup(t, options = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-provider-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const left = path.join(parent, 'left'), right = path.join(parent, 'right');
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(path.join(left, 'plain.txt'), 'original text');
  await fs.writeFile(path.join(left, 'binary.bin'), Buffer.from([0, 255, 8, 7]));
  await fs.mkdir(path.join(left, 'docs'));
  await fs.writeFile(path.join(left, 'docs', 'nested.txt'), 'nested');
  const provider = createProvider({ roots: [left, right], ...options });
  return { provider, left: slash(left), right: slash(right), parent };
}

function row(state, directory, name) { return state.folders[directory].find(file => file.name === name); }

test('column catalog receives creation, access and modification timestamps from the existing metadata read', async t => {
  const { left, right } = await setup(t);
  const provider = createProvider({ roots: [left, right] });
  const state = await provider.load(), file = row(state, slash(left), 'plain.txt');
  const stat = await fs.stat(path.join(left, 'plain.txt'));
  const evaluate = require('../media/commander-column-settings').evaluateColumnTemplate;
  for (const family of ['write', 'creation', 'access']) {
    assert.equal(evaluate(file, `[=tc.${family}date] [=tc.${family}time]`).missingFields.length, 0);
  }
  assert.equal(file.creationdate, new Date(stat.birthtimeMs).toISOString());
  assert.equal(file.accessdate, new Date(stat.atimeMs).toISOString());
});

test('configured favorite roots load only on navigation and support actual file copies', async t => {
  const { left, right, parent } = await setup(t);
  const external = slash(path.join(parent, 'favorite')); await fs.mkdir(external); await fs.writeFile(`${external}/favorite.txt`, 'favorite contents');
  const missing = slash(path.join(parent, 'unavailable'));
  let favorites = [external, missing]; const reads = [];
  const provider = createProvider({ roots: [left, right], additionalRoots: () => favorites, fs: { ...fs, readdir: async directory => { reads.push(slash(directory)); return fs.readdir(directory); }, mkdir: async directory => {
    if (path.basename(directory).startsWith('.bitfroest-') && ![slash(left), slash(right), external].includes(slash(path.dirname(directory)))) throw new Error('Staging escaped the writable operation roots');
    return fs.mkdir(directory);
  } } });
  const initial = await provider.load();
  assert.equal(reads.includes(external), false); assert.equal(reads.includes(missing), false);
  assert.equal(provider.contains(external), true);
  assert.equal(provider.contains(parent), false);
  const loaded = await provider.load({ directories: [external] });
  const after = clone(loaded), source = row(loaded, external, 'favorite.txt');
  after.folders[slash(right)].push({ ...source, id: 'copied-favorite', fsSource: source.fsSource });
  const result = await provider.apply(loaded, after);
  assert.equal(await fs.readFile(`${slash(right)}/favorite.txt`, 'utf8'), 'favorite contents');
  assert.ok(result.folders[external]);
  assert.equal(reads.includes(missing), false);
  favorites = [external, missing, slash(path.join(parent, 'another'))];
  assert.equal(provider.contains(slash(path.join(parent, 'another'))), true);
  assert.ok(initial.folders[slash(left)]);
  if (process.platform === 'win32') {
    favorites.push(left.toUpperCase());
    assert.equal(provider.contains(left), true);
  }
  favorites = [];
  assert.equal(provider.contains(external), true);
  const later = clone(result);
  later.folders[slash(right)].push({ ...source, id: 'after-removal', name: 'after-removal.txt', fsSource: source.fsSource });
  favorites = [slash(path.parse(parent).root)];
  await provider.apply(result, later);
  assert.equal(await fs.readFile(`${slash(right)}/after-removal.txt`, 'utf8'), 'favorite contents');
});

test('measureFolder reads only requested subtree metadata without changing the lazy snapshot', async t => {
  const { left, right } = await setup(t);
  await fs.mkdir(`${left}/docs/deeper`); await fs.writeFile(`${left}/docs/deeper/data`, '1234');
  const reads = [];
  const provider = createProvider({ roots: [left, right], fs: { ...fs,
    readdir: async (...args) => { reads.push(slash(String(args[0]))); return fs.readdir(...args); },
    readFile: async () => { throw new Error('File contents must not be read'); }
  } });
  const state = await provider.load(); const before = clone(state); reads.length = 0;
  assert.equal(await provider.measureFolder(state, `${left}/docs`), 10);
  assert.deepEqual(reads.sort(), [`${left}/docs`, `${left}/docs/deeper`]);
  assert.deepEqual(state, before); assert.ok(state.unloadedFolders.includes(`${left}/docs`));
  await assert.rejects(provider.measureFolder({ ...state, snapshotId: 'stale' }, `${left}/docs`), /Snapshot/);
  await assert.rejects(provider.measureFolder(state, `${left}/plain.txt`));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.measureFolder(state, `${left}/docs`, { signal: controller.signal }), { name: 'AbortError' });
});

test('measureFolder rejects inaccessible descendants instead of returning a complete partial size', async t => {
  const { left, right } = await setup(t);
  const provider = createProvider({ roots: [left, right], fs: { ...fs, readdir: async (directory, ...args) => {
    if (slash(String(directory)) === `${left}/docs`) throw new Error('Access denied');
    return fs.readdir(directory, ...args);
  } } });
  const state = await provider.load();
  await assert.rejects(provider.measureFolder(state, `${left}/docs`), /Access denied/);
});

test('load returns complete file metadata without reading file contents', async t => {
  const { provider, left, right } = await setup(t);
  const state = await provider.load({ recursive: true });
  assert.equal(state.version, 1); assert.equal(state.realFilesystem, true);
  assert.ok(state.snapshotId); assert.deepEqual(state.panes.map(pane => pane.tabs), [[left], [right]]);
  assert.equal(row(state, left, 'plain.txt').content, undefined);
  assert.equal(row(state, left, 'binary.bin').content, undefined);
  assert.equal(row(state, left, 'plain.txt').fsSource, `${left}/plain.txt`);
  assert.equal(state.folders[`${left}/docs`][0].content, undefined);
  assert.deepEqual((await fs.readdir(left)).sort(), ['binary.bin', 'docs', 'plain.txt']);
  const again = await provider.load({ recursive: true });
  assert.equal(row(again, left, 'plain.txt').id, row(state, left, 'plain.txt').id);
});

test('unreadable small files do not block filesystem listings', async t => {
  const { left, right } = await setup(t);
  const deniedFs = { ...fs, readFile: async (file, ...args) => {
    if (String(file).endsWith('/plain.txt')) { const error = new Error('Access denied'); error.code = 'EACCES'; throw error; }
    return fs.readFile(file, ...args);
  } };
  const state = await createProvider({ roots: [left, right], fs: deniedFs }).load({ recursive: true });
  assert.equal(row(state, left, 'plain.txt').size, 13);
  assert.equal(row(state, left, 'plain.txt').fsSource, `${left}/plain.txt`);
  assert.equal(row(state, left, 'plain.txt').content, undefined);
});

for (const code of ['EPERM', 'EACCES']) test(`navigation retains ${code} children without blocking readable siblings`, async t => {
  const { left, right, parent } = await setup(t);
  const protectedPath = slash(path.join(parent, 'DumpStack.log.tmp'));
  await fs.writeFile(protectedPath, 'protected');
  await fs.writeFile(path.join(parent, 'readable.txt'), 'readable');
  let denied = true;
  const deniedFs = { ...fs, lstat: async (file, ...args) => {
    if (denied && slash(String(file)) === protectedPath) throw Object.assign(new Error('Access denied'), { code });
    return fs.lstat(file, ...args);
  } };
  const provider = createProvider({ roots: [left, right], allowNavigationOutsideRoots: true, fs: deniedFs });
  await provider.load();
  const state = await provider.load({ left: parent });
  const protectedRow = row(state, slash(parent), 'DumpStack.log.tmp');
  assert.equal(protectedRow.fsSource, protectedPath);
  assert.equal(protectedRow.size, undefined);
  assert.equal(protectedRow.mtimeMs, undefined);
  assert.equal(row(state, slash(parent), 'readable.txt').size, 8);
  const after = clone(state);
  after.folders[left].push({ id: 'new-readable', name: 'new.txt', type: 'text', content: 'new' });
  const fresh = await provider.apply(state, after);
  assert.equal(await fs.readFile(`${left}/new.txt`, 'utf8'), 'new');
  const removed = clone(fresh);
  removed.folders[slash(parent)] = removed.folders[slash(parent)].filter(file => file.name !== 'DumpStack.log.tmp');
  denied = false;
  await assert.rejects(provider.apply(fresh, removed));
  assert.equal(await fs.readFile(protectedPath, 'utf8'), 'protected');
  denied = true;
  await assert.rejects(provider.load({ left: parent, recursiveDirectories: [parent] }), { code });
});

test('later metadata permission failures retain listed files and directories', async t => {
  const { left, right } = await setup(t);
  await fs.writeFile(`${left}/program.exe`, 'not an executable');
  for (const [name, deniedRead] of [['plain.txt', 2], ['program.exe', 3], ['docs', 1]]) {
    let reads = 0;
    const target = `${left}/${name}`;
    const provider = createProvider({ roots: [left, right], fs: { ...fs, lstat: async (file, ...args) => {
      if (slash(String(file)) === target && ++reads === deniedRead) throw Object.assign(new Error('Access denied'), { code: 'EPERM', path: target });
      return fs.lstat(file, ...args);
    } } });
    const state = await provider.load();
    assert.equal(row(state, left, name).fsSource, target);
    assert.equal(row(state, left, name).size, undefined);
    if (name === 'docs') assert.ok(state.unloadedFolders.includes(target));
    const copied = clone(state);
    copied.folders[right].push({ ...row(state, left, name), id: 'copy-denied', name: 'copy' });
    if (name === 'docs') copied.folders[`${right}/copy`] = [];
    await assert.rejects(provider.apply(state, copied));
    await assert.rejects(fs.lstat(`${right}/copy`), { code: 'ENOENT' });
  }
});

test('directory permission failures and unrelated metadata errors remain navigation errors', async t => {
  const { left, right } = await setup(t);
  for (const [target, code] of [[left, 'EPERM'], [`${left}/plain.txt`, 'EIO']]) {
    const provider = createProvider({ roots: [left, right], fs: { ...fs, lstat: async (file, ...args) => {
      if (slash(String(file)) === target) throw Object.assign(new Error('Read failed'), { code });
      return fs.lstat(file, ...args);
    } } });
    await assert.rejects(provider.load(), { code });
  }
});

test('default scan limit permits a realistic large directory', async t => {
  const { left, right } = await setup(t);
  const names = Array.from({ length: 10001 }, (_, index) => `entry-${index}.txt`);
  const realFs = fs;
  const largeFs = {
    ...fs,
    readdir: async directory => slash(directory) === left ? names : realFs.readdir(directory),
    lstat: async (target, options) => {
      const value = slash(target);
      if (value.startsWith(`${left}/entry-`)) return { dev: 1n, ino: BigInt(Number(value.match(/entry-(\d+)/)[1]) + 1), mode: 0o100644n, size: 1n, mtimeNs: 1n, ctimeNs: 1n, mtimeMs: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
      return realFs.lstat(target, options);
    }
  };
  const state = await createProvider({ roots: [left, right], fs: largeFs }).load();
  assert.equal(state.folders[left].length, names.length);
});

test('default scan depth permits deeply nested directories', async t => {
  const { provider, left } = await setup(t);
  let directory = left;
  for (let depth = 0; depth < 13; depth++) {
    directory = `${directory}/level-${depth}`;
    await fs.mkdir(directory);
  }
  await fs.writeFile(`${directory}/deep.txt`, 'deep');
  const state = await provider.load({ recursive: true });
  assert.equal(row(state, directory, 'deep.txt').size, 4);
});

test('listing and recursive preparation never read source file contents', async t => {
  const { left, right } = await setup(t); const reads = [];
  const observedFs = { ...fs, readFile: async (file, ...args) => { reads.push(String(file)); return fs.readFile(file, ...args); } };
  const provider = createProvider({ roots: [left, right], fs: observedFs });
  const state = await provider.load({ recursive: true });
  assert.deepEqual(reads, []);
  assert.equal(row(state, left, 'plain.txt').content, undefined);
  await provider.prepare(state, { directories: [`${left}/docs`], recursive: true });
  assert.deepEqual(reads, []);
});

test('contains rejects siblings, traversal and symbolic links', async t => {
  const { provider, left, parent } = await setup(t);
  assert.equal(provider.contains(`${left}/plain.txt`), true);
  assert.equal(provider.contains(`${left}/new/subdirectory`), true);
  assert.equal(provider.contains(`${left}-other/file.txt`), false);
  assert.equal(provider.contains(`${left}/../right/plain.txt`), false);
  assert.equal(provider.contains('relative.txt'), false);
  const outside = path.join(parent, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, `${left}/linked`, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(provider.contains(`${left}/linked/child.txt`), false);
  const state = await provider.load({ recursive: true });
  assert.equal(row(state, left, 'linked').type, 'link');
  assert.equal(Object.hasOwn(state.folders, `${left}/linked`), false);
  assert.ok(row(state, left, 'plain.txt'));
  await assert.rejects(provider.load({ directories: [`${left}/linked`] }), /link|reparse|Verknüpfung/i);
  const fresh = await provider.load(), after = clone(fresh);
  after.folders[left].push({ id: 'beside-link', name: 'beside-link.txt', type: 'text', content: 'safe' });
  await provider.apply(fresh, after);
  assert.equal(await fs.readFile(`${left}/beside-link.txt`, 'utf8'), 'safe');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('unrelated changes cannot block creating or moving a file in another loaded directory', async t => {
  const { provider, left, right } = await setup(t);
  let before = await provider.load(), after = clone(before);
  await fs.writeFile(`${right}/unrelated.txt`, 'background update');
  after.folders[left].push({ id: 'created', name: 'created.txt', type: 'text', content: 'created' });
  await provider.apply(before, after);
  assert.equal(await fs.readFile(`${left}/created.txt`, 'utf8'), 'created');
  before = await provider.load(); after = clone(before);
  const file = row(before, left, 'plain.txt');
  after.folders[left] = after.folders[left].filter(item => item.id !== file.id);
  after.folders[right].push({ ...file, id: 'moved' });
  await fs.writeFile(`${right}/unrelated.txt`, 'another unrelated update');
  await provider.apply(before, after);
  assert.equal(await fs.readFile(`${right}/plain.txt`, 'utf8'), 'original text');
  assert.equal(await fs.readFile(`${right}/unrelated.txt`, 'utf8'), 'another unrelated update');
});

test('a removed optional loaded directory cannot turn a committed creation into a reported failure', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ directories: [`${left}/docs`] });
  before.panes[0].tabs = [`${left}/docs`, left, right]; before.panes[0].tab = 1;
  const after = clone(before);
  after.folders[right].push({ id: 'created', name: 'committed.txt', type: 'text', content: 'committed' });
  await fs.unlink(`${left}/docs/nested.txt`); await fs.rmdir(`${left}/docs`);
  const result = await provider.apply(before, after);
  assert.equal(await fs.readFile(`${right}/committed.txt`, 'utf8'), 'committed');
  assert.equal(Object.hasOwn(result.folders, `${left}/docs`), false);
  assert.equal(result.panes[0].tabs[result.panes[0].tab], left);
});

test('copy obtains binary bytes from the original source rather than mock content', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before);
  const source = row(after, left, 'binary.bin');
  after.folders[right].push({ ...source, id: 'copy-1', name: 'copied.bin' });
  const fresh = await provider.apply(before, after);
  assert.deepEqual(await fs.readFile(`${right}/copied.bin`), Buffer.from([0, 255, 8, 7]));
  assert.deepEqual(await fs.readFile(`${left}/binary.bin`), Buffer.from([0, 255, 8, 7]));
  assert.equal(row(fresh, right, 'copied.bin').fsSource, `${right}/copied.bin`);
  assert.notEqual(fresh.snapshotId, before.snapshotId);
});

test('apply creates folders, edits text, renames and deletes explicit entries', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before);
  const text = row(after, left, 'plain.txt'); text.name = 'renamed.txt'; text.content = 'changed';
  after.folders[left] = after.folders[left].filter(file => file.name !== 'binary.bin');
  after.folders[right].push({ id: 'new-dir', name: 'created', type: 'folder', size: 0 });
  after.folders[`${right}/created`] = [];
  const fresh = await provider.apply(before, after);
  assert.equal(await fs.readFile(`${left}/renamed.txt`, 'utf8'), 'changed');
  await assert.rejects(fs.stat(`${left}/plain.txt`), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${left}/binary.bin`), { code: 'ENOENT' });
  assert.equal((await fs.stat(`${right}/created`)).isDirectory(), true);
  assert.equal(row(fresh, left, 'renamed.txt').content, undefined);
});

test('stale snapshots and new external destinations are rejected before any write', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before);
  after.folders[right].push({ ...row(after, left, 'plain.txt'), id: 'copy-1' });
  await fs.writeFile(`${left}/plain.txt`, 'external change');
  await assert.rejects(provider.apply(before, after), /stale|veraltet|geändert/i);
  assert.deepEqual(await fs.readdir(right), []);
  const current = await provider.load({ recursive: true }), copy = clone(current);
  copy.folders[right].push({ ...row(copy, left, 'plain.txt'), id: 'copy-2' });
  await fs.writeFile(`${right}/plain.txt`, 'external destination');
  await assert.rejects(provider.apply(current, copy), /stale|veraltet|geändert|vorhanden/i);
  assert.equal(await fs.readFile(`${right}/plain.txt`, 'utf8'), 'external destination');
});

test('copy does not rescan unrelated loaded roots before its first file copy', async t => {
  const directories = [], inspected = [];
  let baselineReads = 0, unrelatedFolderChecks = 0, expectedSource;
  let unrelatedFolder;
  const observedFs = { ...fs,
    readdir: async directory => { directories.push(String(directory)); return fs.readdir(directory); },
    lstat: async (target, ...args) => { inspected.push(String(target)); return fs.lstat(target, ...args); }
  };
  const { provider, left, right } = await setup(t, { fs: observedFs, copyFile: async (source, target, options) => {
    assert.equal(directories.length, baselineReads, 'copy reaches its first byte operation without a loaded-root sweep');
    assert.equal(inspected.filter(targetPath => targetPath === unrelatedFolder).length, unrelatedFolderChecks, 'copy does not inspect an unrelated cached subtree before its first byte operation');
    expectedSource = options.expectedSource;
    return fs.copyFile(source, target, 1);
  } });
  unrelatedFolder = `${right}/unrelated`;
  await fs.mkdir(unrelatedFolder); await fs.writeFile(`${unrelatedFolder}/child.txt`, 'outside this operation');
  const before = await provider.load(), after = clone(before), source = row(after, left, 'plain.txt');
  unrelatedFolderChecks = inspected.filter(targetPath => targetPath === unrelatedFolder).length;
  const sourceStat = await fs.stat(source.fsSource, { bigint: true });
  baselineReads = directories.length;
  await fs.writeFile(`${right}/unrelated.txt`, 'changed outside the selected copy');
  after.folders[right].push({ ...source, id: 'copy-selected' });
  await provider.apply(before, after, { transfer: { mode: 'copy', sourcePath: left, ids: [source.id], sourceSide: 0 } });
  assert.deepEqual(expectedSource, Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])] )));
  assert.equal(await fs.readFile(`${right}/plain.txt`, 'utf8'), 'original text');
  assert.equal(await fs.readFile(`${right}/unrelated.txt`, 'utf8'), 'changed outside the selected copy');
});

test('copy rejects a same-size source change with restored modification time before reading bytes', async t => {
  let changedDuringStage = false, copies = 0;
  let sourcePath, originalStat;
  const observedFs = { ...fs,
    mkdir: async (directory, ...args) => {
      const result = await fs.mkdir(directory, ...args);
      if (!changedDuringStage && String(directory).includes('.bitfroest-copy-')) {
        changedDuringStage = true;
        const bytes = await fs.readFile(sourcePath); bytes.fill(120); await fs.writeFile(sourcePath, bytes);
        await fs.utimes(sourcePath, new Date(Number(originalStat.atimeNs) / 1e6), new Date(Number(originalStat.mtimeNs) / 1e6));
      }
      return result;
    },
    copyFile: async (...args) => { copies++; return fs.copyFile(...args); }
  };
  const { provider, left, right } = await setup(t, { fs: observedFs });
  sourcePath = `${left}/plain.txt`;
  const fixedMtime = new Date('2020-01-02T03:04:05.000Z'); await fs.utimes(sourcePath, fixedMtime, fixedMtime);
  const before = await provider.load(), after = clone(before), source = row(after, left, 'plain.txt');
  originalStat = await fs.stat(sourcePath, { bigint: true });
  after.folders[right].push({ ...source, id: 'copy-stale-source' });
  await assert.rejects(provider.apply(before, after, { transfer: { mode: 'copy', sourcePath: left, ids: [source.id], sourceSide: 0 } }), /extern geändert|veraltet/);
  const changedStat = await fs.stat(sourcePath, { bigint: true });
  assert.equal(changedStat.size, originalStat.size);
  assert.equal(changedStat.mtimeNs, originalStat.mtimeNs);
  assert.notEqual(changedStat.ctimeNs, originalStat.ctimeNs);
  assert.equal(copies, 0);
  assert.deepEqual(await fs.readdir(right), []);
});

test('copy preserves an externally created selected destination without overwriting it', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load(), after = clone(before), source = row(after, left, 'plain.txt');
  after.folders[right].push({ ...source, id: 'copy-target-race' });
  await fs.writeFile(`${right}/plain.txt`, 'external destination');
  await assert.rejects(provider.apply(before, after, { transfer: { mode: 'copy', sourcePath: left, ids: [source.id], sourceSide: 0 } }));
  assert.equal(await fs.readFile(`${right}/plain.txt`, 'utf8'), 'external destination');
  assert.equal(await fs.readFile(`${left}/plain.txt`, 'utf8'), 'original text');
  assert.equal((await fs.readdir(right)).some(name => name.startsWith('.bitfroest-')), false);
});

test('state cannot escape allowed roots or invent external source provenance', async t => {
  const { provider, left, right, parent } = await setup(t);
  const before = await provider.load({ recursive: true });
  for (const name of ['../escaped.txt', '..\\escaped.txt']) {
    const after = clone(before); after.folders[right].push({ id: 'bad', name, type: 'text', content: 'bad' });
    await assert.rejects(provider.apply(before, after), /name|Pfad|path|ungültig/i);
  }
  const after = clone(before);
  after.folders[right].push({ ...row(after, left, 'plain.txt'), id: 'bad-source', fsSource: slash(path.join(parent, 'secret.txt')) });
  await assert.rejects(provider.apply(before, after), /source|Quelle|erlaubt|root/i);
  assert.deepEqual(await fs.readdir(right), []);
});

test('missing roots, truncated scans and virtual archive changes fail explicitly', async t => {
  const { provider, left, right, parent } = await setup(t);
  const absent = createProvider({ roots: [path.join(parent, 'absent')] });
  await assert.rejects(absent.load({ recursive: true }), /ENOENT|nicht vorhanden/i);
  await assert.rejects(createProvider({ roots: [left, right], maxEntries: 1 }).load({ recursive: true }), /limit|Grenze/i);
  await assert.rejects(createProvider({ roots: [left, right], maxDepth: 0 }).load({ recursive: true }), /limit|Grenze/i);
  const before = await provider.load({ recursive: true }), after = clone(before);
  after.folders[`${left}/archive.zip!`] = [];
  await assert.rejects(provider.apply(before, after), /Archiv|archive|Ordner|directory/i);
  assert.equal((await fs.readdir(left)).length, 3);
});

test('fresh states include the active pane and preserve it after writes', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ recursive: true }); assert.equal(before.active, 0);
  const after = clone(before); after.active = 1;
  after.folders[right].push({ id: 'new', name: 'new.txt', type: 'text', content: 'new' });
  const fresh = await provider.apply(before, after);
  assert.equal(fresh.active, 1); assert.equal(row(fresh, left, 'plain.txt').content, undefined);
});

test('directory copies and moves keep original bytes until all destinations are staged', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before);
  after.folders[right].push({ ...row(after, left, 'docs'), id: 'copy-dir' });
  after.folders[`${right}/docs`] = [{ ...row(after, `${left}/docs`, 'nested.txt'), id: 'copy-child' }];
  after.folders[right].push({ ...row(after, left, 'plain.txt'), id: 'copy-text' });
  after.folders[left] = after.folders[left].filter(file => file.name !== 'plain.txt');
  await provider.apply(before, after);
  assert.equal(await fs.readFile(`${right}/docs/nested.txt`, 'utf8'), 'nested');
  assert.equal(await fs.readFile(`${left}/docs/nested.txt`, 'utf8'), 'nested');
  assert.equal(await fs.readFile(`${right}/plain.txt`, 'utf8'), 'original text');
});

test('failed writes restore removed originals and remove only newly created destinations', async t => {
  const { left, right } = await setup(t);
  let writes = 0;
  const failingFs = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] === 'wx' && ++writes === 2) handle.writeFile = async () => { throw new Error('injected write failure'); };
    return handle;
  }};
  const provider = createProvider({ roots: [left, right], fs: failingFs });
  const before = await provider.load({ recursive: true }), after = clone(before);
  row(after, left, 'plain.txt').content = 'changed';
  after.folders[right].push({ id: 'new', name: 'new.txt', type: 'text', content: 'new' });
  await assert.rejects(provider.apply(before, after), /injected/);
  assert.equal(await fs.readFile(`${left}/plain.txt`, 'utf8'), 'original text');
  assert.deepEqual(await fs.readdir(right), []);
  assert.equal((await fs.readdir(left)).some(name => name.startsWith('.bitfroest-rollback-')), false);
  await assert.rejects(provider.apply(before, after), /veraltet/);
});

test('depth limits and unsupported archives block writes while explicit text content is applied', async t => {
  const { left, right } = await setup(t);
  const metadata = await createProvider({ roots: [left, right], maxTotalBytes: 1 }).load({ recursive: true });
  assert.equal(row(metadata, left, 'plain.txt').content, undefined);
  const provider = createProvider({ roots: [left, right], maxFileBytes: 16, maxTotalBytes: 30, maxDepth: 1 });
  const before = await provider.load({ recursive: true });
  const archive = clone(before); archive.folders[right].push({ id: 'archive', name: 'new.zip', type: 'archive', content: 'fake' });
  await assert.rejects(provider.apply(before, archive), /Archiv|archive/);
  const deep = clone(before);
  deep.folders[`${left}/docs`].push({ id: 'deep', name: 'deep', type: 'folder' }); deep.folders[`${left}/docs/deep`] = [];
  await assert.rejects(provider.apply(before, deep), /Tiefengrenze/);
  const large = clone(before); large.folders[right].push({ id: 'large', name: 'large.txt', type: 'text', content: '1234567890123456' });
  await provider.apply(before, large);
  assert.equal(await fs.readFile(`${right}/large.txt`, 'utf8'), '1234567890123456');
});

test('duplicate destinations, incomplete folders and binary text replacement fail before writes', async t => {
  const { provider, left, right } = await setup(t);
  const before = await provider.load({ recursive: true });
  const duplicate = clone(before); duplicate.folders[right].push({ ...row(duplicate, left, 'plain.txt') });
  await assert.rejects(provider.apply(before, duplicate), /Doppelte/);
  const incomplete = clone(before); delete incomplete.folders[`${left}/docs`];
  await assert.rejects(provider.apply(before, incomplete), /vollständig/);
  const binary = clone(before); row(binary, left, 'binary.bin').content = 'bad';
  await assert.rejects(provider.apply(before, binary), /Binärdateien/);
  assert.deepEqual(await fs.readFile(`${left}/binary.bin`), Buffer.from([0, 255, 8, 7]));
});

test('Windows target names cannot address alternate streams, devices or normalized aliases', { skip: process.platform !== 'win32' }, async t => {
  const { provider, right } = await setup(t);
  const before = await provider.load({ recursive: true });
  for (const name of ['file.txt:secret', 'CON', 'nul.txt', 'name.', 'name ', 'bad?.txt']) {
    const after = clone(before); after.folders[right].push({ id: 'invalid', name, type: 'text', content: 'bad' });
    await assert.rejects(provider.apply(before, after), /name|Name|ungültig/);
  }
  assert.deepEqual(await fs.readdir(right), []);
});

test('navigation-only states preserve the snapshot without file writes', async t => {
  const { provider, left } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before);
  after.active = 1; after.panes[0].tabs.push(`${left}/docs`); after.panes[0].tab = 1;
  const next = await provider.apply(before, after);
  assert.equal(next.snapshotId, before.snapshotId); assert.equal(next.active, 1); assert.equal(next.panes[0].tab, 1);
});

test('provider rejects overlapping roots and roots that are files', async t => {
  const { left, right } = await setup(t);
  assert.throws(() => createProvider({ roots: [] }), /Root/);
  assert.throws(() => createProvider({ roots: [left, `${left}/docs`] }), /Root/);
  await assert.rejects(createProvider({ roots: [`${left}/plain.txt`, right] }).load({ recursive: true }), /Verzeichnis/);
});

test('renaming and then deleting a complete directory validates and transfers its descendants', async t => {
  const { provider, left } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before);
  row(after, left, 'docs').name = 'renamed';
  after.folders[`${left}/renamed`] = after.folders[`${left}/docs`]; delete after.folders[`${left}/docs`];
  const moved = await provider.apply(before, after);
  assert.equal(await fs.readFile(`${left}/renamed/nested.txt`, 'utf8'), 'nested');
  await assert.rejects(fs.stat(`${left}/docs`), { code: 'ENOENT' });
  const deleted = clone(moved); deleted.folders[left] = deleted.folders[left].filter(file => file.name !== 'renamed');
  delete deleted.folders[`${left}/renamed`];
  await provider.apply(moved, deleted);
  await assert.rejects(fs.stat(`${left}/renamed`), { code: 'ENOENT' });
});

test('case-only directory renames use the safe atomic primitive', { skip: process.platform !== 'win32' }, async t => {
  const { provider, left } = await setup(t);
  const before = await provider.load({ recursive: true }), after = clone(before); row(after, left, 'docs').name = 'DOCS';
  after.folders[`${left}/DOCS`] = after.folders[`${left}/docs`]; delete after.folders[`${left}/docs`];
  await provider.apply(before, after);
  assert.equal((await fs.readdir(left)).includes('DOCS'), true);
  assert.equal(await fs.readFile(`${left}/docs/nested.txt`, 'utf8'), 'nested');
});

test('cleanup retains an externally inserted backup entry instead of recursively deleting it', async t => {
  const { left, right } = await setup(t);
  let foreign;
  const changedFs = { ...fs, rename: async (...args) => {
    await fs.rename(...args);
    if (!foreign && String(args[1]).includes('/.bitfroest-rollback-')) {
      foreign = `${slash(path.dirname(args[1]))}/external.txt`; await fs.writeFile(foreign, 'external');
    }
  }};
  const provider = createProvider({ roots: [left, right], fs: changedFs });
  const before = await provider.load({ recursive: true }), after = clone(before); row(after, left, 'plain.txt').content = 'changed';
  await assert.rejects(provider.apply(before, after), /Sicherung|extern|cleanup|Aufräumen/i);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'external');
  assert.equal(await fs.readFile(`${left}/plain.txt`, 'utf8'), 'changed');
});

test('large files are listed without reading their bytes and copies use exclusive native staging', async t => {
  const { left, right } = await setup(t);
  const file = await fs.open(`${left}/large.bin`, 'w'); await file.truncate(2 * 1024 * 1024); await file.close();
  const reads = [], copies = [];
  const observed = { ...fs, readFile: async (...args) => { reads.push(String(args[0])); return fs.readFile(...args); }, copyFile: async (...args) => { copies.push(args); return fs.copyFile(...args); } };
  const provider = createProvider({ roots: [left, right], maxFileBytes: 32, maxTotalBytes: 32, fs: observed });
  const before = await provider.load({ recursive: true });
  assert.equal(row(before, left, 'large.bin').size, 2 * 1024 * 1024);
  assert.equal(row(before, left, 'large.bin').content, undefined);
  assert.equal(reads.some(name => name.endsWith('/large.bin')), false);
  const after = clone(before); after.folders[right].push({ ...row(after, left, 'large.bin'), id: 'large-copy' });
  await provider.apply(before, after);
  assert.equal((await fs.stat(`${right}/large.bin`)).size, 2 * 1024 * 1024);
  assert.equal(copies.length, 1); assert.equal(copies[0][2], require('node:fs').constants.COPYFILE_EXCL);
  assert.ok(copies[0][1].startsWith(`${right}/.bitfroest-copy-`));
  assert.equal(reads.some(name => name.endsWith('/large.bin')), false);
});

test('large moves keep original source paths until verified copies preserve all bytes without previews', async t => {
  const { left, right } = await setup(t);
  const file = await fs.open(`${left}/large.bin`, 'w'); await file.truncate(1024 * 1024); await file.write(Buffer.from([9,8,7]), 0, 3, 1024 * 1024 - 3); await file.close();
  const provider = createProvider({ roots: [left, right], maxFileBytes: 32 });
  const before = await provider.load({ recursive: true }), after = clone(before);
  const source = row(after, left, 'large.bin');
  after.folders[left] = after.folders[left].filter(item => item !== source);
  after.folders[right].push({ ...source, id: 'moved-large' });
  await provider.apply(before, after);
  await assert.rejects(fs.stat(`${left}/large.bin`), { code: 'ENOENT' });
  const target = await fs.open(`${right}/large.bin`, 'r'), bytes = Buffer.alloc(3);
  await target.read(bytes,0,3,1024 * 1024 - 3); await target.close();
  assert.deepEqual(bytes, Buffer.from([9,8,7]));
});

test('default load reads only open directories and preserves unloaded children during unrelated writes', async t => {
  const { left, right } = await setup(t);
  const reads = [];
  const provider = createProvider({ roots: [left,right], fs: { ...fs, readdir: async directory => { reads.push(String(directory)); return fs.readdir(directory); } } });
  const before = await provider.load();
  assert.equal(reads.includes(`${left}/docs`), false);
  assert.deepEqual(before.folders[`${left}/docs`], []);
  assert.ok(before.unloadedFolders.includes(`${left}/docs`));
  assert.ok(Number.isFinite(row(before,left,'plain.txt').mtimeMs));
  const after=clone(before); after.folders[right].push({...row(after,left,'plain.txt'),id:'copy'});
  await provider.apply(before,after);
  assert.equal(await fs.readFile(`${left}/docs/nested.txt`,'utf8'),'nested');
  assert.equal(reads.includes(`${left}/docs`), false);
});

test('prepare expands requested folders and blocks mutation of an unprepared subtree', async t => {
  const { provider, left } = await setup(t);
  const before = await provider.load(), after = clone(before);
  after.folders[left]=after.folders[left].filter(file=>file.name!=='docs'); delete after.folders[`${left}/docs`];
  await assert.rejects(provider.apply(before,after), /vorbereitet|eingelesen/);
  const expanded=await provider.prepare(before,{directories:[`${left}/docs`],recursive:true});
  assert.equal(expanded.folders[`${left}/docs`][0].name,'nested.txt');
  assert.equal(expanded.unloadedFolders.includes(`${left}/docs`),false);
  const removed=clone(expanded); removed.folders[left]=removed.folders[left].filter(file=>file.name!=='docs'); delete removed.folders[`${left}/docs`];
  await provider.apply(expanded,removed);
  await assert.rejects(fs.stat(`${left}/docs`),{code:'ENOENT'});
});

test('default listing does not read medium-sized file contents', async t => {
  const { left,right }=await setup(t); await fs.writeFile(`${left}/medium.txt`,'x'.repeat(300000));
  const reads=[]; const provider=createProvider({roots:[left,right],fs:{...fs,readFile:async(...args)=>{reads.push(String(args[0])); return fs.readFile(...args);}}});
  const state=await provider.load(); assert.equal(row(state,left,'medium.txt').content,undefined);
  assert.equal(reads.some(name=>name.endsWith('/medium.txt')),false);
});

test('writes into unloaded destination folders are refused until their immediate listing is prepared', async t=>{
  const {provider,left}=await setup(t); const before=await provider.load(), after=clone(before);
  after.folders[`${left}/docs`].push({...row(after,left,'plain.txt'),id:'hidden-dest-copy'});
  await assert.rejects(provider.apply(before,after),/vorbereitet|eingelesen/);
  assert.equal(await fs.readFile(`${left}/docs/nested.txt`,'utf8'),'nested');
});

test('direct navigation to a nested directory loads its ancestors without scanning siblings', async t => {
  const {left,right}=await setup(t); await fs.mkdir(`${left}/docs/deep`); await fs.writeFile(`${left}/docs/deep/item.txt`,'nested');
  const provider=createProvider({roots:[left,right]}); const before=await provider.load();
  const state=await provider.prepare(before,{directories:[`${left}/docs/deep`],recursive:false});
  assert.equal(state.folders[`${left}/docs/deep`][0].name,'item.txt');
  const after=clone(state); after.folders[right].push({...row(after,`${left}/docs/deep`,'item.txt'),id:'copy-deep'});
  await provider.apply(state,after);
  assert.equal(await fs.readFile(`${right}/item.txt`,'utf8'),'nested');
});

test('recursive depth limits do not prevent a shallow operation in a directly opened deep directory', async t => {
  const {left,right}=await setup(t); await fs.mkdir(`${left}/docs/deep`); await fs.writeFile(`${left}/docs/deep/item.txt`,'item');
  const provider=createProvider({roots:[left,right],maxDepth:1}); const state=await provider.load({left:`${left}/docs/deep`});
  const after=clone(state); after.folders[right].push({...row(after,`${left}/docs/deep`,'item.txt'),id:'deep-copy'});
  await provider.apply(state,after);
  assert.equal(await fs.readFile(`${right}/item.txt`,'utf8'),'item');
});

test('append joins full binary sources and preserves existing target alternate streams', { timeout: 5000 }, async t => {
  const { provider, left, right } = await setup(t, { maxFileBytes: 4 });
  const sourcePath = `${left}/binary.bin`, targetPath = `${right}/binary.bin`;
  const bytes = Buffer.alloc(700000, 255); bytes[4] = 0;
  await fs.writeFile(sourcePath, bytes); await fs.writeFile(targetPath, Buffer.from([1, 0, 2]));
  if (process.platform === 'win32') await fs.writeFile(`${targetPath}:notes`, 'retain-target-stream');
  const before = await provider.load(), after = clone(before);
  const source = row(after, left, 'binary.bin'), target = row(after, right, 'binary.bin');
  target.fsAppend = { source: source.fsSource, target: target.fsSource }; target.size += source.size; delete target.content;
  await provider.apply(before, after);
  assert.ok((await fs.readFile(targetPath)).equals(Buffer.concat([Buffer.from([1, 0, 2]), bytes])), 'full target bytes precede full source bytes');
  assert.deepEqual(await fs.readFile(sourcePath), bytes);
  if (process.platform === 'win32') assert.equal(await fs.readFile(`${targetPath}:notes`, 'utf8'), 'retain-target-stream');
});

test('append rejects shared file identity and forged provenance before changing bytes', { timeout: 5000 }, async t => {
  const { provider, left, right } = await setup(t);
  await fs.link(`${left}/binary.bin`, `${right}/binary.bin`);
  const before = await provider.load(), after = clone(before);
  const target = row(after, right, 'binary.bin');
  target.fsAppend = { source: `${left}/binary.bin`, target: `${right}/binary.bin` }; target.size *= 2;
  await assert.rejects(provider.apply(before, after), /Quelle|identisch/);
  assert.equal((await fs.stat(`${right}/binary.bin`)).size, 4);
});

test('multiple append sources are validated and streamed in recorded order before source removal', { timeout: 5000 }, async t => {
  const { provider, left, right } = await setup(t);
  await fs.writeFile(`${right}/joined.bin`, 'target');
  const before = await provider.load(), after = clone(before), target = row(after, right, 'joined.bin');
  const originals = ['binary.bin', 'plain.txt'].map(name => row(after, left, name));
  target.fsAppend = { source: originals[0].fsSource, target: target.fsSource, sources: originals.map(file => file.fsSource) };
  target.size += originals.reduce((sum, file) => sum + file.size, 0); delete target.content;
  after.folders[left] = after.folders[left].filter(file => !originals.includes(file));
  await provider.apply(before, after);
  assert.ok((await fs.readFile(`${right}/joined.bin`)).equals(Buffer.concat([Buffer.from('target'), Buffer.from([0, 255, 8, 7]), Buffer.from('original text')])));
  await assert.rejects(fs.stat(`${left}/binary.bin`), { code: 'ENOENT' });
});

test('append rejects an externally replaced stage before writing to the replacement', { timeout: 5000 }, async t => {
  let targetPath, externalPath;
  const { provider, left, right, parent } = await setup(t, { fs: { ...fs, open: async (filename, flags, ...args) => {
    if (flags === 'a') { await fs.unlink(filename); await fs.link(externalPath, filename); }
    return fs.open(filename, flags, ...args);
  } } });
  externalPath = path.join(parent, 'external.txt'); await fs.writeFile(externalPath, 'keep');
  targetPath = `${right}/binary.bin`; await fs.writeFile(targetPath, 'target');
  const before = await provider.load(), after = clone(before), target = row(after, right, 'binary.bin');
  target.fsAppend = { source: `${left}/binary.bin`, target: targetPath }; target.size += 4; delete target.content;
  await assert.rejects(provider.apply(before, after));
  assert.equal(await fs.readFile(externalPath, 'utf8'), 'keep');
});

test('explicit unrestricted navigation loads parents and unrelated directories lazily', async t => {
  const { left, right, parent } = await setup(t);
  const outside = path.join(parent, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'other.txt'), 'outside');
  const provider = createProvider({ roots: [left, right], allowNavigationOutsideRoots: true });
  const before = await provider.load();
  assert.equal(provider.contains(slash(parent)), true);
  const after = await provider.prepare(before, { directories: [slash(parent), slash(outside)] });
  assert.ok(after.folders[slash(parent)].some(row => row.name === 'outside'));
  assert.ok(after.folders[slash(outside)].some(row => row.name === 'other.txt'));
  assert.equal(after.unloadedFolders.includes(`${left}/docs`), true);
});
