const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Progress = require('../media/commander-progress');
const { check } = require('../scripts/check-progress.cjs');

test('planner diagnostics retain actual execution, open planning, counters and termination', () => {
  const plan = Progress.statusPlan({ id: 'read', startedAt: 5, steps: ['directory', 'git'] });
  plan.openPlanning('git'); plan.start('directory'); plan.reserve('directory', 10); plan.confirmRange('directory', 3);
  plan.update('directory', Progress.event({ phase: 'metadata', path: '/files', overall: Progress.known('items', 3, 10), current: Progress.known('items', 3, 10) }));
  plan.terminate('error');
  const report = Progress.statusReport(plan.snapshot());
  assert.equal(report.plan.state, 'error'); assert.equal(report.plan.completedSteps, 3);
  assert.deepEqual(report.plan.openPlanning, ['git']);
  assert.ok(report.events.some(event => event.action === 'range-completed' && event.completed === 3 && event.total === 10));
  assert.ok(report.events.some(event => event.phase === 'metadata' && event.path === '/files'));
  assert.equal(report.events.at(-1).action, 'error');
  assert.equal(report.omittedEvents, 0);
});

test('planner diagnostics bound stored events and explicitly report omitted history', () => {
  const plan = Progress.statusPlan({ id: 'read', startedAt: 0, steps: ['scan'] }); plan.start('scan');
  for (let i = 0; i < 700; i++) plan.update('scan', Progress.event({ phase: 'scan', overall: Progress.known('items', i, 700), current: Progress.known('items', i, 700) }));
  const report = Progress.statusReport(plan.snapshot());
  assert.equal(report.events.length, 512); assert.equal(report.omittedEvents, 190);
  assert.equal(report.events.at(-1).overall.completed, 699);
  assert.equal(report.events.at(-1).sequence - report.events[0].sequence, 511);
});

test('a failed recursive step retains completed work while subsequent steps finish the same plan', () => {
  const plan = Progress.statusPlan({ id: 'git', startedAt: 0, steps: ['inspect'] }); plan.start('inspect');
  const [first, next] = plan.append('inspect', ['first', 'next']);
  plan.start(first); plan.reserve(first, 10); plan.confirmRange(first, 9); plan.fail(first, 'Path too long');
  assert.equal(plan.snapshot().plan.completedSteps, 9); assert.equal(plan.snapshot().plan.failedSteps, 1);
  assert.throws(() => plan.start(first), /complete|failed/);
  plan.start(next); plan.complete(next); plan.complete('inspect');
  assert.equal(plan.finishedSnapshot().plan.state, 'error'); assert.equal(plan.finishedSnapshot().plan.done, true);
  assert.equal(plan.finishedSnapshot().plan.completedSteps, 10); assert.equal(plan.finishedSnapshot().plan.totalSteps, 11);
  assert.ok(Progress.statusReport(plan.snapshot()).events.some(event => event.action === 'failed' && event.error === 'Path too long'));
  const failed = Progress.statusReport(plan.snapshot()).plan.steps.find(step => step.id === first);
  assert.equal(failed.error, 'Path too long');
  assert.equal(typeof failed.startedAt, 'number'); assert.ok(failed.finishedAt >= failed.startedAt);
});

test('open recursive planning prevents a partial step total from becoming an overall percentage', () => {
  const plan = Progress.statusPlan({ id: 'refresh', startedAt: 12, steps: ['metadata', 'git'] });
  plan.openPlanning('git');
  plan.reserve('metadata', 1000); plan.start('metadata'); plan.confirmRange('metadata', 1000); plan.complete('metadata');
  assert.equal(plan.snapshot().display.overallPercent, null);
  assert.equal(plan.snapshot().overall.reason, 'enumerating');
  assert.deepEqual(plan.analyze().openPlanning, ['git']);
  plan.start('git'); const [inspect] = plan.append('git', ['inspect']);
  plan.reserve(inspect, 3000); plan.start(inspect); plan.confirmRange(inspect, 1500);
  assert.equal(plan.snapshot().display.overallPercent, null);
  assert.throws(() => plan.complete('git'), /unfinished/);
  plan.closePlanning('git');
  assert.equal(plan.snapshot().display.overallPercent, 62.5);
  assert.equal(plan.snapshot().id, 'refresh'); assert.equal(plan.snapshot().startedAt, 12);
  plan.confirmRange(inspect, 3000); plan.complete(inspect); plan.complete('git');
  assert.equal(plan.finishedSnapshot().display.overallPercent, 100);
});

