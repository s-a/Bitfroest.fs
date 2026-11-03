function readGlyph(font, codePoint, { contourBounds = false } = {}) {
  function fail() { throw new Error('Invalid or unsupported TrueType font table.'); }
  function slice(data, offset, length) {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > data.length) fail();
    return data.subarray(offset, offset + length);
  }
  if (!Buffer.isBuffer(font) || font.length < 12 || font.readUInt32BE(0) !== 0x00010000) fail();
  const directory = slice(font, 12, font.readUInt16BE(4) * 16), tables = new Map();
  for (let index = 0; index < directory.length; index += 16) {
    tables.set(directory.toString('ascii', index, index + 4), slice(font, directory.readUInt32BE(index + 8), directory.readUInt32BE(index + 12)));
  }
  function table(name, minimum) {
    const data = tables.get(name);
    if (!data || data.length < minimum) fail();
    return data;
  }
  const head = table('head', 54), maxp = table('maxp', 6), cmap = table('cmap', 4);
  const unitsPerEm = head.readUInt16BE(18), glyphCount = maxp.readUInt16BE(4);
  if (!unitsPerEm || !glyphCount || !Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) fail();
  const encodings = slice(cmap, 4, cmap.readUInt16BE(2) * 8), candidates = [];
  for (let index = 0; index < encodings.length; index += 8) {
    const platform = encodings.readUInt16BE(index), encoding = encodings.readUInt16BE(index + 2);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const offset = encodings.readUInt32BE(index + 4), format = slice(cmap, offset, 2).readUInt16BE(0);
    if (![4, 12].includes(format)) continue;
    const length = format === 12 ? slice(cmap, offset, 8).readUInt32BE(4) : slice(cmap, offset, 4).readUInt16BE(2);
    candidates.push({ format, data: slice(cmap, offset, length) });
  }
  candidates.sort((a, b) => b.format - a.format);
  let glyph = 0;
  for (const { format, data } of candidates) {
    if (format === 12) {
      const count = slice(data, 0, 16).readUInt32BE(12);
      const groups = slice(data, 16, count * 12);
      for (let index = 0; index < groups.length; index += 12) {
        const start = groups.readUInt32BE(index), end = groups.readUInt32BE(index + 4);
        if (codePoint >= start && codePoint <= end) { glyph = groups.readUInt32BE(index + 8) + codePoint - start; break; }
      }
    } else if (codePoint <= 0xffff) {
      const count = slice(data, 0, 14).readUInt16BE(6) / 2;
      if (!Number.isInteger(count) || count < 1) fail();
      const ends = slice(data, 14, count * 2), starts = slice(data, 16 + count * 2, count * 2);
      const deltas = slice(data, 16 + count * 4, count * 2), ranges = slice(data, 16 + count * 6, count * 2);
      for (let index = 0; index < count; index++) {
        if (codePoint < starts.readUInt16BE(index * 2) || codePoint > ends.readUInt16BE(index * 2)) continue;
        const range = ranges.readUInt16BE(index * 2), delta = deltas.readInt16BE(index * 2);
        glyph = range ? slice(data, 16 + count * 6 + index * 2 + range + 2 * (codePoint - starts.readUInt16BE(index * 2)), 2).readUInt16BE(0) : codePoint;
        if (glyph || !range) glyph = (glyph + delta) & 0xffff;
        break;
      }
    }
    if (glyph) break;
  }
  if (!glyph || glyph >= glyphCount) throw new Error(`Missing font glyph U+${codePoint.toString(16)}.`);
  const format = head.readInt16BE(50);
  if (![0, 1].includes(format)) fail();
  const loca = table('loca', (glyphCount + 1) * (format ? 4 : 2));
  const offset = index => format ? loca.readUInt32BE(index * 4) : loca.readUInt16BE(index * 2) * 2;
  const start = offset(glyph), end = offset(glyph + 1);
  if (end <= start) throw new Error(`Empty font glyph U+${codePoint.toString(16)}.`);
  const data = slice(table('glyf', 10), start, end - start);
  if (data.length < 10) fail();
  const hhea = table('hhea', 36), metricsCount = hhea.readUInt16BE(34);
  if (!metricsCount || metricsCount > glyphCount) fail();
  const hmtx = table('hmtx', metricsCount * 4 + (glyphCount - metricsCount) * 2);
  const bearing = hmtx.readInt16BE(glyph < metricsCount ? glyph * 4 + 2 : metricsCount * 4 + (glyph - metricsCount) * 2);
  const width = data.readInt16BE(6) - data.readInt16BE(2);
  const bounds = { xMin: bearing, yMin: data.readInt16BE(4), xMax: bearing + width, yMax: data.readInt16BE(8) };
  if (contourBounds) Object.assign(bounds, readContourBounds(data, bearing - data.readInt16BE(2)));
  if (width <= 0 || bounds.yMax <= bounds.yMin) throw new Error(`Empty font glyph U+${codePoint.toString(16)}.`);
  return { unitsPerEm, bounds };
}

