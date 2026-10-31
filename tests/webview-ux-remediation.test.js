const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: true, snapshotId: 'ux', panes: [pane('C:/tmp'), pane('C:/temp')], folders: {
    'C:/tmp': [{ id: 'a', name: 'Neuer Ordner.txt', type: 'text', content: 'original', fsSource: 'C:/tmp/Neuer Ordner.txt', size: 8 }], 'C:/temp': []
  } };
}
function choose(app) { app.click(app.row('Neuer Ordner.txt').querySelector('[data-filename]')); }
function response(app, state, extra = {}) { app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: false, state, ...extra } })); }
function clipboardResponse(app, request, selection, extra = {}) { app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'clipboard-result', requestId: request.requestId, ok: true, selection, ...extra } })); }

test('single-entry counts use the correct English and German nouns without changing filenames', t => {
  for (const language of ['en', 'de']) {
    const app = createApp(t, fixture(), { language });
    assert.match(app.document.querySelector('.pane.active .pane-status').textContent, language === 'en' ? /1 file\b/ : /1 Datei\b/);
    choose(app); app.action('copy');
    assert.equal(app.document.querySelector('#modal-description').textContent, language === 'en' ? '1 selected entry' : '1 ausgewählter Eintrag');
    assert.equal(app.state().folders['C:/tmp'][0].name, 'Neuer Ordner.txt');
  }
});

test('recovery details remain selectable until explicit dismissal', t => {
  const state = fixture(), app = createApp(t, state, { language: 'en' });
  const callbacks = [];
  app.window.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
  const detail = 'Recovery incomplete. C:/tmp/<Neuer Ordner>&".stage/content';
  response(app, state, { error: detail });
  assert.equal(app.document.querySelector('#toast').classList.contains('visible'), false);
  assert.equal(app.document.querySelector('#toast').textContent, '');
  assert.equal(app.document.querySelector('#status-message').textContent, detail);
  callbacks.forEach(callback => callback());
  assert.equal(app.document.querySelector('#modal').open, true);
  const text = app.document.querySelector('.operation-error-text');
  assert.ok(text.value.endsWith(detail));
  assert.equal(text.readOnly, true);
  assert.equal(text.querySelector('img'), null);
  app.click(app.document.querySelector('[data-select-error]'));
  assert.equal(text.selectionEnd - text.selectionStart, text.value.length);
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.document.querySelector('.operation-error'), null);
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('a failed operation preserves an existing creation form and its focus', t => {
  const state = fixture(), app = createApp(t, state, { language: 'en' });
  choose(app); app.action('mkdir');
  const input = app.document.querySelector('#value'); input.value = 'My entered project'; input.focus(); input.setSelectionRange(3, 10);
  response(app, state, { error: 'Retained stage: C:/temp/Neuer Ordner' });
  assert.equal(app.document.querySelector('#value'), input);
  assert.equal(input.value, 'My entered project');
  assert.equal(app.document.activeElement, input);
  assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 10);
  assert.equal(app.document.querySelector('.operation-error').getAttribute('role'), 'alert');
  app.click(app.document.querySelector('#modal-cancel'));
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.ok(app.document.querySelector('.operation-error-text'));
});

test('copy and cut have distinct feedback and temporary cut markers', t => {
  const app = createApp(t, fixture(), { language: 'en' }); choose(app);
  app.key('x', { ctrlKey: true });
  const cut = app.messages.find(message => message.type === 'clipboard-write');
  clipboardResponse(app, cut, { paths: ['C:/tmp/Neuer Ordner.txt'], mode: 'move', token: 'cut', source: 'system' });
  assert.match(app.document.querySelector('#status-message').textContent, /cut|move/i);
  assert.equal(app.row('Neuer Ordner.txt').classList.contains('is-cut'), true);
  assert.match(app.row('Neuer Ordner.txt').getAttribute('aria-label'), /move/i);
  assert.ok(app.row('Neuer Ordner.txt').querySelector('.cut-marker'));
  assert.equal(Object.hasOwn(app.state().folders['C:/tmp'][0], 'cut'), false);
  app.key('c', { ctrlKey: true });
  const copy = app.messages.filter(message => message.type === 'clipboard-write').at(-1);
  clipboardResponse(app, copy, { paths: ['C:/tmp/Neuer Ordner.txt'], mode: 'copy', token: 'copy', source: 'system' });
  assert.match(app.document.querySelector('#status-message').textContent, /copied/i);
  assert.equal(app.row('Neuer Ordner.txt').classList.contains('is-cut'), false);
});

