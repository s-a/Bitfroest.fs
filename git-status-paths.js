const path = require('node:path');

function allowedGitPath(directory, settings = {}) {
  const identity = value => {
    const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const target = identity(directory);
  const inside = value => { const prefix = identity(value); return target === prefix || target.startsWith(prefix + '/'); };
  if ((settings.excludePaths || []).some(value => typeof value === 'string' && value && inside(value))) return false;
  const included = (settings.includePaths || []).filter(value => typeof value === 'string' && value);
  return !included.length || included.some(inside);
}

module.exports = { allowedGitPath };
