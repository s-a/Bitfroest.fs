const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createNativeApi } = require('../native-api');
const { maximizeWindow } = require('../native-window');
const { openTrash } = require('../open-trash');

const enabled = process.platform === 'win32' && process.env.NATIVE_DESKTOP_ACCEPTANCE === '1';
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('approved own window maximization and shell menu cancellation preserve the fixture file', { skip: !enabled }, async () => {
  assert.ok(process.env.NATIVE_WINDOW_FIXTURE, 'NATIVE_WINDOW_FIXTURE must name the prebuilt test module.');
  assert.ok(process.env.NATIVE_ACCEPTANCE_ROOT, 'NATIVE_ACCEPTANCE_ROOT must name the approved external fixture directory.');
  const fixture = require(process.env.NATIVE_WINDOW_FIXTURE);
  const api = createNativeApi(require(binary));
  const session = api.openSession();
  const root = path.resolve(process.env.NATIVE_ACCEPTANCE_ROOT);
  const file = path.join(root, 'shell-menu-check.txt');
  const token = randomUUID();
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, 'native shell menu acceptance fixture');
  let menu;
  try {
    fixture.startWindow(token);
    assert.equal(fixture.isMaximized(), false);
    assert.equal((await maximizeWindow(token, { nativeApi: api })).maximized, true);
    assert.equal(fixture.isMaximized(), true);
    assert.equal(fixture.menuActive(), false);
    menu = session.invoke('shell.showContextMenu', {
      mode: 'show', paths: [file], roots: [root], keyboard: true,
      ownerTitle: token, lockInspectionLabel: 'Inspect folder locks'
    });
    menu.catch(() => {});
    let visible = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      if (fixture.menuActive()) { visible = true; break; }
      await delay(20);
    }
    assert.equal(visible, true, 'The native popup must actually enter menu mode before cancellation.');
    session.close();
    try {
      const result = await menu;
      assert.equal(result.displayed, true);
      assert.equal(result.cancelled, true);
      assert.equal(result.invoked, false);
    } catch (error) {
      assert.equal(error.code, 'SessionClosed');
    }
    assert.equal(fixture.menuActive(), false);
    assert.equal(await fs.readFile(file, 'utf8'), 'native shell menu acceptance fixture');
  } finally {
    session.close();
    if (menu) await menu.catch(() => {});
    fixture.closeWindow();
    await api.shutdownAsync();
  }
});

test('approved trash view activation requests the operating system view', { skip: !enabled }, async () => {
  const api = createNativeApi(require(binary));
  try {
    const result = await openTrash({ platform: 'win32', nativeApi: api });
    assert.equal(result.requested, true);
  } finally { await api.shutdownAsync(); }
});
