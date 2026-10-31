const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('missing prototype directories fall back to an existing home without creating directories', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'startup-paths-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const preferred = ['tmp', 'temp'].map(name => path.join(home, name));
  const { selectStartupRoots } = require('../startup-paths');
  assert.deepEqual(selectStartupRoots(preferred, home), [home.replaceAll('\\', '/')]);
  assert.deepEqual(await fs.readdir(home), []);
  await fs.mkdir(preferred[0]);
  assert.deepEqual(selectStartupRoots(preferred, home), [home.replaceAll('\\', '/')]);
  await fs.mkdir(preferred[1]);
  assert.deepEqual(selectStartupRoots(preferred, home), preferred.map(value => value.replaceAll('\\', '/')));
});

test('non-directory and inaccessible startup paths use the validated fallback', () => {
  const { selectStartupRoots } = require('../startup-paths');
  const home = path.resolve('home'), preferred = [path.resolve('left'), path.resolve('right')];
  const adapter = { realpathSync: value => value, lstatSync: value => {
    if (value === preferred[1]) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return { isDirectory: () => value === home, isSymbolicLink: () => false };
  } };
  assert.deepEqual(selectStartupRoots(preferred, home, adapter), [home.replaceAll('\\', '/')]);
  assert.throws(() => selectStartupRoots(preferred, preferred[0], adapter), /Startverzeichnis/);
});

test('restoration retains existing directories and archives while dropping missing saved tabs', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'startup-tabs-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const archive = path.join(home, 'saved.zip'); await fs.writeFile(archive, 'fixture');
  const virtual = require('../zip-io').location(archive) + '/inside';
  const { existingDirectories } = require('../startup-paths');
  assert.deepEqual(existingDirectories([home, path.join(home, 'missing'), virtual, archive]), [home, virtual]);
});
