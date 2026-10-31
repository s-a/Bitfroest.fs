const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../media/commander-paths');

test('Windows paths use native display syntax and canonical internal separators', () => {
  assert.equal(paths.normalizePath('c:\\git\\zwork\\gb-src-mirror\\node-rpt'), 'c:/git/zwork/gb-src-mirror/node-rpt');
  assert.equal(paths.displayPath('c:/git/zwork/gb-src-mirror/node-rpt'), 'C:\\git\\zwork\\gb-src-mirror\\node-rpt');
  assert.equal(paths.normalizePath(paths.displayPath('c:/git/project')), 'C:/git/project');
  assert.equal(paths.normalizePath('"c:\\git\\project"', { input: true }), 'c:/git/project');
});

test('relative Windows inputs and root-relative inputs resolve against the current directory', () => {
  assert.equal(paths.normalizePath('..\\next\\.\\folder', { base: 'C:/git/project', input: true }), 'C:/git/next/folder');
  assert.equal(paths.normalizePath('\\temp\\child', { base: 'C:/git/project' }), 'C:/temp/child');
  assert.equal(paths.normalizePath('', { base: 'C:/git/project', input: true }), 'C:/git/project');
  assert.equal(paths.normalizePath('  "C:\\git\\project"  ', { input: true }), 'C:/git/project');
});

test('drive and UNC roots survive normalization and parent navigation', () => {
  assert.equal(paths.normalizePath('c:/'), 'c:/');
  assert.equal(paths.displayPath('c:/'), 'C:\\');
  assert.equal(paths.parentPath('c:/git'), 'c:/');
  assert.equal(paths.parentPath('C:/'), 'C:/');
  assert.equal(paths.normalizePath('\\\\server\\share\\folder\\..\\..\\..'), '//server/share');
  assert.equal(paths.parentPath('//server/share/folder'), '//server/share');
  assert.equal(paths.parentPath('//server/share'), '//server/share');
  assert.equal(paths.displayPath('//server/share/folder'), '\\\\server\\share\\folder');
});

test('POSIX paths retain case and filename backslashes without a Windows context', () => {
  assert.equal(paths.normalizePath('/home/person/../Other'), '/home/Other');
  assert.equal(paths.displayPath('/home/My Folder'), '/home/My Folder');
  assert.equal(paths.normalizePath('/home/back\\slash'), '/home/back\\slash');
  assert.equal(paths.normalizePath('../file', { base: '/home/person' }), '/home/file');
  assert.equal(paths.parentPath('/'), '/');
  assert.equal(paths.identity('/Home/File'), '/Home/File');
});

test('archive references preserve boundaries and opaque ZIP identifiers', () => {
  assert.equal(paths.normalizePath('c:\\data\\one.zip!\\folder\\..\\file.txt'), 'c:/data/one.zip!/file.txt');
  assert.equal(paths.displayPath('c:/data/one.zip!/folder/file.txt'), 'C:\\data\\one.zip!\\folder\\file.txt');
  assert.equal(paths.parentPath('C:/data/one.zip!/folder'), 'C:/data/one.zip!');
  assert.equal(paths.parentPath('C:/data/one.zip!'), 'C:/data');
  assert.equal(paths.normalizePath('zip:opaque-token!/folder/../child'), 'zip:opaque-token!/folder/../child');
  assert.equal(paths.displayPath('zip:opaque-token!/folder'), 'zip:opaque-token!/folder');
});

test('shared helpers compare Windows paths and join without corrupting roots', () => {
  assert.equal(paths.identity('c:\\Git\\Repo'), paths.identity('C:/git/repo'));
  assert.equal(paths.baseName('C:/git/project'), 'project');
  assert.equal(paths.joinPath('C:/', 'git'), 'C:/git');
  assert.equal(paths.joinPath('/home', 'person', 'file'), '/home/person/file');
  assert.equal(paths.isAbsolutePath('C:\\git'), true);
  assert.equal(paths.isAbsolutePath('C:git'), false);
  assert.equal(paths.isAbsolutePath('//server/share'), true);
});

test('ordinary exclamation marks and drive-relative inputs do not become archive or absolute paths', () => {
  assert.equal(paths.normalizePath('C:/git/project!notes/file.txt'), 'C:/git/project!notes/file.txt');
  assert.equal(paths.displayPath('/home/project!notes/file'), '/home/project!notes/file');
  assert.equal(paths.normalizePath('C:folder'), 'C:folder');
  assert.equal(paths.normalizePath('../../file'), '../../file');
});
