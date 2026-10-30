const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  return {
    version: 1, active: 0, panes: [pane('/left'), pane('/right')],
    folders: {
      '/left': [
        { id: '1', name: 'A.md', type: 'markdown', size: 50, date: '29.10.2026 14:32', content: '# Preview' },
        { id: '2', name: 'b.txt', type: 'text', size: 30, date: '29.10.2026 14:32', content: 'plain text' },
        { id: '3', name: 'docs', type: 'folder', size: 0, date: '29.10.2026 14:32' },
        { id: '4', name: 'sample.zip', type: 'archive', size: 200, date: '29.10.2026 14:32' }
      ],
      '/left/docs': [{ id: '5', name: 'nested', type: 'folder', size: 0 }],
      '/left/docs/nested': [{ id: '6', name: 'notes.txt', type: 'text', size: 4, content: 'deep' }],
      '/left/sample.zip!': [{ id: '7', name: 'data', type: 'folder', size: 0 }, { id: '8', name: 'manifest.txt', type: 'text', size: 4, content: 'list' }],
      '/left/sample.zip!/data': [{ id: '9', name: 'part.txt', type: 'text', size: 5, content: 'parts' }],
      '/right': []
    }
  };
}

function choose(app, name, extra = {}) {
  const row = app.row(name);
  assert.ok(row, `entry ${name} exists`);
  app.click(row.querySelector('[data-filename]'), extra);
}

function submit(app) {
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
}

function value(app, id, text) {
  const input = app.document.querySelector(`#${id}`);
  assert.ok(input, `input ${id} exists`);
  input.value = text;
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
}

function names(app, path) { return app.state().folders[path].map(file => file.name); }
function dialogOpen(app) { return app.document.querySelector('#modal').hasAttribute('open'); }
function notice(app) { return app.document.querySelector('#status-message').textContent; }

test('copy duplicates selected files into the other pane without changing their source', async t => {
  const app = createApp(t, fixture());
  choose(app, 'A.md'); app.action('copy');
  assert.equal(app.document.querySelector('#value').value, '/right');
  submit(app); await tick();
  assert.equal(dialogOpen(app), false);
  assert.ok(names(app, '/left').includes('A.md'));
  assert.deepEqual(names(app, '/right'), ['A.md']);
  const copy = app.state().folders['/right'][0];
  assert.notEqual(copy.id, '1');
  assert.equal(copy.content, '# Preview');
});

test('copy recursively preserves folder contents and embedded archive contents', async t => {
  const app = createApp(t, fixture());
  choose(app, 'docs'); choose(app, 'sample.zip', { ctrlKey: true });
  app.action('copy'); submit(app); await tick();
  assert.deepEqual(names(app, '/right').sort(), ['docs', 'sample.zip']);
  assert.equal(app.state().folders['/right/docs/nested'][0].content, 'deep');
  assert.equal(app.state().folders['/right/sample.zip!/data'][0].content, 'parts');
  assert.ok(app.state().folders['/left/docs']);
});

test('move copies a directory tree and removes its source and selection', async t => {
  const app = createApp(t, fixture());
  choose(app, 'docs'); app.action('move'); submit(app); await tick();
  assert.ok(!names(app, '/left').includes('docs'));
  assert.equal(app.state().folders['/left/docs'], undefined);
  assert.equal(app.state().folders['/left/docs/nested'], undefined);
  assert.equal(app.state().folders['/right/docs/nested'][0].content, 'deep');
  assert.deepEqual(app.state().panes[0].selected, []);
});

test('copy and move reject invalid targets and require decisions for name conflicts without mutation', async t => {
  for (const [command, destination, selectedName, conflict] of [
    ['copy', '/missing', 'A.md', false], ['copy', '/left', 'A.md', false],
    ['move', '/left/docs', 'docs', false], ['copy', '/left/docs/nested', 'docs', false],
    ['copy', '/left/sample.zip!', 'sample.zip', false], ['move', '/right', 'A.md', true]
  ]) {
    const saved = fixture();
    if (conflict) saved.folders['/right'].push({ id: '90', name: 'a.MD', type: 'markdown', size: 0 });
    const app = createApp(t, saved);
    choose(app, selectedName); const before = JSON.stringify(app.state().folders);
    app.action(command); value(app, 'value', destination); submit(app); await tick();
    assert.equal(dialogOpen(app), true, `${command} must reject ${destination}`);
    assert.equal(JSON.stringify(app.state().folders), before);
    if (conflict || destination === '/left') assert.ok(app.document.querySelector('[data-conflict-action="overwrite"]'));
    else assert.ok(notice(app).length);
  }
});

