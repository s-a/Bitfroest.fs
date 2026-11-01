const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const Progress = require('../media/commander-progress');
function state(inside = false) {
  const root = 'zip:C%3A%2Ftmp%2Ftest.zip!';
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  return { version: 1, realFilesystem: true, snapshotId: 'write', active: 0, panes: [pane(inside ? root : 'C:/tmp'), pane('C:/temp')],
    folders: { 'C:/tmp': [{ id: 'source', name: 'file.txt', type: 'text', fsSource: 'C:/tmp/file.txt' }], 'C:/temp': [], [root]: [{ id: 'entry', name: 'file.txt', type: 'text', fsSource: root + '/file.txt', archive: 'C:/tmp/test.zip', archiveEntry: 'file.txt', size: 5 }] },
    archiveLocations: { [root]: { archive: 'C:/tmp/test.zip', parent: 'C:/tmp' } } };
}
const submit = app => app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

test('empty ZIP verification waits for the matching host result and preserves success, error and cancellation', t => {
  for (const language of ['de', 'en']) for (const outcome of ['success', 'error', 'cancelled']) {
    const saved = state(); saved.folders['C:/tmp'][0] = { id: 'source', name: 'empty.txt', type: 'text', fsSource: 'C:/tmp/empty.txt', size: 0 };
    const app = createApp(t, saved, { language }); app.click(app.row('empty.txt')); app.action('pack'); submit(app);
    const request = app.messages.find(message => message.type === 'zip-write'); assert.ok(request);
    const send = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
    const progress = Progress.event({ phase: 'verifying', currentPath: 'empty.txt', transferred: 0, total: 0, completedBytes: 0, totalBytes: 0, overall: Progress.known('bytes', 0, 0), current: Progress.known('bytes', 0, 0) });
    send({ type: 'filesystem-progress', operationId: request.operationId, progress });
    const meter = app.document.querySelector('#status-progress-file');
    assert.equal(meter.style.width, '0%');
    assert.equal(meter.hasAttribute('aria-valuenow'), false); assert.equal(meter.hasAttribute('aria-valuemax'), false);
    assert.match(meter.getAttribute('aria-valuetext'), language === 'de' ? /0 Bytes.*Hostbestätigung/ : /0 bytes.*Host acknowledgment/);
    assert.equal(app.document.querySelector('#status-percent').textContent, '—/—');
    assert.equal(app.document.querySelectorAll('[data-job-row]').length, 1);
    assert.notEqual(app.document.querySelector('#status-message').dataset.outcome, 'success');
    send({ type: 'filesystem-result', operationId: 'foreign', ok: true, state: saved });
    assert.equal(app.document.querySelectorAll('[data-job-row]').length, 1);
    if (outcome === 'cancelled') {
      app.click(app.document.querySelector('#status-cancel'));
      assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel' && message.operationId === request.operationId).length, 1);
      assert.equal(app.document.querySelectorAll('[data-job-row]').length, 1);
    }
    send({ type: 'filesystem-result', operationId: request.operationId, ok: outcome !== 'error', cancelled: outcome === 'cancelled', ...(outcome === 'error' ? { error: 'CRC mismatch' } : {}), state: saved });
    assert.equal(app.document.querySelectorAll('[data-job-row]').length, 0);
    assert.equal(app.document.querySelector('#status-message').dataset.outcome, outcome);
    const finishedMessage = app.document.querySelector('#status-message').textContent;
    send({ type: 'filesystem-progress', operationId: request.operationId, progress });
    assert.equal(app.document.querySelectorAll('[data-job-row]').length, 0);
    assert.equal(app.document.querySelector('#status-message').textContent, finishedMessage);
  }
});

