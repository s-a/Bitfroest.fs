const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(real = false) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: real, snapshotId: 'clip-one', panes: [pane('C:/tmp'), pane('C:/temp')], folders: { 'C:/tmp': [{ id: 'a', name: 'a.txt', type: 'text', size: 3, content: 'new', fsSource: 'C:/tmp/a.txt' }], 'C:/temp': [] } };
}
function respond(app, request, extra = {}) {
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, ...extra } }));
}
function select(app) { app.click(app.row('a.txt').querySelector('[data-filename]')); }

test('Escape clears copy and cut intent in both panes without removing selected files', t => {
  for (const mode of ['copy', 'cut']) {
    const saved = fixture(); saved.panes[1].tabs = ['C:/tmp'];
    const app = createApp(t, saved); select(app); app.action(`clipboard-${mode}`);
    app.key('Escape');
    assert.equal(app.document.querySelectorAll('.is-cut,.is-copied').length, 0);
    assert.equal(app.state().panes[0].selected.length, 1);
    assert.equal(app.state().folders['C:/tmp'].length, 1);
    assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, false);
  }
});

test('Escape cancels a pending native write and ignores its late success', t => {
  const app = createApp(t, fixture(true), { platform: 'win32' }); select(app);
  app.action('clipboard-cut'); const write = app.messages.find(message => message.type === 'clipboard-write');
  app.key('Escape');
  const reset = app.messages.find(message => message.type === 'clipboard-reset'); assert.ok(reset);
  assert.equal(reset.sourceRequestId, write.requestId);
  respond(app, write, { selection: { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'old', source: 'system' } });
  assert.equal(app.row('a.txt').classList.contains('is-cut'), false);
  respond(app, reset, { matched: true });
  assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, false);
});

test('a late reset result does not replace a newer operation status', t => {
  const app = createApp(t, fixture(true), { platform: 'win32' }); select(app); app.action('clipboard-copy');
  app.key('Escape'); const reset = app.messages.find(message => message.type === 'clipboard-reset');
  app.action('select-all'); const message = app.document.querySelector('#status-message').textContent;
  respond(app, reset, { matched: true });
  assert.equal(app.document.querySelector('#status-message').textContent, message);
});

test('Escape respects text input and quick search before clearing clipboard intent', t => {
  const app = createApp(t, fixture()); select(app); app.action('clipboard-cut');
  const input = app.document.querySelector('.path-input'); input.focus(); app.key('Escape', {}, input);
  assert.equal(app.row('a.txt').classList.contains('is-cut'), true);
  app.document.querySelector('.pane.active .list').focus(); app.key('a'); app.key('Escape');
  assert.equal(app.row('a.txt').classList.contains('is-cut'), true);
  app.key('Escape'); assert.equal(app.row('a.txt').classList.contains('is-cut'), false);
});

test('Escape rejects a delayed paste read and a later copy can be pasted normally', t => {
  const app = createApp(t, fixture(true), { platform: 'win32' }); select(app);
  app.action('clipboard-copy');
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection: { paths: ['C:/tmp/a.txt'], mode: 'copy', token: 'original', source: 'system' } });
  app.action('clipboard-paste');
  const read = app.messages.find(message => message.type === 'clipboard-read');
  app.key('Escape');
  const reset = app.messages.find(message => message.type === 'clipboard-reset');
  assert.equal(reset.token, 'original');
  respond(app, read, { selection: { paths: ['C:/tmp/a.txt'], mode: 'copy', token: 'read', source: 'system' } });
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.action('clipboard-copy'); app.action('clipboard-paste');
  assert.equal(app.messages.filter(message => message.type === 'clipboard-read').length, 2);
});

