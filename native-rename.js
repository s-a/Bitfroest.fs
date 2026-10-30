const path = require('node:path');
const { execFile } = require('node:child_process');
function runHelper(input) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native', 'file-rename.ps1')], { windowsHide: true, timeout: 20000, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
async function renameCase(input, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Atomic case rename requires Windows.');
  if (!input || !Array.isArray(input.roots) || !input.roots.length) throw new Error('Allowed roots are required.');
  const clean = value => {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) throw new Error('An absolute path without traversal is required.');
    const resolved = path.win32.resolve(value);
    if (resolved.slice(path.win32.parse(resolved).root.length).includes(':')) throw new Error('Named streams are not rename targets.');
    return resolved;
  };
  const roots = input.roots.map(clean), source = clean(input.source), target = clean(input.target);
  const lower = value => value.toLowerCase();
  if (source === target || lower(source) !== lower(target) || lower(path.win32.dirname(source)) !== lower(path.win32.dirname(target))) throw new Error('Only a case change in the same directory is supported.');
  if (!roots.some(root => lower(source).startsWith(lower(root.endsWith('\\') ? root : root + '\\')))) throw new Error('The path is outside the allowed roots.');
  if (!input.expected || !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => (key.endsWith('Ns') ? /^-?\d+$/ : /^\d+$/).test(String(input.expected[key])))) throw new Error('A complete expected file identity is required.');
  const response = await (options.runHelper || runHelper)({ roots, source, target, expected: input.expected });
  let result;
  try { result = typeof response === 'string' ? JSON.parse(response.replace(/^\uFEFF/, '')) : response; } catch (cause) { throw new Error('The native rename response is invalid.', { cause }); }
  if (!result || result.ok !== true) {
    const error = new Error(result?.message || 'The atomic rename failed.'); error.code = result?.code || 'ERENAME'; throw error;
  }
  return { renamed: true };
}
module.exports = { renameCase };
