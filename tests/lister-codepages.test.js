const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodepageDecoder } = require('../lister-codepages');
const core = require('../media/commander-lister');

test('Windows lister decoder reuses its worker for DOS, Mac, local aliases and manual codepages', { skip: process.platform !== 'win32' }, async t => {
  const decoder = createCodepageDecoder(); t.after(() => decoder.dispose());
  assert.equal((await decoder.decode(Buffer.from([0x82]), '437')).text, 'é');
  assert.equal((await decoder.decode(Buffer.from([0x9b]), '850')).text, 'ø');
  assert.equal((await decoder.decode(Buffer.from([0x8e]), '2')).text, 'é');
  assert.equal((await decoder.decode(Buffer.from([0x82, 0xa0]), '932')).text, 'あ');
  assert.equal((await decoder.decode(Buffer.from([0xd6, 0xd0]), '936')).text, '中');
  for (const codepage of core.codepages) {
    const result = await decoder.decode(Buffer.from([65, 0x80]), String(codepage));
    assert.ok(result.text.startsWith('A'), String(codepage));
    assert.equal(result.map.at(-1), 2);
  }
  assert.equal((await decoder.decode(Buffer.from([0xc1]), '37')).text, 'A');
  await assert.rejects(decoder.decode(Buffer.from([1]), '65535'));
});

test('lister decoder maps UTF8 and UTF16 supplementary characters to their original byte ranges', async t => {
  const decoder = createCodepageDecoder(); t.after(() => decoder.dispose());
  for (const encoding of ['utf-8', 'utf-16le']) {
    const bytes = Buffer.from('A😀€Z', encoding === 'utf-8' ? 'utf8' : 'utf16le');
    const result = await decoder.decode(bytes, encoding, 100);
    assert.equal(result.text, 'A😀€Z');
    assert.equal(result.map.length, result.text.length + 1);
    assert.equal(result.map[1], result.map[2]);
    assert.equal(result.map.at(-1), bytes.length + 100);
  }
});

test('stateful manual codepages report an explicit range-decoding limitation', async t => {
  const decoder = createCodepageDecoder(); t.after(() => decoder.dispose());
  await assert.rejects(decoder.decode(Buffer.from('+AAA-'), '65000'), /zustandsbehaftete/i);
});
