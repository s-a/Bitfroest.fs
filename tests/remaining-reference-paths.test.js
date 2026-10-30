const test = require('node:test');
const assert = require('node:assert/strict');
const transfer = require('../media/commander-transfer');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('destination masks split on their first dot, remove omitted extensions and restart extension positions at the stem', () => {
  for (const [name, mask, expected] of [['report.csv', '*', 'report'], ['docs.old', '*', 'docs'], ['README', '*.*.bak', 'README.bak'], ['report.csv', '*.*?*', 'report.report'], ['report.csv', '*.new.*', 'report.new'], ['report.csv', '*.*.bak', 'report.csv.bak'], ['.env', '*', '.env'], ['.env', '*.new', '.env.new']]) {
    assert.equal(transfer.applyNameMask(name, mask), expected, `${name}: ${mask}`);
  }
});

test('repeated wildcard runs reset once without duplicating source name components', () => {
  for (const count of [2, 3, 4, 5]) {
    assert.equal(transfer.applyNameMask('report.csv', '*'.repeat(count)), 'report');
    assert.equal(transfer.applyNameMask('report.csv', `*.${'*'.repeat(count)}`), 'report.csv');
    assert.equal(transfer.applyNameMask('report.csv', `prefix_${'*'.repeat(count)}.*`), 'prefix_report.csv');
  }
});

test('copy and move masks rename dotted folder roots while retaining their children', async () => {
  for (const mode of ['copy', 'move']) {
    const folders = { '/source': [{ id: 'dir', name: 'docs.old', type: 'folder' }], '/source/docs.old': [{ id: 'child', name: 'keep.txt', type: 'text', content: 'original' }], '/target': [] };
    const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target/*', ids: ['dir'], mode });
    assert.equal(result.errors.length, 0);
    assert.equal(folders['/target'][0].name, 'docs');
    assert.equal(folders['/target/docs'][0].name, 'keep.txt');
    assert.equal(folders['/target/docs'][0].content, 'original');
    assert.equal(Boolean(folders['/source/docs.old']), mode === 'copy');
  }
});

test('size policies skip equal and zero-equal entries and ignore contradictory age and version metadata', async () => {
  for (const mode of ['copy', 'move']) for (const policy of ['larger', 'smaller']) {
    const cases = [['equal', 2, 2], ['zero', 0, 0], ['empty', 0, 2], ['big', 3, 2], ['new', 1, 0]];
    const folders = { '/source': cases.map(([id, size]) => ({ id, name: `${id}.dll`, type: 'text', size, content: 'source', mtimeMs: 1, fileVersion: [1, 0, 0, 0] })),
      '/target': cases.map(([id, , size]) => ({ id: `old-${id}`, name: `${id}.dll`, type: 'text', size, content: 'target', mtimeMs: 2, fileVersion: [2, 0, 0, 0] })) };
    const expected = cases.filter(([, source, target]) => policy === 'larger' ? source > target : source < target).map(([id]) => id);
    const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target', ids: cases.map(([id]) => id), mode, policy });
    assert.deepEqual(result.completedIds, expected);
    for (const [id] of cases) {
      assert.equal(folders['/target'].find(row => row.name === `${id}.dll`).content, expected.includes(id) ? 'source' : 'target');
      assert.equal(folders['/source'].some(row => row.id === id), mode === 'copy' || !expected.includes(id));
    }
  }
});

test('simple multi-rename previews and commits the default counter without forced leading zeros', t => {
  const app = createApp(t), saved = app.state(), source = '/workspace/bitfroest';
  saved.folders[source].push({ id: 'first-counter', name: 'first.txt', type: 'text', content: 'first' }, { id: 'second-counter', name: 'second.txt', type: 'text', content: 'second' });
  saved.panes[0].selected = ['first-counter', 'second-counter']; saved.panes[0].cursor = 'first-counter';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'restore', state: saved } }));
  const original = structuredClone(app.state().folders);
  app.action('rename');
  app.document.querySelector('#mask').value = 'item_[C]';
  app.document.querySelector('#mask').dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.deepEqual([...app.document.querySelectorAll('#rename-preview tr td:last-child')].map(cell => cell.textContent), ['item_1.txt', 'item_2.txt']);
  app.document.querySelector('#counter').value = '7';
  app.document.querySelector('#counter').dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.deepEqual([...app.document.querySelectorAll('#rename-preview tr td:last-child')].map(cell => cell.textContent), ['item_7.txt', 'item_8.txt']);
  assert.deepEqual(app.state().folders, original);
  app.document.querySelector('#modal-form').requestSubmit();
  assert.equal(app.state().folders[source].find(file => file.id === 'first-counter').name, 'item_7.txt');
  assert.equal(app.state().folders[source].find(file => file.id === 'second-counter').name, 'item_8.txt');
  assert.equal(app.state().folders[source].find(file => file.id === 'second-counter').content, 'second');
});

test('an empty transfer target uses the source directory and retains ordinary collision protection', async () => {
  const folders = { 'C:/source': [{ id: 'a', name: 'a.txt', type: 'text', content: 'original' }], 'C:/target': [] };
  const options = { folders, sourcePath: 'C:/source', targetPath: '', ids: ['a'] };
  assert.equal(transfer.planTarget(options).directory, 'C:/source');
  const guarded = await transfer.execute({ ...options, policy: 'overwrite-all' });
  assert.equal(guarded.completed, 0);
  assert.deepEqual(folders['C:/source'].map(file => file.content), ['original']);
  const copied = await transfer.execute({ ...options, policy: 'autorename-source' });
  assert.equal(copied.completed, 1);
  assert.deepEqual(folders['C:/source'].map(file => [file.name, file.content]), [['a.txt', 'original'], ['a (2).txt', 'original']]);
  assert.deepEqual(folders['C:/target'], []);
});

test('the transfer dialog accepts an empty target as a copy within the source directory', async t => {
  const app = createApp(t);
  app.click(app.row('README.md')); app.action('copy');
  app.document.querySelector('#value').value = '';
  app.document.querySelector('#transfer-policy').value = 'autorename-source';
  assert.equal(app.document.querySelector('#modal-form').checkValidity(), true, 'empty transfer target must pass native form validation');
  app.document.querySelector('#modal-form').requestSubmit(); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  const rows = app.state().folders['/workspace/bitfroest'];
  assert.equal(rows.find(file => file.name === 'README (2).md')?.content, rows.find(file => file.name === 'README.md').content);
  assert.ok(rows.some(file => file.name === 'README (2).md'));
  assert.equal(app.state().folders['/home/demo/Downloads'].some(file => file.name === 'README (2).md'), false);
});