for (const interruption of ['restore', 'dialog', 'path focus', 'context menu']) test(`a pending paste read cannot start after ${interruption}`, async t => {
  const app = createApp(t, fixture(true), { platform: 'win32' }); select(app); app.action('clipboard-copy');
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection: { paths: ['C:/tmp/a.txt'], mode: 'copy', token: 'original', source: 'system' } });
  app.key('Tab'); app.action('clipboard-paste'); const read = app.messages.find(message => message.type === 'clipboard-read');
  if (interruption === 'restore') app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', resetViews: true, state: app.state() } }));
  else if (interruption === 'dialog') app.action('mkdir');
  else if (interruption === 'path focus') app.action('path');
  else app.document.querySelector('.pane.active .list').dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  respond(app, read, { selection: { paths: ['C:/tmp/a.txt'], mode: 'copy', token: 'original', source: 'system' } });
  await tick();
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
test('internal copy/paste transfers directly and preserves source bytes', async t => {
  const app = createApp(t, fixture()); select(app);
  app.key('c', { ctrlKey: true }); app.key('Tab'); app.key('v', { ctrlKey: true });
  assert.equal(app.document.querySelector('#modal').open, false);
  await tick();
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
  assert.equal(app.state().folders['C:/temp'][0].content, 'new');
  assert.equal(app.state().panes[0].tabs[0], 'C:/tmp');
});
test('real cut never acknowledges the system clipboard before host transfer confirmation', async t => {
  const saved = fixture(true), app = createApp(t, saved); select(app);
  app.key('x', { ctrlKey: true });
  const write = app.messages.find(message => message.type === 'clipboard-write'); assert.ok(write);
  const selection = { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'native-clip', source: 'system' };
  respond(app, write, { selection }); app.key('Tab'); app.key('v', { ctrlKey: true });
  const read = app.messages.find(message => message.type === 'clipboard-read'); assert.ok(read);
  respond(app, read, { selection }); await tick();
  const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
  assert.equal(app.messages.some(message => message.type === 'clipboard-ack'), false);
  const confirmed = structuredClone(apply.state); confirmed.snapshotId = 'clip-two'; confirmed.folders['C:/temp'][0].fsSource = 'C:/temp/a.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: confirmed } })); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), []);
});
test('failed host commit keeps the cut source available and does not acknowledge clipboard', async t => {
  const saved = fixture(true), original = structuredClone(saved), app = createApp(t, saved); select(app); app.key('x', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/a.txt'], mode: 'move', token: 'failed', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection }); app.key('Tab'); app.key('v', { ctrlKey: true });
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection }); await tick();
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: original } })); await tick();
  assert.equal(app.messages.some(message => message.type === 'clipboard-ack'), false);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
});
test('copy/cut shortcuts leave text fields and unrelated modifiers alone', t => {
  const app = createApp(t, fixture(true)); select(app);
  app.key('x', { ctrlKey: true, shiftKey: true });
  app.key('c', { ctrlKey: true }, app.document.querySelector('.path-input'));
  assert.equal(app.messages.some(message => message.type === 'clipboard-write'), false);
});

test('native multi-directory cut preserves uncompleted groups when a later conflict is cancelled', async t => {
  const saved = fixture(true); saved.folders['C:/tmp/nested'] = [{ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'two', fsSource: 'C:/tmp/nested/b.txt' }];
  saved.folders['C:/temp'] = [{ id: 'old', name: 'a.txt', type: 'text', size: 3, content: 'old', fsSource: 'C:/temp/a.txt' }];
  const app = createApp(t, saved); app.key('Tab'); app.key('v', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/nested/b.txt', 'C:/tmp/a.txt'], mode: 'move', token: 'multiple', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection });
  assert.equal(app.document.querySelector('#modal').open, false);
  await tick();
  const applied = app.messages.find(message => message.type === 'filesystem-apply');
  const confirmed = structuredClone(applied.state); confirmed.snapshotId = 'multi-two'; confirmed.folders['C:/temp'].find(file => file.name === 'b.txt').fsSource = 'C:/temp/b.txt';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: confirmed } })); await tick();
  assert.ok(app.document.querySelector('[data-conflict-action="overwrite"]'));
  assert.equal(app.document.querySelector('#transfer-filter'), null);
  assert.equal(app.state().panes[1].tabs[0], 'C:/temp');
  app.click(app.document.querySelector('#modal-cancel')); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), ['C:/tmp/a.txt']);
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
});

