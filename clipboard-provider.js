const { loadNativeApi } = require('./native-api');

function createClipboardProvider(options = {}) {
  const platform = options.platform || process.platform;
  const contains = options.contains || (() => false);
  const loadNative = options.nativeApiFactory || loadNativeApi;
  let nativeApi, nativeSession, nativeQueue = Promise.resolve(), disposed = false;
  function unavailable(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined); error.code = 'CLIPBOARD_UNAVAILABLE'; return error;
  }
  function paths(value, empty = false) {
    if (!Array.isArray(value) || (!empty && !value.length) || value.length > 1024) throw new Error('Ungültige Datei-Zwischenablage.');
    const result = [], seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string' || item.length > 4096 || item.includes('\0') || !/^(?:[a-z]:[\\/]|\/)/i.test(item) || item.split(/[\\/]/).includes('..')) throw new Error('Ungültiger Zwischenablage-Pfad.');
      const normalized = item.replace(/\\/g, '/');
      if (!contains(normalized)) throw new Error('Zwischenablage enthält Pfade außerhalb der freigegebenen Ordner.');
      const identity = /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
      if (!seen.has(identity)) { seen.add(identity); result.push(normalized); }
    }
    return result;
  }
  function mode(value) {
    if (!['copy', 'move'].includes(value)) throw new Error('Diese Datei-Zwischenablage-Aktion wird nicht unterstützt.');
    return value;
  }
  async function invoke(payload) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 1048576) throw new Error('Datei-Zwischenablage überschreitet die Größenbegrenzung.');
    if (platform === 'win32') {
      const operation = payload.action === 'read' ? 'clipboard.readFiles' : payload.action === 'write' ? 'clipboard.writeFiles' : payload.action === 'reset' ? 'clipboard.cancelFiles' : 'clipboard.acknowledge';
      const request = payload.action === 'read' ? {} : payload.action === 'write'
        ? { paths: payload.paths, mode: payload.mode }
        : { token: payload.token, paths: payload.paths, mode: payload.mode, ...(payload.action === 'reset' ? {} : { remainingPaths: payload.remainingPaths }) };
      const result = nativeQueue.then(async () => {
        if (disposed) throw Object.assign(new Error('Datei-Zwischenablage ist geschlossen.'), { code: 'SessionClosed' });
        if (!nativeApi) nativeApi = loadNative();
        if (nativeApi.capabilities?.[operation]?.status === 'unsupported') throw unavailable('Native Datei-Zwischenablage ist auf dieser Plattform nicht verfügbar.');
        if (!nativeSession) nativeSession = nativeApi.openSession();
        const session = nativeSession;
        let timer;
        try {
          return await Promise.race([
            session.invoke(operation, request),
            new Promise((_, reject) => { timer = setTimeout(() => {
              if (nativeSession === session) nativeSession = null;
              try { session.close(); } catch { /* Preserve the timeout result. */ }
              reject(Object.assign(new Error('Datei-Zwischenablage antwortet nicht.'), { code: 'ClipboardTimeout' }));
            }, options.timeout || 10000); })
          ]);
        } finally { clearTimeout(timer); }
      });
      nativeQueue = result.catch(() => {});
      return result;
    }
    throw unavailable('Die System-Datei-Zwischenablage wird auf diesem Betriebssystem noch nicht unterstützt.');
  }
  function selection(result) {
    if (Array.isArray(result.paths) && !result.paths.length) return null;
    const normalized = paths(result.paths);
    if (typeof result.token !== 'string' || !result.token || result.token.length > 512) throw new Error('Ungültige Antwort der Datei-Zwischenablage.');
    return { paths: normalized, mode: mode(result.mode), token: result.token, source: 'system' };
  }
  return {
    async read() { return selection(await invoke({ action: 'read' })); },
    async write(request) {
      const payload = { action: 'write', paths: paths(request?.paths), mode: mode(request?.mode) };
      return selection(await invoke(payload));
    },
    async ack(request) {
      if (typeof request?.token !== 'string' || !request.token || request.token.length > 512) throw new Error('Ungültige Zwischenablage-Referenz.');
      const original = paths(request.paths), remaining = paths(request.remainingPaths, true);
      if (remaining.some(item => !original.includes(item))) throw new Error('Ungültige verbleibende Zwischenablage-Auswahl.');
      const result = await invoke({ action: 'ack', token: request.token, paths: original, mode: mode(request.mode), remainingPaths: remaining });
      return result.matched === true;
    },
    async reset(request) {
      if (typeof request?.token !== 'string' || !request.token || request.token.length > 512) throw new Error('Ungültige Zwischenablage-Referenz.');
      const result = await invoke({ action: 'reset', token: request.token, paths: paths(request.paths), mode: mode(request.mode) });
      return result.matched === true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      nativeSession?.close();
      nativeSession = null;
    }
  };
}
module.exports = { createClipboardProvider };
