const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createNativeApi } = require('../native-api');
const { createClipboardProvider } = require('../clipboard-provider');

const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const root = process.env.NATIVE_ACCEPTANCE_ROOT;
const enabled = process.platform === 'win32' && process.env.NATIVE_WINDOWS_ACCEPTANCE === '1';
const slash = value => value.replace(/\\/g, '/');

test('approved live Windows clipboard preserves copy cut partial acknowledgement and concurrent ownership', { skip: !enabled }, async () => {
  assert.ok(root, 'NATIVE_ACCEPTANCE_ROOT must name the approved fixture directory.');
  const api = createNativeApi(require(binary));
  const normalizedRoot = slash(path.resolve(root)) + '/';
  const options = { platform: 'win32', contains: value => value.startsWith(normalizedRoot), nativeApiFactory: () => api };
  const writer = createClipboardProvider(options), reader = createClipboardProvider(options);
  const first = slash(path.join(root, 'clipboard-copy.txt')), second = slash(path.join(root, 'clipboard-move.txt'));
  const movedFirst = first + '.moved', movedSecond = second + '.moved';
  await fs.writeFile(first, 'clipboard copy fixture');
  await fs.writeFile(second, 'clipboard move fixture');
  try {
    const exported = await writer.write({ paths: [first, second], mode: 'copy' });
    assert.equal(exported.mode, 'copy');
    const imported = await reader.read();
    assert.deepEqual(imported.paths, [first, second]);
    assert.equal(imported.mode, 'copy');
    const cut = await writer.write({ paths: [first, second], mode: 'move' });
    await fs.rename(first, movedFirst);
    assert.equal(await writer.ack({ ...cut, remainingPaths: [second] }), true);
    const remaining = await reader.read();
    assert.deepEqual(remaining.paths, [second]);
    assert.equal(remaining.mode, 'move');
    await writer.write({ paths: [movedFirst], mode: 'copy' });
    assert.equal(await reader.ack({ ...remaining, remainingPaths: [] }), false);
    assert.deepEqual((await reader.read()).paths, [movedFirst]);
    const lastCut = await writer.write({ paths: [second], mode: 'move' });
    await fs.rename(second, movedSecond);
    assert.equal(await writer.ack({ ...lastCut, remainingPaths: [] }), true);
    assert.equal(await reader.read(), null);
    await writer.write({ paths: [movedFirst], mode: 'copy' });
    writer.dispose();
    await api.shutdownAsync();
    const nextApi = createNativeApi(require(binary));
    const next = createClipboardProvider({ ...options, nativeApiFactory: () => nextApi });
    try { assert.deepEqual((await next.read()).paths, [movedFirst]); }
    finally { next.dispose(); await nextApi.shutdownAsync(); }
    assert.equal(await fs.readFile(movedFirst, 'utf8'), 'clipboard copy fixture');
    assert.equal(await fs.readFile(movedSecond, 'utf8'), 'clipboard move fixture');
  } finally {
    writer.dispose(); reader.dispose(); await api.shutdownAsync();
  }
});

test('approved Windows opening dispatch preserves the test file and its editor association', { skip: !enabled }, async () => {
  assert.ok(root, 'NATIVE_ACCEPTANCE_ROOT must name the approved fixture directory.');
  const target = path.join(root, 'opening-check.txt');
  const original = await fs.readFile(target);
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    const inspection = await session.invoke('shell.openAssociated', { path: target, inspectOnly: true });
    const activation = await session.invoke('shell.openAssociated', { path: target });
    assert.equal(typeof activation.editor, 'boolean');
    assert.equal(activation.editor, inspection.editor);
    assert.deepEqual(await fs.readFile(target), original);
  } finally { await session.closeAsync(); await api.shutdownAsync(); }
});

test('approved native ShellExecute opens a local fixture through its system association', { skip: !enabled }, async () => {
  assert.ok(root, 'NATIVE_ACCEPTANCE_ROOT must name the approved fixture directory.');
  const target = path.join(root, 'opening-check.html');
  const content = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Native opening check</title><p>Local file association acceptance fixture.</p>';
  await fs.writeFile(target, content);
  const api = createNativeApi(require(binary)), session = api.openSession();
  try {
    const inspection = await session.invoke('shell.openAssociated', { path: target, inspectOnly: true });
    assert.equal(inspection.editor, false, 'A non-editor system association is required to verify ShellExecute.');
    const activation = await session.invoke('shell.openAssociated', { path: target });
    assert.equal(activation.editor, false);
    assert.equal(await fs.readFile(target, 'utf8'), content);
  } finally { await session.closeAsync(); await api.shutdownAsync(); }
});