test('new folder validates names and creates a navigable empty entry', t => {
  const app = createApp(t, fixture());
  app.action('mkdir');
  for (const invalid of ['bad?name', '..', 'trailing.']) {
    value(app, 'value', invalid); submit(app); assert.equal(dialogOpen(app), true);
    assert.ok(!names(app, '/left').includes(invalid) || invalid === 'docs');
  }
  value(app, 'value', 'New folder'); submit(app);
  assert.equal(dialogOpen(app), false);
  assert.deepEqual(app.state().folders['/left/New folder'], []);
  choose(app, 'New folder'); app.action('view');
  assert.equal(app.state().panes[0].tabs[0], '/left/New folder');
});

test('delete cancellation preserves entries while confirmation removes complete trees', t => {
  const app = createApp(t, fixture());
  choose(app, 'docs'); choose(app, 'sample.zip', { ctrlKey: true });
  app.action('delete'); app.click(app.document.querySelector('#modal-cancel'));
  assert.ok(app.state().folders['/left/docs']);
  app.action('delete'); submit(app);
  assert.deepEqual(names(app, '/left'), ['A.md', 'b.txt']);
  assert.equal(app.state().folders['/left/docs/nested'], undefined);
  assert.equal(app.state().folders['/left/sample.zip!'], undefined);
  assert.equal(app.state().folders['/left/sample.zip!/data'], undefined);
  assert.deepEqual(app.state().panes[0].selected, []);
});

test('pack creates a separate archive with folder and nested archive trees', t => {
  const app = createApp(t, fixture());
  choose(app, 'docs'); choose(app, 'sample.zip', { ctrlKey: true });
  app.action('pack'); value(app, 'value', 'Bundle.zip'); submit(app);
  assert.equal(dialogOpen(app), false);
  assert.ok(names(app, '/left').includes('Bundle.zip'));
  assert.deepEqual(names(app, '/left/Bundle.zip!').sort(), ['docs', 'sample.zip']);
  assert.equal(app.state().folders['/left/Bundle.zip!/docs/nested'][0].content, 'deep');
  assert.equal(app.state().folders['/left/Bundle.zip!/sample.zip!/data'][0].content, 'parts');
});

test('pack rejects invalid, non-ZIP and existing archive names', t => {
  const app = createApp(t, fixture());
  choose(app, 'A.md'); app.action('pack');
  for (const invalid of ['bad/archive.zip', 'archive.tar', 'sample.zip']) {
    value(app, 'value', invalid); submit(app); assert.equal(dialogOpen(app), true);
    assert.equal(names(app, '/left').length, 4);
  }
});

test('unpack expands files and nested folders into the other pane', t => {
  const app = createApp(t, fixture());
  choose(app, 'sample.zip'); app.action('unpack'); submit(app);
  assert.equal(dialogOpen(app), false);
  assert.deepEqual(names(app, '/right').sort(), ['data', 'manifest.txt']);
  assert.equal(app.state().folders['/right/data'][0].content, 'parts');
  assert.ok(names(app, '/left').includes('sample.zip'));
});

test('unpack handles absent payloads, wrong selections, invalid targets and conflicts', t => {
  const absent = fixture(); delete absent.folders['/left/sample.zip!'];
  const appAbsent = createApp(t, absent); choose(appAbsent, 'sample.zip'); appAbsent.action('unpack');
  assert.equal(dialogOpen(appAbsent), false); assert.match(notice(appAbsent), /keine Beispieldaten/);
  const appWrong = createApp(t, fixture()); choose(appWrong, 'b.txt'); appWrong.action('unpack');
  assert.equal(dialogOpen(appWrong), false); assert.match(notice(appWrong), /ZIP-Archiv/);
  for (const [target, conflict] of [['/missing', false], ['/left/sample.zip!', false], ['/left/sample.zip!/data', false], ['/right', true]]) {
    const saved = fixture(); if (conflict) saved.folders['/right'].push({ id: '80', name: 'MANIFEST.TXT', type: 'text', size: 0 });
    const app = createApp(t, saved); choose(app, 'sample.zip'); app.action('unpack'); value(app, 'value', target); submit(app);
    assert.equal(dialogOpen(app), true); assert.ok(notice(app).length);
  }
});

test('bulk rename updates the preview and applies masks, replacements and case conversion', t => {
  const saved = fixture(); saved.folders['/left'].push({ id: '10', name: 'c.txt', type: 'text', size: 1 });
  const app = createApp(t, saved);
  choose(app, 'b.txt'); choose(app, 'c.txt', { ctrlKey: true }); app.action('rename');
  value(app, 'mask', '[N]-[C]'); value(app, 'counter', '7'); value(app, 'search', 'b'); value(app, 'replacement', 'renamed'); value(app, 'casing', 'upper');
  assert.match(app.document.querySelector('#rename-preview').textContent, /RENAMED-7.TXT/);
  assert.match(app.document.querySelector('#rename-preview').textContent, /C-8.TXT/);
  submit(app);
  assert.ok(names(app, '/left').includes('RENAMED-7.TXT'));
  assert.ok(names(app, '/left').includes('C-8.TXT'));
});

