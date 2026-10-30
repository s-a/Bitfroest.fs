const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProvider } = require('../filesystem-provider');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('real copy and move retain confirmed bytes before a later nested or flat conflict is cancelled', async t => {
  for (const mode of ['copy', 'move']) for (const nested of [false, true]) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'win32' ? 'C:/tmp' : os.tmpdir(), 'primitive-reference-test-')));
    const left = path.join(root, 'left').replace(/\\/g, '/'), right = path.join(root, 'right').replace(/\\/g, '/');
    t.after(async () => {
      assert.ok(path.basename(root).startsWith('primitive-reference-test-'));
      await fs.rm(root, { recursive: true, force: true });
    });
    const source = nested ? `${left}/docs` : left, target = nested ? `${right}/docs` : right;
    await fs.mkdir(source, { recursive: true }); await fs.mkdir(target, { recursive: true });
    const bytes = Buffer.from([0, 255, 17, 0, 128]);
    await fs.writeFile(`${source}/a-first.bin`, bytes); await fs.writeFile(`${source}/b-conflict.txt`, 'source');
    await fs.writeFile(`${target}/b-conflict.txt`, 'target');
    const provider = createProvider({ roots: [left, right] }), before = await provider.load({ recursive: true });
    before.panes[0].selected = before.folders[left].map(row => row.id); before.panes[0].cursor = before.panes[0].selected[0];
    const app = createApp(t, structuredClone(before)); app.action(mode);
    app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
    const apply = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(apply);
    assert.equal(app.document.querySelector('[data-conflict-action="cancel"]'), null);
    const confirmed = await provider.apply(before, structuredClone(apply.state), { transfer: structuredClone(apply.transfer) });
    assert.deepEqual(await fs.readFile(`${target}/a-first.bin`), bytes);
    assert.equal(await fs.readFile(`${target}/b-conflict.txt`, 'utf8'), 'target');
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: apply.operationId, ok: true, state: structuredClone(confirmed) } })); await tick();
    app.click(app.document.querySelector('[data-conflict-action="cancel"]')); await tick();
    assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
    assert.deepEqual(await fs.readFile(`${target}/a-first.bin`), bytes);
    assert.equal(await fs.readFile(`${source}/b-conflict.txt`, 'utf8'), 'source');
    assert.equal(await fs.stat(`${source}/a-first.bin`).then(() => true, () => false), mode === 'copy');
    if (nested) assert.ok(app.state().panes[0].selected.includes(before.panes[0].selected[0]));
  }
});

test('a real move completes later checkpoints using only sources still present after earlier commits', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'win32' ? 'C:/tmp' : os.tmpdir(), 'primitive-reference-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left').replace(/\\/g, '/'), right = path.join(root, 'right').replace(/\\/g, '/');
  await fs.mkdir(left); await fs.mkdir(right);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(`${left}/${name}`, `source-${name}`);
  for (const name of ['b.txt', 'c.txt']) await fs.writeFile(`${right}/${name}`, `old-${name}`);
  const provider = createProvider({ roots: [left, right] });
  let confirmed = await provider.load();
  confirmed.panes[0].selected = confirmed.folders[left].map(row => row.id);
  confirmed.panes[0].cursor = confirmed.panes[0].selected[0];
  const app = createApp(t, structuredClone(confirmed)); app.action('move');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  for (let index = 0; index < 3; index++) {
    const request = app.messages.filter(message => message.type === 'filesystem-apply')[index]; assert.ok(request);
    confirmed = await provider.apply(confirmed, structuredClone(request.state), { transfer: structuredClone(request.transfer) });
    app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: request.operationId, ok: true, state: structuredClone(confirmed) } })); await tick();
    if (index < 2) { app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick(); }
  }
  assert.deepEqual(await fs.readdir(left), []);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) assert.equal(await fs.readFile(`${right}/${name}`, 'utf8'), `source-${name}`);
  assert.deepEqual(app.state().panes[0].selected, []);
  assert.match(app.document.querySelector('#status-message').textContent, /3/);
});
