const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForX11Display } = require('./support/x11-readiness.cjs');

function fixture(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = new EventEmitter();
  Object.assign(server, { pid: 4242, exitCode: null, signalCode: null, stdio: [null, null, null, new EventEmitter()] });
  let outcome;
  const promise = waitForX11Display(server, options);
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  return { server, ready: server.stdio[3], promise, get outcome() { return outcome; } };
}

function assertReleased(f) {
  for (const event of ['exit', 'error']) assert.equal(f.server.listenerCount(event), 0, event);
  for (const event of ['data', 'end', 'error']) assert.equal(f.ready.listenerCount(event), 0, event);
}

test('a slow private X11 startup waits for actual readiness beyond five seconds', async t => {
  const f = fixture(t);
  t.mock.timers.tick(6000);
  await Promise.resolve();
  assert.equal(f.outcome, undefined);
  f.ready.emit('data', Buffer.from('1234\n'));
  assert.equal(await f.promise, 'localhost:1234');
  assertReleased(f);
});

test('private X11 readiness requires a complete valid display line across chunks', async t => {
  const f = fixture(t);
  f.ready.emit('data', Buffer.from('12'));
  await Promise.resolve();
  assert.equal(f.outcome, undefined);
  f.ready.emit('data', Buffer.from('34\n'));
  assert.equal(await f.promise, 'localhost:1234');
  assertReleased(f);
});

test('private X11 startup remains bounded and reports process and server diagnostics', async t => {
  const f = fixture(t, { timeoutMs: 50, diagnostics: () => 'server diagnostic' });
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(f.outcome, undefined);
  t.mock.timers.tick(1);
  await assert.rejects(f.promise, /50 ms.*pid=4242.*server diagnostic/);
  assertReleased(f);
});

test('private X11 startup rejects an early process exit with diagnostics', async t => {
  const f = fixture(t, { diagnostics: () => 'cannot bind' });
  f.server.emit('exit', 1, null);
  await assert.rejects(f.promise, /exited.*1.*cannot bind/);
  assertReleased(f);
});

test('private X11 startup rejects a readiness stream that ends without a complete line', async t => {
  const f = fixture(t);
  f.ready.emit('data', Buffer.from('12'));
  f.ready.emit('end');
  await assert.rejects(f.promise, /readiness.*closed/);
  assertReleased(f);
});

test('private X11 startup rejects malformed readiness instead of opening a client', async t => {
  const f = fixture(t);
  f.ready.emit('data', Buffer.from('invalid\n'));
  await assert.rejects(f.promise, /invalid.*display/i);
  assertReleased(f);
});

test('private X11 startup preserves a process launch error and releases listeners', async t => {
  const f = fixture(t);
  const error = Object.assign(new Error('Xvfb missing'), { code: 'ENOENT' });
  f.server.emit('error', error);
  await assert.rejects(f.promise, value => value === error);
  assertReleased(f);
});
