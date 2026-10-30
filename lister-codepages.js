const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('./media/commander-lister');

function createCodepageDecoder() {
  let processHandle, pending, input = '', diagnostics = '', queue = Promise.resolve(), disposed = false;
  function start() {
    if (processHandle) return processHandle;
    if (disposed) throw new Error('Der Decoder ist geschlossen.');
    if (process.platform !== 'win32') throw new Error('Diese Codeseite benötigt den Windows-Decoder.');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native', 'lister-codepages.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    processHandle = child;
    input = '';
    diagnostics = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (processHandle !== child) return;
      input += chunk;
      let index;
      while ((index = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, index); input = input.slice(index + 1);
        const task = pending; pending = null;
        if (!task) continue;
        clearTimeout(task.timer);
        try { const result = JSON.parse(line); if (result.error) task.reject(new Error(result.error)); else task.resolve(result); }
        catch (error) { task.reject(error); }
      }
    });
    const failed = error => { if (processHandle !== child) return; processHandle = null; if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
    child.on('error', failed); child.on('exit', () => failed(new Error(`Der Codierungsprozess wurde beendet.${diagnostics ? ` ${diagnostics.trim()}` : ''}`)));
    child.stdin.on('error', failed); child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
    return child;
  }
  return {
    async text(bytes, encoding) {
      const value = String(encoding);
      if (!['0', '1', '2'].includes(value)) {
        try { return new TextDecoder(core.decoderLabel(value), { ignoreBOM: true }).decode(bytes); } catch (error) { if (!/^\d+$/.test(value)) throw error; }
      }
      return (await this.decode(bytes, value, 0, true)).text;
    },
    async decode(bytes, encoding, offset = 0, textOnly = false) {
      const value = String(encoding), native = ['0', '1', '2'].includes(value);
      if (/^(?:5022\d|52936|65000|5700[2-9]|5701[01])$/.test(value)) throw new Error('Zustandsbehaftete Codeseiten werden für Bereichsansichten nicht unterstützt.');
      if (native && bytes.every(byte => byte < 128)) return { text: Buffer.from(bytes).toString('ascii'), map: textOnly ? [] : Array.from({ length: bytes.length + 1 }, (_, index) => offset + index), encoding: value };
      if (!native) { try { return core.decode(bytes, value, offset); } catch (error) { if (!/^\d+$/.test(value)) throw error; } }
      const run = () => new Promise((resolve, reject) => {
        const child = start();
        const timer = setTimeout(() => { pending = null; child.kill(); reject(new Error('Zeitlimit beim Dekodieren überschritten.')); }, 15000);
        pending = { resolve: result => resolve({ ...result, map: result.map?.map(position => position + offset) }), reject, timer };
        child.stdin.write(JSON.stringify({ bytes: Buffer.from(bytes).toString('base64'), codepage: Number(value), textOnly }) + '\n');
      });
      const result = queue.then(run); queue = result.catch(() => {}); return result;
    },
    dispose() { disposed = true; if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Der Decoder ist geschlossen.')); pending = null; } processHandle?.kill(); processHandle = null; }
  };
}
module.exports = { createCodepageDecoder };
