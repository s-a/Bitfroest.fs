const path = require('node:path');
const { loadNativeApi } = require('./native-api');

async function openAssociatedFile(target, options = {}) {
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof target !== 'string' || !paths.isAbsolute(target) || target.includes('\0')) throw new Error('Ungültiger Dateipfad.');
  if (platform === 'win32' || platform === 'linux') {
      const session = (options.nativeApi || loadNativeApi()).openSession();
      let timer;
      try {
        const response = await Promise.race([
          session.invoke('shell.openAssociated', { path: target, ...(options.inspectOnly ? { inspectOnly: true } : {}) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Die Programmöffnung antwortet nicht.'), { code: 'DesktopTimeout' })), options.timeout || 15000); })
        ]);
        if (typeof response?.editor !== 'boolean') throw new Error('Ungültige Antwort beim Öffnen der Datei.');
        if (platform === 'linux' && !options.inspectOnly && (response.available !== true || response.requested !== true)) throw new Error('Ungültige Antwort beim Öffnen der Datei.');
        return { editor: response.editor };
      } finally {
        clearTimeout(timer);
        try { session.close(); } catch { /* Session cleanup must not replace the lookup result. */ }
      }
  }
  throw Object.assign(new Error('Diese Funktion wird auf diesem Betriebssystem noch nicht unterstützt.'), { code: 'ENOTSUPPORTED' });
}

module.exports = { openAssociatedFile };