test('status snapshots require a planner and recursively count newly registered program steps', () => {
  const plan = Progress.statusPlan({ id: 'refresh', startedAt: 123, steps: ['read', 'git'] });
  plan.start('read'); plan.complete('read');
  assert.deepEqual(plan.snapshot().overall, Progress.known('steps', 1, 2));
  plan.start('git');
  const children = plan.append('git', ['locate', 'inspect', 'map']);
  assert.deepEqual(plan.snapshot().overall, Progress.known('steps', 1, 4));
  assert.throws(() => plan.complete('git'), /unfinished/);
  for (const id of children) { plan.start(id); plan.complete(id); }
  assert.equal(plan.snapshot().overall.reason, 'awaiting-confirmation');
  plan.complete('git');
  const snapshot = plan.snapshot();
  assert.deepEqual(snapshot.overall, Progress.known('steps', 4, 4));
  assert.equal(Progress.readStatus(snapshot), snapshot);
  assert.equal(snapshot.id, 'refresh'); assert.equal(snapshot.startedAt, 123);
  assert.equal(plan.analyze().totalSteps, 4);
  assert.equal(plan.analyze().completedSteps, 4);
  assert.throws(() => Progress.readStatus(Progress.event({ phase: 'copy', overall: Progress.known('items', 1, 2), current: Progress.known('items', 1, 2) })), /planner/);
  assert.throws(() => Progress.readStatus({ ...snapshot }), /planner/);
  assert.throws(() => plan.append('git', ['late']), /complete/);
  assert.throws(() => plan.start('foreign'), /step/);
  assert.throws(() => plan.append(null, ['late']), /complete/);
  assert.throws(() => plan.terminate('error'), /complete/);
});

test('cancelled plans retain actual completed work and reject further execution', () => {
  const plan = Progress.statusPlan({ id: 'copy', startedAt: 0, steps: ['read', 'write'] });
  plan.start('read'); plan.complete('read'); plan.start('write');
  plan.terminate('cancelled');
  assert.equal(plan.snapshot().plan.state, 'cancelled');
  assert.equal(plan.snapshot().plan.completedSteps, 1);
  assert.equal(plan.snapshot().plan.totalSteps, 2);
  assert.throws(() => plan.start('write'), /terminated/);
  assert.throws(() => plan.terminate('error'), /terminated/);
});

test('large and growing step ranges retain individual counts without allocating one node per item', () => {
  const plan = Progress.statusPlan({ id: 'refresh', startedAt: 0, steps: ['metadata', 'publish'] });
  plan.reserve('metadata', 1000000); plan.start('metadata');
  plan.confirmRange('metadata', 500000);
  assert.equal(plan.snapshot().plan.totalSteps, 1000001);
  assert.equal(plan.snapshot().plan.completedSteps, 500000);
  assert.equal(plan.analyze().steps.length, 2);
  assert.equal(plan.analyze().steps[0].range.total, 1000000);
  plan.reserve('metadata', 1000100);
  assert.equal(plan.snapshot().plan.totalSteps, 1000101);
  assert.equal(plan.snapshot().plan.completedSteps, 500000);
  assert.throws(() => plan.confirmRange('metadata', 499999), /range/);
  assert.throws(() => plan.complete('metadata'), /unfinished/);
  plan.confirmRange('metadata', 1000100); plan.complete('metadata');
  plan.start('publish'); plan.complete('publish');
  assert.equal(plan.finishedSnapshot().display.overallPercent, 100);
});

test('a known empty work range does not invent a processed item', () => {
  const plan = Progress.statusPlan({ id: 'empty', startedAt: 0, steps: ['metadata', 'publish'] });
  plan.reserve('metadata', 0); plan.start('metadata'); plan.confirmRange('metadata', 0); plan.complete('metadata');
  assert.equal(plan.snapshot().plan.completedSteps, 0);
  assert.equal(plan.snapshot().plan.totalSteps, 1);
  assert.equal(plan.snapshot().display.overallPercent, 0);
  plan.start('publish'); plan.complete('publish');
  assert.equal(plan.finishedSnapshot().plan.completedSteps, 1);
});

test('byte work measurements remain separate from program step counts and require final confirmation', () => {
  const plan = Progress.statusPlan({ id: 'copy', startedAt: 123, steps: ['copy'], mode: 'work' });
  plan.start('copy');
  const update = completed => plan.update('copy', Progress.event({ phase: 'copying', overall: Progress.known('bytes', completed, 1000), current: Progress.known('bytes', 50, 100) }));
  update(250);
  assert.deepEqual(plan.snapshot().overall, Progress.known('bytes', 250, 1000));
  assert.equal(plan.snapshot().display.overallPercent, 25);
  assert.equal(plan.analyze().totalSteps, 1); assert.equal(plan.analyze().completedSteps, 0);
  update(1000);
  assert.equal(plan.snapshot().overall.reason, 'awaiting-confirmation');
  assert.throws(() => plan.finishedSnapshot(), /not finished/);
  plan.complete('copy');
  assert.equal(plan.finishedSnapshot().display.overallPercent, 100);
  assert.equal(plan.analyze().steps[0].measurement.overall.completed, 1000);
});

