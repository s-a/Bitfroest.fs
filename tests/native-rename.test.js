const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { renameCase } = require('../native-rename');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitfroest-native-rename-')));
  t.after(async () => { assert.ok(root.startsWith(await fs.realpath(os.tmpdir()))); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function request(root, source, target) {
  const stat = await fs.lstat(source, { bigint: true });
  return { roots: [root], source, target, expected: { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } };
}
test('a file case rename preserves its bytes without a temporary rename', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = path.join(root, 'lower.txt'), target = path.join(root, 'LOWER.txt');
  await fs.writeFile(source, 'ORIGINAL');
  await renameCase(await request(root, source, target));
  assert.deepEqual(await fs.readdir(root), ['LOWER.txt']);
  assert.equal(await fs.readFile(target, 'utf8'), 'ORIGINAL');
});
test('a directory case rename preserves nested entries', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = path.join(root, 'lower'), target = path.join(root, 'LOWER');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'child.txt'), 'CHILD');
  await renameCase(await request(root, source, target));
  assert.deepEqual(await fs.readdir(root), ['LOWER']);
  assert.equal(await fs.readFile(path.join(target, 'child.txt'), 'utf8'), 'CHILD');
});
test('an exchanged source is rejected without renaming external bytes', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = path.join(root, 'lower.txt'), target = path.join(root, 'LOWER.txt');
  await fs.writeFile(source, 'ORIGINAL'); const input = await request(root, source, target);
  await fs.rename(source, path.join(root, 'saved.txt')); await fs.writeFile(source, 'EXTERNAL');
  await assert.rejects(renameCase(input));
  assert.equal(await fs.readFile(source, 'utf8'), 'EXTERNAL');
  assert.equal(await fs.readFile(path.join(root, 'saved.txt'), 'utf8'), 'ORIGINAL');
});

test('the adapter validates scope and identity before starting a helper', async () => {
  const input = { roots: ['C:/tmp'], source: 'C:/tmp/name.txt', target: 'C:/tmp/NAME.txt', expected: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' } };
  let calls = 0;
  const options = { platform: 'win32', nativeApi: { capabilities: { 'files.rename': { status: 'supported' } }, openSession: () => ({ invoke: async () => { calls++; return { status: 'committed', renamed: true }; }, close() {} }) } };
  for (const invalid of [null, { ...input, roots: [] }, { ...input, source: 'relative' }, { ...input, target: 'C:/tmp/../tmp/NAME.txt' }, { ...input, target: 'C:/tmp/new.txt' }, { ...input, target: input.source }, { ...input, roots: ['C:/other'] }, { ...input, expected: {} }, { ...input, source: 'C:/tmp/name\0.txt' }]) await assert.rejects(renameCase(invalid, options));
  await assert.rejects(renameCase({ ...input, source: 'C:/tmp/name.txt:stream', target: 'C:/tmp/NAME.txt:stream' }, options));
  await assert.rejects(renameCase(input, { ...options, platform: 'linux' }), /requires Windows/);
  assert.equal(calls, 0);
  assert.deepEqual(await renameCase(input, options), { renamed: true });
  assert.equal(calls, 1);
});

test('native failures and malformed outcomes cannot become successful renames', async () => {
  const input = { roots: ['C:/tmp'], source: 'C:/tmp/name.txt', target: 'C:/tmp/NAME.txt', expected: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' } };
  const apiFor = invoke => ({ capabilities: { 'files.rename': { status: 'supported' } }, openSession: () => ({ invoke, close() {} }) });
  for (const result of ['not-json', null, {}, { ok: false, code: 'EXISTS', message: 'Target exists' }]) await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(async () => result) }), { code: 'NativeOutcomeUnknown' });
  const cause = new Error('Stopped');
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(async () => { throw cause; }) }), error => error.code === 'NativeOutcomeUnknown' && error.cause === cause);
});

test('the native API adapter records committed outcomes even when its session closes', async () => {
  const input = { roots: ['C:/tmp'], source: 'C:/tmp/name.txt', target: 'C:/tmp/NAME.txt', expected: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' } };
  const invocations = [], sessions = [];
  const nativeApi = { capabilities: { 'files.rename': { status: 'supported' } }, openSession() {
    const session = { invoke: async (operation, request) => { invocations.push({ operation, request }); return { status: 'committed', renamed: true }; }, close() { sessions.push('closed'); } };
    return session;
  } };
  assert.deepEqual(await renameCase(input, { platform: 'win32', nativeApi, runHelper: async () => { throw new Error('Legacy helper must not run.'); } }), { renamed: true });
  assert.deepEqual(invocations, [{ operation: 'files.rename', request: { ...input, roots: ['C:\\tmp'], source: 'C:\\tmp\\name.txt', target: 'C:\\tmp\\NAME.txt' } }]);
  assert.deepEqual(sessions, ['closed']);
});

test('a stalled native rename closes its session and reports an unknown outcome without retry', async () => {
  const input = { roots: ['C:/tmp'], source: 'C:/tmp/name.txt', target: 'C:/tmp/NAME.txt', expected: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' } };
  let invokes = 0, closes = 0;
  const nativeApi = { capabilities: { 'files.rename': { status: 'supported' } }, openSession: () => ({ invoke: () => { invokes++; return new Promise(() => {}); }, close() { closes++; } }) };
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi, timeout: 2 }), error => error.code === 'NativeOutcomeUnknown' && error.cause?.code === 'NativeTimeout');
  assert.equal(invokes, 1);
  assert.equal(closes, 1);
});