test('failed preparation of a later cut group still acknowledges only earlier confirmed moves', async t => {
  const saved = fixture(true); saved.folders['C:/tmp'] = [{ id: 'folder', name: 'docs', type: 'folder', size: 0, fsSource: 'C:/tmp/docs' }];
  saved.folders['C:/tmp/docs'] = []; saved.unloadedFolders = ['C:/tmp/docs'];
  saved.folders['C:/tmp/nested'] = [{ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'two', fsSource: 'C:/tmp/nested/b.txt' }];
  const app = createApp(t, saved); app.key('Tab'); app.key('v', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/nested/b.txt', 'C:/tmp/docs'], mode: 'move', token: 'preparation', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection }); await tick();
  const applied = app.messages.find(message => message.type === 'filesystem-apply'), confirmed = structuredClone(applied.state); confirmed.snapshotId = 'confirmed-first';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: confirmed } })); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.ok(app.messages.some(message => message.type === 'filesystem-prepare'));
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state: confirmed } })); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), ['C:/tmp/docs']);
});

test('partial native cut acknowledgement retains every source not actually moved', async t => {
  const saved = fixture(true); saved.folders['C:/tmp'].push({ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'two', fsSource: 'C:/tmp/b.txt' });
  const original = structuredClone(saved), app = createApp(t, saved);
  app.click(app.row('a.txt').querySelector('[data-filename]')); app.click(app.row('b.txt').querySelector('[data-filename]'), { ctrlKey: true }); app.key('x', { ctrlKey: true });
  const selection = { paths: ['C:/tmp/a.txt', 'C:/tmp/b.txt'], mode: 'move', token: 'partial', source: 'system' };
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection }); app.key('Tab'); app.key('v', { ctrlKey: true });
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection }); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-apply');
  original.folders['C:/temp'] = [{ ...original.folders['C:/tmp'][0], fsSource: 'C:/temp/a.txt' }]; original.folders['C:/tmp'] = original.folders['C:/tmp'].filter(file => file.id === 'b');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, ok: true, state: original, operationOutcome: { cancelled: true, completedIds: ['a'] } } })); await tick();
  const ack = app.messages.find(message => message.type === 'clipboard-ack'); assert.ok(ack);
  assert.deepEqual(Array.from(ack.remainingPaths), ['C:/tmp/b.txt']);
});

test('cut files are faded while copied files have no added icon', t => {
  const app = createApp(t, fixture()); select(app);
  app.action('clipboard-cut');
  const row = app.row('a.txt');
  const fs = require('node:fs'), path = require('node:path');
  const style = app.document.createElement('style'); style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  assert.equal(app.window.getComputedStyle(row.querySelector('.fileicon')).opacity, '0.5');
  assert.equal(app.window.getComputedStyle(row.querySelector('[data-filename]')).opacity, '0.5');
  assert.equal(app.window.getComputedStyle(row).opacity, '1');
  app.action('clipboard-copy');
  assert.equal(row.classList.contains('is-cut'), false);
  assert.equal(row.classList.contains('is-copied'), true);
  assert.equal(row.querySelector('.copy-marker'), null);
  assert.equal(row.querySelector('.codicon-copy'), null);
  assert.equal(row.querySelector('.cut-marker'), null);
  assert.match(row.getAttribute('aria-label'), /Kopieren/);
  assert.equal(app.window.getComputedStyle(row.querySelector('[data-filename]')).opacity, '1');
  app.action('clipboard-cut');
  assert.equal(row.querySelector('.copy-marker'), null);
  assert.equal(row.classList.contains('is-copied'), false);
});

test('clipboard source markers survive redraw in both panels and switch between copy and cut', t => {
  const state = fixture(); state.panes[1].tabs = ['C:/tmp'];
  const app = createApp(t, state); select(app); app.action('clipboard-copy');
  assert.equal(app.document.querySelectorAll('.is-copied').length, 2);
  app.action('swap');
  assert.equal(app.document.querySelectorAll('.is-copied').length, 2);
  app.action('clipboard-cut');
  assert.equal(app.document.querySelectorAll('.is-copied').length, 0);
  assert.equal(app.document.querySelectorAll('.is-cut').length, 2);
});

