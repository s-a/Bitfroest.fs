const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFilesystemIcons, clearFilesystemIconCache } = require('../filesystem-icons');

test('a stalled direct shell icon query releases its caller and suppresses late results', async () => {
  clearFilesystemIconCache();
  let finish, closes = 0;
  const request = [{ key: 'stalled-icon', name: 'file.txt', type: 'file' }];
  const result = getFilesystemIcons(request, { platform: 'win32', timeout: 2, nativeApi: {
    openSession: () => ({ invoke: () => new Promise(resolve => { finish = resolve; }), close: () => { closes++; } })
  } });
  const completed = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
  assert.ok(completed);
  assert.equal(completed['stalled-icon'], null);
  assert.equal(closes, 1);
  finish({ icons: [{ key: 'stalled-icon', png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed['stalled-icon'], null);
  clearFilesystemIconCache();
});
