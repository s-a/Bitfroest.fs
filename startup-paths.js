const fs = require('node:fs');
const { normalizePath } = require('./media/commander-paths');
const { archivePath } = require('./zip-io');

function selectStartupRoots(preferred, fallback, filesystem = fs) {
  const directory = value => {
    try { const stat = filesystem.lstatSync(value); return stat.isDirectory() && !stat.isSymbolicLink(); }
    catch { return false; }
  };
  if (preferred.length && preferred.every(directory)) return preferred.map(value => normalizePath(value));
  const home = filesystem.realpathSync(fallback);
  if (!directory(home)) throw new Error('Ein vorhandenes Startverzeichnis ist erforderlich.');
  return [normalizePath(home)];
}

function existingDirectories(directories) {
  return directories.filter(value => {
    try {
      const archive = archivePath(value), stat = fs.statSync(archive || value);
      return archive ? stat.isFile() : stat.isDirectory();
    } catch { return false; }
  });
}

module.exports = { selectStartupRoots, existingDirectories };
