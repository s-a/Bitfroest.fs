const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationError, renderOperationError } = require('../operation-errors');
const { create } = require('../media/bitfroest-i18n');
const { maskOperationDetails } = require('../media/operation-report-masking');

test('operation details mask home, network and malformed URI paths without discarding lines', () => {
  const text = [
    'IDs: fs:/home/Casey/Docs/file.txt, fs:C:/Users/Some Name (Work)/Downloads/file.txt',
    'Folder: \\\\private-server\\private-share\\Subfolder (Work)\\Another folder',
    'URI: file:///c%3A/Users/Casey/Folder/item.txt',
    'URI: file:///home/Casey/Folder/item.txt',
    'Malformed URI: file:///home/Casey/Folder/%Z.txt',
    "Access denied at 'C:\\Users\\O'Connor\\Folder\\file.txt'",
    'The folder “/home/Casey” is unavailable.',
    'Code: EACCES'
  ].join('\n');
  const masked = maskOperationDetails(text);
  assert.doesNotMatch(masked, /casey|some name|private-server|private-share|file:\/\/\/|connor/i);
  assert.equal(masked, [
    'IDs: fs:.../Docs/file.txt, fs:.../Downloads/file.txt',
    'Folder: ...\\Subfolder (Work)\\Another folder',
    'URI: .../Folder/item.txt',
    'URI: .../Folder/item.txt',
    'Malformed URI: ...',
    "Access denied at '...\\Folder\\file.txt'",
    'The folder “...” is unavailable.',
    'Code: EACCES'
  ].join('\n'));
});

test('structured recovery errors localize only application parts and preserve paths', () => {
  const paths = ['C:/tmp/Neuer Ordner/Dateioperation fehlgeschlagen<&.stage'];
  const cause = new Error('Sicherungsdatei extern verändert.');
  const error = createOperationError('recovery-incomplete', { cause, paths });
  assert.equal(error.cause, cause);
  assert.match(error.message, /Wiederherstellung unvollständig/);
  assert.deepEqual(error.presentation.paths, paths);
  const english = renderOperationError(error, create('en').t);
  assert.match(english, /Recovery is incomplete/);
  assert.match(english, /A backup file changed externally/);
  assert.ok(english.includes(paths[0]));
  const german = renderOperationError(error, create('de').t);
  assert.match(german, /Wiederherstellung unvollständig/);
  assert.ok(german.includes(paths[0]));
});

test('cleanup errors distinguish completed work and retain unrecognized native details', () => {
  const native = new Error('Win32 32: Datei Neuer Ordner locked');
  const error = createOperationError('cleanup-failed', { cause: native, paths: ['C:/temp/Originalmeldung/content'] });
  const english = renderOperationError(error, create('en').t);
  assert.match(english, /operation completed/i);
  assert.match(english, /cleanup failed/i);
  assert.match(english, /Original error details/);
  assert.ok(english.includes(native.message));
  assert.ok(english.includes('C:/temp/Originalmeldung/content'));
});

test('nested structured errors and ordinary errors preserve their diagnostic messages', () => {
  const t = create('en').t;
  const inner = createOperationError('cleanup-failed', { cause: new Error('Sicherungsdatei extern verändert.'), paths: ['C:/tmp/inner'] });
  const outer = createOperationError('recovery-incomplete', { cause: inner, paths: ['C:/tmp/outer'] });
  assert.match(renderOperationError(outer, t), /Recovery is incomplete/);
  assert.match(renderOperationError(outer, t), /cleanup failed/i);
  assert.equal(renderOperationError(new Error('Sicherungsdatei extern verändert.'), t), 'A backup file changed externally.');
  assert.equal(renderOperationError(new Error('EACCES private name'), t), 'EACCES private name');
});

test('known native helper diagnostics are localized separately from unknown operating-system details', () => {
  for (const message of ['The source identity or metadata changed.', 'Reparse points are not permitted.', 'The path is outside the allowed roots.', 'Only a case change in the same directory is supported.']) {
    assert.notEqual(renderOperationError(new Error(message), create('de').t), message);
    assert.equal(renderOperationError(new Error(message), create('en').t), message === 'The path is outside the allowed roots.' ? 'The path is outside the permitted root directories.' : message);
  }
});
