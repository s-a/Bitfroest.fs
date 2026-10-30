const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { copyFileCancellable } = require('../native-copy');

function runner(scenario) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; const request = JSON.parse(chunk.toString().trim()); if (request.type === 'copy') child.requestId = request.id; scenario({ child, command, args, options, input }); });
    child.stdin.on('end', () => queueMicrotask(() => child.emit('close', 0)));
    return child;
  };
}
function reply(child, record) { child.stdout.write(JSON.stringify({ ...record, id: child.requestId }) + '\n'); }
const input = { roots: ['C:/tmp', 'C:/temp'], source: 'C:/tmp/a.bin', target: 'C:/temp/.stage/content', expected: { dev: '1', ino: '2', size: '100', mtimeNs: '10', ctimeNs: '11' } };
test('copy progress is monotonic and completion waits for the native terminal record', async () => {
  const events = []; let calls = 0;
  const spawn = runner(({ child, command, args, options }) => {
    if (calls++) return;
    assert.equal(command, 'powershell.exe'); assert.equal(options.windowsHide, true); assert.ok(!options.timeout);
    assert.ok(args.includes('-File'));
    queueMicrotask(() => {
      reply(child, { type: 'progress', transferred: 40, total: 100 });
      reply(child, { type: 'progress', transferred: 20, total: 100 });
      reply(child, { type: 'progress', transferred: 100, total: 100 });
      reply(child, { type: 'result', ok: true }); child.emit('close', 0);
    });
  });
  await copyFileCancellable(input, { platform: 'win32', spawn, onProgress: event => events.push(event) });
  assert.deepEqual(events.map(event => event.transferred), [40, 100]);
});
test('mid-file abort sends cancellation and rejects only after the native worker has stopped', async () => {
  const controller = new AbortController(); let stopped = false, started = false;
  const spawn = runner(({ child, input: lines }) => {
    if (!started) { started = true; queueMicrotask(() => { reply(child, { type: 'progress', transferred: 1, total: 100 }); controller.abort(); }); }
    else if (lines.includes('"type":"cancel"')) queueMicrotask(() => { stopped = true; reply(child, { type: 'result', ok: false, cancelled: true, code: 1235 }); child.emit('close', 0); });
  });
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', spawn, signal: controller.signal }), error => error.name === 'AbortError' && stopped);
});
test('already aborted jobs do not start a child or copy a byte', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', signal: controller.signal, spawn: () => assert.fail('worker must not start') }), { name: 'AbortError' });
});
test('missing terminal record and native failures cannot be reported as success', async () => {
  for (const record of ['', '{"type":"result","ok":false,"code":5,"message":"Access denied"}\n']) {
    const spawn = runner(({ child }) => queueMicrotask(() => { if (record) reply(child, JSON.parse(record)); child.emit('close', 0); }));
    await assert.rejects(copyFileCancellable(input, { platform: 'win32', spawn }));
  }
});
test('non-Windows fallback honestly reports between-file cancellation capability', async () => {
  const events = []; let copied = false;
  await copyFileCancellable(input, { platform: 'linux', copyFile: async () => { copied = true; }, onProgress: event => events.push(event) });
  assert.equal(copied, true); assert.equal(events[0].granular, false);
});

test('invalid native requests never start a process', async () => {
  let calls = 0; const options = { platform: 'win32', spawn: () => { calls++; throw new Error('unexpected'); } };
  for (const invalid of [null, { ...input, roots: [] }, { ...input, source: 'relative' }, { ...input, target: 'C:/temp/../temp/t' }, { ...input, source: 'C:/tmp/a\0.bin' }, { ...input, target: 'C:/temp/x:stream' }, { ...input, roots: ['C:/outside'] }, { ...input, target: input.source }, { ...input, expected: {} }]) await assert.rejects(copyFileCancellable(invalid, options));
  assert.equal(calls, 0);
});
test('malformed native output requests cancellation and waits for actual process exit', async () => {
  let called = false, stopped = false;
  const spawn = runner(({ child, input: lines }) => {
    if (!called) { called = true; queueMicrotask(() => child.stdout.write('not-json\n')); }
    else if (lines.includes('"type":"cancel"')) queueMicrotask(() => { stopped = true; child.emit('close', 0); });
  });
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', spawn }), error => stopped && /ungültig/.test(error.message));
});
test('process startup failures and early worker errors propagate', async () => {
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', spawn: () => { throw new Error('spawn failed'); } }), /spawn failed/);
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', spawn: runner(({ child }) => queueMicrotask(() => child.emit('error', new Error('worker failed')))) }), /worker failed/);
});
test('late worker progress after process close cannot update a completed operation', async () => {
  const events = []; let worker;
  await assert.rejects(copyFileCancellable(input, { platform: 'win32', onProgress: event => events.push(event), spawn: runner(({ child }) => { worker = child; queueMicrotask(() => child.emit('close', 1)); }) }));
  worker.stdout.write('{"type":"progress","transferred":10,"total":100}\n');
  assert.deepEqual(events, []);
});
