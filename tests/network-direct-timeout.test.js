const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveUncPaths } = require('../network-paths');

test('a stalled direct network query releases its caller and closes the native session', async () => {
  let closes = 0;
  const input = ['C:/tmp/file.txt'];
  const result = resolveUncPaths(input, { platform: 'win32', timeout: 2, nativeApi: {
    openSession: () => ({ invoke: () => new Promise(() => {}), close: () => { closes++; } })
  } });
  const completed = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('still-pending'), 100))]);
  assert.deepEqual(completed, input);
  assert.equal(closes, 1);
});
