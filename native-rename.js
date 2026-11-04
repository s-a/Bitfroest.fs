const path = require('node:path');
const { loadNativeApi } = require('./native-api');
async function renameNoReplace(input, options = {}) {
  const io = options.fs || require('node:fs/promises');
  const expected = input.expected, source = path.resolve(input.source), target = path.resolve(input.target);
  if (!expected || !['dev', 'ino'].every(key => /^\d+$/.test(String(expected[key]))) || source === target) throw new Error('Eine erwartete Dateiidentität und verschiedene Pfade sind erforderlich.');
  const sourceParent = await io.lstat(path.dirname(source), { bigint: true });
  if (!sourceParent.isDirectory() || sourceParent.isSymbolicLink()) throw new Error('Ein echter Quellordner ist erforderlich.');
  const parent = await io.lstat(path.dirname(target), { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Ein echter Zielordner ist erforderlich.');
  const api = options.nativeApi || loadNativeApi();
  if (!['supported', 'conditional'].includes(api.capabilities?.['locks.rename']?.status)) throw new Error('Die sichere Wiederherstellung ist auf diesem Dateisystem nicht verfügbar.');
  const expectedSnapshotInput = input.expectedSnapshot || (['size', 'mode', 'mtimeNs', 'ctimeNs'].every(key => input.expected?.[key] !== undefined)
    ? Object.fromEntries(['size', 'mode', 'mtimeNs', 'ctimeNs'].map(key => [key, String(input.expected[key])]))
    : undefined);
  if (expectedSnapshotInput && (!['size', 'mode'].every(key => /^\d+$/.test(String(expectedSnapshotInput[key]))) ||
      !['mtimeNs', 'ctimeNs'].every(key => /^-?\d+$/.test(String(expectedSnapshotInput[key]))))) throw new Error('Eine vollständige erwartete Dateiaufnahme ist erforderlich.');
  const expectedSnapshot = expectedSnapshotInput && Object.fromEntries(['size', 'mode', 'mtimeNs', 'ctimeNs'].map(key => [key, String(expectedSnapshotInput[key])]));
  const request = {
    path: source,
    destination: target,
    expected: { dev: String(expected.dev), ino: String(expected.ino) },
    expectedSourceParent: { dev: String(sourceParent.dev), ino: String(sourceParent.ino) },
    expectedParent: { dev: String(parent.dev), ino: String(parent.ino) },
    ...(expectedSnapshot ? { expectedSnapshot } : {}),
    ...(input.allowSymbolicLink === true ? { allowSymbolicLink: true } : {})
  };
  const session = api.openSession();
  try {
    let outcome;
    try { outcome = await session.invoke('locks.rename', request); }
    catch (error) { if (error.outcome?.status === 'committed' && error.outcome.changed === 1) return; throw error; }
    if (outcome?.changed !== 1 || outcome.errors?.length) throw new Error('Die sichere Wiederherstellung wurde nicht bestätigt.');
  } finally { if (session.closeAsync) await session.closeAsync(); else await session.close(); }
}
async function renameCase(input, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Atomic case rename requires Windows.');
  if (!input || !Array.isArray(input.roots) || !input.roots.length) throw new Error('Allowed roots are required.');
  const clean = value => {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) throw new Error('An absolute path without traversal is required.');
    const resolved = path.win32.resolve(value);
    if (resolved.slice(path.win32.parse(resolved).root.length).includes(':')) throw new Error('Named streams are not rename targets.');
    return resolved;
  };
  const roots = input.roots.map(clean), source = clean(input.source), target = clean(input.target);
  const lower = value => value.toLowerCase();
  if (source === target || lower(source) !== lower(target) || lower(path.win32.dirname(source)) !== lower(path.win32.dirname(target))) throw new Error('Only a case change in the same directory is supported.');
  if (!roots.some(root => lower(source).startsWith(lower(root.endsWith('\\') ? root : root + '\\')))) throw new Error('The path is outside the allowed roots.');
  if (!input.expected || !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => (key.endsWith('Ns') ? /^-?\d+$/ : /^\d+$/).test(String(input.expected[key])))) throw new Error('A complete expected file identity is required.');
  const request = { roots, source, target, expected: input.expected };
  return renameCaseWithNativeApi(request, options.nativeApi || loadNativeApi(), options);
}
async function renameCaseWithNativeApi(request, nativeApi, options) {
  const capability = nativeApi?.capabilities?.['files.rename'];
  if (!nativeApi || typeof nativeApi.openSession !== 'function' || !['supported', 'conditional'].includes(capability?.status)) {
    const error = new Error(capability?.reason || 'The native case rename operation is unavailable.');
    error.code = 'UnsupportedOperation';
    throw error;
  }
  const session = nativeApi.openSession();
  let outcome, operationError, closeError, timer;
  try {
    outcome = await Promise.race([
      session.invoke('files.rename', request),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The native rename timed out; its outcome is unknown.'), { code: 'NativeTimeout', outcome: { status: 'unknown' } })), options.timeout || 20000); })
    ]);
  } catch (error) {
    operationError = error;
  } finally {
    clearTimeout(timer);
    try { session.close(); } catch (error) { closeError = error; }
  }

  const committed = operationError?.outcome?.status === 'committed' && operationError.outcome.renamed === true || outcome?.status === 'committed' && outcome?.renamed === true;
  if (committed) return { renamed: true };
  if (operationError) {
    if (operationError.outcome?.status === 'unchanged' && operationError.outcome.renamed === false) {
      const messages = { IdentityChanged: 'The source identity changed before the rename.', ReparsePoint: 'Reparse points are not allowed in the rename path.' };
      const message = messages[operationError.code];
      if (message) throw Object.assign(new Error(message, { cause: operationError }), operationError);
      throw operationError;
    }
    const error = new Error('The native rename outcome is unknown; the operation was not retried.', { cause: operationError });
    error.code = 'NativeOutcomeUnknown';
    throw error;
  }
  if (outcome?.status === 'unchanged' && outcome?.renamed === false) {
    const error = new Error('The native operation completed without changing the filename.');
    error.code = 'NativeOutcomeUnchanged';
    throw error;
  }
  if (closeError) {
    const error = new Error('The native session could not be closed after the rename outcome was received.', { cause: closeError });
    error.code = 'NativeSessionCloseFailed';
    throw error;
  }
  const error = new Error('The native rename returned an unknown outcome; the operation was not retried.');
  error.code = 'NativeOutcomeUnknown';
  throw error;
}
module.exports = { renameCase, renameNoReplace };
