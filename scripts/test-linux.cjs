const path = require('node:path');
const { spawnSync } = require('node:child_process');

const files = Object.freeze([
  'native-api.test.js', 'native-binding.test.js', 'native-folder-icons.test.js', 'native-locks-linux-api.test.js',
  'native-desktop-linux-api.test.js', 'folder-locks-linux-routing.test.js',
  'folder-locks-posix.test.js', 'folder-locks-posix-native.test.js',
  'open-file.test.js', 'open-trash.test.js', 'open-terminal.test.js',
  'native-copy-linux.test.js', 'native-copy-linux-api.test.js', 'native-copy.test.js',
  'native-clipboard-linux-api.test.js', 'x11-readiness.test.js', 'commander-clipboard.test.js', 'commander-i18n.test.js',
  'git-index-linux.test.js', 'git-file-actions.test.js', 'git-status-native.test.js',
  'clipboard-provider.test.js', 'webview-platform-support.test.js', 'webview-clipboard.test.js',
  'filesystem-copy-verification.test.js', 'filesystem-cancellation.test.js',
  'filesystem-write-races.test.js', 'filesystem-delete.test.js', 'linux-test-runner.test.js',
  'filesystem-linux-links.test.js', 'filesystem-linux-metadata.test.js',
  'filesystem-linux-no-hardlinks.test.js', 'native-clipboard-wayland-compositor.test.js'
]);

function missingDesktopFixture(result, env = process.env) {
  const missing = result.error?.code === 'ENOENT' || result.status === 77;
  if (missing && env.BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS === '1') {
    throw new Error(`A required Linux desktop fixture is unavailable: ${result.stderr || result.error?.message || 'fixture exited with status 77'}`);
  }
  return missing;
}

function runLinuxTests(options = {}) {
  if ((options.platform || process.platform) !== 'linux') throw new Error('Linux validation requires a Linux host.');
  const root = path.resolve(__dirname, '..');
  const result = (options.spawn || spawnSync)(process.execPath, ['--test', ...files.map(file => path.join(root, 'tests', file))], {
    cwd: root,
    stdio: 'inherit',
    env: { ...(options.env || process.env), BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS: '1' }
  });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  try { process.exitCode = runLinuxTests(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { runLinuxTests, missingDesktopFixture };
