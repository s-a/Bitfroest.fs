const fs = require('node:fs');
const path = require('node:path');

function stagePackage(source, target) {
  const root = path.resolve(source);
  const excluded = new Set(['.git', '.tmp', 'node_modules', 'native/build', 'native/out']);
  fs.cpSync(root, target, {
    recursive: true,
    filter(entry) {
      const relative = path.relative(root, entry).replaceAll('\\', '/');
      return !excluded.has(relative);
    }
  });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(target, 'node_modules'), 'junction');
}

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Expected source and staging directories.');
  stagePackage(process.argv[2], process.argv[3]);
}

module.exports = { stagePackage };
