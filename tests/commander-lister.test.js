const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../media/commander-lister');

test('HTML text exposes links as data while stripping tags and decoding entity text', () => {
  const bytes = Buffer.from('<h1>Title</h1><a href="next.txt">Next &amp; more</a><a href="https://example.org/">External</a>');
  const view = core.format(bytes, core.decode(bytes), { mode: 'html' });
  assert.doesNotMatch(view.text, /<h1>|<a/);
  assert.match(view.text, /Next & more/);
  assert.deepEqual(view.links.map(item => item.href), ['next.txt', 'https://example.org/']);
});

test('automatic UTF8 recognition accepts a sample ending within a multibyte sequence', () => {
  const bytes = Buffer.concat([Buffer.from('first\nsecond\n'), Buffer.from([0xe2, 0x82])]);
  assert.equal(core.detect(bytes).encoding, 'utf-8');
});
