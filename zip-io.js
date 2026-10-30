const fs = require('node:fs/promises');
const path = require('node:path');

const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const stop = signal => { if (signal?.aborted) throw new DOMException('Entpacken abgebrochen.', 'AbortError'); };
const location = archive => `zip:${encodeURIComponent(archive.replaceAll('\\', '/')).replaceAll('!', '%21')}!`;
function archivePath(value) {
  if (typeof value !== 'string' || !value.startsWith('zip:')) return null;
  const boundary = value.indexOf('!');
  if (boundary < 0) return null;
  try { return decodeURIComponent(value.slice(4, boundary)); } catch { return null; }
}
async function noLinks(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Verknüpfungen sind als Archiv- oder Entpackpfad nicht erlaubt.'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}
function safeName(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Ungültiger Archivpfad.');
}
async function publish(source, destination, signal) {
  stop(signal);
  try { await fs.link(source, destination); return; }
  catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
  }
  stop(signal);
    const output = await fs.open(destination, 'wx', 0o600);
    let input;
    try {
      input = await fs.open(source, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      while (true) {
        stop(signal);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let offset = 0;
        while (offset < bytesRead) { stop(signal); const result = await output.write(buffer, offset, bytesRead - offset); if (!result.bytesWritten) throw new Error('Entpackziel konnte nicht geschrieben werden.'); offset += result.bytesWritten; }
      }
      const stat = await input.stat(); await output.utimes(stat.atime, stat.mtime);
      stop(signal);
    } catch (failure) {
      const owned = signature(await output.stat({ bigint: true }));
      await output.close();
      if (signature(await fs.lstat(destination, { bigint: true })) !== owned) throw new Error(`Wiederherstellung erforderlich: ${destination}`, { cause: failure });
      await fs.unlink(destination); throw failure;
    } finally { await input?.close(); await output.close().catch(() => {}); }
}

module.exports = { signature, stop, location, archivePath, noLinks, safeName, publish };
