const test = require('node:test');
const assert = require('node:assert/strict');

test('font glyphs retain their designed em padding without being enlarged to their contour bounds', () => {
  const fit = require('../scripts/icon-metrics.cjs').fitIcon({ xMin: 0, yMin: 0, xMax: 263, yMax: 263 }, 300);
  assert.equal(fit.fontScale, 1);
  assert.ok(263 * 16 / 300 < 16);
});

test('bundled font glyphs produce centered, scalable CSS before the first render', () => {
  const fs = require('node:fs');
  const { generateIconCss } = require('../scripts/generate-icon-metrics.cjs');
  const source = fs.readFileSync(require.resolve('../media/codicons.css'), 'utf8');
  const font = fs.readFileSync(require.resolve('../media/codicon.ttf'));
  const css = generateIconCss(source, font);
  assert.match(css, /ascent-override:100%;descent-override:0%;line-gap-override:0%/);
  assert.match(css, /\.icon-font::before\{[^}]*position:absolute/);
  assert.match(css, /\.icon-font::before\{[^}]*height:1em/);
  assert.match(css, /\.icon-font::before\{[^}]*font-synthesis:none/);
  assert.doesNotMatch(css, /color:|background:|overflow:hidden/);
  for (const name of ['refresh', 'loading', 'star-empty', 'arrow-right', 'eye-closed']) {
    assert.match(css, new RegExp(`\\.codicon-${name}::before\\{font-size:calc\\(var\\(--icon-size, 16px\\) \\* [\\d.]+\\);left:calc\\(`));
  }
  assert.equal(fs.readFileSync(require.resolve('../media/icon-metrics.css'), 'utf8').replaceAll('\r\n', '\n'), css);
  assert.match(source, /@import url\(['"]?\.\/icon-metrics\.css['"]?\)/);
  assert.match(source, /width: var\(--icon-size, 16px\)/);
  assert.match(source, /height: var\(--icon-size, 16px\)/);
});

test('unknown or empty glyphs and invalid font data fail the build instead of producing a fallback', () => {
  const fs = require('node:fs');
  const { readGlyph } = require('../scripts/true-type-metrics.cjs');
  const font = fs.readFileSync(require.resolve('../media/codicon.ttf'));
  for (const code of [0x10ffff, 32]) assert.throws(() => readGlyph(font, code), /glyph/i);
  assert.throws(() => readGlyph(Buffer.from('invalid font'), 0xea6a), /font|table/i);
});

function metricFont(format, longLocations, indirect) {
  const head = Buffer.alloc(54), maxp = Buffer.alloc(6), hhea = Buffer.alloc(36), hmtx = Buffer.alloc(6), glyf = Buffer.alloc(10);
  head.writeUInt16BE(1000, 18); head.writeInt16BE(longLocations ? 1 : 0, 50);
  maxp.writeUInt16BE(2, 4); hhea.writeUInt16BE(1, 34);
  hmtx.writeUInt16BE(1000, 0); hmtx.writeInt16BE(-100, 4);
  glyf.writeInt16BE(1, 0); glyf.writeInt16BE(200, 2); glyf.writeInt16BE(-200, 4); glyf.writeInt16BE(600, 6); glyf.writeInt16BE(800, 8);
  const loca = Buffer.alloc(longLocations ? 12 : 6);
  if (longLocations) loca.writeUInt32BE(10, 8); else loca.writeUInt16BE(5, 4);
  const codePoint = format === 12 ? 0x1f600 : 0xe001;
  const mapping = Buffer.alloc(format === 12 ? 28 : indirect ? 34 : 32);
  mapping.writeUInt16BE(format, 0);
  if (format === 12) {
    mapping.writeUInt32BE(28, 4); mapping.writeUInt32BE(1, 12);
    mapping.writeUInt32BE(codePoint, 16); mapping.writeUInt32BE(codePoint, 20); mapping.writeUInt32BE(1, 24);
  } else {
    mapping.writeUInt16BE(mapping.length, 2); mapping.writeUInt16BE(4, 6);
    mapping.writeUInt16BE(codePoint, 14); mapping.writeUInt16BE(0xffff, 16);
    mapping.writeUInt16BE(codePoint, 20); mapping.writeUInt16BE(0xffff, 22);
    mapping.writeUInt16BE(indirect ? 0xfffe : (1 - codePoint) & 0xffff, 24); mapping.writeUInt16BE(1, 26);
    if (indirect) { mapping.writeUInt16BE(4, 28); mapping.writeUInt16BE(3, 32); }
  }
  const cmap = Buffer.alloc(12 + mapping.length);
  cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(format === 12 ? 10 : 1, 6); cmap.writeUInt32BE(12, 8); mapping.copy(cmap, 12);
  const tables = { head, maxp, hhea, hmtx, glyf, loca, cmap }, directory = Buffer.alloc(12 + 16 * Object.keys(tables).length);
  directory.writeUInt32BE(0x00010000); directory.writeUInt16BE(7, 4);
  const chunks = [directory]; let offset = directory.length;
  Object.entries(tables).forEach(([name, data], index) => {
    directory.write(name, 12 + index * 16); directory.writeUInt32BE(offset, 20 + index * 16); directory.writeUInt32BE(data.length, 24 + index * 16);
    chunks.push(data); const padding = Buffer.alloc((4 - data.length % 4) % 4); chunks.push(padding); offset += data.length + padding.length;
  });
  return { font: Buffer.concat(chunks), codePoint };
}

test('font bounds handle Unicode mappings, both location formats and negative side bearings', () => {
  const { readGlyph } = require('../scripts/true-type-metrics.cjs');
  for (const format of [4, 12]) for (const long of [false, true]) for (const indirect of [false, true]) {
    const { font, codePoint } = metricFont(format, long, indirect);
    assert.deepEqual(readGlyph(font, codePoint), { unitsPerEm: 1000, bounds: { xMin: -100, yMin: -200, xMax: 300, yMax: 800 } });
    assert.throws(() => readGlyph(font, codePoint + 1), /glyph/i);
    assert.throws(() => readGlyph(font.subarray(0, font.length - 12), codePoint), /font|table/i);
  }
});

test('wide, tall and offset glyphs fit the same square without distortion', () => {
  const { fitIcon } = require('../scripts/icon-metrics.cjs');
  for (const bounds of [
    { xMin: -30, yMin: -10, xMax: 170, yMax: 90 },
    { xMin: 20, yMin: -60, xMax: 70, yMax: 140 },
    { xMin: -200, yMin: -200, xMax: 200, yMax: 200 }
  ]) {
    const fit = fitIcon(bounds, 1000);
    for (const size of [8, 16, 24]) {
      const scale = size * fit.fontScale / 1000;
      const left = size * fit.left + bounds.xMin * scale;
      const right = size * fit.left + bounds.xMax * scale;
      const top = size * (fit.top + fit.fontScale) - bounds.yMax * scale;
      const bottom = size * (fit.top + fit.fontScale) - bounds.yMin * scale;
      const extent = Math.max(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin);
      assert.ok(Math.abs(Math.max(right - left, bottom - top) - size * Math.min(1, extent / 1000)) < 1e-9);
      assert.ok(Math.abs((left + right) / 2 - size / 2) < 1e-9);
      assert.ok(Math.abs((top + bottom) / 2 - size / 2) < 1e-9);
      assert.ok(left >= -1e-9 && right <= size + 1e-9 && top >= -1e-9 && bottom <= size + 1e-9);
    }
  }
  assert.throws(() => fitIcon({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 }, 1000), /bounds/i);
});
