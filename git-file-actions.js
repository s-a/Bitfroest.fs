const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

function literalRule(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || /[\r\n\0]/.test(relative)) throw new Error('Invalid Git file selection.');
  return '/' + relative.split(path.sep).map(part => part.replace(/[\\*?[\]#! ]/g, '\\$&')).join('/');
}
function decode(buffer) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (content.includes('\0')) throw new Error('Invalid encoding');
    return content;
  } catch { throw new Error('.gitignore must contain UTF-8 text.'); }
}
async function readIgnore(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('.gitignore is not a regular file.');
    return decode(await fs.readFile(filename));
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function createGitFileActions(options = {}) {
  const index = options.index || require('./git-index').createGitIndexProvider();
  const tickets = new WeakSet();
  return {
    async prepare({ repositoryRoot, target, ignore = false }) {
      literalRule(repositoryRoot, target);
      const directory = path.dirname(target), rule = literalRule(directory, target), filename = path.join(directory, '.gitignore');
      if (ignore) {
        const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (identity(filename) === identity(target)) throw new Error('The ignore file cannot ignore itself through this action.');
        await readIgnore(filename);
        const source = await fs.lstat(target);
        try {
          const existing = await fs.lstat(filename);
          if (source.dev === existing.dev && source.ino === existing.ino) throw new Error('The ignore file and selected path refer to the same file.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const prepared = { index: await index.prepare({ repositoryRoot, target }), ignore, filename, rule, target };
      tickets.add(prepared); return prepared;
    },
    async execute(prepared) {
      if (!prepared || !tickets.has(prepared)) throw new Error('Invalid or expired Git file selection.');
      tickets.delete(prepared);
      const result = await index.untrack(prepared.index);
      if (!prepared.ignore) return result;
      let handle;
      try {
        await readIgnore(prepared.filename);
        handle = await fs.open(prepared.filename, 'a+');
        const before = await handle.stat(), actual = await fs.lstat(prepared.filename);
        if (!actual.isFile() || actual.isSymbolicLink() || before.dev !== actual.dev || before.ino !== actual.ino) throw new Error('.gitignore identity changed.');
        const source = await fs.lstat(prepared.target);
        if (source.dev === before.dev && source.ino === before.ino) throw new Error('The ignore file and selected path refer to the same file.');
        const content = decode(await handle.readFile());
        const newline = content.includes('\r\n') || !content && process.platform === 'win32' ? '\r\n' : '\n';
        await handle.writeFile(`${newline}${prepared.rule}${newline}`, 'utf8');
        await handle.sync();
        return { ...result, ignored: true };
      } catch (cause) {
        const error = new Error('The file is no longer tracked, but .gitignore could not be updated. Local file data is unchanged.', { cause });
        error.untracked = true; throw error;
      } finally { await handle?.close(); }
    },
    dispose() { index.dispose?.(); }
  };
}
module.exports = { createGitFileActions, literalRule };
