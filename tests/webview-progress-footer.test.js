const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./support/webview.cjs');
const Progress = require('../media/commander-progress');

test('footer icon copies the message and execution log and confirms only a successful reply', async t => {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  const app = createApp(t, { version: 1, realFilesystem: true, snapshotId: 'log', active: 0, panes: [p('/left'), p('/right')], folders: { '/left': [], '/right': [] } });
  app.action('refresh');
  const refresh = app.messages.findLast(message => message.type === 'filesystem-refresh');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-refresh-step', refreshRequestId: refresh.refreshRequestId, path: '/left', phase: 'metadata', completed: 50, total: 100, emittedAt: 123 } }));
  const icon = app.document.querySelector('#status-activity [data-status-icon], #status-message [data-status-icon]');
  assert.equal(icon.tagName, 'BUTTON');
  app.click(icon);
  const request = app.messages.findLast(message => message.type === 'status-log-copy');
  assert.ok(request);
  const log = JSON.parse(request.text);
  assert.equal(log.formatVersion, 1);
  assert.ok(log.currentMessage);
  assert.ok(log.messages.length);
  assert.ok(log.context.panes.length);
  assert.equal(log.context.hostEvents.at(-1).emittedAt, 123);
  assert.equal(log.context.hostEvents.at(-1).phase, 'metadata');
  const operation = log.operations.find(operation => operation.id === refresh.refreshRequestId);
  assert.equal(operation.plan.completedSteps, 51);
  assert.ok(operation.plan.openPlanning.length);
  assert.ok(operation.events.some(event => event.action === 'range-completed' && event.completed === 50));
  assert.equal(icon.dataset.copyState, 'pending');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'status-log-copy-result', requestId: 'obsolete', ok: true } }));
  assert.equal(icon.dataset.copyState, 'pending');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'status-log-copy-result', requestId: request.requestId, ok: true } }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(icon.dataset.copyState, 'copied');
  assert.match(icon.getAttribute('aria-label'), /kopiert/);
});

test('footer copy failure retains the current message and permits a keyboard retry', async t => {
  const app = createApp(t), failure = new Error('Clipboard unavailable'); let calls = 0;
  const bar = app.window.CommanderStatusbar.create({ t: value => value, actions: [], focusList() {}, onCopyLog: async () => { if (!calls++) throw failure; } });
  bar.error('Read failed');
  const button = app.document.querySelector('#status-message [data-status-icon]');
  app.click(button); await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.dataset.copyState, 'error'); assert.match(button.title, /Clipboard unavailable/);
  assert.equal(app.document.querySelector('#status-message [data-status-text]').textContent, 'Read failed');
  button.focus(); button.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.dataset.copyState, 'copied'); assert.equal(calls, 2);
});

function footer(t) {
  const app = createApp(t);
  let now = 0, cancelled = 0;
  const timers = new Map(); let sequence = 0;
  Object.defineProperty(app.window.performance, 'now', { value: () => now });
  app.window.setInterval = callback => { timers.set(++sequence, callback); return sequence; };
  app.window.clearInterval = id => timers.delete(id);
  const bar = app.window.CommanderStatusbar.create({ t: value => value, actions: [], focusList() {}, onCancel: () => cancelled++ });
  const snapshot = progress => {
    const plan = app.window.CommanderProgress.statusPlan({ id: progress.id || progress.phase, startedAt: now, steps: ['run'], mode: 'work' });
    plan.start('run'); plan.update('run', progress); return plan.snapshot();
  };
  const finished = (outcome = 'success') => {
    const plan = app.window.CommanderProgress.statusPlan({ id: 'copy', startedAt: 0, steps: ['run'] }); plan.start('run');
    if (outcome === 'cancelled' || outcome === 'error') plan.terminate(outcome); else plan.complete('run');
    return plan.finishedSnapshot();
  };
  const update = values => {
    const input = { id: 'copy', title: 'Kopieren', statusPath: 'D:\\Projekte\\Archiv.zip', total: 100, completed: 42, fileTotal: 100, fileCompleted: 68, ...values };
    const count = (completed, total) => Number.isSafeInteger(total) && total >= completed ? Progress.known('bytes', completed, total) : Progress.unknown('bytes', 0, 'stream-size-unknown');
    const { title, statusTitle, statusPath, modal, cancelRequested, cancelAvailable, element, quiet } = input;
    bar.setProgress({ title, statusTitle, statusPath, modal, cancelRequested, cancelAvailable, element, quiet, progress: snapshot(Progress.event({ phase: input.phase || 'copying', id: input.id, overall: count(input.completed, input.total), current: count(input.fileCompleted, input.fileTotal) })) });
  };
  const text = id => app.document.querySelector(id).textContent;
  return { ...app, bar, update, snapshot, finished, text, timers, cancelled: () => cancelled, advance(seconds) { now += seconds * 1000; for (const callback of [...timers.values()]) callback(); } };
}

