const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const core = require('./media/commander-lister');
const { createCodepageDecoder } = require('./lister-codepages');
const BLOCK = 196608, WINDOW = 32768;
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const abort = () => Object.assign(new Error('Suche abgebrochen.'), { name: 'AbortError' });

function createListerProvider(options = {}) {
  const io = options.fs || fs, sessions = new Map(), decoder = options.decoder || createCodepageDecoder();
  let disposed = false;
  function get(id) {
    const session = sessions.get(id);
    if (!session || disposed || session.closed) throw new Error('Die Lister-Ansicht ist geschlossen.');
    return session;
  }
  async function check(session) {
    if (session.closed || disposed) throw new Error('Die Lister-Ansicht ist geschlossen.');
    if (!options.validate(session.path)) throw new Error('Ungültiger Lister-Pfad.');
    const [current, original] = await Promise.all([session.handle.stat(), io.lstat(session.path)]);
    if (!original.isFile() || original.isSymbolicLink() || signature(current) !== session.signature || signature(original) !== session.signature) throw new Error('Die Datei wurde verändert. Mit F2 neu laden.');
  }
  async function read(session, position, length = BLOCK) {
    await check(session);
    position = Math.max(0, Math.min(session.size, Math.floor(position)));
    length = Math.min(BLOCK, length, session.size - position);
    if (session.cache && position >= session.cache.offset && position + length <= session.cache.offset + session.cache.bytes.length) return session.cache.bytes.subarray(position - session.cache.offset, position - session.cache.offset + length);
    const bytes = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const result = await session.handle.read(bytes, count, length - count, position + count);
      if (!result.bytesRead) throw new Error('Die Datei wurde verändert. Mit F2 neu laden.');
      count += result.bytesRead;
    }
    await check(session);
    session.cache = { offset: position, bytes };
    return bytes;
  }
  function encodingFor(session, settings) {
    const mode = settings.mode || session.mode;
    return mode === 'utf8' ? 'utf-8' : mode === 'unicode' ? session.encoding === 'utf-16be' ? 'utf-16be' : 'utf-16le' : settings.encoding === 'font' ? '0' : settings.encoding || session.encoding;
  }
  async function view(id, settings = {}) {
    const session = get(id), mode = core.modes.includes(settings.mode) ? settings.mode : session.mode;
    let position = Number.isFinite(settings.position) ? Math.max(0, Math.min(session.size, Math.floor(settings.position))) : 0;
    if (position === session.size && session.size) position = Math.max(0, session.size - WINDOW);
    const encoding = encodingFor(session, { ...settings, mode });
    const label = core.decoderLabel(encoding);
    if (mode === 'hex') position -= position % 16;
    if (mode === 'unicode' || /^utf-16/.test(label)) {
      position -= position % 2;
      if (mode !== 'hex' && position >= 2) {
        const prefix = await read(session, position - 2, 4);
        const unit = index => label === 'utf-16be' ? prefix[index] * 256 + prefix[index + 1] : prefix[index] + prefix[index + 1] * 256;
        if (prefix.length === 4 && unit(0) >= 0xd800 && unit(0) <= 0xdbff && unit(2) >= 0xdc00 && unit(2) <= 0xdfff) position -= 2;
      }
    } else if (mode !== 'hex' && label === 'utf-8' && position > 0) {
      const begin = Math.max(0, position - 3), prefix = await read(session, begin, Math.min(4, session.size - begin));
      let index = position - begin;
      while (index > 0 && (prefix[index] & 0xc0) === 0x80) index--;
      const width = prefix[index] >= 0xf0 ? 4 : prefix[index] >= 0xe0 ? 3 : prefix[index] >= 0xc2 ? 2 : 1;
      if (width > 1 && begin + index + width > position) position = begin + index;
    }
    let bytes = await read(session, position, Math.min(WINDOW + 8, session.size - position));
    let decoded = mode === 'hex' ? { text: '', map: [] } : await decoder.decode(bytes, encoding, position);
    if (mode === 'hex') bytes = bytes.subarray(0, WINDOW);
    else if (bytes.length > WINDOW) {
      const index = decoded.map.findIndex(value => value >= position + WINDOW);
      const boundary = index >= 0 ? decoded.map[index] - position : bytes.length;
      bytes = bytes.subarray(0, boundary);
      decoded = { ...decoded, text: decoded.text.slice(0, index), map: decoded.map.slice(0, index + 1) };
    }
    const formatted = core.format(bytes, decoded, { ...settings, mode, offset: position });
    return { ...formatted, offset: position, next: Math.min(session.size, position + bytes.length), previous: Math.max(0, position - WINDOW), size: session.size, encoding, mode };
  }
  async function open(original) {
    if (disposed || typeof original !== 'string' || !options.validate(original)) throw new Error('Ungültiger Lister-Pfad.');
    const stat = await io.lstat(original);
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Ungültiger Lister-Pfad oder nicht unterstützte Dateigröße.');
    const handle = await io.open(original, 'r');
    const session = { id: crypto.randomUUID(), path: original, size: stat.size, signature: signature(stat), handle, closed: false, jobs: new Set() };
    sessions.set(session.id, session);
    try {
      const bytes = await read(session, 0);
      Object.assign(session, core.detect(bytes));
      return { id: session.id, size: session.size, mode: session.mode, encoding: session.encoding, view: await view(session.id) };
    } catch (error) { await close(session.id); throw error; }
  }
  async function close(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id); session.closed = true; session.cache = null;
    for (const controller of session.jobs) controller.abort();
    await session.handle.close();
  }
  async function lineBoundary(session, position, encoding, backwards) {
    const label = core.decoderLabel(encoding), unicode = label.startsWith('utf-16'), unit = unicode ? 2 : 1;
    let cursor = position - position % unit, scanned = 0;
    while (backwards ? cursor > 0 : cursor < session.size) {
      const start = backwards ? Math.max(0, cursor - BLOCK) : cursor;
      const bytes = await read(session, start, backwards ? cursor - start : Math.min(BLOCK, session.size - start));
      const decoded = await decoder.decode(bytes, encoding, start);
      const index = backwards ? Math.max(decoded.text.lastIndexOf('\n'), decoded.text.lastIndexOf('\r')) : decoded.text.search(/[\r\n]/);
      if (index >= 0) return decoded.map[index + 1];
      scanned += bytes.length;
      if (scanned > 1024 * 1024) throw new Error('Eine Regex-Suchzeile überschreitet 1 MiB. Text- oder Hexsuche verwenden.');
      cursor = backwards ? start : start + bytes.length;
    }
    return backwards ? 0 : session.size;
  }
  async function search(id, settings, signal) {
    const session = get(id), controller = new AbortController();
    const cancelled = () => { if (signal?.aborted || controller.signal.aborted) throw abort(); };
    cancelled(); session.jobs.add(controller);
    const worker = new Worker(path.join(__dirname, 'lister-search-worker.js'));
    let pending;
    const stop = () => { pending?.reject(abort()); pending = null; worker.terminate(); };
    signal?.addEventListener('abort', stop, { once: true }); controller.signal.addEventListener('abort', stop, { once: true });
    worker.on('message', message => { const task = pending; pending = null; if (message.error) task?.reject(new Error(message.error)); else task?.resolve(message.match); });
    worker.on('error', error => { pending?.reject(error); pending = null; });
    const match = (text, bounds) => new Promise((resolve, reject) => { cancelled(); pending = { resolve, reject }; worker.postMessage({ text, settings: { ...settings, ...bounds } }); });
    try {
      if (typeof settings.text !== 'string' || !settings.text.length || settings.text.length > 4096) throw new Error('Ein Suchbegriff mit höchstens 4096 Zeichen ist erforderlich.');
      const needle = settings.hex ? Buffer.from(core.parseHex(settings.text)) : null;
      const limit = Number.isFinite(settings.position) ? Math.max(0, Math.min(session.size, settings.position)) : settings.backward ? session.size : 0;
      const encoding = encodingFor(session, settings), overlap = Math.min(BLOCK / 2, Math.max(16, settings.text.length * 8));
      let position = limit, carry = null;
      if (settings.regex && limit > 0 && limit < session.size) position = await lineBoundary(session, limit, encoding, !settings.backward);
      while (settings.backward ? position > 0 : position < session.size) {
        cancelled();
        let start = settings.backward ? Math.max(0, position - BLOCK + (needle || settings.regex ? 0 : 8)) : settings.regex || needle ? position : Math.max(0, position - 8);
        if (/^utf-16|^120[01]$/.test(encoding)) start -= start % 2;
        let length = settings.backward ? position - start : Math.min(BLOCK, session.size - start);
        const bytes = await read(session, start, Math.min(BLOCK, length + (settings.backward && !needle && !settings.regex ? 8 : 0)));
        if (needle) {
          const index = settings.backward ? bytes.lastIndexOf(needle) : bytes.indexOf(needle, Math.max(0, limit - start));
          if (index >= 0) return { start: start + index, end: start + index + needle.length };
        } else {
          let decoded = await decoder.decode(bytes, encoding, start);
          if (!settings.backward && start + length < session.size) {
            const index = decoded.map.findIndex(value => value >= start + length - 8);
            length = decoded.map[index] - start;
            decoded = { ...decoded, text: decoded.text.slice(0, index), map: decoded.map.slice(0, index + 1) };
          } else if (settings.backward && start > 0) {
            const index = decoded.map.findIndex(value => value >= start + 8);
            start = decoded.map[index]; length = position - start;
            decoded = { ...decoded, text: decoded.text.slice(index), map: decoded.map.slice(index) };
          }
          let text = decoded.text, map = decoded.map;
          if (settings.regex) {
            if (carry) {
              if (settings.backward) { text += carry.text; map = map.slice(0, -1).concat(carry.map); }
              else { text = carry.text + text; map = carry.map.slice(0, -1).concat(map); }
            }
            if (text.split(/\r\n|\r|\n/).some(line => line.length > 1024 * 1024)) throw new Error('Eine Regex-Suchzeile überschreitet 1 MiB. Text- oder Hexsuche verwenden.');
            const boundary = settings.backward ? text.search(/[\r\n]/) : Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
            if (settings.backward && start > 0) {
              carry = { text: text.slice(0, boundary < 0 ? text.length : boundary + 1), map: map.slice(0, boundary < 0 ? map.length : boundary + 2) };
              text = boundary < 0 ? '' : text.slice(boundary + 1); map = boundary < 0 ? [] : map.slice(boundary + 1);
            } else if (!settings.backward && start + length < session.size) {
              carry = { text: text.slice(boundary + 1), map: map.slice(boundary + 1) };
              text = text.slice(0, boundary + 1); map = map.slice(0, boundary + 2);
            } else carry = null;
          }
          const minIndex = settings.backward ? 0 : Math.max(0, map.findIndex(value => value >= limit));
          const maxIndex = settings.backward ? map.findIndex(value => value >= limit) : start + length === session.size ? text.length : text.length - 1;
          const found = await match(text, { minIndex, maxIndex: maxIndex < 0 ? text.length : maxIndex });
          if (found) return { start: map[found.start], end: map[found.end] };
        }
        if (settings.backward) { if (!start) break; position = start + (settings.regex ? 0 : overlap); }
        else { if (start + length >= session.size) break; position = start + length - (settings.regex ? 0 : overlap); }
        await new Promise(resolve => setImmediate(resolve));
      }
      return null;
    } finally {
      signal?.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', stop);
      session.jobs.delete(controller); await worker.terminate();
    }
  }
  async function copy(id, settings, signal) {
    const session = get(id), start = Math.min(settings.start, settings.end), end = Math.max(settings.start, settings.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > session.size) throw new Error('Ungültige Textauswahl.');
    if (end - start > 64 * 1024 * 1024) throw new Error('Die Auswahl überschreitet die Zwischenablagegrenze von 64 MiB.');
    const parts = [], encoding = encodingFor(session, settings);
    for (let position = start; position < end;) {
      if (signal?.aborted) throw abort();
      const length = Math.min(BLOCK, end - position);
      const bytes = await read(session, position, length);
      if (settings.hex) parts.push([...bytes].map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '));
      else parts.push(bytes);
      position += length; await new Promise(resolve => setImmediate(resolve));
    }
    return settings.hex ? parts.join(' ') : (await decoder.text(Buffer.concat(parts), encoding)).replace(/\0/g, ' ');
  }
  return { open, view, search, copy, close, path: id => get(id).path, validate: id => check(get(id)), async validateEncoding(encoding) { await decoder.decode(Buffer.from([128]), String(encoding)); }, async dispose() { disposed = true; await Promise.all([...sessions.keys()].map(close)); decoder.dispose(); } };
}
module.exports = { createListerProvider };
