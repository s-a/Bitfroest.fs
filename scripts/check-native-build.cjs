const fs = require('node:fs');
const os = require('node:os');

function checkNativeBuild(binary) {
  const data = fs.readFileSync(binary);
  const home = os.homedir().replaceAll('\\', '/').toLowerCase();
  for (const encoding of ['latin1', 'utf16le']) {
    const text = data.toString(encoding).replaceAll('\\', '/').toLowerCase();
    if (text.includes(home) || /(?:[a-z]:\/users\/|\/home\/|\/users\/)[^/\0\r\n]+\//.test(text)) {
      throw new Error('The native module contains a build-user directory. Use source and build directories outside user profiles.');
    }
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('One native module path is required.');
    checkNativeBuild(process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { checkNativeBuild };