test('bulk rename relocates folder and archive tree keys', t => {
  const app = createApp(t, fixture());
  choose(app, 'docs'); choose(app, 'sample.zip', { ctrlKey: true }); app.action('rename');
  value(app, 'mask', 'new_[N]'); submit(app);
  assert.equal(app.state().folders['/left/docs'], undefined);
  assert.equal(app.state().folders['/left/new_docs/nested'][0].content, 'deep');
  assert.equal(app.state().folders['/left/sample.zip!'], undefined);
  assert.equal(app.state().folders['/left/new_sample.zip!/data'][0].content, 'parts');
});

test('bulk rename rejects malformed, duplicate and occupied destinations', t => {
  for (const [mask, addSecond] of [['invalid/name', false], ['same', true], ['A', false]]) {
    const saved = fixture(); if (addSecond) saved.folders['/left'].push({ id: '10', name: 'c.txt', type: 'text', size: 1 });
    if (mask === 'A') saved.folders['/left'].push({ id: '11', name: 'A.txt', type: 'text', size: 1 });
    const app = createApp(t, saved); choose(app, 'b.txt'); if (addSecond) choose(app, 'c.txt', { ctrlKey: true });
    const before = JSON.stringify(app.state().folders); app.action('rename'); value(app, 'mask', mask); submit(app);
    assert.equal(dialogOpen(app), true); assert.equal(JSON.stringify(app.state().folders), before);
  }
});

test('view retains an embedded lister while edit sends the selected content and language to the host', t => {
  const app = createApp(t, fixture());
  choose(app, 'A.md'); app.action('view'); app.action('edit');
  assert.deepEqual(app.messages.filter(message => ['preview', 'edit'].includes(message.type)).map(message => [message.type, message.content, message.language]), [
    ['edit', '# Preview', 'markdown']
  ]);
  assert.match(app.document.querySelector('.lister textarea').value, /# Preview/);
  app.key('Escape');
  choose(app, 'b.txt'); app.action('edit');
  const latest = app.messages.filter(message => message.type === 'edit').at(-1);
  assert.equal(latest.content, 'plain text'); assert.equal(latest.language, 'plaintext');
  assert.equal(dialogOpen(app), false);
});

test('operations without a selection report a notice without sending editor requests', t => {
  const app = createApp(t, fixture());
  for (const command of ['copy', 'move', 'delete', 'pack', 'unpack', 'rename', 'view', 'edit']) {
    app.action(command); assert.equal(dialogOpen(app), false); assert.match(notice(app), /markieren/);
  }
  assert.equal(app.messages.filter(message => ['preview', 'edit'].includes(message.type)).length, 0);
});

test('an active modal blocks other host actions and closes without applying changes', t => {
  const app = createApp(t, fixture());
  app.action('mkdir'); value(app, 'value', 'Not yet'); app.action('swap');
  assert.match(notice(app), /Dialog schließen/);
  assert.equal(app.state().active, 0);
  app.click(app.document.querySelector('#modal-close'));
  assert.equal(dialogOpen(app), false); assert.ok(!names(app, '/left').includes('Not yet'));
});

test('deleting a directory preserves a distinct sibling whose name contains an exclamation mark', t => {
  const saved = fixture();
  saved.folders['/left'].push({ id: '20', name: 'docs!backup', type: 'folder', size: 0 });
  saved.folders['/left/docs!backup'] = [{ id: '21', name: 'keep.txt', type: 'text', size: 1, content: 'keep' }];
  const app = createApp(t, saved);
  choose(app, 'docs'); app.action('delete'); submit(app);
  assert.ok(names(app, '/left').includes('docs!backup'));
  assert.equal(app.state().folders['/left/docs!backup']?.[0].content, 'keep');
});

test('bulk rename relocates only the selected directory and preserves similarly named siblings', t => {
  const saved = fixture();
  saved.folders['/left'].push({ id: '20', name: 'docs!backup', type: 'folder', size: 0 });
  saved.folders['/left/docs!backup'] = [{ id: '21', name: 'keep.txt', type: 'text', size: 1, content: 'keep' }];
  const app = createApp(t, saved);
  choose(app, 'docs'); app.action('rename'); value(app, 'mask', 'renamed'); submit(app);
  assert.equal(app.state().folders['/left/docs!backup']?.[0].content, 'keep');
  assert.equal(app.state().folders['/left/renamed/nested'][0].content, 'deep');
  assert.equal(app.state().folders['/left/renamed!backup'], undefined);
});

test('copy permits an unrelated sibling destination whose name contains an exclamation mark', async t => {
  const saved = fixture();
  saved.folders['/left'].push({ id: '20', name: 'docs!backup', type: 'folder', size: 0 });
  saved.folders['/left/docs!backup'] = [];
  const app = createApp(t, saved);
  choose(app, 'docs'); app.action('copy'); value(app, 'value', '/left/docs!backup'); submit(app); await tick();
  assert.equal(dialogOpen(app), false);
  assert.equal(app.state().folders['/left/docs!backup/docs/nested'][0].content, 'deep');
});
