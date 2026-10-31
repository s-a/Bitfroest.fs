const path = require('node:path');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const { loadNativeApi } = require('./native-api');

function abortError() { const error = new Error('Dateiübertragung abgebrochen.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error; }
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
function validate(input) {
  if (!input || typeof input.source !== 'string' || typeof input.target !== 'string' || !Array.isArray(input.roots) || !input.roots.length) throw new Error('Ungültige Kopieranfrage.');
  const clean = value => {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) throw new Error('Ein gültiger absoluter Pfad ohne Traversal ist erforderlich.');
    const resolved = path.win32.resolve(value);
    if (resolved.slice(path.win32.parse(resolved).root.length).includes(':')) throw new Error('Benannte Datenströme sind keine Kopierziele.');
    return resolved;
  };
  const roots = input.roots.map(clean), source = clean(input.source), target = clean(input.target);
  const allowed = value => roots.some(root => value.toLowerCase().startsWith((root.endsWith('\\') ? root : root + '\\').toLowerCase()));
  if (!allowed(source) || !allowed(target) || source.toLowerCase() === target.toLowerCase()) throw new Error('Der Kopierpfad liegt außerhalb der erlaubten Wurzeln oder Quelle und Ziel sind identisch.');
  if (!input.expected || !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => /^-?\d+$/.test(String(input.expected[key])))) throw new Error('Eine vollständige erwartete Dateiidentität ist erforderlich.');
  return { roots, source, target, expected: input.expected };
}
function nativeCopyError(error, outcome, request) {
  const status = outcome?.status;
  if (status === 'committed' && outcome?.copied === true) return null;
  const unchanged = status === 'unchanged' && outcome?.copied === false;
  const code = status === 'unknown' || !unchanged && status !== 'partial' ? 'NativeOutcomeUnknown' : status === 'partial' ? 'NativeCopyPartial' : error?.code || 'NativeOutcomeUnchanged';
  const message = error?.message || (status === 'partial' ? 'The native copy left a partial destination.' : status === 'unknown' ? 'The native copy outcome is unknown.' : 'The native copy did not commit.');
  const result = new Error(message, error ? { cause: error } : undefined);
  result.code = code;
  if (outcome) result.outcome = outcome;
  if (error?.nativeCode !== undefined) result.nativeCode = error.nativeCode;
  if (status === 'partial' && outcome.ownedDestination) result.ownedDestination = { path: request.target, ...outcome.ownedDestination };
  if (outcome?.cancelled || error?.name === 'AbortError') result.name = 'AbortError';
  return result;
}
function createCopySession(options = {}) {
  let activeNative, nativeSession, nativeApi = options.nativeApi, disposed = false, broken = false, disposePromise;
  async function copyNative(request, perCopy) {
    throwIfAborted(perCopy.signal);
    if (disposed || broken) throw new Error('Die Kopiersitzung wurde beendet.');
    if (activeNative) throw new Error('In dieser Kopiersitzung ist bereits eine Datei aktiv.');
    nativeApi ||= loadNativeApi();
    const capability = nativeApi.capabilities?.['files.copy'];
    if (typeof nativeApi.openSession !== 'function' || !['supported', 'conditional'].includes(capability?.status)) {
      const error = new Error(capability?.reason || 'The native file copy operation is unavailable.'); error.code = 'UnsupportedOperation'; throw error;
    }
    nativeSession ||= nativeApi.openSession();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    perCopy.signal?.addEventListener('abort', cancel, { once: true });
    let finished;
    const current = { controller, promise: new Promise(resolve => { finished = resolve; }), transferred: -1 };
    activeNative = current;
    try {
      throwIfAborted(perCopy.signal);
      const operation = nativeSession.invoke('files.copy', request, {
        signal: controller.signal,
        onProgress: event => {
          if (activeNative !== current || !Number.isSafeInteger(event?.transferred) || !Number.isSafeInteger(event?.total) || event.transferred < 0 || event.total < event.transferred || event.transferred < current.transferred) return;
          current.transferred = event.transferred;
          perCopy.onProgress?.({ transferred: event.transferred, total: event.total, granular: true });
        }
      });
      let outcome, operationError;
      try { outcome = await operation; } catch (error) { operationError = error; outcome = error?.outcome; }
      const failure = nativeCopyError(operationError, outcome, request);
      if (failure) {
        if (failure.name === 'AbortError') broken = true;
        throw failure;
      }
      return { copied: true, granular: true };
    } finally {
      perCopy.signal?.removeEventListener('abort', cancel);
      if (activeNative === current) activeNative = null;
      finished();
    }
  }
  return {
    async copy(input, perCopy = {}) {
      throwIfAborted(perCopy.signal);
      if (disposed || broken) throw new Error('Die Kopiersitzung wurde beendet.');
      if ((options.platform || process.platform) !== 'win32') {
        if (!input || typeof input.source !== 'string' || typeof input.target !== 'string' || !Array.isArray(input.roots) || !input.roots.length) throw new Error('Ungültige Kopieranfrage.');
        perCopy.onProgress?.({ transferred: 0, total: Number(input.expected?.size) || 0, granular: false });
        await (options.copyFile || fs.copyFile)(input.source, input.target, nativeFs.constants.COPYFILE_EXCL);
        return { copied: true, granular: false };
      }
      return copyNative(validate(input), perCopy);
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        const current = activeNative;
        if (current) {
          current.controller.abort();
          await current.promise;
        }
        if (nativeSession) {
          const closing = typeof nativeSession.closeAsync === 'function' ? nativeSession.closeAsync() : nativeSession.close();
          nativeSession = null;
          await closing;
        }
      })();
      return disposePromise;
    }
  };
}
async function copyFileCancellable(input, options = {}) {
  const session = createCopySession(options);
  try { return await session.copy(input, options); }
  finally { await session.dispose(); }
}
module.exports = { copyFileCancellable, createCopySession, abortError, throwIfAborted };