test('progress contracts reject absent measurements, invalid totals and unexplained unknown work', () => {
  const overall = Progress.known('bytes', 42, 100), current = Progress.known('bytes', 68, 100);
  assert.equal(Progress.read(Progress.event({ phase: 'packing', overall, current })).version, 1);
  assert.throws(() => Progress.event({ phase: 'packing', overall }), /measurement/);
  assert.throws(() => Progress.known('bytes', 2, 1), /total/);
  assert.throws(() => Progress.known('bytes', 0, NaN), /total/);
  assert.throws(() => Progress.unknown('items', 10), /reason/);
  assert.throws(() => Progress.read({ phase: 'copying', overall, current }), /contract/);
  assert.equal(Progress.unknown('items', 10, 'enumerating').completed, 10);
});

test('the compiler rejects missing totals, missing measurements and direct untyped progress callbacks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'producer.js');
  const api = JSON.stringify(path.resolve(__dirname, '../media/commander-progress').replaceAll('\\', '/'));
  fs.writeFileSync(file, `const Progress = require(${api});\nfunction onProgress(value) { return value; }\nonProgress(Progress.event({ phase: 'copying', overall: Progress.known('bytes', 0, 100), current: Progress.known('bytes', 0, 10) }));\n`);
  assert.deepEqual(check([file]), []);
  fs.writeFileSync(file, `const Progress = require(${api});\nconst statusbar = { setActivity() {}, setProgress() {} };\nconst plan = Progress.statusPlan({ id: 'copy', startedAt: 0, steps: ['copy'] });\nstatusbar.setActivity('Copy', plan.snapshot());\nstatusbar.setProgress({ progress: plan.snapshot() });\n`);
  assert.deepEqual(check([file]), []);
  for (const code of [
    `Progress.known('bytes', 0);`,
    `Progress.event({ phase: 'copying', overall: Progress.known('bytes', 0, 100) });`,
    `Progress.unknown('items', 0);`,
    `Progress.statusPlan(null);`,
    `Progress.statusPlan({ id: 'copy', startedAt: 0, steps: null });`,
    `Progress.statusPlan({ id: 'refresh', startedAt: 0, steps: ['filesystem'] }).update('filesystem');`,
    `onProgress({ phase: 'copying', transferred: 2 });`,
    `const statusbar = { setActivity() {} }; statusbar.setActivity('Loading');`,
    `const statusbar = { setActivity() {} }; statusbar.setActivity('Loading', Progress.event({ phase: 'copying', overall: Progress.known('bytes', 0, 100), current: Progress.known('bytes', 0, 10) }));`,
    `const statusbar = { setProgress() {} }; statusbar.setProgress({ progress: Progress.event({ phase: 'copying', overall: Progress.known('bytes', 0, 100), current: Progress.known('bytes', 0, 10) }) });`,
    `const statusbar = { finishProgress() {} }; const plan = Progress.statusPlan({ id: 'copy', startedAt: 0, steps: ['copy'] }); statusbar.finishProgress({ progress: plan.snapshot() });`,
    `const statusbar = { setProgress() {} }; const plan = Progress.statusPlan({ id: 'copy', startedAt: 0, steps: ['copy'] }); statusbar.setProgress({ progress: plan.snapshot(), completed: 1, total: 2 });`,
    `class Controller { setProgress(value) {} run() { this.setProgress({ completed: 1, total: 2 }); } }`,
    `const bar = window.CommanderStatusbar.create({}); const render = bar.setProgress; render({ title: 'Copy', progress: Progress.event({ phase: 'copy', overall: Progress.known('bytes', 1, 2), current: Progress.known('bytes', 1, 2) }) });`,
    `const bar = window.CommanderStatusbar.create({}); const render = bar.setProgress; const plan = Progress.statusPlan({ id: 'copy', startedAt: 0, steps: ['copy'] }); const input = { title: 'Copy', progress: plan.snapshot(), completed: 1, total: 2 }; render(input);`
  ]) {
    fs.writeFileSync(file, `const Progress = require(${api});\nfunction onProgress(value) { return value; }\n${code}\n`);
    assert.ok(check([file]).length, code);
  }
});

test('removing the planner from the actual statusbar caller fails the build gate', () => {
  const file = path.resolve(__dirname, '../media/app.js'), original = fs.readFileSync(file, 'utf8');
  const modified = original.replace("planned || (measured ? plannedStatus(measured) : null)", 'measured');
  assert.notEqual(modified, original);
  assert.ok(check([file], new Map([[file, modified]])).some(failure => /status planner snapshot/.test(failure)));
});

test('removing a required measurement from an actual ZIP producer fails the build gate', () => {
  const file = path.resolve(__dirname, '../zip-operations.js');
  const original = fs.readFileSync(file, 'utf8');
  const modified = original.replace("overall: Progress.unknown('items', filesScanned, 'enumerating'), ", '');
  assert.notEqual(modified, original);
  const failures = check([file], new Map([[file, modified]]));
  assert.ok(failures.some(failure => /overall|ProgressInput/.test(failure)), failures.join('\n'));
});

test('build and packaging hooks enforce progress contract checking', () => {
  const manifest = require('../package.json');
  assert.match(manifest.scripts.check, /^npm run check:progress &&/);
  assert.match(manifest.scripts['vscode:prepublish'], /^npm run check:progress &&/);
});
