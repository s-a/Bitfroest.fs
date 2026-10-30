const { execFile } = require('node:child_process');

async function openTrash(options = {}) {
  const platform = options.platform || process.platform;
  let command, args;
  if (platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $trashShell=New-Object -ComObject Shell.Application; try { $trashShell.Open(10) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($trashShell) }"];
  } else if (platform === 'darwin') {
    command = '/usr/bin/osascript';
    args = ['-e', 'tell application "Finder" to open trash', '-e', 'tell application "Finder" to activate'];
  } else if (platform === 'linux') {
    command = '/usr/bin/gio'; args = ['open', 'trash:///'];
  } else throw new Error('Die Papierkorbansicht ist auf diesem System nicht verfügbar.');
  try {
    await new Promise((resolve, reject) => (options.executeFile || execFile)(command, args, { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 16384 }, error => error ? reject(error) : resolve()));
  } catch (cause) {
    const message = cause.code === 'ENOENT' ? 'Die Papierkorbansicht ist auf diesem System nicht verfügbar.' : cause.code === 'ETIMEDOUT' || cause.killed ? 'Zeitlimit beim Öffnen des Papierkorbs überschritten.' : 'Der Papierkorb konnte nicht geöffnet werden.';
    throw new Error(message, { cause });
  }
  return { requested: true };
}

module.exports = { openTrash };