test('compact footer overlays independently sized progress with a literal path and right-hand metrics', t => {
  const app = footer(t); app.update();
  assert.equal(app.text('#status-percent'), '42%/68%');
  assert.equal(app.text('#status-eta'), '—');
  assert.equal(app.text('#status-elapsed'), '00:00');
  assert.equal(app.text('#status-times'), '—/00:00');
  assert.equal(app.document.querySelector('#status-eta').title, 'Geschätzte Restdauer');
  assert.equal(app.document.querySelector('#status-elapsed').title, 'Bisherige Laufzeit');
  assert.equal(app.text('#status-message'), 'Kopieren · D:\\Projekte\\Archiv.zip');
  const overall = app.document.querySelector('#status-progress-overall'), file = app.document.querySelector('#status-progress-file');
  assert.equal(overall.style.width, '42%'); assert.equal(file.style.width, '68%');
  assert.equal(overall.parentElement, file.parentElement);
  assert.equal(app.document.querySelector('#status-progress-region').contains(app.document.querySelector('#status-text-region')), true);
  const cancel = app.document.querySelector('#status-cancel');
  assert.equal(cancel.textContent, ''); assert.ok(cancel.querySelector('svg'));
  assert.equal(cancel.getAttribute('aria-label'), 'Abbrechen');
  app.click(cancel); assert.equal(app.cancelled(), 1);
  app.update({ title: 'Kopieren <literal>', statusPath: '/left/<img>.zip', completed: 80, fileCompleted: 15 });
  assert.equal(app.text('#status-message'), 'Kopieren <literal> · /left/<img>.zip');
  assert.equal(app.document.querySelector('#status-message img'), null);
  assert.equal(app.text('#status-message [data-progress-name]'), '<img>.zip');
  assert.equal(app.text('#status-percent'), '80%/15%');
  assert.equal(app.document.querySelector('#status-message').title, 'Kopieren <literal>\n/left/<img>.zip');
  app.bar.dispose();
});

test('statusbar refuses raw counters and copied planner snapshots at its runtime boundary', t => {
  const app = footer(t);
  const raw = Progress.event({ phase: 'copy', overall: Progress.known('bytes', 1, 2), current: Progress.known('bytes', 1, 2) });
  assert.throws(() => app.bar.setActivity('Copy', raw), /planner snapshot/);
  assert.throws(() => app.bar.setProgress({ title: 'Copy', completed: 1, total: 2 }), /planner snapshot/);
  assert.throws(() => app.bar.setActivity('Copy', { ...app.snapshot(raw) }), /planner snapshot/);
  assert.throws(() => app.bar.setProgress({ title: 'Copy', progress: app.snapshot(raw), completed: 99, total: 100 }), /Independent/);
  app.bar.setActivity('Copy', app.snapshot(raw));
  assert.equal(app.text('#status-percent'), '50%/50%');
  app.update();
  assert.throws(() => app.bar.finishProgress({ message: 'Done', progress: app.snapshot(raw) }), /not finished/);
  app.bar.dispose();
});

