const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProvider } = require('../filesystem-provider');
async function fixture(t, adapter) {
  const root = (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-races-')))).replace(/\\/g, '/');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = `${root}/left`, right = `${root}/right`;
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(`${left}/lower.txt`, 'ORIGINAL');
  return { left, right, provider: createProvider({ roots: [left, right], fs: adapter }) };
}

test('move retains originals when an earlier publication disappears during a later copy', async t => {
  const adapter = Object.create(fs);
  const { provider, left, right } = await fixture(t, adapter);
  await fs.writeFile(`${left}/z.txt`, 'SECOND');
  adapter.copyFile = async (source, target, flags) => {
    if (source.endsWith('/z.txt')) await fs.unlink(`${right}/lower.txt`);
    return fs.copyFile(source, target, flags);
  };
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left] = []; after.folders[right] = before.folders[left].map((row, index) => ({ ...row, id: `move-${index}` }));
  await assert.rejects(provider.apply(before, after));
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  assert.equal(await fs.readFile(`${left}/z.txt`, 'utf8'), 'SECOND');
});

test('cancelled move does not delete a source whose published target was replaced', async t => {
  const adapter = Object.create(fs), controller = new AbortController();
  const { provider, left, right } = await fixture(t, adapter);
  await fs.writeFile(`${left}/z.txt`, 'SECOND');
  adapter.copyFile = async (source, target, flags) => {
    if (source.endsWith('/z.txt')) {
      await fs.writeFile(`${right}/lower.txt`, 'EXTERNAL'); controller.abort();
      throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    }
    return fs.copyFile(source, target, flags);
  };
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left] = []; after.folders[right] = before.folders[left].map((row, index) => ({ ...row, id: `move-${index}` }));
  await assert.rejects(provider.apply(before, after, { signal: controller.signal, transfer: { mode: 'move', sourcePath: left, sourceSide: 0, ids: before.folders[left].map(row => row.id) } }), /Wiederherstellung/);
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  assert.equal(await fs.readFile(`${left}/z.txt`, 'utf8'), 'SECOND');
  assert.equal(await fs.readFile(`${right}/lower.txt`, 'utf8'), 'EXTERNAL');
});

test('POSIX filesystem moves preserve distinct case-sensitive source names', { skip: process.platform === 'win32' }, async t => {
  const { provider, left, right } = await fixture(t, Object.create(fs));
  await fs.writeFile(`${left}/LOWER.txt`, 'SECOND');
  const before = await provider.load(), after = structuredClone(before);
  const result = await require('../media/commander-transfer').execute({ folders: after.folders, sourcePath: left, targetPath: right, ids: before.folders[left].map(row => row.id), mode: 'move', policy: 'overwrite-all' });
  assert.equal(result.completed, 2);
  await provider.apply(before, after);
  assert.deepEqual(await fs.readdir(left), []);
  assert.equal(await fs.readFile(`${right}/lower.txt`, 'utf8'), 'ORIGINAL');
  assert.equal(await fs.readFile(`${right}/LOWER.txt`, 'utf8'), 'SECOND');
});

