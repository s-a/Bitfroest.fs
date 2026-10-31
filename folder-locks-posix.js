const fs = require('node:fs/promises');
const { loadNativeApi } = require('./native-api');

const inside = (file, root) => typeof file === 'string' && file.startsWith('/') &&
  (file === root || file.startsWith(root.endsWith('/') ? root : root + '/'));

function createPosixFolderLocks(options = {}) {
  const platform = options.platform || process.platform;
  const io = options.fs || fs;
  let disposed = false, featurePromise, nativeApi = options.nativeApi, nativeSession;
  const nativePending = new Set();
  const alive = () => { if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.'); };
  const unavailable = reason => ({ available: false, reason });
  const actions = () => Object.fromEntries(
    ['scan', 'copy-info', 'unlock', 'terminate', 'copy', 'rename', 'delete', 'delete-processes', 'schedule']
      .map(action => [action, unavailable('unsupported-platform')])
  );

  async function features() {
    alive();
    if (platform !== 'linux') return { native: false, terminate: false, rename: false };
    if (!featurePromise) featurePromise = Promise.resolve().then(() => {
      nativeApi ||= loadNativeApi();
      const supported = operation => ['supported', 'conditional'].includes(nativeApi.capabilities?.[operation]?.status);
      return { native: true, terminate: supported('processes.terminate'), rename: supported('locks.rename') };
    });
    return featurePromise;
  }

  async function capabilities() {
    alive();
    if (platform !== 'linux') return { platform, referencesOnly: true, actions: actions() };
    const available = await features();
    alive();
    const enabled = { available: true };
    return { platform, referencesOnly: true, actions: {
      scan: enabled,
      'copy-info': enabled,
      unlock: unavailable('foreign-handles'),
      schedule: unavailable('restart-delete'),
      terminate: available.terminate ? enabled : unavailable('native-api-unavailable'),
      copy: enabled,
      rename: available.rename ? enabled : unavailable('native-api-unavailable'),
      delete: enabled,
      'delete-processes': available.terminate ? enabled : unavailable('native-api-unavailable')
    } };
  }

  async function optional(method, file) {
    try { return String(await io[method](file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return ''; throw error; }
  }

  async function linuxScan(directory) {
    const rows = [], denied = new Set();
    let boot = 'unknown';
    try { boot = (await optional('readFile', '/proc/sys/kernel/random/boot_id')).trim() || 'unknown'; }
    catch { /* Process start tokens remain scoped to this running session. */ }
    for (const item of await io.readdir('/proc')) {
      alive(); if (!/^\d+$/.test(item) || Number(item) <= 1 || !Number.isSafeInteger(Number(item))) continue;
      const pid = Number(item), base = '/proc/' + item;
      try {
        const before = await optional('readFile', base + '/stat'); if (!before) continue;
        const end = before.lastIndexOf(')'), fields = before.slice(end + 2).trim().split(/\s+/);
        if (end < 0 || !/^\d+$/.test(fields[19] || '')) throw new Error('Ungültige Linux-Prozessidentität.');
        const started = `linux:${boot}:${fields[19]}`;
        let executable = '', commandLine = '';
        try { executable = await optional('readlink', base + '/exe'); commandLine = (await optional('readFile', base + '/cmdline')).replace(/\0/g, ' ').trimEnd(); }
        catch { denied.add(pid); }
        const common = { pid, started, name: before.slice(before.indexOf('(') + 1, end), executable, commandLine };
        const found = [], seen = new Set();
        const add = (file, kind, descriptor) => {
          if (!inside(file, directory) || seen.has(`${kind}:${descriptor || ''}:${file}`)) return;
          seen.add(`${kind}:${descriptor || ''}:${file}`); found.push({ ...common, file, kind, descriptor });
        };
        add(executable, 'image');
        try { add(await optional('readlink', base + '/cwd'), 'handle', 'cwd'); }
        catch { denied.add(pid); }
        try {
          for (const descriptor of await io.readdir(base + '/fd')) {
            alive();
            try { add(await optional('readlink', base + '/fd/' + descriptor), 'handle', descriptor); }
            catch { denied.add(pid); }
          }
        } catch { denied.add(pid); }
        try {
          for (const line of (await optional('readFile', base + '/maps')).split('\n')) {
            const match = /^(\S+)\s+\S+\s+\S+\s+\S+\s+\d+\s+(\/.*)$/.exec(line);
            if (match) {
              let file = match[2];
              if (file.includes('\\012')) {
                try { file = await optional('readlink', base + '/map_files/' + match[1]); if (!file) { denied.add(pid); continue; } }
                catch { denied.add(pid); continue; }
              }
              if (file !== executable) add(file, 'module');
            }
          }
        } catch { denied.add(pid); }
        const after = await optional('readFile', base + '/stat'), rest = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (rest[19] !== fields[19]) { denied.add(pid); continue; }
        rows.push(...found);
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) denied.add(pid); }
    }
    alive(); return { rows, inaccessible: denied.size, referencesOnly: true, partial: true };
  }

  function closeNative(session, error) {
    if (nativeSession === session) nativeSession = undefined;
    try { session.close(); } catch (cause) { error.cause ||= cause; }
    for (const pending of nativePending) if (pending.session === session) pending.reject(error);
  }

  async function nativeRequest(input) {
    alive();
    if (!['rename', 'terminate'].includes(input.action)) throw new Error('Unbekannte Sperrenaktion.');
    const session = nativeSession ||= nativeApi.openSession();
    let reject;
    const cancelled = new Promise((_, fail) => { reject = fail; });
    const pending = { session, reject };
    nativePending.add(pending);
    const timer = setTimeout(() => closeNative(session, Object.assign(new Error('Zeitüberschreitung der Sperrenuntersuchung.'), { code: 'ETIMEDOUT' })), options.timeout || 60000);
    try {
      const operation = input.action === 'rename' ? 'locks.rename' : 'processes.terminate';
      const request = input.action === 'rename'
        ? { path: input.path, destination: input.destination, expected: input.expected, expectedParent: input.expectedParent }
        : { path: input.path, rows: input.rows, hostPid: process.pid };
      const result = await Promise.race([session.invoke(operation, request), cancelled]);
      alive(); return result;
    } finally { clearTimeout(timer); nativePending.delete(pending); }
  }

  return {
    capabilities,
    async request(input) {
      alive();
      if (platform !== 'linux') throw new Error('Diese Aktion ist auf diesem Betriebssystem nicht verfügbar.');
      if (input.action === 'scan') return linuxScan(input.path);
      const allowed = (await capabilities()).actions[input.action];
      alive();
      if (!allowed?.available) throw new Error('Diese Aktion ist auf diesem Betriebssystem nicht verfügbar.');
      return nativeRequest(input);
    },
    dispose() {
      disposed = true;
      if (nativeSession) closeNative(nativeSession, new Error('Die Sperrenuntersuchung ist geschlossen.'));
    }
  };
}

module.exports = { createPosixFolderLocks };
