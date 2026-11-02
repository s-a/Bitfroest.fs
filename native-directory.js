const { loadNativeApi } = require('./native-api');

function createDirectoryReader(options = {}) {
  let api, session, closed = false;
  const platform = options.platform || process.platform;
  const flags = { readonly: 1, hidden: 2, system: 4, directory: 16, archive: 32, sparse: 512, compressed: 2048, offline: 4096, encrypted: 16384 };
  const invalid = () => Object.assign(new Error('Invalid native directory response.'), { code: 'InvalidResponse' });
  return {
    async readDirectory(target, signal) {
      if (closed) throw Object.assign(new Error('Directory reader is closed.'), { code: 'SessionClosed' });
      if (platform !== 'win32') return null;
      api ||= (options.apiFactory || loadNativeApi)();
      if (api.capabilities['files.readDirectory']?.status === 'unsupported' || !api.capabilities['files.readDirectory']) return null;
      session ||= api.openSession();
      let result;
      try { result = await session.invoke('files.readDirectory', { path: target }, { signal }); }
      catch (error) {
        if (error.code === 'UnsupportedDirectoryQuery') return null;
        if (error.code === 'Cancelled') throw Object.assign(error, { name: 'AbortError' });
        throw error;
      }
      if (closed) throw Object.assign(new Error('Directory reader is closed.'), { code: 'SessionClosed' });
      if (!result || !Array.isArray(result.entries) || typeof result.volume !== 'bigint' || typeof result.directoryId !== 'bigint') throw invalid();
      const seen = new Set();
      const entries = result.entries.map(entry => {
        if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || /[\\/:\0]/.test(entry.name) || seen.has(entry.name) ||
            !Number.isInteger(entry.attributes) || entry.attributes < 0 || entry.attributes > 0xffffffff || typeof entry.dosName !== 'string' ||
            !['fileId', 'size', 'creationTime', 'lastAccessTime', 'lastWriteTime', 'changeTime'].every(field => typeof entry[field] === 'bigint') || entry.size < 0n) throw invalid();
        seen.add(entry.name);
        const attributes = Object.fromEntries(Object.entries(flags).map(([key, mask]) => [key, Boolean(entry.attributes & mask)]));
        attributes.dosName = entry.dosName;
        if (entry.attributes & 1024 || entry.fileId === 0n) return { name: entry.name, stat: null, attributes };
        const directory = attributes.directory;
        const stat = { dev: result.volume, ino: entry.fileId, size: directory ? 0n : entry.size,
          mode: BigInt((directory ? 0o040000 | 0o111 : 0o100000) | (attributes.readonly ? 0o444 : 0o666)),
          isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false };
        for (const [key, field] of [['mtime', 'lastWriteTime'], ['ctime', 'changeTime'], ['birthtime', 'creationTime'], ['atime', 'lastAccessTime']]) {
          stat[`${key}Ns`] = (entry[field] - 116444736000000000n) * 100n;
          stat[`${key}Ms`] = stat[`${key}Ns`] / 1000000n;
        }
        return { name: entry.name, stat, attributes };
      });
      return { entries, dev: result.volume, ino: result.directoryId };
    },
    dispose() { closed = true; session?.close(); session = undefined; }
  };
}

module.exports = { createDirectoryReader };
