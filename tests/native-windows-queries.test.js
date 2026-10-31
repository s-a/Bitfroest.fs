const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' };
function session() { return require(binary).openSession(); }

test('native codepage output and byte maps match established decoder vectors', windows, async () => {
  const vectors = require('./fixtures/native-codepage-vectors.json');
  const s = session();
  try {
    for (const vector of vectors) {
      const actual = await s.invoke('encoding.decodeBlock', { codepage: vector.codepage, bytes: Buffer.from(vector.bytes, 'base64') });
      assert.equal(actual.text, vector.text, `text for codepage ${vector.codepage}, bytes ${vector.bytes}`);
      assert.deepEqual(actual.map, vector.map, `byte map for codepage ${vector.codepage}, bytes ${vector.bytes}`);
    }
  } finally { s.close(); }
});

test('network lookup reads only requested drive roots and preserves unmapped roots', windows, async () => {
  const s = session();
  try {
    const drive = path.parse(__filename).root.slice(0, 2).toUpperCase();
    const result = await s.invoke('paths.resolveNetwork', { drives: [drive.toLowerCase(), drive] });
    assert.deepEqual(result.mappings, { [drive]: null });
    assert.deepEqual((await s.invoke('paths.resolveNetwork', { drives: [] })).mappings, {});
    for (const drives of [null, 'C:', ['C:\\file'], ['\\\\server\\share'], ['C:\0'], Array(27).fill('C:')]) {
      assert.throws(() => s.invoke('paths.resolveNetwork', { drives }), { code: 'InvalidRequest' });
    }
  } finally { s.close(); }
});

test('codepage descriptions resolve system aliases without changing system settings', windows, async () => {
  const s = session();
  try {
    const fixed = await s.invoke('encoding.describe', { codepage: 1252 });
    assert.equal(fixed.codepage, 1252);
    assert.equal(fixed.maxCharSize, 1);
    assert.equal(typeof fixed.name, 'string');
    for (const codepage of [0, 1, 2]) {
      const info = await s.invoke('encoding.describe', { codepage });
      assert.ok(info.codepage > 2);
      if (info.blockDecoding) {
        const alias = await s.invoke('encoding.decodeBlock', { codepage, bytes: Buffer.from([65, 0x80]) });
        const explicit = await s.invoke('encoding.decodeBlock', { codepage: info.codepage, bytes: Buffer.from([65, 0x80]) });
        assert.deepEqual(alias, explicit);
      }
    }
    assert.equal((await s.invoke('encoding.describe', { codepage: 65001 })).blockDecoding, true);
    const gb18030 = await s.invoke('encoding.describe', { codepage: 54936 });
    assert.equal(gb18030.maxCharSize, 4);
    assert.equal(gb18030.blockDecoding, true);
    await assert.rejects(s.invoke('encoding.describe', { codepage: 65535 }), { code: 'UnsupportedEncoding' });
    for (const codepage of [-1, 1.5, '1252', null, NaN, 4294967296]) {
      assert.throws(() => s.invoke('encoding.describe', { codepage }), { code: 'InvalidRequest' });
    }
  } finally { s.close(); }
});

test('native decoding preserves single-byte text, embedded nulls, offsets and terminal mapping', windows, async () => {
  const s = session();
  try {
    const result = await s.invoke('encoding.decodeBlock', { codepage: 1252, bytes: Buffer.from([0x41, 0x80, 0, 0xe4]), offset: 17 });
    assert.equal(result.text, 'A€\0ä');
    assert.deepEqual(result.map, [17, 18, 19, 20, 21]);
    assert.equal(result.encoding, '1252');
    const empty = await s.invoke('encoding.decodeBlock', { codepage: 1252, bytes: Buffer.alloc(0), offset: 9 });
    assert.deepEqual(empty.map, [9]);
    assert.equal(empty.text, '');
    const text = await s.invoke('encoding.decodeBlock', { codepage: 1252, bytes: Buffer.from([0x80]), textOnly: true });
    assert.equal(text.text, '€');
    assert.equal(text.map, undefined);
  } finally { s.close(); }
});