test('a replaced system clipboard removes stale cut markers before paste', async t => {
  const app = createApp(t, fixture(), { language: 'en' }); choose(app); app.key('x', { ctrlKey: true });
  clipboardResponse(app, app.messages.find(message => message.type === 'clipboard-write'), { paths: ['C:/tmp/Neuer Ordner.txt'], mode: 'move', token: 'cut', source: 'system' });
  assert.equal(app.row('Neuer Ordner.txt').classList.contains('is-cut'), true);
  app.key('v', { ctrlKey: true });
  clipboardResponse(app, app.messages.find(message => message.type === 'clipboard-read'), null);
  await tick();
  assert.equal(app.row('Neuer Ordner.txt').classList.contains('is-cut'), false);
});

test('confirmed cut moves clear their temporary marker while failed moves retain it', async t => {
  for (const ok of [true, false]) {
    const state = fixture(), original = structuredClone(state), app = createApp(t, state, { language: 'en' }); choose(app); app.key('x', { ctrlKey: true });
    const selection = { paths: ['C:/tmp/Neuer Ordner.txt'], mode: 'move', token: 'cut', source: 'system' };
    clipboardResponse(app, app.messages.find(message => message.type === 'clipboard-write'), selection);
    app.key('Tab'); app.key('v', { ctrlKey: true });
    clipboardResponse(app, app.messages.find(message => message.type === 'clipboard-read'), selection);
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
    const pending = app.messages.find(message => message.type === 'filesystem-apply');
    assert.ok(pending);
    const confirmed = ok ? structuredClone(pending.state) : original;
    response(app, confirmed, { ok, error: ok ? undefined : 'Retained stage: C:/tmp/stage' }); await tick();
    const markers = app.document.querySelectorAll('.is-cut');
    assert.equal(markers.length, ok ? 0 : 1);
  }
});

test('late clipboard-write acknowledgements cannot restore an older cut selection', t => {
  const app = createApp(t, fixture(), { language: 'en' }); choose(app);
  app.key('x', { ctrlKey: true }); app.key('c', { ctrlKey: true });
  const [cut, copy] = app.messages.filter(message => message.type === 'clipboard-write');
  clipboardResponse(app, copy, { paths: ['C:/tmp/Neuer Ordner.txt'], mode: 'copy', token: 'new', source: 'system' });
  clipboardResponse(app, cut, { paths: ['C:/tmp/Neuer Ordner.txt'], mode: 'move', token: 'old', source: 'system' });
  assert.equal(app.row('Neuer Ordner.txt').classList.contains('is-cut'), false);
  assert.match(app.document.querySelector('#status-message').textContent, /copied/i);
});

test('a stale dialog-close event cannot steal focus from a failed inline rename', t => {
  const state = fixture(), original = structuredClone(state), app = createApp(t, state, { language: 'en' }); choose(app); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); input.value = 'Changed.txt'; app.key('Enter', {}, input);
  response(app, original, { error: 'Retained path: C:/tmp/stage' });
  const restored = app.document.querySelector('.inline-rename');
  assert.ok(restored);
  app.document.querySelector('#modal').dispatchEvent(new app.window.Event('close'));
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.equal(app.document.activeElement, restored);
});

test('unacknowledged inline recovery details follow a later creation dialog without being discarded', t => {
  const state = fixture(), original = structuredClone(state), app = createApp(t, state, { language: 'en' }); choose(app); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); input.value = 'Changed.txt'; app.key('Enter', {}, input);
  response(app, original, { error: 'Retained path: C:/tmp/stage' });
  app.key('Escape', {}, app.document.querySelector('.inline-rename'));
  app.action('mkdir');
  assert.ok(app.document.querySelector('#modal-body .operation-error'));
  assert.match(app.document.querySelector('.operation-error-text').value, /C:\/tmp\/stage/);
  assert.equal(app.document.activeElement.id, 'value');
});
