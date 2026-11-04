const test = require('node:test');
const assert = require('node:assert/strict');

test('Linux validation refuses a different host before starting test processes', () => {
  const { runLinuxTests } = require('../scripts/test-linux.cjs');
  assert.throws(() => runLinuxTests({ platform: 'win32', spawn: () => assert.fail('A Linux test process must not start on Windows.') }), /Linux/);
});

test('Linux validation requires desktop fixtures even when the inherited environment disables them', () => {
  const { runLinuxTests } = require('../scripts/test-linux.cjs');
  let invocation;
  const status = runLinuxTests({ platform: 'linux', env: { BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS: '0', TEST_MARKER: 'retained' }, spawn: (...args) => {
    invocation = args;
    return { status: 0 };
  } });
  assert.equal(status, 0);
  assert.equal(invocation[2].env.BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS, '1');
  assert.equal(invocation[2].env.TEST_MARKER, 'retained');
  for (const name of ['filesystem-linux-links.test.js', 'filesystem-linux-metadata.test.js', 'filesystem-linux-no-hardlinks.test.js', 'native-clipboard-wayland-compositor.test.js']) {
    assert.ok(invocation[1].some(argument => argument.endsWith(name)), `Linux validation must include ${name}`);
  }
});

test('Linux validation preserves a failed test process and reports a launch failure', () => {
  const { runLinuxTests } = require('../scripts/test-linux.cjs');
  assert.equal(runLinuxTests({ platform: 'linux', spawn: () => ({ status: 17 }) }), 17);
  assert.throws(() => runLinuxTests({ platform: 'linux', spawn: () => ({ error: Object.assign(new Error('fixture launch denied'), { code: 'EACCES' }) }) }), /fixture launch denied/);
  assert.equal(runLinuxTests({ platform: 'linux', spawn: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
});

test('required Linux desktop fixtures fail instead of silently skipping missing services', () => {
  const { missingDesktopFixture } = require('../scripts/test-linux.cjs');
  const required = { BITFROEST_REQUIRE_LINUX_DESKTOP_TESTS: '1' };
  assert.throws(() => missingDesktopFixture({ status: 77, stderr: 'metadata service missing' }, required), /metadata service missing/);
  assert.throws(() => missingDesktopFixture({ error: Object.assign(new Error('bus missing'), { code: 'ENOENT' }) }, required), /bus missing/);
  assert.equal(missingDesktopFixture({ status: 77 }, {}), true);
  assert.equal(missingDesktopFixture({ status: 0 }, required), false);
});
