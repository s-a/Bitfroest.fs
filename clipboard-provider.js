const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

function runHelper(command, args, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false;
    const outputDecoder = new StringDecoder('utf8');
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Datei-Zwischenablage antwortet nicht.')); }, options.timeout || 10000);
    child.on('error', error => finish(error));
    child.stdout.on('data', chunk => {
      stdout += outputDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.byteLength(stdout) > 1048576) { child.kill(); finish(new Error('Datei-Zwischenablage überschreitet die Größenbegrenzung.')); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 4096); });
    child.on('close', code => finish(code === 0 ? null : new Error(stderr || 'Datei-Zwischenablage konnte nicht gelesen werden.'), stdout + outputDecoder.end()));
    child.stdin.on('error', error => finish(error));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function createClipboardProvider(options = {}) {
  const platform = options.platform || process.platform;
  const contains = options.contains || (() => false);
  const run = options.runHelper || ((command, args, payload) => runHelper(command, args, payload, { spawn: options.spawn, timeout: options.timeout }));
  const helperRoot = options.helperRoot || path.join(__dirname, 'native');
  const environment = options.env || process.env;
  const consumedSelections = new Map();
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
    if (platform === 'linux') return linux(payload);
    let command, args;
    if (platform === 'win32') { command = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(helperRoot, 'file-clipboard.ps1')]; }
    else if (platform === 'darwin') { command = 'osascript'; args = ['-l', 'JavaScript', path.join(helperRoot, 'file-clipboard-macos.js')]; }
    else throw unavailable('Native Datei-Zwischenablage ist auf dieser Plattform nicht verfügbar.');
    const text = await run(command, args, payload);
    let result;
    try { result = JSON.parse(text); } catch (error) { throw new Error('Ungültige Antwort der Datei-Zwischenablage.', { cause: error }); }
    if (!result || typeof result !== 'object') throw new Error('Ungültige Antwort der Datei-Zwischenablage.');
    if (result.error) throw new Error(String(result.error).slice(0, 500));
    return result;
  }
  async function linux(payload) {
    const wayland = Boolean(environment.WAYLAND_DISPLAY), read = wayland ? 'wl-paste' : 'xclip', write = wayland ? 'wl-copy' : 'xclip';
    const listArgs = wayland ? ['--list-types'] : ['-selection', 'clipboard', '-o', '-target', 'TARGETS'];
    const args = (mime, output) => wayland ? output ? ['--no-newline', '--type', mime] : ['--type', mime] : ['-selection', 'clipboard', output ? '-o' : '-i', '-target', mime];
    const token = text => `linux-${createHash('sha256').update(text).digest('hex')}`;
    async function call(command, arguments_, text = '') {
      try { return await run(command, arguments_, text); }
      catch (error) { if (error.code === 'ENOENT') throw unavailable('Native Datei-Zwischenablage benötigt ein vorhandenes Clipboard-Werkzeug.', error); throw error; }
    }
    async function readSelection() {
      const formats = String(await call(read, listArgs)).split(/\s+/);
      const mime = formats.includes('x-special/gnome-copied-files') ? 'x-special/gnome-copied-files' : formats.includes('text/uri-list') ? 'text/uri-list' : '';
      if (!mime) return { paths: [], mode: 'copy', token: token('empty') };
      const text = String(await call(read, args(mime, true)));
      if (Buffer.byteLength(text) > 1048576) throw new Error('Datei-Zwischenablage überschreitet die Größenbegrenzung.');
      const lines = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
      let operation = mime === 'x-special/gnome-copied-files' ? lines.shift() : 'copy';
      let cutMarker = '';
      if (mime === 'text/uri-list' && formats.includes('application/x-kde-cutselection')) {
        cutMarker = String(await call(read, args('application/x-kde-cutselection', true))).trim();
        if (!['0', '1'].includes(cutMarker)) throw new Error('Ungültige Datei-Zwischenablage.');
        operation = cutMarker === '1' ? 'cut' : 'copy';
      }
      if (!['copy', 'cut'].includes(operation)) throw new Error('Ungültige Datei-Zwischenablage.');
      const entries = lines.map(line => {
        const url = new URL(line);
        if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost' || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) throw new Error('Ungültiger Zwischenablage-Pfad.');
        return decodeURIComponent(url.pathname);
      });
      return { paths: entries, mode: operation === 'cut' ? 'move' : 'copy', token: token(`${mime}\0${text}${cutMarker ? `\0${cutMarker}` : ''}`) };
    }
    if (payload.action === 'read') return readSelection();
    if (payload.action === 'ack') return { matched: (await readSelection()).token === payload.token, retained: true };
    const gnome = /(?:^|:)gnome(?:$|:)/i.test(environment.XDG_CURRENT_DESKTOP || '');
    if (payload.mode === 'move' && !gnome) throw unavailable('Ausschneiden über die System-Zwischenablage ist auf dieser Plattform nicht verfügbar.');
    const mime = gnome ? 'x-special/gnome-copied-files' : 'text/uri-list';
    const uris = payload.paths.map(value => platform === process.platform ? pathToFileURL(value).href : `file://${value.split('/').map(encodeURIComponent).join('/')}`);
    const text = gnome ? `${payload.mode === 'move' ? 'cut' : 'copy'}\n${uris.join('\n')}` : `${uris.join('\r\n')}\r\n`;
    await call(write, args(mime, false), text);
    return { paths: payload.paths, mode: payload.mode, token: token(`${mime}\0${text}`) };
  }
  function selection(result) {
    if (Array.isArray(result.paths) && !result.paths.length) return null;
    const normalized = paths(result.paths);
    if (typeof result.token !== 'string' || !result.token || result.token.length > 512) throw new Error('Ungültige Antwort der Datei-Zwischenablage.');
    const consumed = platform === 'linux' ? consumedSelections.get(result.token) : null;
    const available = consumed ? normalized.filter(value => !consumed.includes(value) || (options.exists || fs.existsSync)(value)) : normalized;
    return available.length ? { paths: available, mode: mode(result.mode), token: result.token, source: 'system' } : null;
  }
  return {
    async read() { return selection(await invoke({ action: 'read' })); },
    async write(request) {
      const payload = { action: 'write', paths: paths(request?.paths), mode: mode(request?.mode) };
      if (platform === 'darwin' && payload.mode === 'move') throw unavailable('Ausschneiden über die System-Zwischenablage ist auf dieser Plattform nicht verfügbar.');
      return selection(await invoke(payload));
    },
    async ack(request) {
      if (typeof request?.token !== 'string' || !request.token || request.token.length > 512) throw new Error('Ungültige Zwischenablage-Referenz.');
      const original = paths(request.paths), remaining = paths(request.remainingPaths, true);
      if (remaining.some(item => !original.includes(item))) throw new Error('Ungültige verbleibende Zwischenablage-Auswahl.');
      const result = await invoke({ action: 'ack', token: request.token, paths: original, mode: mode(request.mode), remainingPaths: remaining });
      if (platform === 'linux' && request.mode === 'move' && result.matched === true) {
        consumedSelections.set(request.token, [...new Set([...(consumedSelections.get(request.token) || []), ...original.filter(value => !remaining.includes(value))])]);
        while (consumedSelections.size > 64) consumedSelections.delete(consumedSelections.keys().next().value);
      }
      return result.matched === true;
    }
  };
}
module.exports = { createClipboardProvider };