test('ZIP preparation reports collected entries and packing uses both known progress totals', t => {
  for (const language of ['de', 'en']) {
    const app = createApp(t, state(), { language }); app.click(app.row('file.txt')); app.action('pack'); submit(app);
    const request = app.messages.find(message => message.type === 'zip-write');
    const send = progress => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-progress', operationId: request.operationId, progress } }));
    send({ phase: 'preparing', currentPath: 'C:/tmp/models/large.bin', filesScanned: 1248 });
    assert.match(app.document.querySelector('#status-message').textContent, language === 'de' ? /ZIP-Dateien erfassen · 1248 Einträge erfasst/ : /Collect ZIP files · 1248 entries collected/);
    assert.match(app.document.querySelector('#status-message').textContent, /large\.bin/);
    assert.equal(app.document.querySelector('#status-percent').textContent, '—/—');
    send({ phase: 'packing', currentPath: 'models/large.bin', transferred: 68, total: 100, completedBytes: 42, totalBytes: 100 });
    assert.equal(app.document.querySelector('#status-percent').textContent, '42%/68%');
    assert.doesNotMatch(app.document.querySelector('#status-message').textContent, /1248/);
    send({ phase: 'packing', currentPath: 'models/large.bin', transferred: 4294967296, total: 8589934592, completedBytes: 4294967296, totalBytes: 17179869184 });
    assert.equal(app.document.querySelector('#status-percent').textContent, '25%/50%');
    send({ phase: 'finalizing', currentPath: 'C:/temp/result.zip' });
    assert.match(app.document.querySelector('#status-message').textContent, language === 'de' ? /ZIP abschließen/ : /Finalize ZIP/);
    assert.equal(app.document.querySelector('#status-percent').textContent, '—/—');
    send({ phase: 'publishing', currentPath: 'C:/temp/result.zip' });
    assert.match(app.document.querySelector('#status-message').textContent, language === 'de' ? /ZIP speichern/ : /Save ZIP/);
  }
});

test('ZIP progress names packing and verification, shows literal entries and resets file progress between phases', t => {
  for (const language of ['de', 'en']) {
    const saved = state(), app = createApp(t, saved, { language });
    app.click(app.row('file.txt')); app.action('pack'); submit(app);
    const request = app.messages.find(message => message.type === 'zip-write');
    const send = progress => app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-progress', operationId: request.operationId, progress } }));
    send({ phase: 'packing', currentPath: 'docs/A & B.txt', transferred: 80, total: 100 });
    assert.equal(app.document.querySelector('#status-message').textContent, language === 'de' ? 'ZIP erstellen · docs/A & B.txt' : 'Create ZIP · docs/A & B.txt');
    assert.equal(app.document.querySelector('[data-current-file-path]').textContent, 'docs/A & B.txt');
    assert.match(app.document.querySelector('#status-message').title, /docs\/A & B.txt/);
    assert.equal(app.document.querySelector('#status-progress-file').getAttribute('aria-valuenow'), '80');
    send({ phase: 'verifying', currentPath: 'docs/A & B.txt', transferred: 0, total: 100, completedBytes: 0, totalBytes: 100 });
    assert.equal(app.document.querySelector('#status-message').textContent, language === 'de' ? 'Archiv prüfen · docs/A & B.txt' : 'Verify archive · docs/A & B.txt');
    assert.equal(app.document.querySelector('#status-progress-file').getAttribute('aria-valuenow'), '0');
    send({ phase: 'verifying', currentPath: 'empty.txt', transferred: 0, total: 0, completedBytes: 100, totalBytes: 100 });
    assert.match(app.document.querySelector('#status-message').textContent, /empty\.txt/);
    assert.equal(app.document.querySelector('#status-progress-file').style.width, '0%');
    assert.equal(app.document.querySelector('#status-progress-file').hasAttribute('aria-valuenow'), false);
    assert.match(app.document.querySelector('#status-progress-file').getAttribute('aria-valuetext'), language === 'de' ? /Hostbestätigung/ : /Host acknowledgment/);
    app.click(app.document.querySelector('#status-cancel'));
    assert.equal(app.messages.filter(message => message.type === 'filesystem-cancel').length, 1);
    assert.equal(app.document.querySelector('#status-message').textContent, language === 'de' ? 'Abbruch wird ausgeführt… · empty.txt' : 'Cancelling… · empty.txt');
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, ok: true, cancelled: true, archiveCommitted: true, notice: 'saved', state: saved } }));
    assert.equal(app.document.querySelector('#statusbar').dataset.statusProgressOwner, 'background');
    send({ phase: 'packing', currentPath: 'late.txt' });
    assert.equal(app.document.querySelector('#status-message').textContent, 'saved');
  }
});

