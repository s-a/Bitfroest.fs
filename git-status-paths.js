const path = require('node:path');
const { identity: pathIdentity } = require('./media/commander-paths');

function allowedGitPath(directory, settings = {}) {
  const identity = value => {
    return pathIdentity(path.resolve(value), { platform: process.platform }).replace(/\/$/, '');
  };
  const target = identity(directory);
  const inside = value => { const prefix = identity(value); return target === prefix || target.startsWith(prefix + '/'); };
  if ((settings.excludePaths || []).some(value => typeof value === 'string' && value && inside(value))) return false;
  const included = (settings.includePaths || []).filter(value => typeof value === 'string' && value);
  return !included.length || included.some(inside);
}

module.exports = { allowedGitPath };
