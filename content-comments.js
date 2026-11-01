const nativeFs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const Progress = require('./media/commander-progress');
const { throwIfAborted } = require('./native-copy');

async function readDirectoryComments(directory, names, options = {}) {
  const fs = options.fs || fsPromises, result = new Map();
  const key = name => (options.platform || process.platform) === 'win32' ? name.toLowerCase() : name;
  const filenames = new Set(names.map(key));
  const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].map(String).join(':');
  for (const source of ['descript.ion', 'files.bbs']) {
    throwIfAborted(options.signal);
    const name = names.find(name => key(name) === source);
    if (!name) continue;
    let handle;
    const values = new Map();
    try {
      const target = path.join(directory, name), before = await fs.lstat(target);
      if (!before.isFile() || before.isSymbolicLink()) continue;
      handle = await fs.open(target, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (signature(opened) !== signature(before)) continue;
      const buffer = Buffer.alloc(65536);
      let completedBytes = 0;
      const report = () => options.onProgress?.(Progress.event({ phase: 'directory-comments', path: target, overall: Progress.unknown('bytes', completedBytes, 'enumerating'), current: Number.isSafeInteger(opened.size) && completedBytes <= opened.size ? Progress.known('bytes', completedBytes, opened.size) : Progress.unknown('bytes', completedBytes, 'stream-size-unknown') }));
      await report();
      let decoder, pending = '', previous, skipping = false;
      function line(text) {
        if (source === 'files.bbs' && /^\s/.test(text) && previous && text.trim()) { values.set(previous, values.get(previous) + '\n' + text.trim()); return; }
        const match = /^(?:"([^"\r\n]+)"|([^\s"]+))[ \t]+(.*)$/.exec(text);
        previous = undefined;
        if (!match) return;
        const filename = match[1] || match[2];
        if (/[\\/\0]/.test(filename) || filename === '.' || filename === '..' || !filenames.has(key(filename))) return;
        let comment = match[3];
        const marker = comment.indexOf('\x04');
        if (marker >= 0) {
          const multiline = comment.slice(marker + 1).includes('\u00c2') || comment.slice(marker + 1).includes('\ufffd');
          comment = comment.slice(0, marker);
          if (multiline) comment = comment.replace(/\\([n\\])/g, (_, value) => value === 'n' ? '\n' : '\\');
        }
        previous = key(filename); values.set(previous, comment);
      }
      while (true) {
        throwIfAborted(options.signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        completedBytes += bytesRead;
        await report();
        if (!decoder) {
          const encoding = bytesRead >= 2 && buffer[0] === 255 && buffer[1] === 254 ? 'utf-16le' : bytesRead >= 2 && buffer[0] === 254 && buffer[1] === 255 ? 'utf-16be' : bytesRead >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191 ? 'utf-8' : options.encoding || 'windows-1252';
          try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder('windows-1252'); }
        }
        const chunks = (pending + decoder.decode(buffer.subarray(0, bytesRead), { stream: true })).split('\n');
        pending = chunks.pop();
        for (const chunk of chunks) { if (!skipping) line(chunk.replace(/\r$/, '')); skipping = false; }
        if (pending.length > 32768) { pending = ''; skipping = true; previous = undefined; }
      }
      if (!skipping) line((pending + (decoder?.decode() || '')).replace(/\r$/, ''));
      if (signature(await handle.stat()) !== signature(before) || signature(await fs.lstat(target)) !== signature(before)) continue;
      for (const [filename, comment] of values) if (!result.has(filename)) result.set(filename, comment);
    } catch (error) {
      if (error.name === 'AbortError' || !['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL'].includes(error.code)) throw error;
    } finally { await handle?.close(); }
  }
  return result;
}

module.exports = { readDirectoryComments };
