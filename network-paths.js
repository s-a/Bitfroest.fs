'use strict';
const { loadNativeApi } = require('./native-api');

async function resolveUncPaths(paths, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return [...paths];
  const driveOf = value => /^[a-z]:[\\/]/i.test(value) ? value.slice(0, 2).toUpperCase() : null;
  const drives = [...new Set(paths.map(driveOf).filter(Boolean))];
  if (!drives.length) return [...paths];
  try {
    let response;
    if (options.nativeApi || !options.runHelper) {
      const session = (options.nativeApi || loadNativeApi()).openSession();
      let timer;
      try {
        response = await Promise.race([
          session.invoke('paths.resolveNetwork', { drives }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Network lookup timed out.')), options.timeout || 10000); })
        ]);
      } finally { clearTimeout(timer); session.close(); }
    } else {
      response = await options.runHelper({ drives });
    }
    const result = typeof response === 'string' ? JSON.parse(response.replace(/^\uFEFF/, '')) : response;
    const mappings = result?.mappings;
    const validRoot = value => typeof value === 'string' && !value.startsWith('\\\\?\\') && /^\\\\[^\\/\s]+\\[^\\/]+(?:\\[^\\/]+)*\\?$/.test(value) && !/[\r\n\t\0]/.test(value)
      && value.slice(2).replace(/\\$/, '').split('\\').every(part => part !== '.' && part !== '..');
    return paths.map(original => {
      const drive = driveOf(original), remote = drive && mappings?.[drive];
      return validRoot(remote) ? remote.replace(/\\$/, '') + '\\' + original.slice(3).replaceAll('/', '\\') : original;
    });
  } catch { return [...paths]; }
}

module.exports = { resolveUncPaths };
