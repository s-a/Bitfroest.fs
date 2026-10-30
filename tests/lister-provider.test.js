const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createListerProvider } = require('../lister-provider');

async function fixture(t, content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lister-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sample.bin');
  await fs.writeFile(file, content);
  const reads = [];
  const io = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    return { stat: (...a) => handle.stat(...a), close: () => handle.close(), async read(...a) { reads.push({ length: a[2], position: a[3] }); return handle.read(...a); } };
  } };
  const provider = createListerProvider({ fs: io, validate: value => value === file });
  t.after(() => provider.dispose());
  return { provider, file, reads };
}

test('lister opens a file model beyond 4 GiB with bounded reads and views its final bytes', async t => {
  const offset = 2 ** 32 + 8192;
  const reads = [];
  const stat = { size: offset + 4, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false };
  const provider = createListerProvider({ validate: () => true, fs: { lstat: async () => stat, open: async () => ({ stat: async () => stat, close: async () => {}, read: async (buffer, start, length, position) => {
    reads.push({ length, position });
    const count = Math.max(0, Math.min(length, stat.size - position)); buffer.fill(0, start, start + count);
    if (position === 0) buffer.write('Start\r\nText\r\n', start);
    if (position <= offset && position + count > offset) buffer.write('END!', start + offset - position);
    return { bytesRead: count };
  } }) } });
  t.after(() => provider.dispose());
  const opened = await provider.open('large.bin');
  assert.equal(opened.size, offset + 4);
  assert.match(opened.view.text, /Start/);
  assert.ok(reads.reduce((n, read) => n + read.length, 0) <= 2 * 196608);
  const end = await provider.view(opened.id, { position: offset, mode: 'hex' });
  assert.match(end.text, /45 4E 44 21/);
  assert.match(end.text, /100002000/);
  assert.ok(reads.every(read => read.length <= 196608));
  await assert.rejects(provider.copy(opened.id, { start: 0, end: offset }), /64 MiB/);
});

test('lister detects byte content rather than extensions and changes encodings without writing', async t => {
  const { provider, file } = await fixture(t, Buffer.from('\ufeffGrüße\r\nWelt\r\n', 'utf16le'));
  const opened = await provider.open(file);
  assert.equal(opened.mode, 'unicode');
  assert.match(opened.view.text, /Grüße/);
  const original = await fs.readFile(file);
  const hex = await provider.view(opened.id, { mode: 'hex', position: 0 });
  assert.match(hex.text, /FF FE/);
  assert.deepEqual(await fs.readFile(file), original);
  await assert.rejects(provider.open(path.join(path.dirname(file), 'other')), /Pfad/);
  await provider.close(opened.id);
  await assert.rejects(provider.view(opened.id, {}));
});

test('lister finds text and hex across read boundaries in both directions and copies the exact byte range', async t => {
  const bytes = Buffer.alloc(400000, 32);
  bytes.write('needle', 196605);
  bytes.write('needle', 300000);
  const { provider, file } = await fixture(t, bytes);
  const opened = await provider.open(file);
  const first = await provider.search(opened.id, { text: 'needle', position: 0, encoding: 'utf-8' });
  assert.deepEqual(first, { start: 196605, end: 196611 });
  const last = await provider.search(opened.id, { text: '"nee"646C65', hex: true, backward: true, position: opened.size });
  assert.deepEqual(last, { start: 300000, end: 300006 });
  assert.equal(await provider.copy(opened.id, { start: first.start, end: first.end, encoding: 'utf-8' }), 'needle');
  assert.equal(await provider.copy(opened.id, { start: first.start, end: first.start + 2, hex: true }), '6E 65');
  assert.equal(await provider.search(opened.id, { text: 'absent', position: 0 }), null);
  await assert.rejects(provider.search(opened.id, { text: 'GG', hex: true }), /Hex/);
});