test('copied sources add a neutral hatch strip without an empty gutter on ordinary files', t => {
  const app = createApp(t, fixture()); select(app);
  const style = app.document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  const rules = [...style.sheet.cssRules];
  const reservation = rules.find(rule => rule.selectorText === '.filename::before');
  assert.ok(reservation);
  assert.equal(reservation.style.width, 'var(--file-marker-width, 0px)');
  assert.equal(reservation.style.height, '12px');
  assert.equal(reservation.style.flex, '0 0 var(--file-marker-width, 0px)');
  assert.equal(reservation.style.getPropertyValue('background-image'), 'none');
  const hatch = rules.find(rule => rule.selectorText === '.file-table tr.is-copied .filename::before');
  assert.equal(hatch.style.getPropertyValue('background-size'), '6px 12px');
  assert.match(hatch.style.getPropertyValue('background-image'), /repeating-linear-gradient\(135deg, currentColor 0 1px, transparent 1px 3px\)/i);
  assert.match(reservation.style.color, /--vscode-icon-foreground/);
  const selected = rules.find(rule => rule.selectorText === '.file-table tr.selected .filename::before');
  assert.equal(selected.style.color, 'inherit');
  const forced = rules.find(rule => rule.conditionText === '(forced-colors: active)' && [...rule.cssRules].some(child => child.selectorText === '.filename::before'));
  assert.ok([...forced.cssRules].some(rule => rule.style.color.toLowerCase() === 'canvastext'));
  assert.ok([...forced.cssRules].some(rule => rule.style.color.toLowerCase() === 'highlighttext'));
  const row = app.row('a.txt'), icon = row.querySelector('.fileicon'), name = row.querySelector('[data-filename]');
  const iconMarkup = icon.outerHTML, text = name.textContent;
  app.action('clipboard-copy');
  assert.ok(row.classList.contains('is-copied'));
  assert.ok(row.classList.contains('selected'));
  assert.ok(row.classList.contains('focused'));
  assert.equal(icon.outerHTML, iconMarkup);
  assert.equal(name.textContent, text);
  assert.equal(app.window.getComputedStyle(name).opacity, '1');
  assert.equal(row.querySelector('.copy-marker,.codicon-copy'), null);
  assert.match(row.getAttribute('aria-label'), /Kopieren/);
  app.action('clipboard-cut');
  assert.equal(row.classList.contains('is-copied'), false);
  assert.equal(app.window.getComputedStyle(name).opacity, '0.5');
});

test('paste availability follows internal file selections and excludes archive targets', t => {
  const app = createApp(t, fixture()); select(app);
  const focus = () => app.messages.filter(message => message.type === 'inputFocus').at(-1);
  assert.equal(focus().paste, false);
  app.action('clipboard-copy'); assert.equal(focus().paste, true);
  app.action('clipboard-cut'); assert.equal(focus().paste, true);
  const archived = fixture(), directory = 'zip:C%3A%2Ftmp%2Fsample.zip!/';
  archived.panes[0].tabs = [directory]; archived.folders[directory] = [];
  archived.archiveLocations = { [directory]: { archive: 'C:/tmp/sample.zip', prefix: '' } };
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: archived } }));
  assert.equal(focus().paste, false);
  const manifest = require('../package.json');
  assert.match(manifest.contributes.commands.find(command => command.command === 'bitfroest.clipboard-paste').enablement, /bitfroest\.canPasteFiles/);
});