test('explicit archive testing is labeled before its first progress event', t => {
  for (const language of ['de', 'en']) {
    const saved = state(); saved.folders['C:/tmp'][0] = { id: 'archive', name: 'test.zip', type: 'archive', fsSource: 'C:/tmp/test.zip' };
    const app = createApp(t, saved, { language }); app.click(app.row('test.zip')); app.action('test-archives');
    assert.ok(app.messages.find(message => message.type === 'zip-test'));
    assert.equal(app.document.querySelector('#status-message').textContent, language === 'de' ? 'Archiv wird geprüft…' : 'Verifying archive…');
  }
});

test('pack normalizes edited ZIP extensions before sending the target to the host', t => {
  for (const [entered, expected] of [['result', 'result.zip'], ['result.ZIP', 'result.ZIP'], ['report.backup', 'report.backup.zip']]) {
    const app = createApp(t, state()); app.click(app.row('file.txt')); app.action('pack');
    app.document.querySelector('#value').value = entered; submit(app);
    assert.equal(app.messages.find(message => message.type === 'zip-write')?.archive, `C:/temp/${expected}`);
  }
});

test('pack options have associated labels and separate checkbox rows in both languages', t => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  for (const language of ['de', 'en']) {
    const app = createApp(t, state(), { language }); app.click(app.row('file.txt')); app.action('pack');
    const style = app.document.createElement('style'); style.textContent = css; app.document.head.append(style);
    const groups = app.document.querySelectorAll('fieldset.zip-pack-group');
    assert.equal(groups.length, 2);
    assert.ok([...groups].every(group => group.querySelector('legend')?.textContent));
    for (const id of ['zip-level', 'zip-encryption']) assert.ok(app.document.querySelector(`label[for="${id}"]`));
    for (const id of ['zip-paths', 'zip-recursive', 'zip-move']) {
      const input = app.document.getElementById(id), label = input.closest('label.zip-pack-check');
      assert.ok(label); assert.ok(label.querySelector('span')?.textContent);
      assert.equal(label.querySelectorAll('input').length, 1);
      assert.equal(app.window.getComputedStyle(label).display, 'grid');
      assert.equal(app.window.getComputedStyle(input).width, '16px');
    }
  }
});
test('ZIP-F17/F18/F27 pack dialog is immediately usable and sends options without passwords', t => {
  const app = createApp(t, state()); app.click(app.row('file.txt')); app.action('pack');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.some(message => /zip-write|filesystem-prepare/.test(message.type)), false);
  app.document.querySelector('#value').value = 'C:/temp/result.zip';
  app.document.querySelector('#zip-encryption').value = 'aes256'; submit(app);
  const message = app.messages.find(message => message.type === 'zip-write');
  assert.ok(message); assert.equal(message.archive, 'C:/temp/result.zip'); assert.equal(message.encryption, 'aes256');
  assert.deepEqual([...message.ids], ['source']); assert.equal(Object.hasOwn(message, 'password'), false);
});
test('ZIP-F23 delete needs confirmation and does not optimistically remove the row', t => {
  const app = createApp(t, state(true)); app.click(app.row('file.txt')); app.action('delete');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.messages.some(message => message.type === 'zip-write'), false); submit(app);
  const message = app.messages.find(message => message.type === 'zip-write');
  assert.equal(message?.action, 'remove'); assert.ok(message.operationId); assert.ok(app.row('file.txt'));
  assert.equal(app.document.querySelector('#panes').inert, true);
  assert.equal(app.document.querySelectorAll('[data-job-row]').length, 0);
  assert.equal(app.document.querySelector('#status-cancel').hidden, false);
  app.click(app.document.querySelector('#status-cancel'));
  assert.equal(app.messages.find(item => item.type === 'filesystem-cancel')?.operationId, message.operationId);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
test('ZIP-F24 Shift F6 keeps inline editing and commits through the archive host operation', t => {
  const app = createApp(t, state(true)); app.click(app.row('file.txt')); app.action('rename-one');
  const input = app.document.querySelector('.inline-rename'); assert.ok(input); input.value = 'renamed.txt'; app.key('Enter', {}, input);
  const message = app.messages.find(message => message.type === 'zip-write');
  assert.equal(message?.action, 'rename'); assert.equal(message.name, 'renamed.txt');
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
test('ZIP-F10 unpack dialog exposes mask, paths and separate archive folders before running', t => {
  const saved = state(); saved.folders['C:/tmp'][0] = { id: 'archive', name: 'sample.zip', fsSource: 'C:/tmp/sample.zip', type: 'archive' };
  const app = createApp(t, saved); app.click(app.row('sample.zip')); app.action('unpack');
  assert.equal(app.document.querySelector('#modal').open, true);
  app.document.querySelector('#zip-filter').value = '*.txt'; app.document.querySelector('#zip-paths').checked = false;
  app.document.querySelector('#zip-separate').checked = true; submit(app);
  const request = app.messages.find(message => message.type === 'zip-unpack');
  assert.ok(request); assert.equal(request.filter, '*.txt'); assert.equal(request.paths, false); assert.equal(request.separate, true);
});
test('ZIP-F03 entry activation shows metadata without requesting content; F3 opens the selected entry', t => {
  const saved = state(true); saved.folders[saved.panes[0].tabs[0]][0].compressedSize = 2;
  const app = createApp(t, saved); app.click(app.row('file.txt')); app.key('Enter');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.match(app.document.querySelector('#modal-body').textContent, /file.txt/);
  assert.match(app.document.querySelector('#modal-body').textContent, /40 %/);
  assert.equal(app.messages.some(message => message.type === 'lister-open'), false);
  app.document.querySelector('#modal-cancel').click(); app.action('view');
  assert.ok(app.messages.find(message => message.type === 'lister-open'));
});
test('ZIP pack options use native configuration defaults and scoped pack-move command', t => {
  const app = createApp(t, state(), { fileSettings: { zip: { level: 0, paths: false, recursive: false } } });
  app.click(app.row('file.txt')); app.action('pack-move');
  assert.equal(app.document.querySelector('#zip-level')?.value, '0');
  assert.equal(app.document.querySelector('#zip-paths').checked, false);
  assert.equal(app.document.querySelector('#zip-move').checked, true);
  const manifest = require('../package.json');
  const binding = manifest.contributes.keybindings.find(item => item.command === 'bitfroest.pack-move');
  assert.equal(binding?.key, 'alt+shift+f5'); assert.match(binding.when, /listFocus.*!bitfroest.textInput/);
  const props = Object.assign({}, ...manifest.contributes.configuration.map(group => group.properties));
  assert.equal(props['bitfroest.zip.compressionLevel']?.type, 'integer');
});

test('ZIP-F17 edited pack destination takes effect when the opposite pane is inside an archive', t => {
  const saved = state(); saved.panes[1].tabs = [Object.keys(saved.archiveLocations)[0]];
  const app = createApp(t, saved); app.click(app.row('file.txt', 0)); app.action('copy');
  app.document.querySelector('#value').value = 'C:/temp/other.zip'; submit(app);
  const request = app.messages.find(message => message.type === 'zip-write');
  assert.equal(request.archive, 'C:/temp/other.zip'); assert.equal(request.path, undefined);
});

test('ZIP pack and extraction controls use the selected English interface language', t => {
  const app = createApp(t, state(), { language: 'en' }); app.click(app.row('file.txt')); app.action('pack');
  assert.match(app.document.querySelector('#modal-body').textContent, /Compression level/);
  assert.match(app.document.querySelector('#modal-body').textContent, /Encryption/);
  assert.doesNotMatch(app.document.querySelector('#modal-body').textContent, /Unterverzeichnisse|Quellen entfernen/);
});

test('ZIP-F25 F5 between archive panes starts a pack operation into the destination ZIP', t => {
  const saved = state(true), source = saved.panes[0].tabs[0], target = 'zip:C%3A%2Ftemp%2Ftarget.zip!';
  saved.panes[1].tabs = [target]; saved.folders[target] = []; saved.archiveLocations[target] = { archive: 'C:/temp/target.zip', parent: 'C:/temp' };
  const app = createApp(t, saved); app.click(app.row('file.txt', 0)); app.action('copy'); submit(app);
  const request = app.messages.find(message => message.type === 'zip-write');
  assert.equal(request?.path, target); assert.equal(request?.sourcePath, source); assert.equal(app.messages.some(message => message.type === 'zip-copy'), false);
});

test('ZIP post-pack cancellation displays that the archive was saved and releases the file list', t => {
  const saved = state(), app = createApp(t, saved); app.click(app.row('file.txt')); app.action('pack'); submit(app);
  const request = app.messages.find(message => message.type === 'zip-write'), notice = 'ZIP wurde gespeichert; Nachprüfung oder Quellentfernung wurde nicht abgeschlossen.';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, state: saved, ok: true, cancelled: true, archiveCommitted: true, notice } }));
  assert.equal(app.document.querySelector('#status-message').textContent, notice);
  assert.equal(app.document.querySelector('#panes').inert, false); assert.equal(app.document.querySelector('#status-cancel').hidden, true);
});