test('lister regex search supports words, case, line anchors and a cancellable scan', async t => {
  const { provider, file } = await fixture(t, 'Prefix\r\nAlpha 42\r\nalphabet 99\r\nALPHA 7\r\n');
  const opened = await provider.open(file);
  const match = await provider.search(opened.id, { text: '^Alpha \\d+', regex: true, caseSensitive: true, encoding: 'utf-8', position: 0 });
  assert.deepEqual(match, { start: 8, end: 16 });
  const reverse = await provider.search(opened.id, { text: 'alpha', wholeWords: true, backward: true, position: opened.size, encoding: 'utf-8' });
  assert.deepEqual(reverse, { start: 31, end: 36 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.search(opened.id, { text: 'missing' }, controller.signal), { name: 'AbortError' });
  await assert.rejects(provider.search(opened.id, { text: '(', regex: true }), /regulär|regular|expression/i);
});

test('lister notices truncation, handles empty files, and releases every session on disposal', async t => {
  const { provider, file } = await fixture(t, 'one\ntwo\n');
  const opened = await provider.open(file);
  await fs.truncate(file, 0);
  await assert.rejects(provider.view(opened.id, {}), /verändert/);
  await provider.close(opened.id);
  const empty = await provider.open(file);
  assert.equal(empty.size, 0);
  assert.equal(empty.view.text, '');
  await provider.dispose();
  await assert.rejects(provider.view(empty.id, {}));
});

test('lister preserves multibyte characters between view windows and clipboard read blocks', async t => {
  const bytes = Buffer.concat([Buffer.alloc(32767, 65), Buffer.from('€'), Buffer.from('\nend\n')]);
  const { provider, file } = await fixture(t, bytes);
  const opened = await provider.open(file);
  const first = await provider.view(opened.id, { mode: 'utf8', position: 0, wrap: false });
  const next = await provider.view(opened.id, { mode: 'utf8', position: first.next, wrap: false });
  assert.equal((first.text + next.text).includes('\ufffd'), false);
  assert.equal((first.text + next.text).includes('€'), true);
  await provider.close(opened.id);
  const unicode = Buffer.concat([Buffer.alloc(196606, 0), Buffer.from('😀tail', 'utf16le')]);
  await fs.writeFile(file, unicode);
  const second = await provider.open(file);
  const copied = await provider.copy(second.id, { start: 0, end: unicode.length, mode: 'unicode' });
  assert.ok(copied.endsWith('😀tail'));
});

test('lister whole word search considers characters preceding the starting position', async t => {
  const { provider, file } = await fixture(t, 'xneedle\nend\n');
  const opened = await provider.open(file);
  assert.equal(await provider.search(opened.id, { text: 'needle', wholeWords: true, position: 1, encoding: 'utf-8' }), null);
});

test('a regex search refuses an oversized single line while text search still works', async t => {
  const { provider, file } = await fixture(t, Buffer.alloc(2 * 1024 * 1024, 65));
  const opened = await provider.open(file);
  await assert.rejects(provider.search(opened.id, { text: 'absent', regex: true, encoding: 'utf-8' }), /Regex.*1 MiB/);
  assert.deepEqual(await provider.search(opened.id, { text: 'AAAA', encoding: 'utf-8' }), { start: 0, end: 4 });
});

test('hex continuation does not repeat a previous match and regex lines cross blocks without duplicated bytes', async t => {
  const { provider, file } = await fixture(t, 'needle needle\n');
  const opened = await provider.open(file);
  assert.deepEqual(await provider.search(opened.id, { text: '6e6565646c65', hex: true, position: 6 }), { start: 7, end: 13 });
  await provider.close(opened.id);
  await fs.writeFile(file, 'a'.repeat(196608) + 'Z\n');
  const next = await provider.open(file);
  assert.deepEqual(await provider.search(next.id, { text: '^a{196608}Z$', regex: true, encoding: 'utf-8', position: 0 }), { start: 0, end: 196609 });
});

test('regex search retains a UTF8 character spanning a read block', async t => {
  const { provider, file } = await fixture(t, 'a'.repeat(196607) + '€Z\n');
  const opened = await provider.open(file);
  assert.deepEqual(await provider.search(opened.id, { text: '€Z$', regex: true, encoding: 'utf-8', position: 0 }), { start: 196607, end: 196611 });
});

test('reverse words and regex anchors use surrounding file context at the requested position', async t => {
  const { provider, file } = await fixture(t, 'needlex\n');
  const opened = await provider.open(file);
  assert.equal(await provider.search(opened.id, { text: 'needle', wholeWords: true, backward: true, position: 6, encoding: 'utf-8' }), null);
  await provider.close(opened.id); await fs.writeFile(file, 'xneedle\n');
  const next = await provider.open(file);
  assert.equal(await provider.search(next.id, { text: '^needle', regex: true, position: 1, encoding: 'utf-8' }), null);
});

test('seeking into the middle of a Unicode character aligns to the complete character', async t => {
  const { provider, file } = await fixture(t, 'a'.repeat(32767) + '€tail\n');
  const opened = await provider.open(file);
  const view = await provider.view(opened.id, { position: 32768, mode: 'utf8' });
  assert.equal(view.offset, 32767);
  assert.ok(view.text.startsWith('€'));
});

test('a running pathological regex can be cancelled without blocking subsequent views', async t => {
  const { provider, file } = await fixture(t, 'a'.repeat(20000) + '!\n');
  const opened = await provider.open(file), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(provider.search(opened.id, { text: '(a+)+$', regex: true, encoding: 'utf-8' }, controller.signal), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.equal((await provider.view(opened.id, { mode: 'hex' })).offset, 0);
});
