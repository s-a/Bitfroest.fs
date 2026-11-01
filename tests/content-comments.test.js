const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('comment streaming reports the bytes actually read against the opened file size', async t => {
  const { readDirectoryComments } = require('../content-comments');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const text = 'file.txt Notes\n'.repeat(10000), bytes = Buffer.byteLength(text);
  await fs.writeFile(path.join(directory, 'descript.ion'), text);
  const progress = [];
  await readDirectoryComments(directory, ['descript.ion', 'file.txt'], { onProgress: event => progress.push(event) });
  assert.ok(progress.length > 2);
  assert.equal(progress[0].current.completed, 0);
  assert.equal(progress.at(-1).current.completed, bytes);
  assert.ok(progress.every(event => event.current.unit === 'bytes' && event.current.total === bytes));
  assert.equal(progress[1].current.completed, 65536);
});

test('directory comments read Unicode, quoted names and marked escapes with deterministic precedence', async t => {
  const { readDirectoryComments } = require('../content-comments');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'column-comments-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'descript.ion'), '\ufeff"two words.dll" Erste\\nZweite\\\\Zeile\x04\u00c2\nplain.txt literal\\ntext\n');
  await fs.writeFile(path.join(directory, 'files.bbs'), 'plain.txt fallback\nother.txt More\n           continued\nghost.txt Unrelated\n');
  const result = await readDirectoryComments(directory, ['descript.ion', 'files.bbs', 'two words.dll', 'plain.txt', 'other.txt'], { platform: 'linux' });
  assert.equal(result.get('two words.dll'), 'Erste\nZweite\\Zeile');
  assert.equal(result.get('plain.txt'), 'literal\\ntext');
  assert.equal(result.get('other.txt'), 'More\ncontinued');
  assert.equal(result.has('ghost.txt'), false);
  await fs.writeFile(path.join(directory, 'descript.ion'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('"two words.dll" Grüße\r\n', 'utf16le')]));
  assert.equal((await readDirectoryComments(directory, ['descript.ion', 'two words.dll'], {})).get('two words.dll'), 'Grüße');
  await fs.writeFile(path.join(directory, 'descript.ion'), Buffer.from('plain.txt Gr\xfc\xdfe\n', 'latin1'));
  assert.equal((await readDirectoryComments(directory, ['descript.ion', 'plain.txt'], { encoding: 'windows-1252' })).get('plain.txt'), 'Grüße');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readDirectoryComments(directory, ['descript.ion'], { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal((await readDirectoryComments(directory, [], {})).size, 0);
});

test('comment reads release handles and discard replaced, unreadable and linked sources', async () => {
  const { readDirectoryComments } = require('../content-comments');
  const stat = { dev: 1, ino: 1, size: 16, mtimeMs: 1, ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false };
  function mock(options = {}) {
    let read = false, closed = 0, opens = 0;
    const handle = { async stat() { return stat; }, async read(buffer) { if (options.abort) options.abort.abort(); if (read) return { bytesRead: 0 }; read = true; return { bytesRead: buffer.write('file.txt Notes\n') }; }, async close() { closed++; } };
    const fs = { async lstat() { if (options.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return options.link ? { ...stat, isSymbolicLink: () => true } : read && options.replaced ? { ...stat, ino: 2 } : stat; }, async open() { opens++; return handle; } };
    return { fs, closed: () => closed, opens: () => opens };
  }
  for (const options of [{ replaced: true }, { denied: true }, { link: true }]) {
    const fixture = mock(options);
    assert.equal((await readDirectoryComments('/data', ['descript.ion'], { fs: fixture.fs })).size, 0);
    assert.equal(fixture.closed(), fixture.opens());
  }
  const abort = new AbortController(), fixture = mock({ abort });
  await assert.rejects(readDirectoryComments('/data', ['descript.ion'], { fs: fixture.fs, signal: abort.signal }), error => error.name === 'AbortError');
  assert.equal(fixture.closed(), 1);
});