test('native paste availability refreshes silently and ignores an obsolete status after copying', t => {
  const app = createApp(t, fixture(true), { platform: 'win32' });
  const focus = () => app.messages.filter(message => message.type === 'inputFocus').at(-1);
  const first = app.messages.find(message => message.type === 'clipboard-status'); assert.ok(first);
  respond(app, first, { available: true }); assert.equal(focus().paste, true);
  app.window.dispatchEvent(new app.window.Event('focus'));
  assert.equal(focus().paste, true);
  const second = app.messages.filter(message => message.type === 'clipboard-status').at(-1);
  respond(app, second, { available: false }); assert.equal(focus().paste, false);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fixture(true) } }));
  assert.equal(app.document.querySelector('#modal').open, false);
  app.window.dispatchEvent(new app.window.Event('focus'));
  const third = app.messages.filter(message => message.type === 'clipboard-status').at(-1);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: fixture(true) } }));
  select(app); app.action('clipboard-copy');
  respond(app, third, { available: false });
  respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection: { paths: ['C:/tmp/a.txt'], mode: 'copy', source: 'system', token: 'current' } });
  assert.equal(focus().paste, true);
});

test('text clipboard changes immediately disable native file paste while read failures remain silent', t => {
  const app = createApp(t, fixture(true), { platform: 'win32' });
  const focus = () => app.messages.filter(message => message.type === 'inputFocus').at(-1);
  const status = app.messages.find(message => message.type === 'clipboard-status');
  respond(app, status, { available: true }); assert.equal(focus().paste, true);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-changed' } }));
  assert.equal(focus().paste, false);
  const next = app.messages.filter(message => message.type === 'clipboard-status').at(-1);
  respond(app, next, { ok: false, error: 'Clipboard busy' });
  assert.equal(focus().paste, false);
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.querySelector('#status-message').textContent.includes('Clipboard busy'), false);
});

test('a status reply from an older document cannot enable paste after reloading', t => {
  const old = createApp(t, fixture(true), { platform: 'win32' });
  const current = createApp(t, fixture(true), { platform: 'win32' });
  const obsolete = old.messages.find(message => message.type === 'clipboard-status');
  respond(current, obsolete, { available: true });
  assert.equal(current.messages.filter(message => message.type === 'inputFocus').at(-1).paste, false);
  respond(current, current.messages.find(message => message.type === 'clipboard-status'), { available: true });
  assert.equal(current.messages.filter(message => message.type === 'inputFocus').at(-1).paste, true);
});

test('an empty paste result cannot be overwritten by an earlier availability check', t => {
  const app = createApp(t, fixture(true), { platform: 'win32' });
  const status = app.messages.find(message => message.type === 'clipboard-status');
  app.action('clipboard-paste');
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection: null });
  respond(app, status, { available: true });
  assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, false);
});

test('platforms without a system file clipboard keep paste available for their internal file selection', t => {
  const app = createApp(t, fixture(true), { platform: 'linux' }); select(app);
  assert.equal(app.messages.some(message => message.type === 'clipboard-status'), false);
  app.action('clipboard-copy');
  assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, true);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-changed' } }));
  assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, true);
  assert.equal(app.messages.some(message => message.type === 'clipboard-write'), false);
});

test('confirmed clipboard files remain pasteable across focus and pane changes with an overlapping status check', async t => {
  for (const sourceSide of [1, 0]) for (const mode of ['copy', 'move']) for (const pendingStatus of [true, false]) {
    const saved = fixture(true);
    saved.folders['C:/temp'] = [{ id: 'b', name: 'b.txt', type: 'text', size: 3, content: 'right', fsSource: 'C:/temp/b.txt' }];
    const app = createApp(t, saved, { platform: 'win32' });
    const initial = app.messages.find(message => message.type === 'clipboard-status');
    if (!pendingStatus) respond(app, initial, { available: false });
    const sourcePath = saved.panes[sourceSide].tabs[0], targetSide = 1 - sourceSide;
    const source = saved.folders[sourcePath][0];
    app.click(app.document.querySelector(`[data-pane="${sourceSide}"] tr[data-id="${source.id}"] [data-filename]`));
    app.action(mode === 'copy' ? 'clipboard-copy' : 'clipboard-cut');
    const selection = { paths: [source.fsSource], mode, source: 'system', token: 'confirmed' };
    respond(app, app.messages.find(message => message.type === 'clipboard-write'), { selection });
    app.window.dispatchEvent(new app.window.Event('focus'));
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, state: saved } }));
    const target = app.document.querySelector(`[data-pane="${targetSide}"] .list`);
    target.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    assert.equal(app.state().active, targetSide);
    assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, true, `${sourceSide}/${mode}/${pendingStatus}`);
    if (pendingStatus) {
      respond(app, initial, { available: false });
      assert.equal(app.messages.filter(message => message.type === 'inputFocus').at(-1).paste, true);
      const current = app.messages.filter(message => message.type === 'clipboard-status').at(-1);
      assert.notEqual(current.requestId, initial.requestId);
      respond(app, current, { available: true });
    }
    app.click(app.document.querySelector('[data-context-action="clipboard-paste"]'));
    respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection });
    assert.equal(app.document.querySelector('#modal').open, false);
    await tick();
    const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
    assert.ok(apply.state.folders[saved.panes[targetSide].tabs[0]].some(file => file.name === source.name));
  }
});

