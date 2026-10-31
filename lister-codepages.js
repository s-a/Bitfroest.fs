const core = require('./media/commander-lister');
const { loadNativeApi } = require('./native-api');

const MAX_CHUNK = 1024 * 1024;
const STATEFUL_CODEPAGE = /^(?:5022\d|52936|65000|5700[2-9]|5701[01])$/;

function createCodepageDecoder(options = {}) {
  const loadApi = options.apiFactory || loadNativeApi;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  let api, nativeSession, active, queue = Promise.resolve(), disposed = false;

  function decoderClosed() { return new Error('Der Decoder ist geschlossen.'); }
  function decoderTimeout() { return new Error('Zeitlimit beim Dekodieren überschritten.'); }

  function getSession() {
    if (disposed) throw decoderClosed();
    if (process.platform !== 'win32' && !options.apiFactory) throw new Error('Diese Codeseite benötigt den Windows-Decoder.');
    if (!api) api = loadApi();
    if (!nativeSession) nativeSession = api.openSession();
    return nativeSession;
  }

  function runNative(action) {
    const result = queue.then(() => {
      const session = getSession();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (active?.session === session) active = null;
          callback(value);
        };
        const timer = setTimeout(() => {
          if (nativeSession === session) nativeSession = null;
          session.close();
          finish(reject, decoderTimeout());
        }, timeoutMs);
        active = { session, cancel: () => finish(reject, decoderClosed()) };
        Promise.resolve().then(() => action(session)).then(
          value => finish(resolve, value),
          error => finish(reject, disposed ? decoderClosed() : error)
        );
      });
    });
    queue = result.catch(() => {});
    return result;
  }

  async function decodeNative(session, bytes, encoding, offset, textOnly) {
    const codepage = Number(encoding);
    if (bytes.length <= MAX_CHUNK) {
      return session.invoke('encoding.decodeBlock', { codepage, bytes, offset, textOnly });
    }

    let resolvedCodepage = codepage;
    if (codepage === 0 || codepage === 1 || codepage === 2) {
      const description = await session.invoke('encoding.describe', { codepage });
      resolvedCodepage = description.codepage;
    }
    const text = [];
    const map = textOnly ? undefined : [];
    let pending = Buffer.alloc(0), mapStart = offset, result;
    for (let start = 0; start < bytes.length; start += MAX_CHUNK) {
      const end = Math.min(bytes.length, start + MAX_CHUNK);
      const final = end === bytes.length;
      result = await session.invoke('encoding.decodeChunk', {
        codepage: resolvedCodepage,
        bytes: bytes.subarray(start, end),
        pending,
        offset: offset + start,
        mapStart,
        final,
        textOnly
      });
      text.push(result.text);
      if (map) for (const position of result.map) map.push(position);
      pending = result.pending;
      mapStart = result.mapStart;
    }
    if (pending.length) throw Object.assign(new Error('Der native Decoder hat unvollständige Restbytes zurückgegeben.'), { code: 'NativeFailure' });
    return { text: text.join(''), encoding: result.encoding, ...(map ? { map } : {}) };
  }

  return {
    async text(bytes, encoding) {
      const value = String(encoding);
      if (!['0', '1', '2'].includes(value)) {
        try { return new TextDecoder(core.decoderLabel(value), { ignoreBOM: true }).decode(bytes); }
        catch (error) { if (!/^\d+$/.test(value)) throw error; }
      }
      return (await this.decode(bytes, value, 0, true)).text;
    },
    async decode(bytes, encoding, offset = 0, textOnly = false) {
      const value = String(encoding), aliases = ['0', '1', '2'].includes(value);
      if (STATEFUL_CODEPAGE.test(value)) throw new Error('Zustandsbehaftete Codeseiten werden für Bereichsansichten nicht unterstützt.');
      if (aliases && bytes.every(byte => byte < 128)) {
        return {
          text: Buffer.from(bytes).toString('ascii'),
          map: textOnly ? [] : Array.from({ length: bytes.length + 1 }, (_, index) => offset + index),
          encoding: value
        };
      }
      if (!aliases) {
        try { return core.decode(bytes, value, offset); }
        catch (error) { if (!/^\d+$/.test(value)) throw error; }
      }
      return runNative(session => decodeNative(session, bytes, value, offset, textOnly));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = active;
      const session = current?.session || nativeSession;
      nativeSession = null;
      session?.close();
      current?.cancel();
    }
  };
}

module.exports = { createCodepageDecoder };
