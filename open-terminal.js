const path = require('node:path');
const { loadNativeApi } = require('./native-api');

async function openTerminal(directory, options = {}) {
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof directory !== 'string' || !paths.isAbsolute(directory) || directory.includes('\0')) throw new Error('Ungültiger Ordnerpfad.');
  if (platform === 'win32') {
    const session = (options.nativeApi || loadNativeApi()).openSession();
    let timer;
    try {
      const result = await Promise.race([
        session.invoke('shell.openTerminal', { path: path.win32.normalize(directory) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Die Programmöffnung antwortet nicht.'), { code: 'DesktopTimeout' })), options.timeout || 15000); })
      ]);
      if (result?.requested !== true) throw new Error('Ungültige Antwort beim Öffnen des Terminals.');
    } finally {
      clearTimeout(timer);
      try { session.close(); } catch { /* Preserve the launch result during cleanup. */ }
    }
    return;
  }
  if (platform === 'linux') {
    options.window.createTerminal({ cwd: directory }).show();
    return;
  }
  throw Object.assign(new Error('Diese Funktion wird auf diesem Betriebssystem noch nicht unterstützt.'), { code: 'ENOTSUPPORTED' });
}

module.exports = { openTerminal };
