const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const { Readable } = require('node:stream');
const safeEntry = name => name && !name.includes('\0') && !name.startsWith('/') && !/^[a-z]:/i.test(name) && !name.split('/').includes('..');
const stop = signal => { if (signal?.aborted) throw new DOMException('Suche abgebrochen.', 'AbortError'); };
const asNumber = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Ungültige Archivgröße.'); return n; };
const { createZipProvider } = require('./zip-provider');
async function* zipEntries(target, signal, options = {}) {
  const provider = options.provider || createZipProvider({ contains: value => path.resolve(value) === path.resolve(target) });
  try {
    for await (const row of provider.entries(target, { signal })) {
      yield { ...row, entry: row.archiveEntry,
        stat: { size: row.size, mtimeMs: row.mtimeMs, mode: 0o644, isFile: () => !row.directory, isDirectory: () => row.directory },
        chunks: () => provider.readEntry(row, { signal }) };
    }
  } finally { if (!options.provider) provider.dispose(); }
}
async function* archiveEntries(target, signal, options = {}) {
  if (/\.(zip|docx|xlsx|pptx|odt|ods|odp|epub)$/i.test(target)) { yield* zipEntries(target, signal, options); return; }
  if (/\.gz$/i.test(target) && !/\.tar\.gz$/i.test(target)) {
    const info = await fs.stat(target);
    const entry = path.basename(target).replace(/\.gz$/i, '');
    const chunks = async function* () {
      const input = nativeFs.createReadStream(target), decoded = input.pipe(zlib.createGunzip());
      input.on('error', error => decoded.destroy(error));
      try { for await (const chunk of decoded) { stop(signal); yield chunk; } } finally { decoded.destroy(); input.destroy(); }
    };
    let sizing;
    const stat = { size: 0, mtimeMs: info.mtimeMs, mode: 0o644, isFile: () => true, isDirectory: () => false,
      resolveSize() { sizing ||= (async () => { let size = 0; for await (const chunk of chunks()) size += chunk.length; stat.size = asNumber(size); })(); return sizing; }
    };
    yield { entry, name: entry, stat, chunks }; return;
  }
  if (/\.(tar|tgz|tar\.gz|gz)$/i.test(target)) {
    const raw = nativeFs.createReadStream(target), decoded = /\.(tgz|gz)$/i.test(target) ? raw.pipe(zlib.createGunzip()) : raw;
    if (decoded !== raw) raw.on('error', error => decoded.destroy(error));
    const iterator = decoded[Symbol.asyncIterator](); let buffer = Buffer.alloc(0), done = false;
    async function take(count) { while (buffer.length < count && !done) { const next = await iterator.next(); done = Boolean(next.done); if (!done) buffer = Buffer.concat([buffer, next.value]); } const bytes = buffer.subarray(0, count); buffer = buffer.subarray(bytes.length); return bytes; }
    try {
      let longName = null, pax = {}, globalPax = {};
      while (true) {
        stop(signal); const header = await take(512); if (!header.length || header.every(x => !x)) break;
        if (header.length !== 512) throw new Error('Unvollständiges TAR-Archiv.');
        const string = (offset, length) => header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
        const metadata = [120, 103, 76].includes(header[156]), properties = metadata ? {} : { ...globalPax, ...pax };
        const entry = properties.path || longName || [string(345, 155), string(0, 100)].filter(Boolean).join('/'); if (!metadata) { longName = null; pax = {}; }
        const size = properties.size === undefined ? parseInt(string(124, 12).trim() || '0', 8) : Number(properties.size), mtimeMs = properties.mtime === undefined ? parseInt(string(136, 12).trim() || '0', 8) * 1000 : Number(properties.mtime) * 1000;
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Ungültige TAR-Größe.');
        let remaining = size;
        const chunks = async function* () { while (remaining) { stop(signal); const bytes = await take(Math.min(65536, remaining)); if (!bytes.length) throw new Error('Unvollständiger TAR-Eintrag.'); remaining -= bytes.length; yield bytes; } };
        if (header[156] === 76) { const all = []; for await (const bytes of chunks()) all.push(bytes); longName = Buffer.concat(all).toString('utf8').replace(/\0.*$/s, ''); }
        else if ([120, 103].includes(header[156])) {
          const all = []; for await (const bytes of chunks()) all.push(bytes); const data = Buffer.concat(all), values = {}; let at = 0;
          while (at < data.length) { const space = data.indexOf(32, at), length = Number(data.subarray(at, space).toString()); if (space < 0 || !Number.isSafeInteger(length) || length <= space - at + 1 || at + length > data.length) throw new Error('Ungültiger PAX-Eintrag.'); const record = data.subarray(space + 1, at + length - 1).toString('utf8'), equal = record.indexOf('='); if (equal > 0) values[record.slice(0, equal)] = record.slice(equal + 1); at += length; }
          if (header[156] === 103) globalPax = { ...globalPax, ...values }; else pax = values;
        }
        else if ([0, 48].includes(header[156]) && safeEntry(entry)) yield { entry, name: path.posix.basename(entry), stat: { size, mtimeMs, mode: 0o644, isFile: () => true, isDirectory: () => false }, chunks };
        for await (const bytes of chunks()) { void bytes; }
        await take((512 - size % 512) % 512);
      }
    } finally { decoded.destroy(); raw.destroy(); }
  } else if (/\.(7z|rar|arj|lzh|cab|ace)$/i.test(target)) throw new Error('Für dieses Archivformat ist kein Suchadapter verfügbar.');
}
function xmlText(value) {
  return value.replace(/<\/(?:\w+:)?(?:p|tr|h[1-6])>/gi, '\n').replace(/<(?:\w+:)?(?:br|tab)\b[^>]*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => entity[0] === '#' ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()]);
}
async function* officeText(target, signal, options = {}) {
  for await (const entry of zipEntries(target, signal, options)) {
    if (!/\.(xml|xhtml|html|htm)$/i.test(entry.entry) || /^(?:_rels|docProps)\//.test(entry.entry)) continue;
    const chunks = []; for await (const bytes of entry.chunks()) chunks.push(bytes);
    yield Buffer.from(xmlText(Buffer.concat(chunks).toString('utf8')) + '\n', 'utf8');
  }
}
module.exports = { archiveEntries, officeText, zipEntries, xmlText, safeEntry, Readable };