test('double-byte decoding retains byte-to-UTF16 positions including trailing lead bytes', windows, async () => {
  const s = session();
  try {
    const result = await s.invoke('encoding.decodeBlock', { codepage: 932, bytes: Buffer.from([0x41, 0x82, 0xa0, 0x42]), offset: 100 });
    assert.equal(result.text, 'AあB');
    assert.deepEqual(result.map, [100, 101, 103, 104]);
    const tail = await s.invoke('encoding.decodeBlock', { codepage: 932, bytes: Buffer.from([0x82]) });
    assert.equal(tail.text, '・');
    assert.deepEqual(tail.map, [0, 1]);
  } finally { s.close(); }
});

test('decoding rejects unsupported state and unsafe or oversized requests explicitly', windows, async () => {
  const s = session();
  try {
    for (const codepage of [50220, 52936, 65000, 57002]) {
      await assert.rejects(s.invoke('encoding.decodeBlock', { codepage, bytes: Buffer.from('A') }), { code: 'UnsupportedEncoding' });
    }
    for (const request of [null, {}, { codepage: 1252, bytes: 'QQ==' }, { codepage: 1252, bytes: Buffer.alloc(1048577) }, { codepage: 1252, bytes: Buffer.from('A'), offset: -1 }, { codepage: 1252, bytes: Buffer.from('A'), offset: Number.MAX_SAFE_INTEGER }]) {
      assert.throws(() => s.invoke('encoding.decodeBlock', request), { code: 'InvalidRequest' });
    }
    const pending = s.invoke('encoding.decodeBlock', { codepage: 1252, bytes: Buffer.alloc(1024) });
    s.close();
    await assert.rejects(pending, { code: 'SessionClosed' });
  } finally { s.close(); }
});

test('native UTF8 matches established incremental decoder text and UTF16 byte maps', windows, async () => {
  const s = session();
  try {
    for (const vector of require('./fixtures/native-utf8-vectors.json')) {
      const bytes = Buffer.from(vector.bytes, 'base64');
      const result = await s.invoke('encoding.decodeBlock', { codepage: 65001, bytes, offset: 100 });
      assert.equal(result.text, vector.text, `text: ${vector.bytes}`);
      assert.deepEqual(result.map, vector.map.map(index => index + 100), `map: ${vector.bytes}`);
      assert.equal(result.encoding, '65001');
      const textOnly = await s.invoke('encoding.decodeBlock', { codepage: 65001, bytes, textOnly: true });
      assert.equal(textOnly.text, vector.text);
      assert.equal(textOnly.map, undefined);
    }
  } finally { s.close(); }
});

test('native GB18030 matches established incremental decoder text and UTF16 byte maps', windows, async () => {
  const s = session();
  try {
    for (const vector of require('./fixtures/native-gb18030-vectors.json')) {
      const bytes = Buffer.from(vector.bytes, 'base64');
      const result = await s.invoke('encoding.decodeBlock', { codepage: vector.codepage, bytes, offset: 100 });
      assert.equal(result.text, vector.text, `${vector.name} text`);
      assert.deepEqual(result.map, vector.map.map(index => index + 100), `${vector.name} byte map`);
      assert.equal(result.encoding, '54936');
      const textOnly = await s.invoke('encoding.decodeBlock', { codepage: vector.codepage, bytes, textOnly: true });
      assert.equal(textOnly.text, vector.text, `${vector.name} textOnly`);
      assert.equal(textOnly.map, undefined, `${vector.name} textOnly map`);
    }
  } finally { s.close(); }
});

test('native GB18030 matches adversarial incremental decoder vectors', windows, async () => {
  const s = session();
  try {
    const failures = [];
    const vectors = require('./fixtures/native-gb18030-adversarial-vectors.json');
    for (const [index, vector] of vectors.entries()) {
      const result = await s.invoke('encoding.decodeBlock', { codepage: 54936, bytes: Buffer.from(vector.bytes, 'base64'), offset: 5 });
      const expectedMap = vector.map.map(position => position + 5);
      if (result.text !== vector.text || JSON.stringify(result.map) !== JSON.stringify(expectedMap)) {
        failures.push({ index, bytes: vector.bytes, textMatches: result.text === vector.text, mapMatches: JSON.stringify(result.map) === JSON.stringify(expectedMap) });
      }
    }
    assert.equal(failures.length, 0, `${failures.length}/${vectors.length} GB18030 vectors differed: ${JSON.stringify(failures.slice(0, 8))}`);
  } finally { s.close(); }
});