test('active footer recalculates its overlay colors on live theme changes', async t => {
  const app = footer(t);
  const bar = app.document.querySelector('#statusbar');
  bar.style.color = 'rgb(204, 204, 204)'; bar.style.backgroundColor = 'rgb(37, 37, 38)';
  app.update();
  const first = bar.style.getPropertyValue('--status-progress-fill'); assert.ok(first);
  bar.style.color = 'rgb(51, 51, 51)'; bar.style.backgroundColor = 'rgb(255, 255, 255)';
  app.document.body.classList.add('vscode-light');
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(bar.style.getPropertyValue('--status-progress-fill'), first);
  assert.equal(bar.style.getPropertyValue('--status-progress-foreground'), '#333333');
  app.bar.dispose();
});

test('elapsed time ticks without host progress and ETA uses observed overall work rather than file progress', t => {
  const app = footer(t); app.update({ completed: 0 });
  app.advance(10); app.update({ completed: 25 });
  assert.equal(app.text('#status-eta'), '00:30');
  assert.equal(app.text('#status-elapsed'), '00:10');
  app.advance(5);
  assert.equal(app.text('#status-eta'), '00:25');
  assert.equal(app.text('#status-elapsed'), '00:15');
  app.update({ statusPath: 'D:\\Projekte\\next.zip', completed: 50, fileCompleted: 1 });
  assert.equal(app.text('#status-elapsed'), '00:15');
  assert.equal(app.timers.size, 1);
  app.advance(3600); assert.equal(app.text('#status-elapsed'), '1:00:15');
  app.bar.dispose(); assert.equal(app.timers.size, 0);
});

test('the footer clock starts at the planner action start rather than the first rendered frame', t => {
  const app = footer(t), plan = app.window.CommanderProgress.statusPlan({ id: 'copy', startedAt: 0, steps: ['copy'] });
  plan.start('copy'); app.advance(5);
  app.bar.setProgress({ title: 'Copy', progress: plan.snapshot() });
  assert.equal(app.text('#status-elapsed'), '00:05');
  app.bar.dispose();
});

test('unknown progress, denominator changes and phase resets discard stale estimates without resetting elapsed time', t => {
  const app = footer(t); app.update({ total: undefined, fileTotal: undefined });
  assert.equal(app.text('#status-percent'), '—/—');
  app.advance(3); app.update({ completed: 20 });
  assert.equal(app.text('#status-eta'), '—');
  app.advance(10); app.update({ completed: 40 });
  assert.equal(app.text('#status-eta'), '00:30');
  app.update({ total: 200, completed: 40 }); assert.equal(app.text('#status-eta'), '—');
  app.advance(10); app.update({ total: 200, completed: 80 }); assert.equal(app.text('#status-eta'), '00:30');
  app.update({ total: 200, completed: 0 }); assert.equal(app.text('#status-eta'), '—');
  assert.equal(app.text('#status-elapsed'), '00:23');
  app.update({ total: undefined, fileTotal: undefined, cancelRequested: true });
  assert.equal(app.text('#status-eta'), '—');
  assert.equal(app.document.querySelector('#status-cancel').disabled, true);
  assert.equal(app.timers.size, 1);
  app.bar.finishProgress({ message: 'Abgebrochen', outcome: 'cancelled', progress: app.finished('cancelled') });
  assert.equal(app.timers.size, 0);
  assert.equal(app.document.querySelector('#status-metrics').hidden, true);
  assert.equal(app.text('#status-message'), 'Abgebrochen');
  app.update({ id: 'next' }); assert.equal(app.text('#status-elapsed'), '00:00');
  app.bar.reset(); assert.equal(app.timers.size, 0);
  app.update(); app.window.dispatchEvent(new app.window.Event('pagehide')); assert.equal(app.timers.size, 0);
});