test('native API adapter treats committed close errors as success and never retries ambiguous outcomes', async () => {
  const input = { roots: ['C:/tmp'], source: 'C:/tmp/name.txt', target: 'C:/tmp/NAME.txt', expected: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' } };
  let calls = 0, closes = 0;
  const apiFor = invoke => ({ capabilities: { 'files.rename': { status: 'supported' } }, openSession: () => ({ invoke: async () => { calls++; return invoke(); }, close: () => { closes++; } }) });
  const committed = Object.assign(new Error('The native session closed.'), { code: 'SessionClosed', outcome: { status: 'committed', renamed: true } });
  const noLegacy = { runHelper: async () => { throw new Error('Legacy helper must not run.'); } };
  assert.deepEqual(await renameCase(input, { platform: 'win32', nativeApi: apiFor(() => { throw committed; }), ...noLegacy }), { renamed: true });
  const unchanged = Object.assign(new Error('The native session closed.'), { code: 'SessionClosed', outcome: { status: 'unchanged', renamed: false } });
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(() => { throw unchanged; }), ...noLegacy }), error => error === unchanged);
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(() => ({ status: 'unchanged', renamed: false })), ...noLegacy }), error => error.code === 'NativeOutcomeUnchanged');
  const closedBeforeCommit = Object.assign(new Error('The native session closed.'), { code: 'SessionClosed' });
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(() => { throw closedBeforeCommit; }), ...noLegacy }), error => error.code === 'NativeOutcomeUnknown' && error.cause === closedBeforeCommit);
  const ambiguous = Object.assign(new Error('Connection lost.'), { code: 'TransportFailure' });
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(() => { throw ambiguous; }), ...noLegacy }), error => error.code === 'NativeOutcomeUnknown' && error.cause === ambiguous);
  const malformed = Object.assign(new Error('Malformed operation outcome.'), { code: 'NativeFailure', outcome: { status: 'unchanged', renamed: true } });
  await assert.rejects(renameCase(input, { platform: 'win32', nativeApi: apiFor(() => { throw malformed; }), ...noLegacy }), error => error.code === 'NativeOutcomeUnknown' && error.cause === malformed);
  assert.equal(calls, 6);
  assert.equal(closes, 6);
});

test('changed source metadata is rejected while preserving its current contents', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = path.join(root, 'lower.txt'), target = path.join(root, 'LOWER.txt');
  await fs.writeFile(source, 'ORIGINAL'); const input = await request(root, source, target);
  await fs.writeFile(source, 'CHANGED CONTENT');
  await assert.rejects(renameCase(input), /changed/);
  assert.deepEqual(await fs.readdir(root), ['lower.txt']);
  assert.equal(await fs.readFile(source, 'utf8'), 'CHANGED CONTENT');
});

test('a reparse ancestor cannot be used to rename a file outside its lexical root', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), real = path.join(root, 'real'), linked = path.join(root, 'linked');
  await fs.mkdir(real); await fs.writeFile(path.join(real, 'lower.txt'), 'ORIGINAL');
  await fs.symlink(real, linked, 'junction');
  await assert.rejects(renameCase(await request(linked, path.join(linked, 'lower.txt'), path.join(linked, 'LOWER.txt'))), /Reparse/);
  assert.deepEqual(await fs.readdir(real), ['lower.txt']);
});

test('same-sized external bytes with restored mtime are rejected by change time', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = path.join(root, 'lower.txt'), target = path.join(root, 'LOWER.txt');
  await fs.writeFile(source, 'ORIGINAL'); await fs.utimes(source, 1000000000, 1000000000);
  const input = await request(root, source, target);
  await new Promise(resolve => setTimeout(resolve, 30));
  await fs.writeFile(source, 'EXTERNAL'); await fs.utimes(source, 1000000000, 1000000000);
  assert.notEqual(String((await fs.lstat(source, { bigint: true })).ctimeNs), input.expected.ctimeNs);
  await assert.rejects(renameCase(input), /changed/);
  assert.deepEqual(await fs.readdir(root), ['lower.txt']);
  assert.equal(await fs.readFile(source, 'utf8'), 'EXTERNAL');
});
