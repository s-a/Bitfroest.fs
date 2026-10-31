const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inspectRuntimeSource } = require('./support/runtime-architecture.cjs');

const root = path.resolve(__dirname, '..');
const excluded = new Set(['.git', '.vscode', '.nyc_output', 'node_modules', 'coverage', 'Docs', 'design', 'scripts', 'tests']);

function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    if (!prefix && excluded.has(item.name)) return [];
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) return files(path.join(directory, item.name), relative);
    return item.isFile() ? [relative] : [];
  });
}

test('product JavaScript has no external process execution or opaque loader paths', () => {
  const sourceFiles = files(root).filter(name => /\.(?:js|cjs|mjs)$/.test(name) && name !== 'eslint.config.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(sourceFiles.includes(manifest.main.replace(/^\.\//, '')));
  const violations = sourceFiles.flatMap(name => inspectRuntimeSource(fs.readFileSync(path.join(root, name), 'utf8'), name));
  assert.equal(violations.length, 0, violations.map(item => `${item.file}:${item.line}: ${item.message}`).join('\n'));
});

test('native bridge distribution contains no interpreter scripts', () => {
  const scripts = files(path.join(root, 'native')).filter(name => /\.(?:ps1|psm1|psd1|js|cjs|mjs|py)$/i.test(name));
  assert.equal(scripts.length, 0, `Native bridge scripts still require migration:\n${scripts.join('\n')}`);
});

test('packaged native module contains no developer home directory paths', () => {
  const binary = fs.readFileSync(path.join(root, 'native/binding.node'));
  const paths = [os.homedir().replace(/\\/g, '/'), os.homedir().replace(/\//g, '\\')].map(value => value.toLowerCase());
  for (const encoding of ['latin1', 'utf16le']) {
    const strings = binary.toString(encoding).toLowerCase();
    for (const home of paths) assert.equal(strings.includes(home), false, 'Native build metadata contains a local home directory.');
  }
});

test('replaced icon adapters are absent from the native distribution', () => {
  for (const name of ['file-icons.ps1', 'file-icons-macos.js']) {
    assert.equal(fs.existsSync(path.join(root, 'native', name)), false, `${name} has been replaced`);
  }
  const source = fs.readFileSync(path.join(root, 'filesystem-icons.js'), 'utf8');
  assert.equal(/file-icons\.(?:ps1|js)|file-icons-macos\.js/.test(source), false);
  assert.equal(inspectRuntimeSource(source, 'filesystem-icons.js').length, 0);
});

test('case rename uses the native module and has no interpreter adapter', () => {
  assert.equal(fs.existsSync(path.join(root, 'native/file-rename.ps1')), false);
  assert.deepEqual(inspectRuntimeSource(fs.readFileSync(path.join(root, 'native-rename.js'), 'utf8'), 'native-rename.js'), []);
});

test('Windows clipboard and file activation have no remaining PowerShell adapters', () => {
  for (const name of ['file-clipboard.ps1', 'open-file.ps1']) assert.equal(fs.existsSync(path.join(root, 'native', name)), false, name);
  for (const name of ['clipboard-provider.js', 'open-file.js']) assert.equal(/powershell/i.test(fs.readFileSync(path.join(root, name), 'utf8')), false, name);
});

test('Windows window setup and shell menus have no remaining interpreter adapters', () => {
  for (const name of ['maximize-window.ps1', 'file-context-menu.ps1']) assert.equal(fs.existsSync(path.join(root, 'native', name)), false, name);
  for (const name of ['extension.js', 'native-window.js', 'native-shell-menu.js']) {
    assert.deepEqual(inspectRuntimeSource(fs.readFileSync(path.join(root, name), 'utf8'), name), []);
  }
  assert.equal(/powershell/i.test(fs.readFileSync(path.join(root, 'open-trash.js'), 'utf8')), false);
});

test('Windows lock operations have no interpreter or runtime compilation adapter', () => {
  for (const name of ['folder-locks.ps1', 'folder-locks.cs']) assert.equal(fs.existsSync(path.join(root, 'native', name)), false, name);
  const source = fs.readFileSync(path.join(root, 'folder-locks.js'), 'utf8');
  assert.deepEqual(inspectRuntimeSource(source, 'folder-locks.js'), []);
  assert.equal(/powershell|folder-locks\.(?:ps1|cs)/i.test(source), false);
});

test('Windows copy uses the native module without a PowerShell worker', () => {
  assert.equal(fs.existsSync(path.join(root, 'native/file-copy.ps1')), false);
  const source = fs.readFileSync(path.join(root, 'native-copy.js'), 'utf8');
  assert.deepEqual(inspectRuntimeSource(source, 'native-copy.js'), []);
  assert.equal(/powershell|file-copy\.ps1/i.test(source), false);
});

test('development exclusions cannot hide distributed process helpers', () => {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const directory of ['scripts', 'tests', 'Docs', 'coverage', '.vscode', 'design']) {
    assert.ok(ignore.split(/\r?\n/).includes(`${directory}/**`), `${directory} must be excluded from distribution`);
    assert.equal(ignore.split(/\r?\n/).some(line => line.startsWith(`!${directory}/`)), false);
  }
});

test('native production build and package contain no executable helpers', () => {
  const nativeFiles = files(path.join(root, 'native'));
  assert.deepEqual(nativeFiles.filter(name => /\.(?:exe|com|bat|cmd)$/i.test(name)), []);
  const cmake = fs.readFileSync(path.join(root, 'native/CMakeLists.txt'), 'utf8');
  assert.equal(/add_executable\s*\(/i.test(cmake), false);
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('native/*.exe'));
  assert.equal(ignore.some(line => /^!native\/.*\.exe$/i.test(line)), false);
  for (const file of files(path.join(root, 'native/src')).filter(name => /\.(?:cc|cpp|h)$/.test(name))) {
    const source = fs.readFileSync(path.join(root, 'native/src', file), 'utf8');
    assert.equal(/\b(?:CreateProcess[AW]?|WinExec|_w?spawn\w*|_w?popen)\s*\(/.test(source), false, `${file} must not launch a helper process`);
  }
});

test('extension packaging and publishing enforce the runtime architecture gate', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['vscode:prepublish'], 'npm run test:architecture');
});

test('distribution contains a loadable precompiled binding and excludes its build sources', () => {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('!native/binding.node'));
  assert.ok(ignore.includes('native/src/**'));
  assert.ok(ignore.includes('native/CMakeLists.txt'));
  const api = require('../native-api').loadNativeApi();
  assert.equal(api.apiVersion.major, 1);
  const session = api.openSession(); session.close(); api.shutdown();
});
