const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('native terminal inspection preserves literal directories and never starts a terminal', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-'));
  const session = require(binary).openSession();
  try {
    const api = require('../native-api').createNativeApi(require(binary));
    const facade = api.openSession();
    try {
      const inspected = await facade.invoke('shell.openTerminal', { path: directory, inspectOnly: true });
      assert.equal(inspected.requested, false);
    } finally { facade.close(); }
    const root = path.parse(directory).root;
    const rootResult = await session.invoke('shell.openTerminal', { path: root, inspectOnly: true });
    assert.equal(rootResult.requested, false);
    assert.ok(rootResult.parameters.endsWith(root + '\\"'));
    for (const name of ['with spaces', 'a;new-tab', 'ä&%name']) {
      const target = path.join(directory, name); await fs.mkdir(target);
      const result = await session.invoke('shell.openTerminal', { path: target, inspectOnly: true });
      assert.equal(result.requested, false);
      assert.match(result.parameters, /^-w 0 nt -p "Windows PowerShell" -d "/);
      assert.ok(result.parameters.includes(target.replaceAll(';', '\\;')));
      assert.equal(result.parameters.at(-1), '"');
    }
    for (const request of [{}, { path: 'relative' }, { path: 'C:/bad\0path' }, { path: directory, inspectOnly: 'yes' }]) {
      assert.throws(() => session.invoke('shell.openTerminal', request), { code: 'InvalidRequest' });
    }
    await assert.rejects(session.invoke('shell.openTerminal', { path: path.join(directory, 'missing'), inspectOnly: true }), { code: 'NotFound' });
    const file = path.join(directory, 'file'); await fs.writeFile(file, 'preserved');
    await assert.rejects(session.invoke('shell.openTerminal', { path: file, inspectOnly: true }));
    assert.equal(await fs.readFile(file, 'utf8'), 'preserved');
  } finally { session.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
