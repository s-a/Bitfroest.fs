const { loadNativeApi } = require('./native-api');

async function openTrash(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' && platform !== 'linux') throw Object.assign(new Error('Diese Funktion wird auf diesem Betriebssystem noch nicht unterstützt.'), { code: 'ENOTSUPPORTED' });
  try {
    if (platform === 'win32' || platform === 'linux') {
      const session = (options.nativeApi || loadNativeApi()).openSession();
      let timer;
      try {
        const result = await Promise.race([
          session.invoke('shell.openTrash', { inspectOnly: false }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Trash opening timed out.'), { code: 'ETIMEDOUT' })), options.timeout ?? 10000);
          })
        ]);
        if (result?.available !== true || result?.requested !== true) throw new Error('Invalid native trash opening response.');
      } finally { clearTimeout(timer); session.close(); }
    }
  } catch (cause) {
    const message = ['ENOENT', 'Unavailable', 'UnsupportedOperation'].includes(cause.code) ? 'Die Papierkorbansicht ist auf diesem System nicht verfügbar.' : cause.code === 'ETIMEDOUT' || cause.killed ? 'Zeitlimit beim Öffnen des Papierkorbs überschritten.' : 'Der Papierkorb konnte nicht geöffnet werden.';
    throw new Error(message, { cause });
  }
  return { requested: true };
}

module.exports = { openTrash };
