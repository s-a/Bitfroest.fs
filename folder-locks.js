const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function createFolderLocks(options = {}) {
  let disposed = false, busy = false, child, pending, target, targetIdentity, rows = new Map();
  const alive = () => { if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.'); };
  const fingerprint = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  const platform = options.platform || process.platform;
  const identity = value => path.resolve(value).toLowerCase();
  const inside = (value, root) => identity(value) === identity(root) || identity(value).startsWith(identity(root) + path.sep);
  async function validate(value, directory = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.length > 32760 || value.split(/[\\/]/).includes('..')) throw new Error('Ungültiger Pfad.');
    if (process.platform === 'win32' && value.slice(path.parse(value).root.length).includes(':')) throw new Error('Benannte Datenströme werden nicht unterstützt.');
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
  function stop(error) {
    const current = child; child = undefined;
    if (pending) { clearTimeout(pending.timer); const reject = pending.reject; pending = undefined; reject(error); }
    current?.kill();
  }
  function native(input) {
    if (!child) {
      const current = (options.spawn || spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native', 'folder-locks.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = current;
      let errors = '';
      current.stderr.on('data', data => { errors = (errors + data).slice(-4096); });
      const lines = readline.createInterface({ input: current.stdout });
      lines.on('line', line => {
        if (child !== current || !pending) return;
        const request = pending; pending = undefined; clearTimeout(request.timer);
        try { const result = JSON.parse(line.replace(/^\uFEFF/, '')); if (result.ok !== true) throw new Error(result.error || 'Die Sperrenuntersuchung ist fehlgeschlagen.'); request.resolve(result); }
        catch (error) { request.reject(error); }
      });
      current.on('error', error => { if (child === current) stop(error); });
      current.stdin.on('error', error => { if (child === current) stop(error); });
      current.on('exit', () => { lines.close(); if (child === current) stop(new Error(errors.trim() || 'Der Windows-Adapter wurde beendet.')); });
    }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => stop(new Error('Zeitüberschreitung der Sperrenuntersuchung.')), options.timeout || 60000) };
      child.stdin.write(JSON.stringify({ ...input, hostPid: process.pid }) + '\n');
    });
  }
  async function exclusive(work) {
    if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.');
    if (platform !== 'win32') throw new Error('Die Sperrenuntersuchung ist nur unter Windows verfügbar.');
    if (busy) throw new Error('Eine Sperrenuntersuchung läuft bereits.');
    busy = true;
    try { const result = await work(); if (disposed) throw new Error('Die Sperrenuntersuchung ist geschlossen.'); return result; }
    finally { busy = false; }
  }
  const run = input => (options.run || native)(input);
  function chosen(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > rows.size || new Set(ids).size !== ids.length || ids.some(id => !rows.has(id))) throw new Error('Die Prozessauswahl ist veraltet. Bitte aktualisieren.');
    return ids.map(id => rows.get(id));
  }
  async function mutate(action, ids, extra = {}) {
    await currentTarget();
    const selected = chosen(ids);
    if (!['unlock', 'terminate'].includes(action)) throw new Error('Ungültige Sperrenaktion.');
    const result = await run({ action, path: target, rows: selected, ...extra });
    alive();
    if (result.errors?.length) throw new Error(result.errors.join('\n'));
    return result;
  }
  return {
    scan: folder => exclusive(async () => {
      rows = new Map(); targetIdentity = undefined; target = await validate(folder, true);
      targetIdentity = fingerprint(await fs.stat(target, { bigint: true })); alive();
      const result = await run({ action: 'scan', path: target });
      if (!Array.isArray(result.rows) || !Number.isSafeInteger(result.inaccessible) || result.inaccessible < 0) throw new Error('Ungültige Antwort des Windows-Adapters.');
      const visible = [];
      for (const row of result.rows) {
        if (!row || !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.started !== 'string' || typeof row.file !== 'string' || !inside(row.file, target) || !['handle', 'module', 'image'].includes(row.kind)) throw new Error('Ungültiger Sperreneintrag.');
        const id = crypto.randomUUID(); rows.set(id, { ...row });
        visible.push({ id, pid: row.pid, started: row.started, name: row.name || '', executable: row.executable || '', commandLine: row.commandLine || '', file: row.file, kind: row.kind });
      }
      return { path: target, rows: visible, inaccessible: result.inaccessible };
    }),
    act: (action, ids) => exclusive(() => mutate(action, ids)),
    fileAction: (action, ids, destination) => exclusive(async () => {
      await currentTarget();
      if (!['copy', 'rename', 'delete', 'delete-processes'].includes(action)) throw new Error('Ungültige Dateiaktion.');
      const selected = ids.length ? chosen(ids) : [];
      let to;
      if (action === 'copy' || action === 'rename') {
        if (typeof destination !== 'string' || !path.isAbsolute(destination) || /[\0\r\n]/.test(destination) || destination.split(/[\\/]/).includes('..')) throw new Error('Ungültiger Zielpfad.');
        const parent = await validate(path.dirname(destination), true); to = path.join(parent, path.basename(destination));
        if (inside(to, target) || inside(target, to)) throw new Error('Quelle und Ziel dürfen sich nicht überschneiden.');
        try { await fs.lstat(to); throw new Error('Das Ziel ist bereits vorhanden.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (action === 'delete-processes') {
        const files = [...new Set(selected.map(row => row.executable))];
        for (const file of files) await validate(file);
        await mutate('terminate', ids);
        for (const file of files) { await currentTarget(); await validate(file); alive(); await options.trash(file); }
        return { changed: files.length };
      }
      if (selected.length) await mutate('unlock', ids);
      await currentTarget();
      if (to) { await validate(path.dirname(to), true); alive(); try { await fs.lstat(to); throw new Error('Das Ziel ist bereits vorhanden.'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      alive();
      if (action === 'copy') await fs.cp(target, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, filter: async source => { alive(); await validate(source); if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Verknüpfungen werden bei dieser Aktion nicht kopiert.'); return true; } });
      else if (action === 'rename') { const result = await run({ action: 'rename', path: target, destination: to }); if (result.errors?.length) throw new Error(result.errors.join('\n')); }
      else { await currentTarget(); await options.trash(target); }
      return { changed: 1, destination: to };
    }),
    schedule: backup => exclusive(async () => { await currentTarget(); return run({ action: 'schedule', path: target, backup }); }),
    dispose() { disposed = true; rows.clear(); stop(new Error('Die Sperrenuntersuchung ist geschlossen.')); }
  };
}
module.exports = { createFolderLocks };
