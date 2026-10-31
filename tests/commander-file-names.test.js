const test = require('node:test');
const assert = require('node:assert/strict');
const names = require('../media/commander-file-names');
const folders = () => ({ 'C:/tmp': [], 'C:/temp': [] });

test('folder creation plans intermediate directories and multiple absolute and relative targets', () => {
  const result = names.plan('docs\\drafts|C:\\temp\\exports', { base: 'C:/tmp', folders: folders(), kind: 'folder' });
  assert.deepEqual(result.paths, ['C:/tmp/docs/drafts', 'C:/temp/exports']);
  assert.deepEqual(result.directories, ['C:/tmp/docs', 'C:/tmp/docs/drafts', 'C:/temp/exports']);
  assert.equal(result.openEditor, false);
});

test('quoted file names create batches without opening the editor while a single file opens it', () => {
  const options = { base: 'C:/tmp', folders: folders(), kind: 'file' };
  assert.deepEqual(names.plan('"first notes.txt" "second.txt"', options).paths, ['C:/tmp/first notes.txt', 'C:/tmp/second.txt']);
  assert.equal(names.plan('one.txt|two.txt', options).openEditor, false);
  assert.equal(names.plan('single note.txt', options).openEditor, true);
});

test('counter and date masks use the dialog opening timestamp and cursor basename', () => {
  const options = { base: 'C:/tmp', folders: folders(), kind: 'folder', now: new Date(2026, 9, 29, 8, 7, 6), currentName: 'report.csv' };
  assert.deepEqual(names.plan('<5-7>[Y]-[M]-[D] [N] [C:3]', options).paths, ['C:/tmp/2026-10-29 report 005', 'C:/tmp/2026-10-29 report 006', 'C:/tmp/2026-10-29 report 007']);
  assert.equal(names.plan('<1-1>[C].txt', { ...options, kind: 'file' }).openEditor, false);
});

test('invalid batches are rejected before any model mutation', () => {
  const data = folders(), options = { base: 'C:/tmp', folders: data, kind: 'folder' };
  for (const input of ['', 'one||two', '"one"|', '../outside', 'C:/outside/new', 'one|one', '<5-1>[C]', '<1-1001>[C]', '<[Unknown]', '<1-2>[C]|other', 'bad:name']) assert.throws(() => names.plan(input, options), Error, input);
  assert.deepEqual(data, folders());
});

test('directory planning rejects existing file ancestors and targets but can reuse an existing folder', () => {
  const data = folders(); data['C:/tmp'].push({ name: 'file.txt', type: 'text' }, { name: 'existing', type: 'folder' }); data['C:/tmp/existing'] = [];
  const options = { base: 'C:/tmp', folders: data, kind: 'folder' };
  assert.throws(() => names.plan('file.txt/child', options));
  assert.throws(() => names.plan('file.txt', options));
  assert.throws(() => names.plan('existing', options));
  assert.deepEqual(names.plan('existing', { ...options, allowExisting: true }).directories, []);
});

test('ensureDirectories creates each missing ancestor once using the supplied factory', () => {
  const data = folders();
  const result = names.plan('a/b|a/c', { base: 'C:/tmp', folders: data, kind: 'folder' });
  names.ensureDirectories(data, result.directories, name => ({ name, type: 'folder' }));
  assert.deepEqual(data['C:/tmp'].map(row => row.name), ['a']);
  assert.deepEqual(data['C:/tmp/a'].map(row => row.name), ['b', 'c']);
});

test('Windows ancestor spelling is retained when the entered path uses different casing', () => {
  const data = folders();
  const result = names.plan('c:/TMP/new/nested', { base: 'C:/tmp', folders: data, kind: 'folder' });
  names.ensureDirectories(data, result.directories, name => ({ name, type: 'folder' }));
  assert.deepEqual(result.paths, ['C:/tmp/new/nested']);
  assert.ok(data['C:/tmp/new/nested']);
});

test('UNC directory planning preserves the known share root', () => {
  const result = names.plan('\\\\server\\share\\new\\nested', { base: '//server/share', folders: { '//server/share': [] }, kind: 'folder' });
  assert.deepEqual(result.paths, ['//server/share/new/nested']);
  assert.deepEqual(result.directories, ['//server/share/new', '//server/share/new/nested']);
});
