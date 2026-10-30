const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFolderLocks } = require('../folder-locks');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-locks-'));
  const folder = path.join(root, 'target'); await fs.mkdir(folder);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const row = { pid: 8123, started: '12345', name: 'owned.exe', executable: path.join(folder, 'owned.exe'), file: path.join(folder, 'a.txt'), kind: 'handle', handle: '124' };
  const provider = createFolderLocks({ platform: 'win32', roots: [root], run: async input => { calls.push(input); return input.action === 'scan' ? { rows: [row], inaccessible: 2 } : { changed: 1 }; }, ...overrides });
  t.after(() => provider.dispose());
  return { root, folder, row, calls, provider };
}

test('scan freezes a directory selection and never reports inaccessible processes as proven freedom', async t => {
  const { provider, folder, calls } = await fixture(t);
  const result = await provider.scan(folder);
  assert.equal(calls[0].action, 'scan'); assert.equal(calls[0].path, folder);
  assert.equal(result.rows[0].pid, 8123); assert.equal(result.inaccessible, 2);
  assert.ok(result.rows[0].id); assert.equal(result.rows[0].handle, undefined);
});

test('actions use private observed identities and reject stale or invented selection tokens', async t => {
  const { provider, folder, calls } = await fixture(t);
  const first = await provider.scan(folder), id = first.rows[0].id;
  await assert.rejects(provider.act('terminate', ['foreign']));
  await provider.act('unlock', [id]);
  assert.equal(calls.at(-1).action, 'unlock'); assert.equal(calls.at(-1).rows[0].started, '12345');
  assert.equal(calls.at(-1).rows[0].handle, '124');
  await provider.scan(folder);
  await assert.rejects(provider.act('terminate', [id]));
  assert.equal(calls.filter(call => call.action === 'terminate').length, 0);
});

test('external paths, links and non-directories never reach native inspection', async t => {
  const { provider, folder, root, calls } = await fixture(t);
  const file = path.join(root, 'file'); await fs.writeFile(file, 'data');
  for (const target of [path.dirname(root), file, folder + '\0', path.join(root, 'absent')]) await assert.rejects(provider.scan(target));
  assert.equal(calls.length, 0);
});

test('unsupported platforms and disposed sessions cannot launch helpers', async () => {
  let calls = 0;
  const provider = createFolderLocks({ platform: 'linux', roots: ['/tmp'], run: async () => calls++ });
  await assert.rejects(provider.scan('/tmp'), /Windows/); assert.equal(calls, 0);
  provider.dispose(); await assert.rejects(provider.scan('/tmp'));
});

test('busy and disposed inspections cannot publish late results or overlap', async t => {
  let finish;
  const { provider, folder } = await fixture(t, { run: async () => new Promise(resolve => { finish = resolve; }) });
  const pending = provider.scan(folder);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(provider.scan(folder), /läuft/);
  provider.dispose(); finish({ rows: [], inaccessible: 0 }); await assert.rejects(pending, /geschlossen/);
});

test('replacing the investigated directory invalidates later destructive actions', async t => {
  const { provider, folder, calls } = await fixture(t);
  const result = await provider.scan(folder);
  await fs.rename(folder, folder + '-original'); await fs.mkdir(folder);
  await assert.rejects(provider.act('terminate', result.rows.map(row => row.id)), /geändert/);
  assert.equal(calls.filter(call => call.action === 'terminate').length, 0);
});

test('copy validates the destination before unlocking, preserves content and refuses an existing target', async t => {
  const { provider, folder, root, calls } = await fixture(t);
  await fs.writeFile(path.join(folder, 'content.txt'), 'original');
  const result = await provider.scan(folder), ids = result.rows.map(row => row.id);
  await assert.rejects(provider.fileAction('copy', ids, folder));
  assert.equal(calls.filter(call => call.action === 'unlock').length, 0);
  const destination = path.join(root, 'copy');
  await provider.fileAction('copy', ids, destination);
  assert.equal(await fs.readFile(path.join(destination, 'content.txt'), 'utf8'), 'original');
  await assert.rejects(provider.fileAction('copy', ids, destination), /vorhanden/);
  assert.equal(calls.filter(call => call.action === 'unlock').length, 1);
});

test('failed native unlocking prevents deleting the target folder', async t => {
  let trashed = 0;
  const { provider, folder } = await fixture(t, { trash: async () => trashed++, run: async input => input.action === 'scan' ? { rows: [{ pid: 8123, started: '1', name: 'app', file: path.join(input.path, 'held'), kind: 'handle', handle: '2' }], inaccessible: 0 } : { errors: ['still held'] } });
  const result = await provider.scan(folder);
  await assert.rejects(provider.fileAction('delete', result.rows.map(row => row.id)), /still held/);
  assert.equal(trashed, 0);
});

test('closing during unlock prevents later file mutations', async t => {
  let finish, trashed = 0;
  const { provider, folder } = await fixture(t, { trash: async () => trashed++, run: async input => input.action === 'scan' ? { rows: [{ pid: 8123, started: '1', file: path.join(input.path, 'held'), kind: 'handle', handle: '2' }], inaccessible: 0 } : new Promise(resolve => { finish = resolve; }) });
  const state = await provider.scan(folder), pending = provider.fileAction('delete', state.rows.map(row => row.id));
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  provider.dispose(); finish({ changed: 1 });
  await assert.rejects(pending, /geschlossen/); assert.equal(trashed, 0);
});