test('ZIP-F43 new text file opens its confirmed archive entry in the native editor', t => {
  const saved = state(true), source = saved.panes[0].tabs[0], app = createApp(t, saved); app.action('new-file');
  app.document.querySelector('#value').value = 'new.txt'; submit(app);
  const request = app.messages.find(message => message.type === 'zip-write'); assert.equal(app.messages.some(message => message.type === 'edit'), false);
  saved.folders[source].push({ id: 'new', name: 'new.txt', archive: 'C:/tmp/test.zip', archiveEntry: 'new.txt', fsSource: source + '/new.txt' });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', ok: true, operationId: request.operationId, state: saved } }));
  assert.equal(app.messages.find(message => message.type === 'edit')?.path, source + '/new.txt');
});

test('an unpack job opens an uncached target on the destination pane from its popup', t => {
  const saved = state(); saved.folders['C:/tmp'].push({ id: 'archive', name: 'test.zip', type: 'archive', fsSource: 'C:/tmp/test.zip', size: 10 });
  const app = createApp(t, saved); app.click(app.row('test.zip')); app.action('unpack');
  app.document.querySelector('#value').value = 'C:/custom-target'; submit(app);
  const request = app.messages.find(message => message.type === 'zip-unpack');
  assert.equal(request.target, 'C:/custom-target');
  app.click(app.document.querySelector('#jobs-toggle'));
  app.click(app.document.querySelector('#jobs-center .job-content'));
  const navigation = app.messages.filter(message => message.type === 'filesystem-navigate').at(-1);
  assert.equal(navigation.path, 'C:/custom-target');
  assert.equal(navigation.side, 1);
  assert.equal(app.messages.filter(message => message.type === 'zip-unpack').length, 1);
});
