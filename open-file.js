const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);

async function openAssociatedFile(target, options = {}) {
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof target !== 'string' || !paths.isAbsolute(target) || target.includes('\0')) throw new Error('Ungültiger Dateipfad.');
  const execute = options.executeFile || executeFile;
  if (platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native', 'open-file.ps1'), '-EncodedPath', Buffer.from(target, 'utf8').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!result || typeof result.editor !== 'boolean') throw new Error('Ungültige Antwort beim Öffnen der Datei.');
    return { editor: result.editor };
  }
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Das Öffnen verknüpfter Programme ist auf diesem Betriebssystem nicht verfügbar.');
  await execute(platform === 'darwin' ? 'open' : 'xdg-open', [target], { timeout: 15000 });
  return { editor: false };
}

module.exports = { openAssociatedFile };
