const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodepageDecoder } = require('../lister-codepages');
const { createNativeApi } = require('../native-api');

const MAX_CHUNK = 1024 * 1024;

function createFakeApi(options = {}) {
  const sessions = [];
  const calls = [];
  const api = {
    openSession() {
      const session = {
        closed: false,
        invoke(operation, request) {
          calls.push({ operation, request, session });
          if (session.closed) return Promise.reject(Object.assign(new Error('Closed'), { code: 'SessionClosed' }));
          if (options.invoke) return options.invoke(operation, request, session, sessions.length - 1);
          if (operation === 'encoding.describe') return Promise.resolve({ codepage: 1252 });
          if (operation === 'encoding.decodeChunk') {
            const text = request.bytes.toString('latin1');
            const map = request.textOnly ? undefined : Array.from({ length: request.bytes.length }, (_, i) => request.offset + i);
            if (map && request.final) map.push(request.offset + request.bytes.length);
            return Promise.resolve({
              text,
              encoding: String(request.codepage),
              pending: Buffer.alloc(0),
              mapStart: request.offset + request.bytes.length,
              ...(map ? { map } : {})
            });
          }
          if (operation === 'encoding.decodeBlock') {
            const text = request.bytes.toString('latin1');
            const map = request.textOnly ? undefined : Array.from({ length: request.bytes.length + 1 }, (_, i) => request.offset + i);
            return Promise.resolve({ text, encoding: String(request.codepage), ...(map ? { map } : {}) });
          }
          return Promise.reject(Object.assign(new Error('Unknown operation'), { code: 'UnknownOperation' }));
        },
        close() {
          if (session.closed) return;
          session.closed = true;
          options.onClose?.(session, sessions.length - 1);
        }
      };
      sessions.push(session);
      return session;
    }
  };
  return { api, calls, sessions };
}

test('native fallback decodes numeric Windows codepages and preserves caller offsets', async t => {
  const fake = createFakeApi();
  const decoder = createCodepageDecoder({ apiFactory: () => fake.api });
  t.after(() => decoder.dispose());

  const result = await decoder.decode(Buffer.from([0x41, 0x80]), '37', 17);
  assert.equal(result.text, 'A\u0080');
  assert.deepEqual(result.map, [17, 18, 19]);
  assert.equal(result.encoding, '37');
  assert.equal(fake.calls[0].operation, 'encoding.decodeBlock');
});

test('large text and mapped decodes stream through bounded native chunks', async t => {
  const fake = createFakeApi();
  const decoder = createCodepageDecoder({ apiFactory: () => fake.api });
  t.after(() => decoder.dispose());
  const bytes = Buffer.alloc(MAX_CHUNK + 3, 0x41);
  bytes[1] = 0x80;
  const offset = 700;

  const textOnly = await decoder.decode(bytes, '0', offset, true);
  assert.equal(textOnly.text.length, bytes.length);
  assert.equal(textOnly.map, undefined);
  assert.deepEqual(fake.calls.map(call => call.operation), [
    'encoding.describe', 'encoding.decodeChunk', 'encoding.decodeChunk'
  ]);
  const chunks = fake.calls.filter(call => call.operation === 'encoding.decodeChunk');
  assert.deepEqual(chunks.map(call => call.request.bytes.length), [MAX_CHUNK, 3]);
  assert.deepEqual(chunks.map(call => call.request.final), [false, true]);
  assert.ok(chunks.every(call => call.request.codepage === 1252));

  const mapped = await decoder.decode(bytes, '0', offset, false);
  assert.equal(mapped.text.length, bytes.length);
  assert.equal(mapped.map.length, bytes.length + 1);
  assert.equal(mapped.map[0], offset);
  assert.equal(mapped.map[MAX_CHUNK], offset + MAX_CHUNK);
  assert.equal(mapped.map.at(-1), offset + bytes.length);
});

test('decoder timeout closes the native session and a later request opens a fresh one', async t => {
  let calls = 0, closes = 0;
  const fake = createFakeApi({
    onClose: () => { closes++; },
    invoke(operation, request) {
      if (operation !== 'encoding.decodeBlock') throw new Error(`Unexpected operation ${operation}`);
      calls++;
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve({ text: '€', encoding: String(request.codepage), map: [0, 1] });
    }
  });
  const decoder = createCodepageDecoder({ apiFactory: () => fake.api, timeoutMs: 20 });
  t.after(() => decoder.dispose());

  await assert.rejects(decoder.decode(Buffer.from([0x80]), '0'), /Zeitlimit/);
  assert.equal(closes, 1);
  assert.equal((await decoder.decode(Buffer.from([0x80]), '0')).text, '€');
  assert.equal(fake.sessions.length, 2);
});

test('dispose immediately cancels an active native decoder request', async () => {
  const fake = createFakeApi({ invoke: () => new Promise(() => {}) });
  const decoder = createCodepageDecoder({ apiFactory: () => fake.api });
  const pending = decoder.decode(Buffer.from([0x80]), '0');
  await new Promise(resolve => setImmediate(resolve));
  decoder.dispose();
  await assert.rejects(pending, /Decoder ist geschlossen/);
  assert.equal(fake.sessions[0].closed, true);
});

test('native GB18030 adapter preserves maps when an invalid reprocessing prefix crosses the one MiB boundary', { skip: process.platform !== 'win32' }, async t => {
  const bindingPath = process.env.NATIVE_BINDING_TEST_PATH;
  assert.ok(bindingPath, 'NATIVE_BINDING_TEST_PATH must point to the external native build');
  const api = createNativeApi(require(bindingPath));
  const decoder = createCodepageDecoder({ apiFactory: () => api });
  t.after(() => decoder.dispose());
  const bytes = Buffer.alloc(MAX_CHUNK + 3, 0x41);
  bytes[MAX_CHUNK - 4] = 0x81;
  bytes[MAX_CHUNK - 3] = 0x30;
  bytes[MAX_CHUNK - 2] = 0x80;
  bytes[MAX_CHUNK - 1] = 0xa1;
  bytes[MAX_CHUNK] = 0xb3;
  const expectedText = `${'A'.repeat(MAX_CHUNK - 4)}?0?〕AA`;
  const offset = 29;

  const result = await decoder.decode(bytes, '54936', offset);
  assert.equal(result.text, expectedText);
  assert.equal(result.map.length, expectedText.length + 1);
  assert.deepEqual(result.map.slice(0, MAX_CHUNK - 4), Array.from({ length: MAX_CHUNK - 4 }, (_, index) => offset + index));
  assert.deepEqual(result.map.slice(MAX_CHUNK - 4, MAX_CHUNK - 1), Array(3).fill(offset + MAX_CHUNK - 4));
  assert.equal(result.map[MAX_CHUNK - 1], offset + MAX_CHUNK);
  assert.equal(result.map[MAX_CHUNK], offset + MAX_CHUNK + 1);
  assert.equal(result.map[MAX_CHUNK + 1], offset + MAX_CHUNK + 2);
  assert.equal(result.map.at(-1), offset + bytes.length);
  assert.equal(await decoder.text(bytes, '54936'), expectedText);
});
