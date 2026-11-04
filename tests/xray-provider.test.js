const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createListerProvider } = require('../lister-provider');

test('X-Ray reads complete short, empty, UTF8 and UTF16 files regardless of extension', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const provider = createListerProvider({ validate: file => path.dirname(file) === dir });
  t.after(() => provider.dispose());
  for (const bytes of [Buffer.alloc(0), Buffer.from('{"a":1}'), Buffer.from('Grüße'), Buffer.from('Hello', 'utf16le'), Buffer.from([0xfe, 0xff, 0, 65])]) {
    const file = path.join(dir, 'unknown.bin'); await fs.writeFile(file, bytes);
    const progress = [];
    const result = await provider.fullText(file, { maxBytes: 100, onProgress: value => progress.push(value) });
    assert.equal(typeof result.text, 'string');
    assert.equal(result.bytes, bytes.length);
    assert.equal(progress.at(-1).current.completed, bytes.length);
  }
});

test('X-Ray rejects binary content, size overflow, cancellation and releases handles', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file.json');
  const provider = createListerProvider({ validate: value => value === file });
  t.after(() => provider.dispose());
  await fs.writeFile(file, Buffer.from([1, 2, 0, 3]));
  await assert.rejects(provider.fullText(file, { maxBytes: 100 }), /binary/i);
  await fs.writeFile(file, 'abc');
  await assert.rejects(provider.fullText(file, { maxBytes: 2 }), /limit/i);
  assert.equal((await provider.fullText(file, { maxBytes: 3 })).text, 'abc');
  await assert.rejects(provider.fullText(file, { maxBytes: 3, signal: AbortSignal.abort() }), { name: 'AbortError' });
  await fs.rename(file, path.join(dir, 'closed.txt'));
});

test('X-Ray detects file growth during reading and cancellation after a measured block', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'large.txt');
  const provider = createListerProvider({ validate: value => value === file });
  t.after(() => provider.dispose());
  const content = Buffer.alloc(5242880, 65); await fs.writeFile(file, content);
  const complete = await provider.fullText(file);
  assert.equal(complete.text.length, content.length);
  await assert.rejects(provider.fullText(file, { onProgress: progress => {
    if (progress.current.completed > 0) require('node:fs').appendFileSync(file, 'changed');
  } }), /verändert/);
  await fs.writeFile(file, content);
  const controller = new AbortController();
  await assert.rejects(provider.fullText(file, { signal: controller.signal, onProgress: progress => {
    if (progress.current.completed > 0) controller.abort();
  } }), { name: 'AbortError' });
});
