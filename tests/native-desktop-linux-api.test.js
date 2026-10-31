const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createNativeApi } = require('../native-api');

test('Linux desktop operations are exposed by the packaged module when GIO is installed', { skip: process.platform !== 'linux' }, async () => {
  const binding = require(process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node'));
  const api = createNativeApi(binding);
  try {
    assert.equal(api.capabilities['shell.openAssociated'].status, 'conditional');
    assert.equal(api.capabilities['shell.openTrash'].status, 'conditional');
  } finally { await api.shutdownAsync(); }
});

async function runDesktopFixture(t, scenario, registered = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-desktop-linux-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['config', 'data/applications', 'cache', 'runtime', 'empty']) await fs.mkdir(path.join(root, name), { recursive: true });
  const target = path.join(root, 'spaces ü & $report.txt'), log = path.join(root, 'launch.json');
  const app = path.join(root, 'activation.cjs');
  await fs.writeFile(target, 'UNCHANGED');
  await fs.writeFile(app, "require('node:fs').writeFileSync(process.env.TEST_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)));\n");
  if (registered) {
    await fs.writeFile(path.join(root, 'data/applications/fixture.desktop'), `[Desktop Entry]\nType=Application\nName=Desktop fixture\nExec="${process.execPath}" "${app}" %u\nTerminal=false\nMimeType=text/plain;application/octet-stream;x-scheme-handler/trash;\n`);
    await fs.writeFile(path.join(root, 'config/mimeapps.list'), '[Default Applications]\ntext/plain=fixture.desktop\napplication/octet-stream=fixture.desktop\nx-scheme-handler/trash=fixture.desktop\n');
  }
  const script = `
    (async () => {
      const assert = require('node:assert/strict');
      const fs = require('node:fs/promises');
      const { fileURLToPath } = require('node:url');
      const path = require('node:path');
      const { createNativeApi } = require(process.env.TEST_NATIVE_API);
      const api = createNativeApi(require(process.env.NATIVE_BINDING_TEST_PATH));
      const session = api.openSession();
      const target = process.env.TEST_DESKTOP_FILE;
      const log = process.env.TEST_LAUNCH_LOG;
      try { ${scenario} } finally { await api.shutdownAsync(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync('dbus-run-session', ['--', process.execPath, '-e', script], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_RUNTIME_DIR: path.join(root, 'runtime'),
      XDG_DATA_DIRS: path.join(root, 'empty'), XDG_CONFIG_DIRS: path.join(root, 'empty'),
      XDG_CURRENT_DESKTOP: 'TestFixture', GIO_USE_VFS: 'local', TEST_LAUNCH_LOG: log,
      TEST_DESKTOP_FILE: target, TEST_NATIVE_API: path.join(__dirname, '../native-api.js'),
      TEST_NATIVE_PRODUCT_ROOT: process.env.NATIVE_PRODUCT_TEST_ROOT || path.join(__dirname, '..'),
      NATIVE_BINDING_TEST_PATH: process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node') }
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(target, 'utf8'), 'UNCHANGED');
}

test('Linux native association inspection finds the private MIME handler without launching it', { skip: process.platform !== 'linux' }, async t => {
  await runDesktopFixture(t, `
    const result = await session.invoke('shell.openAssociated', { path: target, inspectOnly: true });
    assert.equal(result.available, true);
    assert.equal(result.requested, false);
    assert.equal(result.editor, false);
    assert.equal(result.outcome.status, 'unchanged');
    await assert.rejects(fs.stat(log), { code: 'ENOENT' });
  `);
});

for (const trash of [false, true]) test(`Linux native launcher dispatches ${trash ? 'trash URI' : 'file URI'} to the private headless application`, { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  await runDesktopFixture(t, `
    const result = await session.invoke('${trash ? 'shell.openTrash' : 'shell.openAssociated'}', ${trash ? '{}' : '{ path: target }'});
    assert.equal(result.available, true);
    assert.equal(result.requested, true);
    assert.equal(result.outcome.status, 'committed');
    let argumentsReceived;
    const deadline = Date.now() + 5000;
    while (!argumentsReceived && Date.now() < deadline) {
      try { argumentsReceived = JSON.parse(await fs.readFile(log, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.deepEqual(${trash ? 'argumentsReceived' : "argumentsReceived.map(value => value.startsWith('file:') ? fileURLToPath(value) : value)"}, [${trash ? "'trash:///'" : 'target'}]);
  `);
});

test('Linux module remains loadable when the optional desktop library cannot be loaded', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-desktop-library-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'libgio-2.0.so.0'), 'invalid-library-fixture');
  const binding = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
  const script = `const assert = require('node:assert/strict'); const binding = require(process.env.NATIVE_BINDING_TEST_PATH); assert.equal(binding.capabilities['shell.openAssociated'].status, 'unsupported'); assert.equal(binding.capabilities['shell.openTrash'].status, 'unsupported'); assert.equal(binding.capabilities['git.info'].status, 'supported'); const session = binding.openSession(); session.close();`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LD_LIBRARY_PATH: root, NATIVE_BINDING_TEST_PATH: binding } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Linux native activation reports absent associations without claiming a launch', { skip: process.platform !== 'linux' }, async t => {
  await runDesktopFixture(t, `
    const inspection = await session.invoke('shell.openAssociated', { path: target, inspectOnly: true });
    assert.equal(inspection.available, false);
    assert.equal(inspection.requested, false);
    await assert.rejects(session.invoke('shell.openAssociated', { path: target }), error => error.code === 'Unavailable' && error.nativeCode !== undefined);
    await assert.rejects(fs.stat(log), { code: 'ENOENT' });
  `, false);
});

test('Linux desktop session close prevents a queued launch and preserves an unchanged outcome', { skip: process.platform !== 'linux' }, async t => {
  await runDesktopFixture(t, `
    const pending = session.invoke('shell.openAssociated', { path: target });
    const rejected = assert.rejects(pending, error => error.code === 'SessionClosed' && error.outcome.status === 'unchanged' && error.outcome.requested === false);
    await session.closeAsync();
    await rejected;
    await assert.rejects(fs.stat(log), { code: 'ENOENT' });
  `);
});

test('Linux association inspection distinguishes a missing file from an absent MIME association', { skip: process.platform !== 'linux' }, async t => {
  await runDesktopFixture(t, `
    await assert.rejects(session.invoke('shell.openAssociated', { path: target + '.missing', inspectOnly: true }), error =>
      error.code === 'NotFound' && error.nativeDomain === 'g-io-error-quark' && typeof error.nativeCode === 'number');
    await assert.rejects(fs.stat(log), { code: 'ENOENT' });
  `);
});

for (const trash of [false, true]) test(`Linux product default dispatches ${trash ? 'trash' : 'file'} through the packaged native module`, { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  await runDesktopFixture(t, `
    const product = process.env.TEST_NATIVE_PRODUCT_ROOT;
    const result = ${trash ? "await require(path.join(product, 'open-trash.js')).openTrash()" : "await require(path.join(product, 'open-file.js')).openAssociatedFile(target)"};
    assert.deepEqual(result, ${trash ? '{ requested: true }' : '{ editor: false }'});
    let args;
    const deadline = Date.now() + 5000;
    while (!args && Date.now() < deadline) {
      try { args = JSON.parse(await fs.readFile(log, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.deepEqual(${trash ? 'args' : "args.map(value => value.startsWith('file:') ? fileURLToPath(value) : value)"}, [${trash ? "'trash:///'" : 'target'}]);
  `);
});