test('native decode chunks preserve decoder state and absolute UTF16 maps across every byte split', windows, async () => {
  const s = session();
  const cases = [
    { codepage: 65001, bytes: Buffer.from([0x41, 0xf0, 0x9f, 0x98, 0x80, 0xe2, 0x82, 0x41, 0x42]) },
    { codepage: 932, bytes: Buffer.from([0x41, 0x82, 0xa0, 0x82, 0x20, 0x42, 0x82]) },
    { codepage: 54936, bytes: Buffer.from('gTCAobMvBWemDwbxygcKDA==', 'base64') }
  ];
  try {
    for (const vector of cases) {
      const offset = 37;
      const expected = await s.invoke('encoding.decodeBlock', { ...vector, offset });
      for (let split = 1; split < vector.bytes.length; split++) {
        const first = await s.invoke('encoding.decodeChunk', {
          codepage: vector.codepage,
          bytes: vector.bytes.subarray(0, split),
          pending: Buffer.alloc(0),
          offset,
          mapStart: offset,
          final: false
        });
        assert.equal(first.map.length, first.text.length, `non-final map length at split ${split}`);
        const second = await s.invoke('encoding.decodeChunk', {
          codepage: vector.codepage,
          bytes: vector.bytes.subarray(split),
          pending: first.pending,
          offset: offset + split,
          mapStart: first.mapStart,
          final: true
        });
        assert.deepEqual(first.pending.length <= 3, true, `bounded pending state at split ${split}`);
        assert.equal(first.text + second.text, expected.text, `text at split ${split}, codepage ${vector.codepage}`);
        assert.deepEqual([...first.map, ...second.map], expected.map, `map at split ${split}, codepage ${vector.codepage}`);
        assert.equal(second.pending.length, 0, `final pending state at split ${split}`);
      }
    }
  } finally { s.close(); }
});

test('native GB18030 carries all adversarial replacement and reprocessing states across chunk boundaries', windows, async () => {
  const s = session();
  const vectors = require('./fixtures/native-gb18030-adversarial-vectors.json');
  const offset = 5;
  try {
    for (const [vectorIndex, vector] of vectors.entries()) {
      const bytes = Buffer.from(vector.bytes, 'base64');
      for (let split = 1; split < bytes.length; split++) {
        const first = await s.invoke('encoding.decodeChunk', {
          codepage: 54936, bytes: bytes.subarray(0, split), pending: Buffer.alloc(0),
          offset, mapStart: offset, final: false
        });
        const second = await s.invoke('encoding.decodeChunk', {
          codepage: 54936, bytes: bytes.subarray(split), pending: first.pending,
          offset: offset + split, mapStart: first.mapStart, final: true
        });
        assert.equal(first.pending.length <= 3, true, `carry length at vector ${vectorIndex}, split ${split}`);
        assert.equal(first.text + second.text, vector.text, `text at vector ${vectorIndex}, split ${split}`);
        assert.deepEqual([...first.map, ...second.map], vector.map.map(position => position + offset), `map at vector ${vectorIndex}, split ${split}`);
        assert.equal(second.pending.length, 0, `final carry at vector ${vectorIndex}, split ${split}`);
      }
    }
  } finally { s.close(); }
});

test('concurrent native queries retain their own payloads and copy caller-owned buffers', windows, async () => {
  const s = session();
  try {
    const bytes = Buffer.from([0x80]);
    const first = s.invoke('encoding.decodeBlock', { codepage: 1252, bytes });
    bytes[0] = 0x41;
    const results = await Promise.all([first, ...Array.from({ length: 20 }, (_, index) => s.invoke('encoding.decodeBlock', { codepage: 1252, bytes: Buffer.from([65 + index]), offset: index }))]);
    assert.equal(results[0].text, '€');
    for (let index = 0; index < 20; index++) {
      assert.equal(results[index + 1].text, String.fromCharCode(65 + index));
      assert.deepEqual(results[index + 1].map, [index, index + 1]);
    }
  } finally { s.close(); }
});
