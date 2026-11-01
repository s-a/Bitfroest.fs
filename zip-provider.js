const fs = require('node:fs/promises');
const path = require('node:path');
const Progress = require('./media/commander-progress');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { WritableStream, TransformStream } = require('node:stream/web');
const zip = require('@zip.js/zip.js');

const { signature, stop, location, archivePath, noLinks, safeName, publish } = require('./zip-io');
const { resolvePassword } = require('./zip-password');
const { matches } = require('./zip-filter');
const { readableMethod } = require('./zip-codecs');

function createZipProvider(options = {}) {
  const sessions = new Map();
  const active = new Set();
  const reads = new AsyncLocalStorage();
  let disposed = false, generation = 0;
  const permitted = value => path.isAbsolute(value) && options.contains?.(value);
  async function openContainer(value, signal) {
    stop(signal);
    if (disposed || !permitted(value)) throw new Error('Dieses ZIP-Archiv ist nicht verfügbar.');
    const archive = path.resolve(value);
    await noLinks(archive);
    const stat = await fs.stat(archive, { bigint: true });
    if (!stat.isFile()) throw new Error('Dieses ZIP-Archiv ist nicht verfügbar.');
    const key = location(archive), cached = sessions.get(key);
    if (cached?.signature === signature(stat)) return structuredClone(cached.view);
    const revision = generation;
    const handle = await fs.open(archive, 'r');
    const reader = new zip.Reader();
    reader.size = Number(stat.size);
    reader.readUint8Array = async (offset, length) => {
      const current = reads.getStore();
      if (current) return current(offset, length);
      stop(signal);
      if (disposed || revision !== generation) throw new Error('Archivansicht wurde geschlossen.');
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > reader.size || length > reader.size - offset || length > (options.maxMetadataBytes ?? 64 * 1024 * 1024)) throw new Error('Das ZIP-Inhaltsverzeichnis überschreitet das verfügbare Lesebudget.');
      const bytes = Buffer.alloc(length);
      let count = 0;
      while (count < length) { const result = await handle.read(bytes, count, length - count, offset + count); if (!result.bytesRead) throw new Error('Unvollständiges ZIP-Archiv.'); count += result.bytesRead; }
      options.onRead?.({ offset, length });
      return bytes;
    };
    const zipReader = new zip.ZipReader(reader, { strictness: 'strict', useWebWorkers: false, checkCrc32: true, checkAuthenticationCode: true, checkOverlappingEntry: true });
    try {
      const entries = new Map(), folders = { [key]: [] }, locations = { [key]: { archive: archive.replaceAll('\\', '/'), parent: path.dirname(archive).replaceAll('\\', '/') } };
      const add = (name, directory, entry) => {
        const parts = name.split('/'), basename = parts.pop(), parent = parts.length ? `${key}/${parts.join('/')}` : key;
        if (!folders[parent]) add(parts.join('/'), true);
        const existing = folders[parent].find(row => row.name === basename);
        if (existing) { if (!directory || existing.type !== 'folder') throw new Error('Mehrdeutige ZIP-Einträge werden nicht unterstützt.'); if (entry) existing.date = entry.lastModDate?.toISOString() || ''; return; }
        const source = `${key}/${name}`;
        folders[parent].push({ id: `zip-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 24)}`, name: basename, type: directory ? 'folder' : 'text', size: directory ? 0 : entry.uncompressedSize, compressedSize: entry?.compressedSize || 0, compressionMethod: entry?.compressionMethod, encrypted: Boolean(entry?.encrypted), encryption: entry?.encrypted ? entry.zipCrypto ? 'zipcrypto' : `aes${({ 1: 128, 2: 192, 3: 256 })[entry.extraFieldAES?.strength] || 256}` : 'none', date: entry?.lastModDate?.toISOString() || '', attributes: '', fsSource: source, archive: archive.replaceAll('\\', '/'), archiveEntry: name });
        if (directory) { folders[source] = []; locations[source] = { archive: archive.replaceAll('\\', '/'), parent }; }
      };
      let count = 0;
      for await (const entry of zipReader.getEntriesGenerator()) {
        stop(signal);
        const name = entry.filename.replace(/\/$/, ''); safeName(name);
        if (entry.symlink || entries.has(name)) throw new Error('Verknüpfungen oder doppelte ZIP-Einträge werden nicht unterstützt.');
        entries.set(name, entry); add(name, entry.directory, entry);
        if (++count % 256 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (disposed || revision !== generation) throw new Error('Archivansicht wurde geschlossen.');
      if (signature(await handle.stat({ bigint: true })) !== signature(stat)) throw new Error('Das ZIP-Archiv wurde geändert.');
      const currentRevision = crypto.createHash('sha256').update(signature(stat)).digest('hex');
      for (const rows of Object.values(folders)) for (const row of rows) row.revision = currentRevision;
      for (const item of Object.values(locations)) item.revision = currentRevision;
      const view = { path: key, folders, locations, revision: currentRevision };
      if (sessions.get(key)?.signature === signature(stat)) return structuredClone(sessions.get(key).view);
      sessions.set(key, { archive, signature: signature(stat), entries, view });
      return structuredClone(view);
    } finally { await zipReader.close(); await handle.close(); }
  }
  async function open(value) {
    if (!/\.zip$/i.test(value)) throw new Error('Dieses ZIP-Archiv ist nicht verfügbar.');
    return openContainer(value);
  }
  const token = session => crypto.createHash('sha256').update(session.signature).digest('hex');
  async function* entries(archive, { signal } = {}) {
    const view = await openContainer(archive, signal), session = sessions.get(view.path);
    for (const rows of Object.values(view.folders)) for (const row of rows) {
      stop(signal);
      if (disposed || sessions.get(view.path) !== session) throw new Error('Archivansicht wurde geschlossen.');
      const metadata = session.entries.get(row.archiveEntry);
      yield { ...row, directory: row.type === 'folder', mtimeMs: row.date ? Date.parse(row.date) : 0, encrypted: Boolean(metadata?.encrypted), compressionMethod: metadata?.compressionMethod, revision: token(session) };
    }
  }
  async function* readEntry(reference, settings = {}) {
    const { signal } = settings;
    stop(signal);
    const view = await openContainer(reference.archive, signal), session = sessions.get(view.path);
    if (!reference.revision || token(session) !== reference.revision) throw new Error('Das ZIP-Archiv wurde geändert.');
    safeName(reference.archiveEntry);
    const metadata = session.entries.get(reference.archiveEntry);
    if (!metadata || metadata.directory || !readableMethod(metadata.compressionMethod)) throw new Error('Dieser ZIP-Eintrag ist nicht verfügbar.');
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); active.add(controller);
    if (signal?.aborted) abort();
    let handle, streamReader, pumping;
    const verify = async () => {
      stop(controller.signal);
      await noLinks(session.archive);
      if (!permitted(session.archive) || signature(await handle.stat({ bigint: true })) !== session.signature || signature(await fs.stat(session.archive, { bigint: true })) !== session.signature) throw new Error('Das ZIP-Archiv wurde geändert.');
    };
    try {
      handle = await fs.open(session.archive, 'r'); await verify();
      const reader = new zip.Reader(); reader.size = Number((await handle.stat()).size);
      reader.readUint8Array = async (offset, length) => {
        stop(controller.signal);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > reader.size - offset) throw new Error('Ungültiger ZIP-Lesebereich.');
        const bytes = Buffer.alloc(length); let count = 0;
        while (count < length) { stop(controller.signal); const result = await handle.read(bytes, count, length - count, offset + count); if (!result.bytesRead) throw new Error('Unvollständiges ZIP-Archiv.'); count += result.bytesRead; }
        options.onRead?.({ offset, length }); return bytes;
      };
      const password = await reads.run(reader.readUint8Array, () => resolvePassword(metadata, { ...settings, signal: controller.signal }));
      const stream = new TransformStream(); streamReader = stream.readable.getReader();
      let failure, total = 0;
      pumping = reads.run(reader.readUint8Array, () => metadata.getData(stream.writable, { signal: controller.signal, password })).catch(async error => { failure = error; await streamReader.cancel(error).catch(() => {}); });
      while (true) {
        stop(controller.signal);
        const next = await streamReader.read(); if (next.done) break;
        total += next.value.length;
        if (total > metadata.uncompressedSize) throw new Error('Ungültige entpackte Dateigröße.');
        yield next.value;
      }
      await pumping; if (failure) throw failure;
      if (total !== metadata.uncompressedSize) throw new Error('Ungültige entpackte Dateigröße.');
      await verify();
    } finally {
      controller.abort(); await streamReader?.cancel().catch(() => {}); await pumping;
      streamReader?.releaseLock(); await handle?.close();
      active.delete(controller); signal?.removeEventListener('abort', abort);
    }
  }
  function find(value) {
    const archive = archivePath(value), session = archive && sessions.get(location(path.resolve(archive)));
    if (!session || !Object.hasOwn(session.view.folders, value)) throw new Error('Die ZIP-Ansicht ist nicht mehr verfügbar.');
    return session;
  }
  async function copy(request, settings = {}, references) {
    stop(settings.signal);
    if (disposed) throw new Error('Archivansicht wurde geschlossen.');
    const controller = new AbortController(), signal = settings.signal;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); active.add(controller);
    try { return await extract(request, { ...settings, signal: controller.signal }, references); }
    finally { active.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  async function extract(request, settings = {}, references) {
    stop(settings.signal);
    const session = find(request.path);
    if (!Array.isArray(request.ids) || !request.ids.length || !permitted(request.target)) throw new Error('Ungültiger Entpackauftrag.');
    const rows = references || session.view.folders[request.path].filter(row => request.ids.includes(row.id));
    if (rows.length !== new Set(request.ids).size) throw new Error('Ungültige Archivauswahl.');
    const target = path.resolve(request.target);
    await noLinks(target);
    try { if (!(await fs.stat(target)).isDirectory()) throw new Error('Ein Zielordner ist erforderlich.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const selected = [...session.entries].filter(([name, entry]) => rows.some(row => name === row.archiveEntry || row.type === 'folder' && name.startsWith(`${row.archiveEntry}/`)) && (entry.directory ? request.paths !== false : matches(path.posix.basename(name), request.filter)));
    const prefix = request.path.slice(session.view.path.length).replace(/^\//, '');
    const destinations = new Set();
    const sourceIdentity = await fs.stat(session.archive, { bigint: true });
    const sourceIdentities = [sourceIdentity, ...(settings.protectedSources || [])];
    const isSource = stat => sourceIdentities.some(source => stat.dev === source.dev && stat.ino === source.ino);
    for (const [name, metadata] of selected) {
      if (!metadata.directory && !readableMethod(metadata.compressionMethod)) throw new Error('Diese ZIP-Kompressionsmethode wird nicht unterstützt.');
      if (metadata.encrypted && typeof settings.password !== 'string' && !settings.onPassword) throw new Error('Für diesen ZIP-Eintrag ist ein Passwort erforderlich.');
      const relative = request.paths === false ? path.posix.basename(name) : prefix ? name.slice(prefix.length + 1) : name; safeName(relative);
      for (const part of relative.split('/')) if (process.platform === 'win32' && (/[<>:"|?*]/.test(part) || [...part].some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Ungültiger Dateiname im Entpackziel.');
      const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
      if (destinations.has(key) && request.paths !== false) throw new Error('Mehrdeutige Namen im Entpackziel.'); destinations.add(key);
      const destination = path.join(target, ...relative.split('/'));
      try {
        const existing = await fs.lstat(destination, { bigint: true });
        if (isSource(existing)) throw new Error('Das Quellarchiv darf nicht überschrieben werden.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const handle = await fs.open(session.archive, 'r');
    const verify = async () => {
      if (!permitted(session.archive)) throw new Error('Dieses ZIP-Archiv ist nicht verfügbar.');
      await noLinks(session.archive);
      if (signature(await handle.stat({ bigint: true })) !== session.signature || signature(await fs.stat(session.archive, { bigint: true })) !== session.signature) throw new Error('Das ZIP-Archiv wurde geändert.');
    };
    let completed = 0, completedBytes = 0;
    let totalBytes = selected.reduce((sum, [, metadata]) => sum + (metadata.directory ? 0 : metadata.uncompressedSize), 0);
    const report = (name, written, total) => settings.onProgress?.(Progress.event({ phase: 'copying', currentPath: name, transferred: written, total, completedBytes: completedBytes + written, totalBytes,
      overall: Progress.known('bytes', completedBytes + written, totalBytes), current: Progress.known('bytes', written, total) }));
    try {
      await verify();
      await fs.mkdir(target, { recursive: true }); await noLinks(target);
      const reader = new zip.Reader(); reader.size = Number((await handle.stat()).size);
      reader.readUint8Array = async (offset, length) => { stop(settings.signal); const bytes = Buffer.alloc(Math.min(length, reader.size - offset)); let read = 0; while (read < bytes.length) { const result = await handle.read(bytes, read, bytes.length - read, offset + read); if (!result.bytesRead) throw new Error('Unvollständiges ZIP-Archiv.'); read += result.bytesRead; } return bytes; };
      const source = new zip.ZipReader(reader, { strictness: 'strict', useWebWorkers: false, checkCrc32: true, checkAuthenticationCode: true, checkOverlappingEntry: true });
      try {
        const needed = new Set(selected.map(([name]) => name)), actual = new Map();
        for await (const entry of source.getEntriesGenerator()) if (needed.has(entry.filename.replace(/\/$/, ''))) actual.set(entry.filename.replace(/\/$/, ''), entry);
        for (const [name, metadata] of selected) {
          stop(settings.signal); await verify();
          const relative = request.paths === false ? path.posix.basename(name) : prefix ? name.slice(prefix.length + 1) : name, destination = path.join(target, ...relative.split('/'));
          if (!permitted(destination)) throw new Error('Ungültiger Entpackpfad.');
          await noLinks(destination);
          if (metadata.directory) { await fs.mkdir(destination, { recursive: true }); continue; }
          report(name, 0, metadata.uncompressedSize);
          let existing;
          try { existing = await fs.lstat(destination, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (existing) {
            if (isSource(existing)) throw new Error('Das Quellarchiv darf nicht überschrieben werden.');
            if (!existing.isFile()) throw new Error('Das Entpackziel ist keine gewöhnliche Datei.');
            const answer = request.overwrite ? 'overwrite' : await settings.onConflict?.(destination);
            if (answer === 'skip') { totalBytes -= metadata.uncompressedSize; report(name, 0, 0); continue; }
            if (answer !== 'overwrite') throw new DOMException('Entpacken abgebrochen.', 'AbortError');
          }
          stop(settings.signal);
          await fs.mkdir(path.dirname(destination), { recursive: true }); await noLinks(destination);
          const stage = path.join(path.dirname(destination), `.zip-${crypto.randomUUID()}.tmp`);
          const output = await fs.open(stage, 'wx', 0o600);
          let written = 0, backup;
          try {
            const writer = new WritableStream({ async write(bytes) { stop(settings.signal); if (written + bytes.length > metadata.uncompressedSize) throw new Error('Ungültige entpackte Dateigröße.'); let offset = 0; while (offset < bytes.length) { const result = await output.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw new Error('Entpackziel konnte nicht geschrieben werden.'); offset += result.bytesWritten; } written += bytes.length; report(name, written, metadata.uncompressedSize); } });
            const entry = actual.get(name), password = await resolvePassword(entry, settings);
            await entry.getData(writer, { signal: settings.signal, password });
            if (written !== metadata.uncompressedSize) throw new Error('Ungültige entpackte Dateigröße.');
            if (metadata.lastModDate && Number.isFinite(metadata.lastModDate.getTime())) await output.utimes(metadata.lastModDate, metadata.lastModDate);
            await output.close(); stop(settings.signal); await verify(); await noLinks(destination);
            if (existing) {
              if (signature(await fs.lstat(destination, { bigint: true })) !== signature(existing)) throw new Error('Das Entpackziel wurde geändert.');
              backup = `${stage}.backup`; await fs.rename(destination, backup);
            }
            try { await publish(stage, destination, settings.signal); }
            catch (error) { if (backup) { try { await publish(backup, destination); await fs.unlink(backup); backup = null; } catch { throw new Error(`Wiederherstellung erforderlich: ${backup}`, { cause: error }); } } throw error; }
            if (backup) { await fs.unlink(backup); backup = null; }
            report(name, written, metadata.uncompressedSize);
            completed++; completedBytes += written;
          } finally { await output.close().catch(() => {}); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        }
      } finally { await source.close(); }
      stop(settings.signal);
      return { completed, completedBytes };
    } finally { await handle.close(); }
  }
  async function copyEntries(request, settings = {}) {
    if (!Array.isArray(request.entries) || !request.entries.length) throw new Error('Ungültige Archivauswahl.');
    const view = await openContainer(request.entries[0].archive, settings.signal), session = sessions.get(view.path);
    const all = Object.values(view.folders).flat(), rows = request.entries.map(reference => {
      if (path.resolve(reference.archive) !== session.archive || reference.revision !== token(session)) throw new Error('Das ZIP-Archiv wurde geändert.');
      const row = all.find(row => row.archiveEntry === reference.archiveEntry && row.id === reference.id);
      if (!row) throw new Error('Ungültige Archivauswahl.'); return row;
    });
    return copy({ path: view.path, ids: rows.map(row => row.id), target: request.target }, settings, rows);
  }
  const clear = () => { generation++; for (const controller of active) controller.abort(); sessions.clear(); };
  return { open, entries, readEntry, copy, copyEntries, archivePath, dispose() { disposed = true; clear(); }, clear };
}
module.exports = { createZipProvider, archivePath };
