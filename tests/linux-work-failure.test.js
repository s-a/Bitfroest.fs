const test = require('node:test');
const assert = require('node:assert/strict');

test('Linux completion construction failure rejects its promise and releases the close barrier', {
  skip: process.platform !== 'linux' || !process.env.NATIVE_LINUX_WORK_TEST_BINDING,
  timeout: 5000
}, async () => {
  const fixture = require(process.env.NATIVE_LINUX_WORK_TEST_BINDING);
  await assert.rejects(fixture.failCompletion(), { code: 'BindingFailure' });
  await fixture.close();
});