test('rollback never replaces a file created after its final missing-target check', async t => {
  const adapter = Object.create(fs); let failed = false, checks = 0;
  const { provider, left, right } = await fixture(t, adapter);
  await fs.writeFile(`${right}/lower.txt`, 'OLD TARGET');
  adapter.copyFile = async () => { failed = true; throw new Error('Copy failed'); };
  adapter.lstat = async (...args) => {
    try { return await fs.lstat(...args); }
    catch (error) {
      if (failed && path.resolve(args[0]) === path.resolve(`${right}/lower.txt`) && error.code === 'ENOENT' && ++checks === 2) await fs.writeFile(args[0], 'EXTERNAL');
      throw error;
    }
  };
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right] = [{ ...before.folders[left][0], id: 'copy' }];
  let failure;
  try { await provider.apply(before, after); } catch (error) { failure = error; }
  assert.ok(checks >= 2, 'a competing file was created after the missing-target check');
  assert.equal(await fs.readFile(`${right}/lower.txt`, 'utf8'), 'EXTERNAL');
  assert.match(failure.message, /Wiederherstellung unvollständig/);
  const backups = (await fs.readdir(right)).filter(name => name.startsWith('.bitfroest-rollback-'));
  assert.equal(backups.length, 1);
  const saved = await fs.readdir(`${right}/${backups[0]}`);
  assert.equal(await fs.readFile(`${right}/${backups[0]}/${saved[0]}`, 'utf8'), 'OLD TARGET');
});
test('case-only rename bypasses the unsafe temporary Node rename sequence', { skip: process.platform !== 'win32' }, async t => {
  const adapter = Object.create(fs); let injected = false;
  adapter.rename = async (from, to) => {
    if (!injected && from.includes('/.bitfroest-case-') && to.endsWith('/LOWER.txt')) { injected = true; await fs.writeFile(to, 'EXTERNAL'); }
    return fs.rename(from, to);
  };
  const { provider, left } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before); after.folders[left][0].name = 'LOWER.txt';
  await provider.apply(before, after);
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  assert.deepEqual(await fs.readdir(left), ['LOWER.txt']);
  assert.equal(injected, false);
});
test('a rejected exclusive path write cannot leave a partial output', async t => {
  const adapter = Object.create(fs);
  adapter.writeFile = async (target, data, options) => { await fs.writeFile(target, 'PARTIAL', options); throw new Error('Injected partial write'); };
  const { provider, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ id: 'new', name: 'new.txt', type: 'text', content: 'new contents' });
  try { await provider.apply(before, after); } catch (error) { assert.match(error.message, /Injected partial write/); }
  const output = await fs.readFile(`${right}/new.txt`, 'utf8').catch(error => { assert.equal(error.code, 'ENOENT'); return null; });
  assert.ok(output === null || output === 'new contents', 'only complete output or clean rollback is allowed');
});
test('an exclusive handle write that rejects after partial bytes removes its owned output', async t => {
  const adapter = Object.create(fs);
  adapter.open = async (target, flags) => {
    const handle = await fs.open(target, flags);
    if (flags === 'wx') handle.writeFile = async () => { await handle.write(Buffer.from('PARTIAL')); throw new Error('Partial handle write'); };
    return handle;
  };
  const { provider, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ id: 'new', name: 'new.txt', type: 'text', content: 'new contents' });
  await assert.rejects(provider.apply(before, after), /Partial handle write/);
  assert.deepEqual(await fs.readdir(right), []);
});
test('rollback preserves an external replacement of a partially written output', async t => {
  const adapter = Object.create(fs);
  adapter.open = async (target, flags) => {
    const handle = await fs.open(target, flags);
    if (flags === 'wx') handle.writeFile = async () => {
      await handle.write(Buffer.from('PARTIAL')); await fs.rename(target, `${target}.displaced`);
      await fs.writeFile(target, 'EXTERNAL'); throw new Error('Partial handle write');
    };
    return handle;
  };
  const { provider, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ id: 'new', name: 'new.txt', type: 'text', content: 'new contents' });
  await assert.rejects(provider.apply(before, after), error => /Wiederherstellung unvollständig/.test(error.message) && error.message.includes(`${right}/new.txt`));
  assert.equal(await fs.readFile(`${right}/new.txt`, 'utf8'), 'EXTERNAL');
  assert.equal(await fs.readFile(`${right}/new.txt.displaced`, 'utf8'), 'PARTIAL');
});
test('failed initial handle inspection closes the handle and reports an ambiguous output path', async t => {
  const adapter = Object.create(fs); let closed = false;
  adapter.open = async (target, flags) => {
    const handle = await fs.open(target, flags);
    if (flags === 'wx') {
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle); let first = true;
      handle.stat = (...args) => { if (first) { first = false; return Promise.reject(new Error('Handle inspection failed')); } return stat(...args); };
      handle.close = async () => { closed = true; return close(); };
      t.after(() => { if (!closed) return close(); });
    }
    return handle;
  };
  const { provider, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ id: 'new', name: 'new.txt', type: 'text', content: 'new contents' });
  await assert.rejects(provider.apply(before, after), /Handle inspection failed/);
  assert.equal(closed, true);
  assert.deepEqual(await fs.readdir(right), []);
});
test('native staged copying preserves Windows data streams and source modification time', { skip: process.platform !== 'win32' }, async t => {
  const { provider, left, right } = await fixture(t);
  await fs.writeFile(`${left}/lower.txt:note`, 'STREAM');
  await fs.utimes(`${left}/lower.txt`, new Date('2001-01-02'), new Date('2001-01-02'));
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ ...after.folders[left][0], id: 'copy' });
  await provider.apply(before, after);
  assert.equal(await fs.readFile(`${right}/lower.txt:note`, 'utf8'), 'STREAM');
  assert.equal((await fs.stat(`${left}/lower.txt`)).mtimeMs, (await fs.stat(`${right}/lower.txt`)).mtimeMs);
});
test('an external file occupying the final target before atomic publication is preserved', async t => {
  const adapter = Object.create(fs); let target;
  adapter.link = async (source, destination) => { target = destination; await fs.writeFile(destination, 'EXTERNAL'); return fs.link(source, destination); };
  const { provider, left, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left] = []; after.folders[right].push({ ...before.folders[left][0], id: 'move' });
  await assert.rejects(provider.apply(before, after), /EEXIST/);
  assert.equal(target, `${right}/lower.txt`);
  assert.equal(await fs.readFile(target, 'utf8'), 'EXTERNAL');
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
});
test('a failed native copy preserves ambiguous staging bytes and reports their exact path', async t => {
  const adapter = Object.create(fs); let staged;
  adapter.copyFile = async (_source, destination, flags) => { staged = destination; await fs.writeFile(destination, 'PARTIAL', { flag: 'wx' }); assert.ok(flags); throw new Error('Native partial copy'); };
  const { provider, left, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left] = []; after.folders[right].push({ ...before.folders[left][0], id: 'move' });
  await assert.rejects(provider.apply(before, after), error => /Native partial copy/.test(error.message) && error.message.includes(staged));
  assert.equal(await fs.readFile(staged, 'utf8'), 'PARTIAL');
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  await assert.rejects(fs.stat(`${right}/lower.txt`), { code: 'ENOENT' });
});
test('preexisting foreign staging content is retained without publishing or deleting source bytes', async t => {
  const adapter = Object.create(fs); let stage;
  adapter.copyFile = async (source, destination, flags) => { stage = destination; await fs.writeFile(destination, 'EXTERNAL'); return fs.copyFile(source, destination, flags); };
  const { provider, left, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left] = []; after.folders[right].push({ ...before.folders[left][0], id: 'move' });
  await assert.rejects(provider.apply(before, after), error => /EEXIST/.test(error.message) && error.message.includes(stage));
  assert.equal(await fs.readFile(stage, 'utf8'), 'EXTERNAL');
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  await assert.rejects(fs.stat(`${right}/lower.txt`), { code: 'ENOENT' });
});
test('unsupported atomic publication fails without a streaming fallback or source removal', async t => {
  const adapter = Object.create(fs);
  adapter.link = async () => { throw Object.assign(new Error('Hardlinks unsupported'), { code: 'ENOTSUP' }); };
  const { provider, left, right } = await fixture(t, adapter);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[left] = []; after.folders[right].push({ ...before.folders[left][0], id: 'move' });
  await assert.rejects(provider.apply(before, after), /Hardlinks unsupported/);
  assert.equal(await fs.readFile(`${left}/lower.txt`, 'utf8'), 'ORIGINAL');
  assert.deepEqual(await fs.readdir(right), []);
});
test('copying a read-only Windows source retains the published read-only state', { skip: process.platform !== 'win32' }, async t => {
  const { provider, left, right } = await fixture(t);
  await fs.chmod(`${left}/lower.txt`, 0o444);
  const before = await provider.load(), after = structuredClone(before);
  after.folders[right].push({ ...before.folders[left][0], id: 'copy' });
  await provider.apply(before, after);
  assert.equal((await fs.stat(`${right}/lower.txt`)).mode & 0o200, 0);
  assert.equal(await fs.readFile(`${right}/lower.txt`, 'utf8'), 'ORIGINAL');
  assert.deepEqual(await fs.readdir(right), ['lower.txt']);
});
