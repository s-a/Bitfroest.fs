const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { WritableStream, TransformStream } = require('node:stream/web');
const zip = require('@zip.js/zip.js');
const { signature, stop, noLinks, safeName, publish } = require('./zip-io');
const { resolvePassword } = require('./zip-password');
require('./zip-codecs');

const tree = (name, root) => name === root || name.startsWith(`${root}/`);
const revision = stat => crypto.createHash('sha256').update(signature(stat)).digest('hex');
const normalize = name => { const value = name.replace(/\/$/, ''); safeName(value); return value; };
async function exists(target) { try { return await fs.lstat(target, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
function fileReader(handle, size, signal, maxMetadataBytes = 64 * 1024 * 1024) {
  const reader = new zip.Reader(); reader.size = size;
  reader.readUint8Array = async (offset, length) => {
    stop(signal);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > size - offset) throw new Error('Ungültiger ZIP-Lesebereich.');
    if (length > maxMetadataBytes) throw new Error('Das ZIP-Inhaltsverzeichnis überschreitet das verfügbare Lesebudget.');
    const bytes = Buffer.alloc(length); let count = 0;
    while (count < length) { stop(signal); const result = await handle.read(bytes, count, length - count, offset + count); if (!result.bytesRead) throw new Error('Unvollständiges ZIP-Archiv.'); count += result.bytesRead; }
    return bytes;
  };
  return reader;
}
function encryptionOptions(mode, password) {
  if (!mode || mode === 'none') return {};
  if (!['zipcrypto', 'aes128', 'aes192', 'aes256'].includes(mode) || typeof password !== 'string' || !password) throw new Error('Ein Passwort und eine gültige ZIP-Verschlüsselung sind erforderlich.');
  return { password, zipCrypto: mode === 'zipcrypto', encryptionStrength: { aes128: 1, aes192: 2, aes256: 3 }[mode] || 3 };
}
function createZipOperations(options = {}) {
  const readFile = (handle, size, signal) => fileReader(handle, size, signal, options.maxMetadataBytes);
  const active = new Set(); let disposed = false;
  const allowed = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !options.contains?.(value)) throw new Error('Ungültiger Archiv- oder Dateipfad.');
    return path.resolve(value);
  };
  async function collect(request, archive, settings) {
    const { signal } = settings;
    const files = [], roots = [], names = new Set();
    const inside = request.inside ? normalize(request.inside) : '';
    const add = item => { const key = normalize(item.name); if (names.has(key)) throw new Error('Doppelte Namen im ZIP-Auftrag.'); names.add(key); files.push(item); };
    async function visit(source, relative, root) {
      stop(signal); allowed(source); settings.onProgress?.({ phase: 'preparing', currentPath: source }); stop(signal);
      await noLinks(source);
      const stat = await fs.lstat(source, { bigint: true });
      if (path.resolve(source) === archive || stat.isFile() && (await exists(archive))?.ino === stat.ino && (await exists(archive))?.dev === stat.dev) throw new Error('Das Quellarchiv kann nicht in sich selbst gepackt werden.');
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Nur gewöhnliche Dateien und Verzeichnisse können gepackt werden.');
      const name = [inside, request.paths === false ? path.basename(relative) : relative].filter(Boolean).join('/');
      if (stat.isDirectory()) {
        if (relative && request.paths !== false) add({ name: name + '/', directory: true, source, stat });
        if (request.recursive === false && !root) return;
        for (const child of await fs.readdir(source)) await visit(path.join(source, child), [relative, child].filter(Boolean).join('/'), false);
      } else add({ name, source, stat });
    }
    for (const value of request.sources || []) {
      const source = allowed(value), stat = await fs.lstat(source, { bigint: true });
      roots.push({ path: source, stat });
      await visit(source, request.omitRoot && stat.isDirectory() ? '' : path.basename(source), true);
    }
    for (const item of request.additions || []) {
      const name = [inside, normalize(item.name)].filter(Boolean).join('/');
      if (typeof item.data !== 'string' && !Buffer.isBuffer(item.data) && !(item.data instanceof Uint8Array) && !item.data?.[Symbol.asyncIterator] && !item.directory) throw new Error('Ungültiger neuer ZIP-Inhalt.');
      add({ name: name + (item.directory ? '/' : ''), directory: Boolean(item.directory), data: item.data, date: item.date, preserveMetadata: item.preserveMetadata });
    }
    return { files, roots };
  }
  async function run(operation, settings = {}) {
    if (disposed) throw new Error('Archivansicht wurde geschlossen.');
    const controller = new AbortController(), abort = () => controller.abort(settings.signal?.reason);
    settings.signal?.addEventListener('abort', abort, { once: true }); if (settings.signal?.aborted) abort(); active.add(controller);
    try { return await operation({ ...settings, signal: controller.signal }); }
    finally { active.delete(controller); settings.signal?.removeEventListener('abort', abort); }
  }
  const write = (request, settings) => run(current => transact(request, current), settings);
  async function localFields(reader, entry) {
    const header = await reader.readUint8Array(entry.offset, 30);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50) throw new Error('Ungültiger lokaler ZIP-Dateikopf.');
    const bytes = await reader.readUint8Array(entry.offset + 30 + view.getUint16(26, true), view.getUint16(28, true));
    const fields = new Map(), data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length;) {
      if (bytes.length - offset < 4) throw new Error('Ungültiges lokales ZIP-Zusatzfeld.');
      const id = data.getUint16(offset, true), size = data.getUint16(offset + 2, true); offset += 4;
      if (size > bytes.length - offset) throw new Error('Ungültiges lokales ZIP-Zusatzfeld.');
      fields.set(id, bytes.slice(offset, offset + size)); offset += size;
    }
    return fields;
  }
  async function transact(request, settings) {
    const archive = allowed(request.archive), signal = settings.signal; stop(signal); await noLinks(archive);
    const original = await exists(archive);
    if (original && !original.isFile()) throw new Error('Das Archivziel ist keine gewöhnliche Datei.');
    if (request.revision && (!original || revision(original) !== request.revision)) throw new Error('Das ZIP-Archiv wurde geändert.');
    if (original && request.confirmExisting) {
      if (await settings.onArchiveExists?.(archive) !== 'update') throw new DOMException('Packen abgebrochen.', 'AbortError');
      stop(signal); await noLinks(archive);
      const confirmed = await exists(archive);
      if (!confirmed || signature(confirmed) !== signature(original)) throw new Error('Das ZIP-Archiv wurde geändert.');
    }
    if (request.level !== undefined && (!Number.isInteger(request.level) || request.level < 0 || request.level > 9)) throw new Error('Die ZIP-Kompressionsrate muss zwischen 0 und 9 liegen.');
    const encryption = encryptionOptions(request.encryption, request.password);
    const removal = (request.remove || []).map(normalize), renames = (request.rename || []).map(item => ({ from: normalize(item.from), to: normalize(item.to) }));
    const { files, roots } = await collect(request, archive, settings);
    const stage = path.join(path.dirname(archive), `.zip-write-${crypto.randomUUID()}.tmp`);
    let input, source, output, writer, backup, originalComment, committedResult, publishedStat;
    const skipped = new Set(); let completed = 0;
    const progress = (phase, currentPath, transferred = 0, total) => settings.onProgress?.({ phase, currentPath, completed, transferred, total });
    async function cleanup() {
      const beforeCleanup = committedResult && await fs.stat(archive, { bigint: true }).catch(() => null);
      try {
        await source?.close(); await input?.close(); await output?.close().catch(() => {});
        await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } catch (error) { if (committedResult) error.committedResult = committedResult; throw error; }
      finally {
        if (publishedStat && beforeCleanup && signature(publishedStat) === signature(beforeCleanup)) {
          const afterCleanup = await fs.stat(archive, { bigint: true }).catch(() => null);
          if (afterCleanup && ['dev', 'ino', 'size', 'mtimeNs'].every(key => afterCleanup[key] === publishedStat[key])) committedResult.revision = revision(afterCleanup);
        }
      }
    }
    try {
      let previous = [];
      if (original) {
        input = await fs.open(archive, 'r');
        source = new zip.ZipReader(readFile(input, Number(original.size), signal), { strictness: 'strict', useWebWorkers: false, checkCrc32: true, checkAuthenticationCode: true });
        previous = await source.getEntries(); originalComment = source.comment;
        for (const root of [...removal, ...renames.map(item => item.from)]) if (!previous.some(entry => tree(normalize(entry.filename), root))) throw new Error('Dieser Archiveintrag ist nicht vorhanden.');
      }
      const keep = [], seen = new Set();
      for (const entry of previous) {
        const name = normalize(entry.filename); if (removal.some(root => tree(name, root))) continue;
        const rename = renames.find(item => tree(name, item.from)), destination = rename ? rename.to + name.slice(rename.from.length) : name;
        const incoming = files.find(item => normalize(item.name) === destination);
        if (incoming && !entry.directory) {
          const decision = request.policy === 'overwrite' ? 'overwrite' : request.policy === 'skip' ? 'skip' : await settings.onConflict?.(destination, entry);
          if (decision === 'overwrite') {
            if (incoming.preserveMetadata) { incoming.metadata = entry; incoming.localExtraField = await localFields(readFile(input, Number(original.size), signal), entry); }
            continue;
          }
          if (decision !== 'skip') throw new DOMException('Packen abgebrochen.', 'AbortError');
          skipped.add(destination);
        }
        if (seen.has(destination)) throw new Error('Doppelte Namen im ZIP-Auftrag.'); seen.add(destination);
        keep.push({ entry, name: destination + (entry.directory ? '/' : '') });
      }
      const planned = new Map(keep.map(item => [normalize(item.name), item.entry.directory]));
      for (const item of files) if (!skipped.has(normalize(item.name))) {
        const name = normalize(item.name);
        if (planned.has(name) && planned.get(name) !== item.directory) throw new Error('Datei und Verzeichnis belegen denselben Archivpfad.');
        planned.set(name, Boolean(item.directory));
      }
      for (const name of planned.keys()) {
        const parts = name.split('/'); parts.pop();
        while (parts.length) { if (planned.get(parts.join('/')) === false) throw new Error('Eine Datei kann kein übergeordnetes Archivverzeichnis sein.'); parts.pop(); }
      }
      stop(signal); await noLinks(archive);
      output = await fs.open(stage, 'wx', 0o600);
      const writable = new WritableStream({ async write(bytes) { stop(signal); let offset = 0; while (offset < bytes.length) { const result = await output.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw new Error('ZIP-Ausgabe konnte nicht geschrieben werden.'); offset += result.bytesWritten; } } });
      writer = new zip.ZipWriter(writable, { useWebWorkers: false, level: request.level ?? 6, zip64: request.zip64 });
      const unchanged = new Set(keep.filter(item => item.name === item.entry.filename).map(item => item.name));
      progress('packing', archive);
      if (unchanged.size) await writer.appendZip(readFile(input, Number(original.size), signal), { filter: entry => unchanged.has(entry.filename), readerOptions: { strictness: 'strict' } });
      for (const { entry, name } of keep) {
        if (unchanged.has(name)) continue;
        stop(signal); progress('packing', name);
        const localExtraField = await localFields(readFile(input, Number(original.size), signal), entry);
        if (entry.directory) await writer.add(name, null, { entry, localExtraField, directory: true, passThrough: true, signal });
        else {
          const stream = new TransformStream();
          await Promise.all([entry.getData(stream.writable, { passThrough: true, signal }), writer.add(name, stream.readable, { entry, localExtraField, passThrough: true, signal })]);
        }
      }
      for (const item of files) {
        stop(signal); const name = normalize(item.name);
        if (skipped.has(name) || item.directory && seen.has(name)) continue;
        if (seen.has(name)) throw new Error('Doppelte Namen im ZIP-Auftrag.'); seen.add(name);
        progress('packing', item.name);
        let stream, handle;
        try {
          if (item.source && !item.directory) {
            await noLinks(item.source); handle = await fs.open(item.source, 'r');
            if (signature(await handle.stat({ bigint: true })) !== signature(item.stat)) throw new Error('Die Quelldatei wurde geändert.');
            stream = Readable.toWeb(handle.createReadStream({ autoClose: false }));
          }
          const data = item.directory ? null : stream || (item.data?.[Symbol.asyncIterator] ? Readable.toWeb(Readable.from(item.data)) : new zip.Uint8ArrayReader(Buffer.from(item.data)));
          await writer.add(item.name, data, { entry: item.metadata, localExtraField: item.localExtraField, ...encryption, directory: item.directory, lastModDate: item.stat?.mtime || item.date || new Date(), signal, onprogress: (loaded, total) => progress('packing', item.name, loaded, total) });
          if (handle && signature(await handle.stat({ bigint: true })) !== signature(item.stat)) throw new Error('Die Quelldatei wurde geändert.');
          completed++;
        } finally { await handle?.close(); }
      }
      await writer.close(request.comment === undefined ? originalComment : new TextEncoder().encode(request.comment)); writer = null;
      await output.close(); output = null; await source?.close(); source = null; await input?.close(); input = null;
      stop(signal);
      await noLinks(archive);
      const current = await exists(archive);
      if (original ? !current || signature(current) !== signature(original) : current) throw new Error('Das ZIP-Archiv wurde geändert.');
      if (original) { backup = stage + '.backup'; await fs.rename(archive, backup); }
      try { await publish(stage, archive, signal); }
      catch (error) {
        if (backup) { try { await publish(backup, archive); await fs.unlink(backup); backup = null; } catch { throw new Error(`Wiederherstellung erforderlich: ${backup}`, { cause: error }); } }
        throw error;
      }
      committedResult = { archive, completed, committed: true };
      publishedStat = await fs.stat(archive, { bigint: true }); committedResult.revision = revision(publishedStat);
      await fs.unlink(stage);
      publishedStat = await fs.stat(archive, { bigint: true }); committedResult.revision = revision(publishedStat);
      if (backup) { await fs.unlink(backup); backup = null; }
      stop(signal);
      if (request.verify !== false) await testArchive(archive, { ...settings, password: request.password });
      if (request.move) {
        for (const item of files.filter(item => item.source && !item.directory && !skipped.has(normalize(item.name)))) {
          stop(signal);
          await noLinks(item.source);
          if (signature(await fs.lstat(item.source, { bigint: true })) !== signature(item.stat)) throw new Error('Archiv gespeichert; geänderte Quelldatei wurde nicht entfernt.');
          await fs.unlink(item.source);
        }
        for (const item of files.filter(item => item.directory && item.source).sort((a, b) => b.source.length - a.source.length)) await fs.rmdir(item.source).catch(error => { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
        for (const root of roots.filter(root => root.stat.isDirectory())) await fs.rmdir(root.path).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
      }
      stop(signal);
      return committedResult;
    } catch (error) {
      if (committedResult) error.committedResult = committedResult;
      throw error;
    } finally { await cleanup(); }
  }
  async function testArchive(value, settings = {}) {
    const archive = allowed(value); await noLinks(archive); stop(settings.signal);
    const handle = await fs.open(archive, 'r'), original = await handle.stat({ bigint: true });
    const reader = new zip.ZipReader(readFile(handle, Number(original.size), settings.signal), { checkCrc32: true, checkAuthenticationCode: true, useWebWorkers: false });
    let files = 0, bytes = 0;
    try {
      const entries = await reader.getEntries(), totalBytes = entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.uncompressedSize), 0);
      settings.onProgress?.({ phase: 'verifying', currentPath: archive, completedBytes: 0, totalBytes });
      for (const entry of entries) {
        stop(settings.signal); if (entry.directory) continue;
        let transferred = 0;
        const report = () => settings.onProgress?.({ phase: 'verifying', currentPath: entry.filename, transferred, total: entry.uncompressedSize, completedBytes: bytes, totalBytes });
        report(); stop(settings.signal);
        const password = await resolvePassword(entry, settings);
        await entry.getData(new WritableStream({ write(chunk) { stop(settings.signal); bytes += chunk.length; transferred += chunk.length; report(); } }), { password, signal: settings.signal }); files++;
      }
      stop(settings.signal);
      if (signature(await handle.stat({ bigint: true })) !== signature(original) || signature(await fs.stat(archive, { bigint: true })) !== signature(original)) throw new Error('Das ZIP-Archiv wurde geändert.');
      return { files, bytes };
    } finally { await reader.close(); await handle.close(); }
  }
  const clear = () => { for (const controller of active) controller.abort(); active.clear(); };
  return { write, test: (value, settings) => run(current => testArchive(value, current), settings), clear, dispose() { disposed = true; clear(); } };
}
module.exports = { createZipOperations };