test('paste copies or moves directly into either active pane without a preparation dialog', async t => {
  for (const sourceSide of [1, 0]) for (const mode of ['copy', 'move']) {
    const saved = fixture(); saved.folders['C:/temp'] = [{ id: 'b', name: 'right.txt', type: 'text', content: 'right', size: 5 }];
    const sourcePath = saved.panes[sourceSide].tabs[0], targetSide = 1 - sourceSide, source = { ...saved.folders[sourcePath][0] };
    const targetPath = saved.panes[targetSide].tabs[0], app = createApp(t, saved);
    app.click(app.document.querySelector(`[data-pane="${sourceSide}"] tr[data-id="${source.id}"] [data-filename]`));
    app.action(mode === 'copy' ? 'clipboard-copy' : 'clipboard-cut'); app.key('Tab'); app.action('clipboard-paste');
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.equal(app.document.querySelector('#transfer-filter'), null);
    await tick();
    assert.equal(app.state().folders[targetPath].find(file => file.name === source.name)?.content, source.content);
    assert.equal(app.state().folders[sourcePath].some(file => file.name === source.name), mode === 'copy');
    assert.equal(app.document.querySelector('#modal').open, false);
  }
});

test('direct paste opens only the conflict decision when the destination name exists', async t => {
  const saved = fixture(); saved.folders['C:/temp'] = [{ id: 'old', name: 'a.txt', type: 'text', size: 3, content: 'old' }];
  const app = createApp(t, saved); select(app); app.action('clipboard-copy'); app.key('Tab'); app.action('clipboard-paste');
  await tick();
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.ok(app.document.querySelector('[data-conflict-action="overwrite"]'));
  assert.equal(app.document.querySelector('#transfer-filter'), null);
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  assert.equal(app.state().folders['C:/temp'][0].content, 'new');
  assert.equal(app.state().folders['C:/tmp'][0].content, 'new');
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('skip-all from a direct paste conflict applies to later source groups without another dialog', async t => {
  const saved = fixture(true);
  saved.folders['C:/tmp/nested'] = [{ id: 'b', name: 'b.txt', type: 'text', content: 'new-b', size: 5, fsSource: 'C:/tmp/nested/b.txt' }];
  saved.folders['C:/temp'] = [{ id: 'old-a', name: 'a.txt', type: 'text', content: 'old-a', size: 5 }, { id: 'old-b', name: 'b.txt', type: 'text', content: 'old-b', size: 5 }];
  const app = createApp(t, saved); app.key('Tab'); app.action('clipboard-paste');
  respond(app, app.messages.find(message => message.type === 'clipboard-read'), { selection: { paths: ['C:/tmp/a.txt', 'C:/tmp/nested/b.txt'], mode: 'copy', token: 'groups', source: 'system' } });
  await tick();
  assert.ok(app.document.querySelector('[data-conflict-action="skip-all"]'));
  app.click(app.document.querySelector('[data-conflict-action="skip-all"]')); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  assert.deepEqual(app.state().folders['C:/temp'].map(file => file.content), ['old-a', 'old-b']);
  assert.equal(app.state().folders['C:/tmp/nested'][0].content, 'new-b');
});
