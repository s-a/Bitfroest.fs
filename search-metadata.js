const path = require('node:path');
const { loadNativeApi } = require('./native-api');
function createSearchMetadata(options = {}) {
  let session, disposed = false;
  const pending = new Set();
  const platform = options.platform || process.platform;
  const apiFactory = options.apiFactory || loadNativeApi;
  function closedError() { return Object.assign(new Error('Die Metadatenabfrage wurde beendet.'), { code: 'SessionClosed' }); }
  function assertOpen() {
    if (disposed) throw closedError();
  }
  return {
    async attributes(target, stat, shortName = false) {
      assertOpen();
      if (platform !== 'win32') return { directory: stat.isDirectory(), readonly: !(stat.mode & 0o200), archive: stat.isFile(), hidden: path.basename(target).startsWith('.'), system: false, compressed: false, encrypted: false };
      session ||= apiFactory().openSession();
      const result = await new Promise((resolve, reject) => {
        const task = { reject }; pending.add(task);
        try {
          Promise.resolve(session.invoke('metadata.query', { path: target, ...(shortName ? { shortName: true } : {}) })).then(
            value => { pending.delete(task); resolve(value); },
            error => { pending.delete(task); reject(error); }
          );
        } catch (error) { pending.delete(task); reject(error); }
      });
      assertOpen();
      const flags = result?.attributes;
      if (!flags || !['directory', 'readonly', 'archive', 'hidden', 'system', 'compressed', 'encrypted'].every(key => typeof flags[key] === 'boolean')) throw Object.assign(new Error('Ungültige Dateiattribute.'), { code: 'InvalidResponse' });
      return shortName ? { ...flags, ...(typeof result.dosName === 'string' ? { dosName: result.dosName } : {}) } : flags;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const task of pending) task.reject(closedError());
      pending.clear();
      session?.close(); session = undefined;
    }
  };
}
module.exports = { createSearchMetadata };
