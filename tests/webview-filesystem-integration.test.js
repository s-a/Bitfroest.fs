const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-webview-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const left = path.join(parent, 'left').replace(/\\/g, '/'), right = path.join(parent, 'right').replace(/\\/g, '/');
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(`${left}/binary.bin`, Buffer.from([0,255,12,3]));
  await fs.writeFile(`${left}/notes.md`, '# Original');
  const provider = createProvider({ roots: [left, right], deletePath: target => fs.rm(target, { recursive: true }) });
  let confirmed = await provider.load();
  const app = createApp(t, clone(confirmed));
  async function commit() {
    const message = app.messages.filter(message => ['filesystem-apply', 'filesystem-delete'].includes(message.type)).at(-1);
    assert.ok(message, 'surface sends a real operation');
    confirmed = message.type === 'filesystem-delete' ? await provider.remove(confirmed, message) : await provider.apply(confirmed, clone(message.state));
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: clone(confirmed) } }));
    return confirmed;
  }
  const submit = () => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  return { app, provider, left, right, commit, submit };
}

test('Space size requests measure real unloaded nested folders without changing files or snapshot contents', async t => {
  const { app, provider, left, right } = await fixture(t);
  let nested = `${left}/deep`;
  await fs.mkdir(nested);
  for (let index = 0; index < 20; index++) { nested += `/d${index}`; await fs.mkdir(nested); }
  await fs.writeFile(`${nested}/payload.bin`, Buffer.from([0, 255, 1, 2, 3]));
  await fs.mkdir(`${left}/empty`);
  const state = await provider.load(); const before = clone(state);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: clone(state) } }));
  app.click(app.row('deep')); app.key(' '); app.key(' ');
  const request = app.messages.filter(m => m.type === 'folder-size').at(-1);
  assert.ok(request); assert.equal(request.path, `${left}/deep`);
  const size = await provider.measureFolder(state, request.path);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { ...request, type: 'folder-size-result', ok: true, size } }));
  assert.equal(app.row('deep').querySelector('[data-cell="size"]').textContent, '5 B');
  assert.deepEqual(state, before); assert.deepEqual(app.state().folders, before.folders);
  assert.deepEqual(await fs.readFile(`${nested}/payload.bin`), Buffer.from([0, 255, 1, 2, 3]));
  assert.deepEqual(await fs.readdir(right), []);
  assert.equal(await provider.measureFolder(state, `${left}/empty`), 0);
  assert.equal(app.messages.some(m => ['filesystem-apply', 'filesystem-prepare'].includes(m.type)), false);
});
test('real F5 copies binary bytes through the surface, host bridge and filesystem provider', async t => {
  const { app, left, right, submit, commit } = await fixture(t);
  app.click(app.row('binary.bin')); app.action('copy'); submit(); await tick();
  assert.equal(app.document.querySelector('#panes').inert, false);
  app.action('mkdir'); assert.equal(app.document.querySelector('#modal').open, false);
  assert.deepEqual(await fs.readdir(right), []);
  await commit();
  assert.deepEqual(await fs.readFile(`${right}/binary.bin`), await fs.readFile(`${left}/binary.bin`));
  assert.equal(app.document.querySelector('#panes').inert, false);
  assert.ok(app.document.querySelectorAll('.pane')[1].querySelector('[data-file-row][data-id]'));
});
test('real F7, inline rename, F4 and F8 roundtrip through refreshed snapshots', async t => {
  const { app, left, submit, commit } = await fixture(t);
  app.action('mkdir'); app.document.querySelector('#value').value = 'created'; submit(); await commit();
  assert.equal((await fs.stat(`${left}/created`)).isDirectory(), true);
  app.click(app.row('notes.md')); app.action('edit');
  assert.equal(app.messages.filter(message => message.type === 'edit').at(-1).path, `${left}/notes.md`);
  app.action('rename-one'); const input = app.document.querySelector('.inline-rename'); input.value = 'renamed.md'; app.key('Enter', {}, input);
  await commit();
  assert.equal(await fs.readFile(`${left}/renamed.md`, 'utf8'), '# Original');
  app.click(app.row('renamed.md')); app.action('delete'); submit(); await commit();
  await assert.rejects(fs.stat(`${left}/renamed.md`), { code: 'ENOENT' });
});

test('opening a Windows reparse row keeps the existing associated-file command', async t => {
  const { left, provider } = await fixture(t);
  const initial = await provider.load();
  initial.folders[left].push({ id: 'reparse', name: 'reparse', type: 'link', fsSource: `${left}/reparse` });
  const app = createApp(t, clone(initial), { platform: 'win32' });
  app.click(app.row('reparse').querySelector('[data-filename]')); app.key('Enter');
  assert.equal(app.messages.findLast(message => message.type === 'open')?.path, `${left}/reparse`);
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate'), false);
});

test('opening a Linux directory symlink navigates to the host canonical directory', async t => {
  const { left, right, provider } = await fixture(t), target = `${left}/actual-directory`;
  await fs.mkdir(target); await fs.writeFile(`${target}/visible.txt`, 'visible');
  const initial = await provider.load();
  initial.folders[left].push({ id: 'directory-link', name: 'directory-link', type: 'link', fsSource: `${left}/directory-link` });
  const app = createApp(t, clone(initial), { platform: 'linux' });

  app.click(app.row('directory-link').querySelector('[data-filename]')); app.key('Enter');
  const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
  assert.ok(request, 'opening a link row requests host resolution');
  const result = await provider.prepare(initial, { directories: [target], navigation: true, visibleDirectories: [target, right] });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: {
    type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: clone(result),
    resumeNavigation: { path: target, side: 0 }
  } }));

  assert.equal(app.state().panes[0].tabs[0], target);
  assert.ok(app.row('visible.txt'));
});

test('opening a Linux file symlink uses its host-resolved canonical in-root file path', async t => {
  const { left, provider } = await fixture(t), target = `${left}/actual.txt`;
  await fs.writeFile(target, 'file target');
  const initial = await provider.load();
  initial.folders[left].push({ id: 'file-link', name: 'file-link', type: 'link', fsSource: `${left}/file-link` });
  const app = createApp(t, clone(initial), { platform: 'linux' });

  app.click(app.row('file-link').querySelector('[data-filename]')); app.key('Enter');
  const request = app.messages.findLast(message => message.type === 'filesystem-navigate');
  assert.ok(request, 'opening a link row asks the host to resolve its target type');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: {
    type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: true, state: clone(initial),
    resumeOpen: { path: target }
  } }));

  assert.equal(app.messages.findLast(message => message.type === 'open')?.path, target);
});

test('host failure response replaces optimistic state with the real directory snapshot', async t => {
  const { app, provider, right, submit } = await fixture(t);
  app.click(app.row('notes.md')); app.action('copy'); submit(); await tick();
  await fs.writeFile(`${right}/notes.md`, 'external');
  const fresh = await provider.load();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: fresh } }));
  assert.equal(app.document.querySelector('#panes').inert, false);
  assert.equal(app.state().folders[right][0].content, undefined);
  assert.equal(app.state().folders[right][0].size, Buffer.byteLength('external'));
  assert.equal(app.state().folders[right][0].fsSource, `${right}/notes.md`);
  assert.equal(await fs.readFile(`${right}/notes.md`, 'utf8'), 'external');
  assert.match(app.document.querySelector('.operation-error-text').value, /fehlgeschlagen/);
});