function readContourBounds(data, shiftX) {
  const contours = data.readInt16BE(0);
  if (contours <= 0) throw new Error('Contour measurement requires a simple TrueType glyph.');
  let cursor = 10;
  const ends = [];
  for (let index = 0; index < contours; index++, cursor += 2) ends.push(data.readUInt16BE(cursor));
  const count = ends.at(-1) + 1;
  cursor += 2 + data.readUInt16BE(cursor);
  const flags = [];
  while (flags.length < count) {
    const flag = data.readUInt8(cursor++); flags.push(flag);
    if (flag & 8) {
      const repeats = data.readUInt8(cursor++);
      if (flags.length + repeats > count) throw new Error('Invalid TrueType contour flags.');
      for (let index = 0; index < repeats; index++) flags.push(flag);
    }
  }
  const coordinates = (short, positive) => {
    let value = 0;
    return flags.map(flag => {
      if (flag & short) { const delta = data.readUInt8(cursor++); value += flag & positive ? delta : -delta; }
      else if (!(flag & positive)) { value += data.readInt16BE(cursor); cursor += 2; }
      return value;
    });
  };
  const xs = coordinates(2, 16), ys = coordinates(4, 32);
  const bounds = { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity };
  const include = point => {
    bounds.xMin = Math.min(bounds.xMin, point.x + shiftX); bounds.xMax = Math.max(bounds.xMax, point.x + shiftX);
    bounds.yMin = Math.min(bounds.yMin, point.y); bounds.yMax = Math.max(bounds.yMax, point.y);
  };
  const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  let first = 0;
  for (const end of ends) {
    const points = [];
    for (let index = first; index <= end; index++) points.push({ x: xs[index], y: ys[index], on: Boolean(flags[index] & 1) });
    first = end + 1;
    const expanded = [];
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      expanded.push(a); if (!a.on && !b.on) expanded.push(middle(a, b));
    }
    const start = expanded.findIndex(point => point.on);
    if (start < 0) throw new Error('Invalid TrueType contour.');
    const ordered = [...expanded.slice(start), ...expanded.slice(0, start)]; ordered.push(ordered[0]);
    for (let index = 0; index < ordered.length - 1; index++) {
      const a = ordered[index], b = ordered[index + 1]; include(a);
      if (b.on) continue;
      const c = ordered[index + 2]; include(c);
      for (const axis of ['x', 'y']) {
        const denominator = a[axis] - 2 * b[axis] + c[axis];
        const t = denominator ? (a[axis] - b[axis]) / denominator : 0;
        if (t > 0 && t < 1) include({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * b.x + t ** 2 * c.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * b.y + t ** 2 * c.y });
      }
      index++;
    }
  }
  return bounds;
}

module.exports = { readGlyph };
