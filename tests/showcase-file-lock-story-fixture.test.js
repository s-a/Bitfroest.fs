const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createFileLockStoryFixture } = require('../scripts/showcases/file-lock-story-fixture.cjs');

const modulePath = process.env.SHOWCASE_FILE_LOCK_MODULE;
test('the Windows lock fixture is a test-only native module target', async () => {
  const config = await fs.readFile(path.join(__dirname, 'native-fixtures.cmake'), 'utf8');
  const productConfig = await fs.readFile(path.join(__dirname, '../native/CMakeLists.txt'), 'utf8');
  assert.match(config, /add_windows_test_module\(showcase_file_lock_fixture\s+"\$\{CMAKE_CURRENT_LIST_DIR\}\/fixtures\/showcase-file-lock-fixture\.cc"\s*\)/);
  assert.match(productConfig, /if\(WIN32 AND BITFROEST_BUILD_TEST_FIXTURES\)\s+include\("\$\{CMAKE_CURRENT_SOURCE_DIR\}\/\.\.\/tests\/native-fixtures\.cmake"\)/);
});
test('the fixture holds its own file without delete sharing and releases it on shutdown',
  { skip: process.platform !== 'win32' || !modulePath }, async t => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-locked-file-test-'));
    const fixture = await createFileLockStoryFixture(parent, modulePath);
    t.after(async () => { await fixture.dispose(); await fs.rmdir(parent); });
    assert.equal(fixture.left, fixture.folder);
    assert.equal(fixture.right, path.dirname(fixture.folder));
    assert.deepEqual(await fs.readdir(fixture.right), ['Build-Output']);
    assert.equal(fixture.executable, path.join(fixture.root, 'Preview-Build.exe'));
    assert.equal(fixture.script, path.join(fixture.root, 'Preview-Build.cjs'));
    assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['.showcase-file-lock', 'ShowcaseLock.node', 'Preview-Build.exe', 'Preview-Build.cjs', 'workspace'].sort());
    assert.deepEqual(await fs.readFile(fixture.executable), await fs.readFile(process.execPath));
    await fixture.assertIntact();
    await assert.rejects(fs.unlink(fixture.file), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
    assert.equal(await fs.readFile(fixture.file, 'utf8'), 'The preview build is using this file.\n');
    await fixture.release();
    await fs.unlink(fixture.file);
    await assert.rejects(fs.stat(fixture.file), { code: 'ENOENT' });
  });

test('a fixture rejects unrelated file targets before use', { skip: process.platform !== 'win32' || !modulePath }, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-locked-file-test-'));
  const fixture = await createFileLockStoryFixture(parent, modulePath);
  t.after(async () => { await fixture.dispose(); await fs.rmdir(parent); });
  await assert.rejects(fixture.assertTarget(path.join(parent, 'foreign.txt')), /not the fixture file/);
  await fixture.assertTarget(fixture.file);
});

test('changed demo script prevents authorization and changed executable prevents cleanup', { skip: process.platform !== 'win32' || !modulePath }, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-locked-file-test-'));
  const fixture = await createFileLockStoryFixture(parent, modulePath);
  t.after(async () => { await fixture.dispose(); await fs.rmdir(parent); });
  const source = await fs.readFile(fixture.script);
  try {
    await fs.writeFile(fixture.script, 'changed');
    await assert.rejects(fixture.assertTarget(fixture.file), /contents changed/);
  } finally { await fs.writeFile(fixture.script, source); }
  await fixture.release();
  const exe = await fs.readFile(fixture.executable);
  try {
    await fs.writeFile(fixture.executable, 'changed');
    await assert.rejects(fixture.dispose(), /executable changed/);
  } finally { await fs.writeFile(fixture.executable, exe); }
});

test('a modified marker prevents authorization of the locked target', { skip: process.platform !== 'win32' || !modulePath }, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-locked-file-test-'));
  const fixture = await createFileLockStoryFixture(parent, modulePath);
  t.after(async () => { await fixture.dispose(); await fs.rmdir(parent); });
  const marker = path.join(fixture.root, '.showcase-file-lock');
  const original = await fs.readFile(marker, 'utf8');
  try {
    await fs.writeFile(marker, 'changed');
    await assert.rejects(fixture.assertTarget(fixture.file), /fixture contents changed/);
  } finally { await fs.writeFile(marker, original); }
});
