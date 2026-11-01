const test = require('node:test');
const assert = require('node:assert/strict');
test('one immutable selection is one serial job and duplicate completions cannot advance the queue', () => {
  const { createQueue } = require('../media/commander-jobs');
  const starts = [], ends = [];
  const queue = createQueue({ start: job => starts.push(job), finish: (job, result) => ends.push([job, result]) });
  const input = { command: 'copy', title: 'Copy', target: 'C:/target', sources: ['a', 'b', 'c'] };
  const first = queue.add(input); input.sources.push('other');
  const second = queue.add({ command: 'copy', title: 'Copy', target: 'C:/other', sources: ['d'] });
  assert.equal(queue.items.length, 2); assert.equal(starts.length, 1);
  assert.deepEqual(first.request.sources, ['a', 'b', 'c']);
  queue.complete(first.id, { ok: false });
  assert.equal(starts[1], second);
  queue.complete(first.id, { ok: true }); assert.equal(starts.length, 2);
  queue.cancel(second.id); assert.equal(second.cancelling, true);
  queue.complete(second.id, { cancelled: true }); assert.equal(queue.items.length, 0);
  assert.equal(ends.length, 2);
});
test('removing a waiting job never executes it and emits one terminal result', () => {
  const { createQueue } = require('../media/commander-jobs');
  const starts = [], ends = [];
  const queue = createQueue({ start: job => starts.push(job), finish: (job, result) => ends.push(result) });
  queue.add({ command: 'copy', title: 'Copy', target: 'one', sources: ['a'] }); const waiting = queue.add({ command: 'copy', title: 'Copy', target: 'two', sources: ['b'] });
  queue.cancel(waiting.id);
  assert.equal(starts.length, 1); assert.equal(ends[0].cancelled, true);
  assert.equal(queue.items.length, 1);
});

test('every background request requires a registered operation contract', () => {
  const Jobs = require('../media/commander-jobs');
  const queue = Jobs.createQueue({ start() {}, finish() {} });
  const request = { title: 'Copy', target: '/target', sources: ['/source'] };
  assert.throws(() => queue.add(request), /command/i);
  assert.throws(() => queue.add({ ...request, command: 'unknown' }), /command/i);
  assert.throws(() => queue.add({ ...request, command: 'rename' }), /background/i);
  assert.throws(() => queue.add({ ...request, command: 'copy', sources: [] }), /sources/i);
  assert.equal(queue.items.length, 0);
});

test('command capabilities describe progress, cancellation and placement independently from scheduling', () => {
  const Jobs = require('../media/commander-jobs');
  const deletion = Jobs.getCommand('delete').supportsBackgroundOperation;
  assert.equal(deletion.enabled, false);
  assert.equal(deletion.reason, 'foreground-only');
  assert.deepEqual(deletion.presentation, { progress: 'footer', interaction: 'locked' });
  assert.equal(Jobs.getCommand('copy').supportsBackgroundOperation.presentation.placement, 'pane-header');
  assert.equal(Jobs.getCommand('rename').supportsBackgroundOperation.enabled, false);
  assert.equal(Jobs.getCommand('rename-many').supportsBackgroundOperation.reason, 'foreground-only');
  assert.deepEqual(Jobs.getCommand('rename-many').supportsBackgroundOperation.presentation, { progress: 'footer', interaction: 'locked' });
  for (const action of ['rename', 'rename-one', 'mkdir', 'mkdir-other', 'new-file', 'remove']) assert.equal(Jobs.commandForAction(action).supportsBackgroundOperation.enabled, false, action);
  for (const action of ['copy', 'copy-same', 'move', 'pack', 'pack-move', 'unpack', 'test-archives']) assert.equal(Jobs.commandForAction(action).supportsBackgroundOperation.enabled, true, action);
  for (const action of ['delete', 'delete-alternate', 'delete-permanently']) assert.equal(Jobs.commandForAction(action).supportsBackgroundOperation.enabled, false, action);
  assert.deepEqual(Jobs.executionPolicy, { mode: 'serial', maxConcurrent: 1 });
  assert.ok(Object.isFrozen(deletion.presentation));
  assert.throws(() => Jobs.operation({ command: 'delete', title: 'Delete', target: '/target', sources: ['/source'] }), /background/i);
});
test('untrusted labels and embedded NUL cannot enter an operation request', () => {
  const Jobs = require('../media/commander-jobs');
  const input = { command: 'copy', title: 'Copy', target: '/target', sources: ['/source'] };
  for (const invalid of [{ label: {} }, { title: 'Copy\0' }, { target: '/bad\0' }, { sources: ['/bad\0'] }]) assert.throws(() => Jobs.operation({ ...input, ...invalid }), TypeError);
  for (const targetLocation of [{ pane: 2, tabId: 'tab' }, { pane: 1, tabId: '' }, { pane: 0, tabId: 'bad\0tab' }]) assert.throws(() => Jobs.operation({ ...input, targetLocation }), TypeError);
  const targetLocation = { pane: 1, tabId: 'tab-target' }, request = Jobs.operation({ ...input, targetLocation });
  targetLocation.tabId = 'changed';
  assert.deepEqual(request.targetLocation, { pane: 1, tabId: 'tab-target' });
  assert.ok(Object.isFrozen(request.targetLocation));
});
test('queue summary adds comparable measured work and never weights unknown jobs by their count', () => {
  const { summarize } = require('../media/commander-jobs');
  const Progress = require('../media/commander-progress');
  const job = (unit, completed, total, state = 'running') => ({ state, progress: { overall: Progress.known(unit, completed, total) } });
  assert.deepEqual(summarize([job('bytes', 10, 100), job('bytes', 0, 900, 'waiting')]), { current: .1, overall: .01 });
  assert.deepEqual(summarize([job('bytes', 10, 100), { state: 'waiting' }]), { current: .1, overall: null });
  assert.equal(summarize([job('bytes', 10, 100), job('items', 0, 4, 'waiting')]).overall, null);
  assert.equal(summarize([job('bytes', 0, 0)]).current, 1);
});
