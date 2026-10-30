const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function createShellMenuProvider(options = {}) {
  const platform = options.platform || process.platform, children = new Set();
  let disposed = false, busy = false;
  const clean = value => {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) throw failure('EINVAL', 'Ungültige Dateiauswahl für das Systemmenü.');
    const resolved = path.win32.resolve(value);
    if (resolved.slice(path.win32.parse(resolved).root.length).includes(':')) throw failure('EINVAL', 'Benannte Datenströme unterstützen kein Systemmenü.');
    return resolved;
  };
  async function selection(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 256) throw failure('EINVAL', 'Ungültige Dateiauswahl für das Systemmenü.');
    const normalized = paths.map(clean), identities = normalized.map(value => value.toLowerCase());
    const roots = await Promise.all((options.roots || []).map(async root => clean(await fs.realpath(clean(root)))));
    if (!roots.length) throw failure('EINVAL', 'Erlaubte Verzeichnisse für das Systemmenü fehlen.');
    if (new Set(identities).size !== normalized.length) throw failure('EINVAL', 'Ungültige Dateiauswahl für das Systemmenü.');
    const parent = path.win32.dirname(normalized[0]).toLowerCase();
    if (normalized.some(value => path.win32.dirname(value).toLowerCase() !== parent)) throw failure('EINVAL', 'Das Systemmenü benötigt Einträge aus demselben Ordner.');
    for (const value of normalized) {
      const actual = clean(await fs.realpath(value));
      const allowed = roots.some(root => actual.toLowerCase().startsWith((root.endsWith('\\') ? root : root + '\\').toLowerCase()));
      if (!allowed || actual.toLowerCase() !== value.toLowerCase() || (await fs.lstat(value)).isSymbolicLink()) throw failure('EACCESS', 'Die Dateiauswahl liegt außerhalb der erlaubten Verzeichnisse oder enthält Verknüpfungen.');
    }
    return { paths: normalized, roots };
  }
  function runHelper(input) {
    return new Promise((resolve, reject) => {
      let child, settled = false;
      const finish = (error, stdout) => { if (settled) return; settled = true; children.delete(child); error ? reject(error) : resolve(stdout); };
      child = (options.execFile || execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-File', path.join(__dirname, 'native', 'file-context-menu.ps1')], { windowsHide: true, ...(input.mode === 'inspect' ? { timeout: 30000 } : {}), maxBuffer: 262144 }, finish);
      children.add(child);
      child.stdin.on('error', error => { child.kill(); finish(error); });
      child.stdin.end(JSON.stringify(input));
    });
  }
  async function request(mode, paths, settings = {}) {
    const started = performance.now();
    const anchor = { keyboard: Boolean(settings.keyboard), ownerTitle: typeof settings.ownerTitle === 'string' ? settings.ownerTitle.slice(0, 1024) : '', lockInspectionLabel: typeof settings.lockInspectionLabel === 'string' ? settings.lockInspectionLabel.slice(0, 120) : 'Ordnersperren untersuchen' };
    if (platform !== 'win32') throw failure('ENOTSUPPORTED', 'Das native Systemmenü ist auf diesem Betriebssystem noch nicht verfügbar.');
    if (disposed) throw failure('EDISPOSED', 'Der Anbieter für das Systemmenü wurde geschlossen.');
    if (busy) throw failure('EBUSY', 'Ein Systemmenü ist bereits geöffnet.');
    busy = true;
    try {
      const chosen = await selection(paths);
      if (disposed) throw failure('EDISPOSED', 'Der Anbieter für das Systemmenü wurde geschlossen.');
      const raw = await (options.runHelper || runHelper)({ ...chosen, mode, ...anchor, expectedProcessPath: process.execPath, hostProcessId: process.pid });
      if (disposed) throw failure('EDISPOSED', 'Der Anbieter für das Systemmenü wurde geschlossen.');
      let result;
      try { result = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw; } catch { throw failure('EPROTOCOL', 'Die Antwort des Systemmenüs ist ungültig.'); }
      if (!result || result.ok !== true) throw failure('ESHELLMENU', result?.message || 'Das native Systemmenü konnte nicht geöffnet werden.');
      if (result.action != null && (result.action !== 'inspect-locks' || chosen.paths.length !== 1 || !(await fs.lstat(chosen.paths[0])).isDirectory())) throw failure('EPROTOCOL', 'Die Sperrenuntersuchung benötigt genau einen Ordner.');
      if (mode === 'inspect' && (result.displayed !== false || result.invoked !== false || !Array.isArray(result.entries)) || mode === 'show' && (result.displayed !== true || typeof result.invoked !== 'boolean' || typeof result.cancelled !== 'boolean' || result.invoked === result.cancelled)) throw failure('EPROTOCOL', 'Die Antwort des Systemmenüs ist ungültig.');
      return { ...result, timing: { ...result.timing, totalMilliseconds: Math.round(performance.now() - started) } };
    } finally { busy = false; }
  }
  return {
    inspect: paths => request('inspect', paths),
    show: (paths, settings) => request('show', paths, settings),
    dispose() { disposed = true; for (const child of children) child.kill(); children.clear(); }
  };
}
module.exports = { createShellMenuProvider };
