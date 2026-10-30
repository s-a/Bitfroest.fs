(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderLister = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const modes = ['text', 'binary', 'hex', 'html', 'unicode', 'utf8'];
  const codepages = [0, 1, 2, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 936, 950, 932, 949, 874, 437, 850, 20866];
  const labels = { 2: 'macintosh', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 20866: 'koi8-r', 65001: 'utf-8', 1200: 'utf-16le', 1201: 'utf-16be' };
  function detect(bytes) {
    if (bytes[0] === 255 && bytes[1] === 254) return { mode: 'unicode', encoding: 'utf-16le' };
    if (bytes[0] === 254 && bytes[1] === 255) return { mode: 'unicode', encoding: 'utf-16be' };
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { mode: 'utf8', encoding: 'utf-8' };
    let score = 0, breaks = 0;
    for (const byte of bytes) {
      if (byte < 9 || byte === 11 || byte === 12) score++;
      if (byte === 32) score--;
      if (byte === 10 || byte === 13) breaks++;
      if (score >= 5) break;
    }
    if (bytes.length && (score >= 5 || breaks < 2)) return { mode: 'binary', encoding: '0' };
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); return { mode: 'text', encoding: 'utf-8' }; }
    catch { return { mode: 'text', encoding: '0' }; }
  }
  function decoderLabel(encoding) {
    const value = String(encoding);
    if (labels[value]) return labels[value];
    if (/^125[0-8]$/.test(value) || value === '874') return `windows-${value}`;
    if (value === '0') return 'windows-1252';
    return value;
  }
  function decode(bytes, encoding = 'utf-8', offset = 0) {
    const label = decoderLabel(encoding);
    try {
      if (label === 'utf-8' || label.startsWith('utf-16')) {
        const text = new TextDecoder(label, { ignoreBOM: true, fatal: true }).decode(bytes), map = [];
        let position = offset;
        for (let index = 0; index < text.length; index++) {
          const point = text.codePointAt(index); map.push(position);
          if (point > 0xffff) { map.push(position); index++; }
          position += label === 'utf-8' ? point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4 : point > 0xffff ? 4 : 2;
        }
        map.push(offset + bytes.length); return { text, map, encoding: String(encoding) };
      }
      if (/^(windows-|koi8-|macintosh)/.test(label)) {
        const text = new TextDecoder(label).decode(bytes);
        if (text.length === bytes.length) return { text, map: Array.from({ length: text.length + 1 }, (_, index) => offset + index), encoding: String(encoding) };
      }
    } catch { /* Incomplete or invalid sequences retain incremental byte mapping. */ }
    const decoder = new TextDecoder(label, { ignoreBOM: true });
    const map = [], parts = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      const text = decoder.decode(bytes.subarray(i, i + 1), { stream: true });
      if (text) {
        parts.push(text);
        for (let j = 0; j < text.length; j++) map.push(offset + (j && text.length > 1 && text.charCodeAt(0) === 0xfffd ? i : start));
        start = i + 1;
      }
    }
    const tail = decoder.decode();
    if (tail) { parts.push(tail); for (let j = 0; j < tail.length; j++) map.push(offset + start); }
    map.push(offset + bytes.length);
    return { text: parts.join(''), map, encoding: String(encoding) };
  }
  function format(bytes, decoded, options = {}) {
    const mode = options.mode || 'text', offset = options.offset || 0;
    const result = [], map = [], ends = [], lines = [offset];
    const put = (text, position, end = position) => { result.push(text); for (let j = 0; j < text.length; j++) { map.push(position); ends.push(end); } };
    const newline = position => { put('\n', position); lines.push(position); };
    if (mode === 'hex') {
      for (let i = 0; i < bytes.length; i += 16) {
        if (i) newline(offset + i);
        put((offset + i).toString(16).toUpperCase().padStart(8, '0') + '  ', offset + i);
        for (let j = 0; j < 16; j++) put(i + j < bytes.length ? bytes[i + j].toString(16).toUpperCase().padStart(2, '0') + ' ' : '   ', offset + Math.min(i + j, bytes.length), offset + Math.min(i + j + 1, bytes.length));
        put(' ', offset + i);
        for (let j = 0; j < 16 && i + j < bytes.length; j++) put(bytes[i + j] >= 32 && bytes[i + j] < 127 ? String.fromCharCode(bytes[i + j]) : '.', offset + i + j, offset + i + j + 1);
      }
    } else {
      const text = decoded.text, positions = decoded.map;
      const width = mode === 'binary' ? 74 : options.wrap === false ? mode === 'unicode' ? 512 : 1024 : Math.max(20, Math.min(1024, options.width || 80));
      let column = 0, inTag = false, quote = '';
      for (let i = 0; i < text.length; i++) {
        let character = text[i]; const position = positions[i];
        if (!offset && !i && character === '\ufeff' && mode !== 'binary') continue;
        if (mode === 'html') {
          if (inTag) {
            if (quote) { if (character === quote) quote = ''; }
            else if (character === '"' || character === "'") quote = character;
            else if (character === '>') { inTag = false; if (column) { newline(position); column = 0; } }
            continue;
          }
          if (character === '<') { inTag = true; continue; }
          if (character === '&') {
            const entity = /^&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/i.exec(text.slice(i, i + 16));
            if (entity) {
              const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
              const value = entity[1][0] === '#' ? parseInt(entity[1].slice(entity[1][1].toLowerCase() === 'x' ? 2 : 1), entity[1][1].toLowerCase() === 'x' ? 16 : 10) : null;
              character = value !== null ? value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\ufffd' : named[entity[1].toLowerCase()];
              i += entity[0].length - 1;
            }
          }
        }
        if (mode !== 'binary' && (character === '\r' || character === '\n')) {
          if (character === '\r' && text[i + 1] === '\n') i++;
          newline(positions[i + 1]); column = 0; continue;
        }
        if (character === '\0') character = mode === 'binary' ? '.' : ' ';
        if (mode === 'binary' && (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) character = '.';
        if (column >= width) { newline(position); column = 0; }
        if (options.wrap !== false && mode !== 'binary' && character === ' ') {
          const upcoming = /^\S*/.exec(text.slice(i + 1, i + width + 1))[0].length;
          if (column && column + upcoming + 1 > width) { newline(position); column = 0; }
        }
        let end = positions[i + 1];
        if (end === position) end = positions[i + 2] ?? end;
        put(character, position, end); column++;
      }
    }
    map.push(offset + bytes.length);
    const links = [];
    if (mode === 'html') {
      const expression = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
      for (const match of decoded.text.matchAll(expression)) {
        const href = (match[1] ?? match[2] ?? match[3]).replace(/&amp;/gi, '&');
        if (href.length <= 4096 && links.length < 100) links.push({ href, label: match[4].replace(/<[^>]*>/g, '').replace(/&amp;/gi, '&').slice(0, 160) || href });
      }
    }
    return { text: result.join(''), map, ends, lines, links };
  }
  function parseHex(value) {
    const bytes = [];
    let index = 0;
    while (index < value.length) {
      if (/\s/.test(value[index])) { index++; continue; }
      if (value[index] === '"' || value[index] === "'") {
        const quote = value[index++];
        while (index < value.length && value[index] !== quote) {
          if (value.charCodeAt(index) > 255) throw new Error('Ungültige Hexsuche.');
          bytes.push(value.charCodeAt(index++));
        }
        if (value[index++] !== quote) throw new Error('Ungültige Hexsuche.');
      } else {
        const pair = value.slice(index, index + 2);
        if (!/^[0-9a-f]{2}$/i.test(pair)) throw new Error('Ungültige Hexsuche.');
        bytes.push(parseInt(pair, 16)); index += 2;
      }
    }
    if (!bytes.length) throw new Error('Ungültige Hexsuche.');
    return Uint8Array.from(bytes);
  }
  return { modes, codepages, detect, decode, format, parseHex, decoderLabel };
});
