const path = require('node:path');
const fs = require('node:fs/promises');
const { loadNativeApi } = require('./native-api');

async function readDefaultProfile(local = process.env.LOCALAPPDATA) {
  const unavailable = 'Das Windows-Terminal-Standardprofil konnte nicht eindeutig ermittelt werden.';
  if (!local || !path.isAbsolute(local)) throw new Error(unavailable);
  const candidates = ['', 'Preview', 'Canary'].map(channel => path.join(local,
    'Packages', 'Microsoft.WindowsTerminal' + channel + '_8wekyb3d8bbwe', 'LocalState', 'settings.json'));
  candidates.push(path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'));
  const profiles = new Set();
  for (const candidate of candidates) {
    try {
      const jsonc = await fs.readFile(candidate, 'utf8');
      const json = jsonc.replace(/^\uFEFF/, '')
        .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ')
        .replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, token => token === ',' ? '' : token);
      const profile = JSON.parse(json).defaultProfile;
      if (typeof profile !== 'string' || !/^\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\}$/i.test(profile)) throw new Error(unavailable);
      profiles.add(profile.toLowerCase());
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(unavailable, { cause: error });
    }
  }
  if (profiles.size !== 1) throw new Error(unavailable);
  return profiles.values().next().value;
}

function powerShellCommand(script) {
  const quote = value => "([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" +
    Buffer.from(value, 'utf16le').toString('base64') + "')))";
  const named = [];
  const positional = [];
  for (const argument of script.args) {
    if (typeof argument === 'string') positional.push(quote(argument));
    else {
      if (!/^[\w-]+$/.test(argument.name)) throw new Error('Ungültiger Parametername.');
      const value = typeof argument.value === 'boolean' ? '$' + argument.value : quote(argument.value);
      named.push("'" + argument.name + "'=" + value);
    }
  }
  const command = '$named=@{' + named.join(';') + '};$positional=@(' + positional.join(',') +
    '); & ' + quote(script.path) + ' @named @positional';
  return Buffer.from(command, 'utf16le').toString('base64');
}

async function runIntegratedScript(terminal, options) {
  const script = options.script;
  const unsupported = () => new Error('Das Terminalprofil unterstützt den Skriptstart nicht.');
  const shell = () => terminal.state?.shell || path.basename(options.env?.shell || '');
  const supported = () => ['bash', 'zsh'].includes(shell());
  if (!terminal.shellIntegration) {
    await new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer);
        for (const listener of listeners) listener.dispose();
        if (error) reject(error);
        else resolve();
      };
      const listeners = [
        options.window.onDidChangeTerminalShellIntegration(event => {
          if (event.terminal === terminal && terminal.shellIntegration) done();
        }),
        options.window.onDidCloseTerminal(closed => { if (closed === terminal) done(unsupported()); }),
      ];
      const timer = setTimeout(() => done(unsupported()), options.timeout || 5000);
      if (terminal.shellIntegration) done();
    });
  }
  if (!supported()) throw unsupported();
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const words = [script.path, ...script.args];
  if (words.some(value => typeof value !== 'string' || Array.from(value).some(character => character < ' ' || character === '\x7f'))) {
    throw new Error('Skriptpfad oder Argument enthält ein nicht unterstütztes Steuerzeichen.');
  }
  terminal.shellIntegration.executeCommand(words.map(quote).join(' '));
}

async function openTerminal(directory, options = {}) {
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof directory !== 'string' || !paths.isAbsolute(directory) || directory.includes('\0')) throw new Error('Ungültiger Ordnerpfad.');
  if (platform === 'win32') {
    const request = { path: path.win32.normalize(directory) };
    if (options.script) {
      request.profile = await (options.readDefaultProfile || readDefaultProfile)();
      request.encodedCommand = powerShellCommand(options.script);
    }
    const session = (options.nativeApi || loadNativeApi()).openSession();
    let timer;
    try {
      const result = await Promise.race([
        session.invoke('shell.openTerminal', request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Die Programmöffnung antwortet nicht.'), { code: 'DesktopTimeout' })), options.timeout || 15000); })
      ]);
      if (result?.requested !== true) throw new Error('Ungültige Antwort beim Öffnen des Terminals.');
    } finally {
      clearTimeout(timer);
      try { session.close(); } catch { /* Preserve the launch result during cleanup. */ }
    }
    return;
  }
  if (platform === 'linux' || platform === 'darwin') {
    const terminal = options.window.createTerminal({ cwd: directory });
    terminal.show();
    if (options.script) await runIntegratedScript(terminal, options);
    return;
  }
  throw Object.assign(new Error('Diese Funktion wird auf diesem Betriebssystem noch nicht unterstützt.'), { code: 'ENOTSUPPORTED' });
}

module.exports = { openTerminal, readDefaultProfile };
