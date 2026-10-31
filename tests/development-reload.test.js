const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts/development-host/extension.cjs');
const load = () => require(entry);

function fixture(t, extra = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = [], errors = [], calls = [];
  const watcher = load().startWatcher(root, {
    watch(directory, options, listener) {
      const record = { directory, options, listener, closed: false };
      listeners.push(record);
      return { on() {}, close() { record.closed = true; } };
    },
    reload() { calls.push('reload'); },
    onError(error) { errors.push(error); },
    ...extra
  });
  t.after(() => watcher.dispose());
  return { watcher, listeners, errors, calls, change: name => listeners[0].listener('change', name) };
}

test('external writes and atomic replacements reload once after a quiet interval', async t => {
  const app = fixture(t);
  app.change('extension.js');
  t.mock.timers.tick(500);
  app.listeners.find(item => item.directory === path.join(root, 'media')).listener('rename', 'app.css');
  t.mock.timers.tick(749);
  assert.deepEqual(app.calls, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(app.calls, ['reload']);
  app.change('package.json');
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(app.calls.length, 1);
});

test('tests, dependencies, documentation and generated logs do not trigger reloads', async t => {
  const app = fixture(t);
  for (const name of ['README.md', 'package-lock.json', 'eslint.config.js', 'tests/example.test.js', 'node_modules/library/index.js', '.git/index', 'debug.log']) app.change(name);
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.deepEqual(app.calls, []);
  assert.equal(app.listeners.some(item => item.directory.includes('node_modules')), false);
});

test('disposal cancels pending reloads and closes every watcher', async t => {
  const app = fixture(t);
  app.change('extension.js');
  app.watcher.dispose();
  app.change('extension.js');
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.deepEqual(app.calls, []);
  assert.ok(app.listeners.every(item => item.closed));
});

test('failed reloads are reported and a later edit can retry', async t => {
  const failure = new Error('reload unavailable');
  const app = fixture(t, { reload: () => Promise.reject(failure) });
  app.change('extension.js');
  t.mock.timers.tick(750);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(app.errors, [failure]);
  app.change('file-type-colors.json');
  t.mock.timers.tick(750);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(app.errors.length, 2);
});

test('watcher initialization and asynchronous errors are reported without blocking other paths', t => {
  const errors = [], callbacks = [], watchers = [];
  const failure = new Error('watch unavailable');
  const watcher = load().startWatcher(root, {
    reload() {}, onError: error => errors.push(error),
    watch(directory) {
      if (directory === root) throw failure;
      const item = { closed: false, on(_event, callback) { callbacks.push(callback); }, close() { this.closed = true; } };
      watchers.push(item);
      return item;
    }
  });
  t.after(() => watcher.dispose());
  assert.deepEqual(errors, [failure]);
  assert.ok(callbacks.length > 0);
  callbacks[0](failure);
  assert.deepEqual(errors, [failure, failure]);
  watcher.dispose();
  assert.ok(watchers.every(item => item.closed));
});

test('real filesystem writes outside the editor trigger a reload', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfroest-development-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'media'));
  const reloaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('filesystem reload timed out')), 5000);
    t.after(() => clearTimeout(timeout));
    const watcher = load().startWatcher(directory, { delay: 30, reload: resolve, onError: reject });
    t.after(() => watcher.dispose());
  });
  fs.writeFileSync(path.join(directory, 'media', 'app.css'), 'body {}');
  await reloaded;
});

test('companion activation watches the project and registers cleanup with the host', t => {
  const callbacks = [], commands = [], subscriptions = [];
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(entry), console, setTimeout, clearTimeout,
    require(name) {
      if (name === 'vscode') return { commands: { executeCommand: name => commands.push(name) } };
      if (name === 'node:fs') return { existsSync: fs.existsSync, watch: (_dir, _options, callback) => { callbacks.push(callback); return { on() {}, close() {} }; } };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), sandbox);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.module.exports.activate({ subscriptions });
  t.after(() => subscriptions.forEach(item => item.dispose()));
  assert.equal(subscriptions.length, 1);
  callbacks[0]('change', 'extension.js');
  t.mock.timers.tick(750);
  return Promise.resolve().then(() => assert.deepEqual(commands, ['workbench.action.reloadWindow']));
});

test('PowerShell starter and F5 load the project and the companion without installing', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(root, 'Start-Development.ps1').replaceAll("'", "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; function Invoke-TestCode { $args | ConvertTo-Json -Compress }; & '${script}' -CodeCommand Invoke-TestCode`
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout.trim());
  assert.deepEqual(args, ['--new-window', `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${path.join(root, 'scripts', 'development-host')}`, root]);
  const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8')).configurations[0];
  assert.equal(launch.type, 'extensionHost');
  assert.ok(launch.args.includes('--extensionDevelopmentPath=${workspaceFolder}'));
  assert.ok(launch.args.includes('--extensionDevelopmentPath=${workspaceFolder}/scripts/development-host'));
  const companion = JSON.parse(fs.readFileSync(path.join(root, 'scripts/development-host/package.json'), 'utf8'));
  assert.ok(companion.activationEvents.includes('onStartupFinished'));
  assert.equal(companion.main, './extension.cjs');
  const excluded = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  for (const pattern of ['scripts/**', '.vscode/**', 'Start-Development.ps1']) assert.ok(excluded.includes(pattern));
});
