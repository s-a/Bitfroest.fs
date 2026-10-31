const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadNativeApi } = require('./native-api');
const { createPosixFolderLocks } = require('./folder-locks-posix');

function createFolderLocks(options = {}) {
  let disposed = false, busy = false, nativeSession, nativePending, target, targetIdentity, targetFileId, rows = new Map();
  const alive = () => { if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.'); };
  const fingerprint = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  const platform = options.platform || process.platform;
  const unix = platform === 'linux' ? options.posixAdapter || createPosixFolderLocks({ platform, nativeApi: options.nativeApi, timeout: options.timeout }) : undefined;
  const ordinaryActions = ['copy-info', 'copy', 'delete'];
  let nativeApi = options.nativeApi;
  const getNativeApi = () => (nativeApi ||= loadNativeApi());
  const capabilities = async () => {
    if (unix) return unix.capabilities();
    if (platform !== 'win32') return { platform, referencesOnly: false, actions: Object.fromEntries(['scan', 'copy-info', 'unlock', 'terminate', 'copy', 'rename', 'delete', 'delete-processes', 'schedule'].map(action => [action, { available: false, reason: 'unsupported-platform' }])) };
    if (options.run) return { platform, referencesOnly: false, actions: Object.fromEntries(['scan', 'copy-info', 'unlock', 'terminate', 'copy', 'rename', 'delete', 'delete-processes', 'schedule'].map(action => [action, { available: true }])) };
    const api = getNativeApi();
    const supported = operation => api.capabilities?.[operation]?.status === 'supported' || api.capabilities?.[operation]?.status === 'conditional';
    const actions = Object.fromEntries(ordinaryActions.map(action => [action, { available: true }]));
    actions.scan = { available: supported('locks.scan'), reason: supported('locks.scan') ? undefined : 'native-api-unavailable' };
    actions.unlock = { available: supported('locks.releaseHandles') && supported('locks.unloadModules'), reason: 'native-api-unavailable' };
    actions.terminate = { available: supported('processes.terminate'), reason: 'native-api-unavailable' };
    actions.rename = { available: supported('locks.rename'), reason: 'native-api-unavailable' };
    actions.schedule = { available: supported('restartDeletion.prepare') && supported('restartDeletion.commit'), reason: 'native-api-unavailable' };
    actions['delete-processes'] = { available: supported('processes.terminate'), reason: 'native-api-unavailable' };
    return { platform, referencesOnly: false, actions };
  };
  async function available(action) { const state = await capabilities(); alive(); if (!state.actions[action]?.available) throw new Error('Diese Aktion ist auf diesem Betriebssystem nicht verfügbar.'); return state; }
  const identity = value => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const inside = (value, root) => { const base = identity(root); return identity(value) === base || identity(value).startsWith(base.endsWith(path.sep) ? base : base + path.sep); };
  async function validate(value, directory = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || platform === 'win32' && /[\r\n]/.test(value) || value.length > 32760 || value.split(platform === 'win32' ? /[\\/]/ : /\//).includes('..')) throw new Error('Ungültiger Pfad.');
    if (platform === 'win32' && value.slice(path.parse(value).root.length).includes(':')) throw new Error('Benannte Datenströme werden nicht unterstützt.');
    const absolute = path.resolve(value), actual = await fs.realpath(absolute);
    const roots = await Promise.all((options.roots || []).map(root => fs.realpath(root)));
    if (!roots.some(root => inside(actual, root)) || identity(actual) !== identity(absolute)) throw new Error('Der Pfad liegt außerhalb der erlaubten Verzeichnisse oder enthält Verknüpfungen.');
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || directory && !stat.isDirectory()) throw new Error('Ein echter Ordner ist erforderlich.');
    return actual;
  }
  async function currentTarget() {
    alive(); await validate(target, true); alive();
    if (fingerprint(await fs.stat(target, { bigint: true })) !== targetIdentity) throw new Error('Der untersuchte Ordner hat sich geändert. Bitte aktualisieren.');
    alive();
  }
  function nativeSessionForRequest() {
    if (!nativeSession) nativeSession = getNativeApi().openSession();
    return nativeSession;
  }
  async function nativeApiRun(input) {
    const session = nativeSessionForRequest();
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = error => {
        if (nativeSession === session) nativeSession = undefined;
        try { session.close(); } catch (cause) { error.cause ||= cause; }
        reject(error);
      };
    });
    nativePending = cancel;
    const timer = setTimeout(() => cancel(Object.assign(new Error('Zeitüberschreitung der Sperrenuntersuchung.'), { code: 'ETIMEDOUT' })), options.timeout || 60000);
    try { return await Promise.race([executeNativeAction(input, session), cancelled]); }
    finally { clearTimeout(timer); if (nativePending === cancel) nativePending = undefined; }
  }
  async function executeNativeAction(input, session) {
    const invoke = (operation, request) => {
      alive();
      if (nativeSession !== session) throw new Error('Die Sperrenuntersuchung ist geschlossen.');
      return session.invoke(operation, request);
    };
    if (input.action === 'scan') return invoke('locks.scan', { path: input.path });
    if (input.action === 'terminate') return invoke('processes.terminate', { path: input.path, hostPid: process.pid, rows: input.rows });
    if (input.action === 'unlock') {
      const groups = [
        ['locks.releaseHandles', input.rows.filter(row => row.kind === 'handle' || row.kind === 'image')],
        ['locks.unloadModules', input.rows.filter(row => row.kind === 'module')]
      ].filter(([, selected]) => selected.length);
      const results = [];
      for (const [operation, selected] of groups) results.push(await invoke(operation, { path: input.path, hostPid: process.pid, rows: selected }));
      return { changed: results.reduce((sum, result) => sum + (Number.isSafeInteger(result.changed) ? result.changed : 0), 0), errors: results.flatMap(result => Array.isArray(result.errors) ? result.errors : []) };
    }
    if (input.action === 'rename') return invoke('locks.rename', { path: input.path, destination: input.destination, expected: input.expected, expectedParent: input.expectedParent });
    if (input.action === 'schedule') {
      const prepared = await invoke('restartDeletion.prepare', { path: input.path, backup: input.backup });
      return invoke('restartDeletion.commit', { path: input.path, backup: prepared.backup, token: prepared.token });
    }
    throw new Error('Unbekannte Sperrenaktion.');
  }
  async function exclusive(work) {
    if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.');
    if (!['win32', 'linux'].includes(platform)) throw new Error('Die Sperrenuntersuchung ist auf diesem Betriebssystem nicht verfügbar.');
    if (busy) throw new Error('Eine Sperrenuntersuchung läuft bereits.');
    busy = true;
    try { const result = await work(); if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.'); return result; }
    finally { busy = false; }
  }
  const run = input => options.run ? options.run(input) : unix ? unix.request(input) : nativeApiRun(input);
  function chosen(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > rows.size || new Set(ids).size !== ids.length || ids.some(id => !rows.has(id))) throw new Error('Die Prozessauswahl ist veraltet. Bitte aktualisieren.');
    return ids.map(id => rows.get(id));
  }
  async function mutate(action, ids, extra = {}) {
    await available(action);
    await currentTarget();
    const selected = chosen(ids);
    if (action === 'terminate' && selected.some(row => row.canTerminate === false)) throw new Error('Das sichere Beenden ist für diese Prozessidentität nicht verfügbar.');
    if (!['unlock', 'terminate'].includes(action)) throw new Error('Ungültige Sperrenaktion.');
    const result = await run({ action, path: target, rows: selected, ...extra });
    alive();
    if (result.errors?.length) throw new Error(result.errors.join('\n'));
    return result;
  }
  return {
    capabilities,
    scan: folder => exclusive(async () => {
      const supported = await available('scan');
      rows = new Map(); targetIdentity = undefined; target = await validate(folder, true);
      const targetStat = await fs.stat(target, { bigint: true }); targetIdentity = fingerprint(targetStat); targetFileId = { dev: String(targetStat.dev), ino: String(targetStat.ino) }; alive();
      const result = await run({ action: 'scan', path: target });
      if (!Array.isArray(result.rows) || !Number.isSafeInteger(result.inaccessible) || result.inaccessible < 0) throw new Error('Ungültige Antwort des Prozessadapters.');
      const visible = [];
      for (const row of result.rows) {
        if (!row || !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.started !== 'string' || typeof row.file !== 'string' || !inside(row.file, target) || !['handle', 'module', 'image'].includes(row.kind)) throw new Error('Ungültiger Sperreneintrag.');
        const id = crypto.randomUUID(); rows.set(id, { ...row });
        visible.push({ id, pid: row.pid, started: row.started, startedAt: row.startedAt, canTerminate: row.canTerminate !== false, terminationReason: row.terminationReason, name: row.name || '', executable: row.executable || '', commandLine: row.commandLine || '', file: row.file, kind: row.kind });
      }
      return { path: target, rows: visible, inaccessible: result.inaccessible, capabilities: supported, referencesOnly: Boolean(result.referencesOnly), partial: Boolean(result.partial), diagnostic: result.diagnostic || '' };
    }),
    act: (action, ids) => exclusive(() => mutate(action, ids)),
    fileAction: (action, ids, destination) => exclusive(async () => {
      const supported = await available(action);
      await currentTarget();
      if (!['copy', 'rename', 'delete', 'delete-processes'].includes(action)) throw new Error('Ungültige Dateiaktion.');
      const selected = ids.length ? chosen(ids) : [];
      let to;
      if (action === 'copy' || action === 'rename') {
        if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0') || platform === 'win32' && /[\r\n]/.test(destination) || destination.split(platform === 'win32' ? /[\\/]/ : /\//).includes('..')) throw new Error('Ungültiger Zielpfad.');
        const parent = await validate(path.dirname(destination), true); to = path.join(parent, path.basename(destination));
        if (inside(to, target) || inside(target, to)) throw new Error('Quelle und Ziel dürfen sich nicht überschneiden.');
        try { await fs.lstat(to); throw new Error('Das Ziel ist bereits vorhanden.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (action === 'delete-processes') {
        const files = [...new Set(selected.map(row => row.executable))];
        const identities = new Map();
        for (const file of files) { await validate(file); identities.set(file, fingerprint(await fs.stat(file, { bigint: true }))); }
        await mutate('terminate', ids);
        for (const file of files) { await currentTarget(); await validate(file); if (fingerprint(await fs.stat(file, { bigint: true })) !== identities.get(file)) throw new Error('Die Programmdatei hat sich geändert.'); alive(); await options.trash(file); }
        return { changed: files.length };
      }
      if (selected.length && supported.actions.unlock.available) await mutate('unlock', ids);
      await currentTarget();
      if (to) { await validate(path.dirname(to), true); alive(); try { await fs.lstat(to); throw new Error('Das Ziel ist bereits vorhanden.'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      alive();
      if (action === 'copy') await fs.cp(target, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, filter: async source => { alive(); await validate(source); if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Verknüpfungen werden bei dieser Aktion nicht kopiert.'); return true; } });
      else if (action === 'rename') { const parent = await fs.stat(path.dirname(to), { bigint: true }); await validate(path.dirname(to), true); alive(); const result = await run({ action: 'rename', path: target, destination: to, expected: targetFileId, expectedParent: { dev: String(parent.dev), ino: String(parent.ino) } }); if (result.errors?.length) throw new Error(result.errors.join('\n')); }
      else { await currentTarget(); await options.trash(target); }
      return { changed: 1, destination: to };
    }),
    schedule: backup => exclusive(async () => { await available('schedule'); await currentTarget(); return run({ action: 'schedule', path: target, backup }); }),
    dispose() {
      disposed = true; rows.clear(); unix?.dispose();
      const error = new Error('Die Sperrenuntersuchung ist geschlossen.');
      if (nativePending) nativePending(error);
      else nativeSession?.close();
      nativeSession = undefined;
    }
  };
}
module.exports = { createFolderLocks };