test('a work counter moving backwards or a new phase invalidates the previous ETA', t => {
  const app = footer(t); app.update({ completed: 0, phase: 'copying' });
  app.advance(10); app.update({ completed: 40, phase: 'copying' });
  assert.equal(app.text('#status-eta'), '00:15');
  app.update({ completed: 30, phase: 'copying' });
  assert.equal(app.text('#status-eta'), '—');
  app.advance(10); app.update({ completed: 60, phase: 'copying' });
  app.update({ completed: 60, phase: 'verifying' });
  assert.equal(app.text('#status-eta'), '—');
  assert.equal(app.text('#status-elapsed'), '00:20');
  app.bar.dispose();
});

test('measured background activity shares the footer without taking status ownership or creating notifications', t => {
  const app = footer(t); app.bar.setStatus('Previous result', 'success');
  const version = app.bar.version;
  const progress = Progress.event({ phase: 'metadata', overall: Progress.known('items', 25, 100), current: Progress.known('items', 1, 1) });
  app.bar.setActivity('Read metadata', app.snapshot(progress));
  assert.equal(app.text('#status-percent'), '25%/100%');
  assert.equal(app.bar.version, version);
  assert.equal(app.document.querySelector('#notifications-list').children.length, 0);
  app.advance(5); assert.equal(app.text('#status-elapsed'), '00:05');
  app.update(); assert.equal(app.text('#status-percent'), '42%/68%');
  app.bar.finishProgress({ message: 'Copy done', progress: app.finished() });
  assert.equal(app.text('#status-percent'), '25%/100%');
  app.bar.setActivity(''); assert.equal(app.timers.size, 0);
  assert.equal(app.document.querySelector('#status-metrics').hidden, true);
  app.bar.dispose();
});

test('background work displays its own status without an unrelated previous success', t => {
  const app = footer(t);
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  app.bar.setStatus('Verzeichnis geöffnet: /left', 'success');
  const message = app.document.querySelector('#status-message');
  const version = app.bar.version;
  app.bar.setActivity('Read directory', app.snapshot(Progress.event({ phase: 'metadata', overall: Progress.known('requests', 0, 2), current: Progress.known('items', 0, 100) })));
  assert.equal(app.window.getComputedStyle(message).display, 'none');
  assert.equal(app.bar.version, version);
  app.bar.setStatus('Read failed', 'error');
  assert.notEqual(app.window.getComputedStyle(message).display, 'none');
  app.bar.setActivity('', null);
  assert.notEqual(app.window.getComputedStyle(message).display, 'none');
  app.bar.dispose();
});

test('unknown overall work never fills or sweeps the overall track while time advances', t => {
  const app = footer(t);
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  const unknown = Progress.unknown('items', 0, 'native-operation');
  const meter = app.document.querySelector('#status-progress-overall');
  for (const operation of [false, true]) {
    if (operation) app.bar.setProgress({ title: 'Read directory', progress: app.snapshot(Progress.event({ phase: 'reading', overall: unknown, current: unknown })) });
    else app.bar.setActivity('Read directory', app.snapshot(Progress.event({ phase: 'reading', overall: unknown, current: unknown })));
    app.advance(5);
    assert.equal(meter.hasAttribute('aria-valuenow'), false);
    assert.equal(meter.style.width, '0%');
    assert.equal(app.window.getComputedStyle(meter).animation, 'none');
    assert.equal(app.text('#status-percent'), '—/—');
  }
  app.bar.dispose();
});

test('footer layers share the available width and keep one text baseline with distinct progress heights', () => {
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.doesNotMatch(css, /grid-template-columns:\s*minmax\(0, 7fr\) minmax\(0, 3fr\)/);
  assert.match(css, /#status-progress-area\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
  assert.match(css, /#status-progress-track\s*\{[^}]*height:\s*100%/);
  assert.match(css, /#status-progress-overall\s*\{[^}]*height:\s*100%/);
  assert.match(css, /#status-progress-file\s*\{[^}]*bottom:\s*0[^}]*height:\s*3px/);
  assert.match(css, /#status-metrics\s*\{[^}]*flex-shrink:\s*0[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /#status-text-region\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /#status-message \[data-status-text\][^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /forced-colors:[\s\S]*#status-progress-overall/);
});
