const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadNativeApi } = require('./native-api');

function createGitIndexProvider(options = {}) {
  let api, disposed = false;
  const tickets = new WeakSet();
  function native() {
    if (disposed) throw Object.assign(new Error('The Git index provider is closed.'), { code: 'SessionClosed' });
    api ||= options.nativeApi || loadNativeApi();
    if (api.capabilities['git.untrack']?.status !== 'supported') throw Object.assign(new Error('Git index actions are unavailable on this platform.'), { code: 'UnsupportedOperation' });
    return api;
  }
  const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return {
    async prepare({ repositoryRoot, target }) {
      const session = native().openSession();
      try {
        const info = await session.invoke('git.info', { directory: repositoryRoot });
        if (!info.repository || identity(info.root) !== identity(repositoryRoot)) throw Object.assign(new Error('The Git repository root has changed.'), { code: 'RepositoryMismatch' });
        const relative = path.relative(repositoryRoot, target);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Object.assign(new Error('The file is outside the Git repository.'), { code: 'UnsafePath' });
        const stat = await fs.lstat(target, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('The selected path is not a regular file.'), { code: 'UnsafePath' });
        const bytes = await fs.readFile(path.join(info.gitdir, 'index'));
        const ticket = Object.freeze({ repositoryRoot, target, expectedHead: info.head || '', expectedReference: info.detached ? 'HEAD' : 'refs/heads/' + info.branch, expectedIndex: crypto.createHash('sha256').update(bytes).digest('hex'), expectedIno: stat.ino.toString() });
        tickets.add(ticket); return ticket;
      } finally { await session.closeAsync(); }
    },
    async untrack(ticket, settings = {}) {
      if (!tickets.has(ticket)) throw Object.assign(new Error('A captured Git index ticket is required.'), { code: 'InvalidRequest' });
      tickets.delete(ticket);
      const session = native().openSession();
      try { return await session.invoke('git.untrack', ticket, settings); }
      finally { await session.closeAsync(); }
    },
    dispose() { disposed = true; if (api && !options.nativeApi) api.shutdown(); }
  };
}
module.exports = { createGitIndexProvider };
