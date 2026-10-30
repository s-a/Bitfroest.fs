const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCopySession } = require('../native-copy');

const input = { roots: ['C:/tmp', 'C:/temp'], source: 'C:/tmp/a.bin', target: 'C:/temp/.stage/content', expected: { dev: '1', ino: '2', size: '100', mtimeNs: '10', ctimeNs: '11' } };
function worker(onRequest) {
  let starts = 0, current;
  return { get starts() { return starts; }, get child() { return current; }, spawn() {
    starts++;
    const child = current = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let text = '';
    child.stdin.on('data', chunk => { text += chunk; let end; while ((end = text.indexOf('\n')) >= 0) { const line = text.slice(0, end); text = text.slice(end + 1); if (line) onRequest(JSON.parse(line), child); } });
    child.stdin.on('end', () => queueMicrotask(() => child.emit('close', 0)));
    child.kill = () => { child.emit('close', 1); return true; };
    return child;
  } };
}
test('one transfer session reuses one worker and isolates progress by request identity', async () => {
  const ids = [], progress = [];
  const native = worker((request, child) => {
    if (request.type !== 'copy') return;
    ids.push(request.id);
    queueMicrotask(() => {
      if (ids.length > 1) child.stdout.write(JSON.stringify({ type: 'progress', id: ids[0], transferred: 99, total: 100 }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'progress', id: request.id, transferred: 100, total: 100 }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: true }) + '\n');
    });
  });
  const session = createCopySession({ platform: 'win32', spawn: native.spawn });
  await session.copy(input, { onProgress: value => progress.push(value.transferred) });
  await session.copy({ ...input, target: 'C:/temp/.stage/second' }, { onProgress: value => progress.push(value.transferred) });
  assert.equal(native.starts, 1); assert.equal(new Set(ids).size, 2); assert.deepEqual(progress, [100, 100]);
  await session.dispose();
  await assert.rejects(session.copy(input), /beendet/);
});
test('disposing an active session sends cancellation, closes input, and waits for process exit', async () => {
  let cancelled = false, stopped = false;
  const native = worker((request, child) => {
    if (request.type === 'cancel') { cancelled = true; queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: false, cancelled: true }) + '\n')); }
  });
  const session = createCopySession({ platform: 'win32', spawn: native.spawn });
  const pending = session.copy(input); pending.catch(() => {});
  native.child.on('close', () => { stopped = true; });
  await session.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true); assert.equal(stopped, true);
});
test('one session rejects overlapping copies and abort is tied to the active request', async () => {
  const controller = new AbortController(); let activeId;
  const native = worker((request, child) => {
    if (request.type === 'copy') activeId = request.id;
    if (request.type === 'cancel') { assert.equal(request.id, activeId); queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: false, cancelled: true }) + '\n')); }
  });
  const session = createCopySession({ platform: 'win32', spawn: native.spawn });
  const pending = session.copy(input, { signal: controller.signal });
  await assert.rejects(session.copy(input), /aktiv/); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); await session.dispose();
});

test('an aborted worker that ignores cancellation is stopped before rejection', async () => {
  const controller = new AbortController(); let killed = false;
  const native = worker(() => {}), spawn = () => {
    const child = native.spawn(); child.kill = () => { killed = true; child.emit('close', 1); return true; }; return child;
  };
  const session = createCopySession({ platform: 'win32', spawn, cancelTimeoutMs: 5 });
  const pending = session.copy(input, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && killed);
  await session.dispose();
});

test('disposing an unused session does not start a helper', async () => {
  const session = createCopySession({ platform: 'win32', spawn: () => assert.fail('unused session must remain lazy') });
  await session.dispose(); await session.dispose();
  await assert.rejects(session.copy(input), /beendet/);
});

test('ordinary native file errors preserve session reuse while cancellation closes it', async () => {
  let copies = 0;
  const native = worker((request, child) => {
    if (request.type !== 'copy') return;
    copies++;
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: false, cancelled: copies > 1, code: 5, message: 'denied', ownedDestination: 'owned' }) + '\n'));
  });
  const session = createCopySession({ platform: 'win32', spawn: native.spawn });
  await assert.rejects(session.copy(input), error => error.code === 5 && error.ownedDestination === 'owned');
  await assert.rejects(session.copy(input), { name: 'AbortError' });
  await assert.rejects(session.copy(input), /beendet/); await session.dispose();
});

test('invalid response envelopes and excessive unfinished lines fail closed after worker exit', async () => {
  for (const response of ['{"type":"result","ok":true}\n', '{"type":"unknown","id":"1"}\n', '{"type":"result","id":"1","ok":"yes"}\n', 'x'.repeat(65537), 'x'.repeat(65537) + '\n']) {
    const native = worker((request, child) => { if (request.type === 'copy') queueMicrotask(() => child.stdout.write(response)); });
    const session = createCopySession({ platform: 'win32', spawn: native.spawn });
    await assert.rejects(session.copy(input), /ungültig|groß/); await session.dispose();
  }
});

test('ready records and blank lines are permitted while late terminal records cannot finish another request', async () => {
  let previous;
  const native = worker((request, child) => {
    if (request.type !== 'copy') return;
    queueMicrotask(() => {
      child.stdout.write('\n{"type":"ready"}\n');
      if (previous) child.stdout.write(JSON.stringify({ type: 'result', id: previous, ok: false, code: 5 }) + '\n');
      previous = request.id; child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: true }) + '\n');
    });
  });
  const session = createCopySession({ platform: 'win32', spawn: native.spawn });
  await session.copy(input); await session.copy(input); await session.dispose();
});
