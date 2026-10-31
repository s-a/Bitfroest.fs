const test = require('node:test');
const assert = require('node:assert/strict');
const { createSelectionIO } = require('../selection-io');
function harness(options = {}) {
  const calls = [], destination = { scheme: 'file', fsPath: '/selection.txt' };
  const api = {
    window: { showSaveDialog: async () => options.cancel ? undefined : destination, showOpenDialog: async () => options.cancel ? undefined : [destination] },
    workspace: { fs: {
      writeFile: async (uri, bytes) => calls.push({ uri, bytes: Buffer.from(bytes) }),
      stat: async () => ({ size: options.size || options.bytes?.length || 0 }),
      readFile: async () => { if (options.error) throw new Error('Read failed'); return options.bytes || Buffer.alloc(0); }
    } }, env: { clipboard: { writeText: async text => calls.push({ text }) } }
  };
  return { io: createSelectionIO(api, value => value, options.active, options.resolvePaths), calls, api };
}
test('selection file save writes UTF-16LE with BOM and copies remain plain text', async () => {
  const { io, calls } = harness();
  assert.deepEqual(await io('save', 'Ä.txt\r\nb.txt'), { ok: true });
  assert.equal(calls[0].bytes.subarray(0, 2).toString('hex'), 'fffe');
  assert.equal(calls[0].bytes.subarray(2).toString('utf16le'), 'Ä.txt\r\nb.txt');
  await io('copy', 'Ä.txt'); assert.deepEqual(calls[1], { text: 'Ä.txt' });
});
test('selection file load decodes UTF-16, UTF-8 and legacy ANSI including final unterminated lines', async () => {
  for (const bytes of [Buffer.from('\ufeffÄ.txt\r\nb.txt', 'utf16le'), Buffer.from('Ä.txt\r\nb.txt'), Buffer.from([0xc4, 46, 116, 120, 116, 13, 10, 98, 46, 116, 120, 116])]) {
    assert.deepEqual(await harness({ bytes }).io('load'), { ok: true, text: 'Ä.txt\r\nb.txt' });
  }
  assert.equal((await harness({ bytes: Buffer.from([0xfe, 0xff, 0x00, 0xc4, 0x00, 0x2e, 0x00, 0x74]) }).io('load')).text, 'Ä.t');
});
test('cancellation, malformed requests and import errors do not write files', async () => {
  const cancelled = harness({ cancel: true });
  assert.deepEqual(await cancelled.io('save', 'a'), { ok: true, cancelled: true });
  assert.deepEqual(await cancelled.io('load'), { ok: true, cancelled: true });
  await assert.rejects(cancelled.io('unknown', 'a'));
  await assert.rejects(cancelled.io('copy', {}));
  await assert.rejects(harness({ error: true }).io('load'), /Read failed/);
  await assert.rejects(harness({ size: 20 * 1024 * 1024 }).io('load'));
  assert.equal(cancelled.calls.length, 0);
});

test('path copy resolves only structured path ranges and preserves detail cells and row order', async () => {
  const text = 'Z:\\a.txt\t12 B\r\nZ:\\b.txt\t20 B';
  const second = text.indexOf('Z:', 1), requests = [];
  const { io, calls } = harness({ resolvePaths: async paths => { requests.push(paths); return paths.map(value => value.replace('Z:', '\\\\files\\team')); } });
  await io('copy', text, [{ start: 0, length: 8 }, { start: second, length: 8 }]);
  assert.deepEqual(requests, [['Z:\\a.txt', 'Z:\\b.txt']]);
  assert.equal(calls[0].text, '\\\\files\\team\\a.txt\t12 B\r\n\\\\files\\team\\b.txt\t20 B');
  await io('copy', 'Z:\\name.txt'); assert.equal(requests.length, 1, 'plain name copies are not resolved');
});
test('invalid path ranges cannot write text and disposal during resolution cancels the copy', async () => {
  const app = harness();
  for (const ranges of [[{ start: -1, length: 2 }], [{ start: 2, length: 40 }], [{ start: 0, length: 3 }, { start: 1, length: 3 }], 'invalid']) {
    await assert.rejects(app.io('copy', 'Z:\\a.txt', ranges));
  }
  assert.equal(app.calls.length, 0);
  let active = true;
  const disposed = harness({ active: () => active, resolvePaths: async paths => { active = false; return paths; } });
  assert.deepEqual(await disposed.io('copy', 'Z:\\a.txt', [{ start: 0, length: 8 }]), { ok: true, cancelled: true });
  assert.equal(disposed.calls.length, 0);
});
