const { loadNativeApi } = require('./native-api');

async function maximizeWindow(titleToken, options = {}) {
  const session = (options.nativeApi || loadNativeApi()).openSession();
  let timer;
  try {
    const result = await Promise.race([
      session.invoke('windows.maximize', { titleToken }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Zeitlimit beim Maximieren des Fensters überschritten.'), { code: 'WindowTimeout' })), options.timeout ?? 12000);
      })
    ]);
    if (result?.maximized !== true) {
      throw Object.assign(new Error('Das native Fenster wurde nicht als maximiert bestätigt.'), { code: 'InvalidNativeResponse' });
    }
    return { maximized: true };
  } finally {
    clearTimeout(timer);
    session.close();
  }
}

async function inspectWindows(options = {}) {
  const abortError = () => Object.assign(new Error('Window inspection cancelled.'), { name: 'AbortError', code: 'Cancelled' });
  if (options.signal?.aborted) throw abortError();
  const api = options.nativeApi || loadNativeApi();
  if (api.capabilities?.['windows.inspect']?.status === 'unsupported') return { available: false, reason: 'UnsupportedOperation', apiVersion: api.apiVersion, capability: api.capabilities['windows.inspect'] };
  const session = api.openSession(); let timer, abort;
  try {
    const result = await Promise.race([
      session.invoke('windows.inspect', options.titleToken === undefined ? {} : { titleToken: options.titleToken }),
      new Promise((_, reject) => {
        abort = () => reject(abortError());
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Window inspection timed out.'), { code: 'WindowTimeout' })), options.timeout ?? 2000); })
    ]);
    if (result?.version !== 1 || result.readOnly !== true || !Array.isArray(result.windows) || result.windows.length > 64 || options.titleToken !== undefined && result.titleToken !== options.titleToken) throw Object.assign(new Error('The window inspection response is invalid.'), { code: 'InvalidNativeResponse' });
    return { ...result, available: true, apiVersion: api.apiVersion, capability: api.capabilities?.['windows.inspect'] };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); session.close(); }
}

module.exports = { maximizeWindow, inspectWindows };
