const path = require('node:path');
const { spawn } = require('node:child_process');
function createSearchMetadata() {
  let child, pending, input = '';
  function fail(error) { if (pending) { pending.reject(error); pending = null; } }
  function start() {
    if (child) return;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native/search-metadata.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      input += data; let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        try { const result = JSON.parse(line); if (result.error) fail(new Error(result.error)); else { pending?.resolve(result.attributes); pending = null; } }
        catch (error) { fail(error); }
      }
    });
    child.on('error', fail); child.on('exit', () => fail(new Error('Der Attributprozess wurde beendet.'))); child.stdin.on('error', fail); child.stderr.resume();
  }
  return {
    async attributes(target, stat) {
      if (process.platform !== 'win32') return { directory: stat.isDirectory(), readonly: !(stat.mode & 0o200), archive: stat.isFile(), hidden: path.basename(target).startsWith('.'), system: false, compressed: false, encrypted: false };
      start(); const flags = await new Promise((resolve, reject) => { pending = { resolve, reject }; child.stdin.write(JSON.stringify({ path: target }) + '\n'); });
      return Object.fromEntries(Object.entries({ readonly: 1, hidden: 2, system: 4, directory: 16, archive: 32, compressed: 2048, encrypted: 16384 }).map(([name, mask]) => [name, Boolean(flags & mask)]));
    },
    dispose() { fail(new Error('Der Attributprozess ist geschlossen.')); child?.stdin.end(); child?.kill(); child = null; }
  };
}
module.exports = { createSearchMetadata };
