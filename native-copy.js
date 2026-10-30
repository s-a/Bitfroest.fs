const path = require('node:path');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

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
function createCopySession(options = {}) {
  let child, active, buffer = '', stderr = '', sequence = 0, disposed = false, broken = false, exited = false, exitResolve, disposePromise, protocolError;
  const decoder = new StringDecoder('utf8');
  const closed = new Promise(resolve => { exitResolve = resolve; });
  function settle(error, value) {
    const request = active; if (!request) return;
    active = null; request.signal?.removeEventListener('abort', request.cancel); clearTimeout(request.cancelTimer);
    error ? request.reject(error) : request.resolve(value);
  }
  function send(record) { if (child && !exited && !child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.write(JSON.stringify(record) + '\n'); }
  function fail(error) {
    if (broken) return;
    broken = true; protocolError = error;
    if (active) send({ type: 'cancel', id: active.id });
    child?.stdin.end();
  }
  function start() {
    if (child) return;
    child = (options.spawn || spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native', 'file-copy.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      if (exited || protocolError) return;
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim().replace(/^\uFEFF/, ''); buffer = buffer.slice(end + 1);
        if (!line) continue;
        if (line.length > 65536) { fail(new Error('Die native Kopierantwort ist zu groß.')); return; }
        try {
          const record = JSON.parse(line);
          if (record.type === 'ready') continue;
          if (typeof record.id !== 'string') throw new Error('Missing request identity');
          if (!active || record.id !== active.id) continue;
          if (record.type === 'result') {
            if (typeof record.ok !== 'boolean') throw new Error('Missing copy result');
            if (record.ok) settle(null, { copied: true, granular: true });
            else {
              const error = record.cancelled ? abortError() : new Error(record.message || 'Die native Kopie ist fehlgeschlagen.');
              if (record.cancelled) broken = true; else error.code = record.code || 'ECOPY';
              if (record.ownedDestination) error.ownedDestination = record.ownedDestination;
              settle(error);
            }
          } else if (record.type === 'progress') {
            if (Number.isSafeInteger(record.transferred) && Number.isSafeInteger(record.total) && record.total >= 0 && record.transferred >= active.transferred && record.transferred >= 0 && record.transferred <= record.total) {
              active.transferred = record.transferred; active.onProgress?.({ transferred: record.transferred, total: record.total, granular: true });
            }
          } else throw new Error('Unknown copy response');
        } catch (cause) { fail(new Error('Die native Kopierantwort ist ungültig.', { cause })); return; }
      }
      if (buffer.length > 65536) fail(new Error('Die native Kopierantwort ist zu groß.'));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
    child.on('error', error => { exited = true; broken = true; settle(error); exitResolve(); });
    child.on('close', code => {
      if (exited) return;
      exited = true;
      if (active) settle(protocolError || (disposed || active.signal?.aborted ? abortError() : new Error(stderr || 'Der native Kopierprozess wurde ohne Ergebnis beendet.')));
      if (code !== 0) broken = true;
      exitResolve();
    });
  }
  return {
    async copy(input, perCopy = {}) {
      throwIfAborted(perCopy.signal);
      if (disposed || broken || exited) throw new Error('Die Kopiersitzung wurde beendet.');
      if (active) throw new Error('In dieser Kopiersitzung ist bereits eine Datei aktiv.');
      if ((options.platform || process.platform) !== 'win32') {
        if (!input || typeof input.source !== 'string' || typeof input.target !== 'string' || !Array.isArray(input.roots) || !input.roots.length) throw new Error('Ungültige Kopieranfrage.');
        perCopy.onProgress?.({ transferred: 0, total: Number(input.expected?.size) || 0, granular: false });
        await (options.copyFile || fs.copyFile)(input.source, input.target, nativeFs.constants.COPYFILE_EXCL);
        return { copied: true, granular: false };
      }
      const request = validate(input);
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        active = { id, resolve, reject, signal: perCopy.signal, onProgress: perCopy.onProgress, transferred: -1, cancel() {
          send({ type: 'cancel', id });
          if (active?.id === id && !active.cancelTimer) active.cancelTimer = setTimeout(() => { if (active?.id === id && !exited) { broken = true; child.stdin.end(); child.kill(); } }, options.cancelTimeoutMs || 5000);
        } };
        try { start(); }
        catch (error) { broken = true; exited = true; settle(error); exitResolve(); return; }
        perCopy.signal?.addEventListener('abort', active.cancel, { once: true });
        send({ type: 'copy', id, ...request });
        if (perCopy.signal?.aborted) active?.cancel();
      });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      if (!child || exited) return Promise.resolve();
      if (active) send({ type: 'cancel', id: active.id });
      child.stdin.end();
      disposePromise = new Promise(resolve => {
        const timer = setTimeout(() => { if (!exited) child.kill(); }, options.shutdownTimeoutMs || 5000);
        closed.then(() => { clearTimeout(timer); resolve(); });
      });
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
