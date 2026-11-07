const test = require('node:test');
const assert = require('node:assert/strict');
const { getPrepublishCommands } = require('../scripts/prepublish.cjs');

test('local fast packaging checks the progress contract before building', () => {
  assert.deepEqual(getPrepublishCommands({ BITFROEST_LOCAL_FAST_INSTALL: '1' }), [
    ['run', 'check:progress'], ['run', 'build:xray']
  ]);
});

test('normal packaging retains all release checks', () => {
  assert.deepEqual(getPrepublishCommands({}), [
    ['run', 'build:xray'],
    ['run', 'check:progress'],
    ['run', 'check:operations'],
    ['run', 'check:icons'],
    ['run', 'test:architecture']
  ]);
});
