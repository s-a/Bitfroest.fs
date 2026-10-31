const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClipboardProvider } = require('../clipboard-provider');
const { openAssociatedFile } = require('../open-file');

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Caller remained blocked.')), 100); })]); }
  finally { clearTimeout(timer); }
}

test('native clipboard timeout closes only the stalled session and allows a new explicit request', async () => {
  let opened = 0, closed = 0, late;
  const provider = createClipboardProvider({ platform: 'win32', timeout: 2, contains: value => value.startsWith('C:/tmp/'),
    nativeApiFactory: () => ({ openSession() {
      const number = ++opened;
      return { invoke: () => number === 1 ? new Promise(resolve => { late = resolve; }) : Promise.resolve({ paths: ['C:/tmp/new.txt'], mode: 'copy', token: 'new' }), close() { closed++; } };
    } })
  });
  try {
    await assert.rejects(bounded(provider.read()), { code: 'ClipboardTimeout' });
    assert.equal(closed, 1);
    assert.equal(opened, 1);
    assert.equal((await bounded(provider.read())).token, 'new');
    late({ paths: ['C:/tmp/old.txt'], mode: 'move', token: 'old' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await provider.read()).token, 'new');
  } finally { provider.dispose(); }
});

test('native association timeout closes the session and rejects a late editor result', async () => {
  let closed = 0, late;
  const promise = openAssociatedFile('C:/tmp/fixture.txt', { platform: 'win32', timeout: 2,
    nativeApi: { openSession: () => ({ invoke: () => new Promise(resolve => { late = resolve; }), close() { closed++; } }) }
  });
  await assert.rejects(bounded(promise), { code: 'DesktopTimeout' });
  assert.equal(closed, 1);
  late({ editor: true });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(promise, { code: 'DesktopTimeout' });
});
