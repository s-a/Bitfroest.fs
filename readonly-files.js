const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createReadonlyResources(vscode, options) {
  const io = options.fs || fs, translate = options.t || (text => text), resources = new Map();
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxResources = options.maxResources ?? 256;
  let disposed = false;
  const unavailable = () => vscode.FileSystemError.Unavailable(translate('Die Datei ist verändert, zu groß oder nicht vollständig lesbar.'));
  const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  function validate(original) {
    if (disposed || typeof original !== 'string' || !options.validate(original)) throw vscode.FileSystemError.NoPermissions();
  }
  async function inspect(original) {
    validate(original);
    const stat = await io.lstat(original);
    validate(original);
    if (stat.isSymbolicLink() || !stat.isFile()) throw vscode.FileSystemError.NoPermissions();
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw unavailable();
    if (stat.size > maxBytes) throw vscode.FileSystemError.Unavailable(`${translate('Die Datei überschreitet die Grenze für Konfliktansichten.')} (${maxBytes} Bytes)`);
    return stat;
  }
  async function resolve(uri) {
    const resource = resources.get(uri.toString());
    if (!resource || disposed) throw vscode.FileSystemError.FileNotFound();
    const stat = await inspect(resource.original);
    if (signature(stat) !== resource.signature) throw unavailable();
    return { ...resource, stat };
  }
  const deny = () => { throw vscode.FileSystemError.NoPermissions(); };
  const provider = {
    onDidChangeFile: () => ({ dispose() {} }),
    watch: () => ({ dispose() {} }),
    async stat(uri) {
      const resource = await resolve(uri), stat = resource.stat;
      return { type: vscode.FileType.File, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, permissions: vscode.FilePermission.Readonly };
    },
    async readFile(uri) {
      const resource = await resolve(uri);
      const handle = await io.open(resource.original, 'r');
      try {
        if (signature(await handle.stat()) !== resource.signature) throw unavailable();
        const bytes = Buffer.alloc(resource.stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== resource.stat.size || signature(await handle.stat()) !== resource.signature) throw unavailable();
        await resolve(uri);
        return bytes.subarray(0, offset);
      } finally { await handle.close(); }
    },
    readDirectory() { throw vscode.FileSystemError.FileNotADirectory(); },
    writeFile: deny, delete: deny, rename: deny, createDirectory: deny
  };
  const registration = vscode.workspace.registerFileSystemProvider('bitfroest-conflict', provider, { isReadonly: true, isCaseSensitive: true });
  return {
    async createUri(original, expected) {
      const expectedSize = expected?.size, expectedTime = expected?.mtimeMs;
      const stat = await inspect(original);
      if (Number.isFinite(expectedSize) && stat.size !== expectedSize || Number.isFinite(expectedTime) && Math.trunc(stat.mtimeMs) !== Math.trunc(expectedTime)) throw unavailable();
      const name = path.posix.basename(original.replace(/\\/g, '/'));
      const uri = vscode.Uri.from({ scheme: 'bitfroest-conflict', path: `/${crypto.randomUUID()}/${name}` });
      resources.set(uri.toString(), { original, signature: signature(stat) });
      while (resources.size > maxResources) resources.delete(resources.keys().next().value);
      return uri;
    },
    dispose() { disposed = true; resources.clear(); registration.dispose(); }
  };
}
module.exports = { createReadonlyResources };
