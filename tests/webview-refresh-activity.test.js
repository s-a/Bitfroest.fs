const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
function fixture() {
  const p = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'activity', active: 0, panes: [p('/left'), p('/right')], folders: {
    '/left': [{ id: 'child', name: 'child', type: 'folder' }], '/left/child': [], '/right': []
  } };
}
const activity = app => app.document.querySelector('#status-activity');
const finishGit = (app, request, directories = request.directories) => send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, directories: Object.fromEntries(directories.map(path => [path, { ok: true, repository: false }])), partial: true });

test('the initial Git query uses the planned child checks for its overall total rather than two directory replies', t => {
  const app = createApp(t, fixture()), Progress = require('../media/commander-progress'), git = app.messages.find(message => message.type === 'git-status');
  for (const [directory, count] of [['/left', 2], ['/right', 8]]) send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, partial: true, directories: { [directory]: Progress.event({ phase: 'git-dirty-check', stage: 'inspect', ok: true, loading: true, repository: false, repositoryChecks: { paths: Array.from({ length: count }, (_, index) => `${directory}/${index}`), total: count, completed: 0, active: null }, overall: Progress.unknown('requests', 0, 'enumerating'), current: Progress.known('requests', 0, count) }) } });
  const overall = app.document.querySelector('#status-progress-overall');
  assert.ok(Number(overall.getAttribute('aria-valuemax')) > 10);
  assert.match(overall.getAttribute('aria-valuetext'), /Programmschritte/);
});
function observeRefresh(app) {
  const create = app.window.CommanderProgress.statusPlan; let plan;
  app.window.CommanderProgress.statusPlan = input => { const result = create(input); if (input.id.startsWith('refresh-')) plan = result; return result; };
  return () => plan.snapshot();
}

test('focus refresh retains its total plan and elapsed time when one Git query fails before the other', t => {
  const app = createApp(t, fixture()), snapshot = observeRefresh(app);
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  let now = 0; Object.defineProperty(app.window.performance, 'now', { value: () => now });
  send(app, { type: 'window-focus' }); const request = app.messages.findLast(message => message.type === 'filesystem-refresh');
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const git = app.messages.findLast(message => message.type === 'git-status'); now = 10000;
  send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, partial: true, directories: { '/left': { ok: false, error: 'Access denied', repositoryDetected: true } } });
  assert.equal(snapshot().id, request.refreshRequestId); assert.equal(snapshot().plan.state, 'running');
  assert.equal(app.document.querySelector('#status-progress-overall').hasAttribute('aria-valuenow'), false);
  assert.equal(app.document.querySelector('#status-elapsed').textContent, '00:10');
  finishGit(app, git, ['/right']); assert.equal(activity(app).hidden, true); assert.equal(snapshot().plan.state, 'error');
});

test('focus refresh plans all child dirty checks before execution and advances one overall process', t => {
  const app = createApp(t, fixture()), Progress = require('../media/commander-progress'), snapshot = observeRefresh(app);
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  send(app, { type: 'window-focus' }); const refresh = app.messages.findLast(message => message.type === 'filesystem-refresh');
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const git = app.messages.findLast(message => message.type === 'git-status');
  const check = (directory, checks, result) => send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, partial: true, directories: { [directory]: Progress.event({ phase: 'git-dirty-check', stage: 'inspect', ok: true, loading: true, repository: false, repositoryChecks: checks, repositoryResult: result, overall: Progress.unknown('requests', checks.completed, 'enumerating'), current: Progress.known('requests', checks.completed, checks.total) }) } });
  check('/left', { paths: ['/left/a', '/left/b'], total: 2, completed: 0, active: null });
  check('/right', { paths: [], total: 0, completed: 0, active: null });
  const overall = app.document.querySelector('#status-progress-overall');
  assert.equal(snapshot().id, refresh.refreshRequestId); assert.equal(snapshot().plan.openPlanningCount, 0);
  assert.equal(overall.hasAttribute('aria-valuemax'), true);
  const completed = snapshot().plan.completedSteps;
  check('/left', { total: 2, completed: 0, active: '/left/a' });
  assert.equal(snapshot().plan.completedSteps, completed);
  check('/left', { total: 2, completed: 1, active: '/left/a' }, { path: '/left/a', ok: true });
  assert.equal(snapshot().plan.completedSteps, completed + 1);
  check('/left', { total: 2, completed: 1, active: '/left/b' });
  check('/left', { total: 2, completed: 2, active: '/left/b' }, { path: '/left/b', ok: false, error: 'Access denied' });
  assert.equal(snapshot().plan.failedSteps, 1); assert.equal(snapshot().plan.state, 'running');
  finishGit(app, git); assert.equal(activity(app).hidden, true); assert.equal(snapshot().plan.state, 'error');
});

test('tab changes during a pending refresh are persisted independently of the filesystem result', t => {
  const state = fixture(); state.panes[0].tabs.push('/left/child');
  const app = createApp(t, state); finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh'); const start = app.messages.length;
  app.click(app.document.querySelector('[data-pane="0"] [data-tab="1"]'));
  assert.equal(app.state().panes[0].tab, 1);
  const saved = app.messages.slice(start).findLast(message => message.type === 'view-state');
  assert.ok(saved); assert.deepEqual(Array.from(saved.panes[0].tabs), ['/left', '/left/child']); assert.equal(saved.panes[0].tab, 1);
  assert.equal(app.messages.slice(start).some(message => message.type === 'filesystem-apply'), false);
});

test('refresh does not show an overall percentage while subsequent Git work is still being discovered', t => {
  const app = createApp(t, fixture()); finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh'); const request = app.messages.findLast(message => message.type === 'filesystem-refresh');
  send(app, { type: 'filesystem-refresh-step', refreshRequestId: request.refreshRequestId, path: '/left', phase: 'metadata', completed: 1000, total: 1000 });
  assert.equal(app.document.querySelector('#status-progress-overall').hasAttribute('aria-valuenow'), false);
  assert.equal(app.document.querySelector('#status-percent').textContent.split('/')[0], '—');
});

test('Git counter updates preserve file icons and only refresh the status display', t => {
  const app = createApp(t, fixture()), Progress = require('../media/commander-progress');
  const request = app.messages.find(message => message.type === 'git-status');
  const update = completed => send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, partial: true, directories: { '/left': Progress.event({ phase: 'git-read-worktree', ok: true, loading: true, incremental: true, statuses: { child: 'clean' }, overall: Progress.unknown('items', completed, 'native-operation'), current: Progress.unknown('items', completed, 'native-operation') }) } });
  update(0);
  const computed = app.window.getComputedStyle.bind(app.window); let colorReads = 0;
  app.window.getComputedStyle = element => { if (element.id === 'statusbar') colorReads++; return computed(element); };
  const original = app.document.querySelectorAll.bind(app.document); let iconTraversals = 0;
  app.document.querySelectorAll = selector => {
    const sections = original(selector);
    if (selector === '.pane') for (const section of sections) {
      if (section.querySelectorAll.counted) continue;
      const query = section.querySelectorAll.bind(section);
      section.querySelectorAll = selector => { if (selector === 'tr[data-id]') iconTraversals++; return query(selector); };
      section.querySelectorAll.counted = true;
    }
    return sections;
  };
  for (let n = 1; n <= 30; n++) update(n);
  assert.equal(iconTraversals, 0);
  assert.equal(colorReads, 0);
  assert.equal(activity(app).hidden, false);
  assert.match(activity(app).textContent, /Git-Index und Arbeitsbaum prüfen/);
});

test('refresh reports saving the view state instead of an unspecified host wait', t => {
  const app = createApp(t, fixture()); finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh'); const request = app.messages.findLast(message => message.type === 'filesystem-refresh');
  for (const path of ['/left', '/right']) send(app, { type: 'filesystem-refresh-step', refreshRequestId: request.refreshRequestId, path, phase: 'done', completed: 0, total: 0 });
  send(app, { type: 'filesystem-refresh-step', refreshRequestId: request.refreshRequestId, phase: 'state-save' });
  assert.match(activity(app).textContent, /Ansichtszustand speichern/);
  assert.doesNotMatch(activity(app).textContent, /Hostbestätigung/);
  send(app, { type: 'filesystem-result', refreshRequestId: request.refreshRequestId, ok: true, state: app.state() });
  finishGit(app, app.messages.findLast(message => message.type === 'git-status'));
  assert.equal(activity(app).hidden, true);
});

test('refresh activity names the busy panels and ends after their actual Git replies', t => {
  for (const [language, git, read] of [['de', 'Git-Abfrage', 'Verzeichnis einlesen'], ['en', 'Git query', 'Read directory']]) {
    const app = createApp(t, fixture(), { language });
    const request = app.messages.find(message => message.type === 'git-status');
    assert.equal(activity(app).hidden, false);
    assert.equal(activity(app).textContent.split(git).length - 1, 1);
    assert.ok(activity(app).textContent.includes('/left'));
    assert.ok(activity(app).textContent.includes('/right'));
    finishGit(app, request, ['/left']);
    assert.equal(activity(app).textContent.split(git).length - 1, 1);
    finishGit(app, request, ['/right']);
    assert.equal(activity(app).hidden, true);
    app.action('refresh');
    assert.ok(activity(app).textContent.includes(read));
    const refresh = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
    send(app, { type: 'filesystem-refresh-step', refreshRequestId: refresh.refreshRequestId, path: '/left', phase: 'metadata' });
    assert.ok(activity(app).textContent.includes(language === 'de' ? 'Dateieigenschaften lesen' : 'Read file properties'));
    send(app, { type: 'filesystem-refresh-step', refreshRequestId: 'obsolete', path: '/right', phase: 'done' });
    assert.equal(app.document.querySelector('[data-pane="1"] [data-refresh]').getAttribute('aria-busy'), 'true');
    send(app, { type: 'filesystem-refresh-step', refreshRequestId: refresh.refreshRequestId, path: '/left', phase: 'done' });
    assert.equal(app.document.querySelector('[data-pane="0"] [data-refresh]').getAttribute('aria-busy'), 'false');
    send(app, { type: 'filesystem-result', ok: true, state: app.state() });
    assert.ok(activity(app).textContent.includes(git));
    finishGit(app, request);
    assert.equal(activity(app).hidden, false, 'an obsolete reply cannot finish the new query');
    finishGit(app, app.messages.filter(message => message.type === 'git-status').at(-1));
    assert.equal(activity(app).hidden, true);
    assert.equal(app.document.querySelector('[data-refresh]').getAttribute('aria-busy'), 'false');
  }
});

test('navigation activity changes to metadata reading after names without replacing errors', t => {
  const app = createApp(t, fixture());
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.click(app.row('child')); app.key('Enter');
  const request = app.messages.find(message => message.type === 'filesystem-navigate');
  assert.ok(activity(app).textContent.includes('Verzeichnis einlesen'));
  send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: '/left/child', names: [], rows: [] });
  assert.ok(activity(app).textContent.includes('Dateieigenschaften lesen'));
  assert.ok(activity(app).textContent.includes('/left/child'));
  send(app, { type: 'filesystem-result', navigationRequestId: request.navigationRequestId, ok: false, error: 'Read failed' });
  assert.equal(app.document.querySelector('#status-message').textContent, 'Read failed');
  assert.equal(app.document.querySelector('#status-message').dataset.outcome, 'error');
  finishGit(app, app.messages.filter(message => message.type === 'git-status').at(-1));
  assert.equal(activity(app).hidden, true);
  assert.equal(app.document.querySelector('#status-message').textContent, 'Read failed');
});

test('refresh counts actual metadata steps in the overall plan and keeps current work separate', t => {
  const app = createApp(t, fixture());
  const snapshot = observeRefresh(app);
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  const request = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  send(app, { type: 'filesystem-refresh-step', refreshRequestId: request.refreshRequestId, path: '/left', phase: 'metadata', completed: 50, total: 100 });
  assert.equal(app.document.querySelector('#status-percent').textContent, '—/50%');
  assert.equal(snapshot().plan.completedSteps, 51);
  assert.equal(snapshot().plan.totalSteps, 116);
  send(app, { type: 'filesystem-refresh-step', refreshRequestId: 'stale', path: '/left', phase: 'metadata', completed: 99, total: 100 });
  assert.equal(app.document.querySelector('#status-percent').textContent, '—/50%');
});

test('refresh overall progress and elapsed time span metadata and the complete follow-up query', t => {
  const Progress = require('../media/commander-progress');
  const app = createApp(t, fixture());
  const initial = app.messages.find(message => message.type === 'git-status');
  finishGit(app, initial);
  let now = 10000;
  Object.defineProperty(app.window.performance, 'now', { value: () => now });
  app.action('refresh');
  const refresh = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  const overall = app.document.querySelector('#status-progress-overall');
  const assertRunning = () => {
    assert.equal(overall.classList.contains('indeterminate'), true);
    assert.equal(overall.hasAttribute('aria-valuenow'), false);
    assert.equal(activity(app).hidden, false);
  };
  assertRunning();
  now += 2000;
  for (const path of ['/left', '/right']) {
    send(app, { type: 'filesystem-refresh-step', refreshRequestId: refresh.refreshRequestId, path, phase: 'metadata', completed: 100, total: 100 });
    assertRunning();
    send(app, { type: 'filesystem-refresh-step', refreshRequestId: refresh.refreshRequestId, path, phase: 'done' });
    assertRunning();
  }
  assert.equal(activity(app).hidden, false, 'directory completion is not host confirmation');
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const git = app.messages.filter(message => message.type === 'git-status').at(-1);
  assertRunning();
  assert.equal(app.document.querySelector('#status-elapsed').textContent, '00:02');
  now += 3000;
  for (const [index, phase] of ['git-locate', 'git-read-worktree', 'git-map-status'].entries()) {
    const progress = Progress.event({ phase, ok: true, loading: true, overall: Progress.unknown('items', index * 100, 'native-operation'), current: Progress.known('items', 100, 100) });
    send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, partial: true, directories: { '/left': progress } });
    assertRunning();
    assert.equal(app.document.querySelector('#status-progress-file').hasAttribute('aria-valuenow'), false);
    assert.match(overall.getAttribute('aria-valuetext'), /Programmschritte/);
  }
  finishGit(app, initial);
  assertRunning();
  send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: 'obsolete', directories: {} });
  assertRunning();
  finishGit(app, git, ['/left']);
  assertRunning();
  assert.equal(app.document.querySelector('#status-elapsed').textContent, '00:05');
  finishGit(app, git, ['/right']);
  assert.equal(activity(app).hidden, true);
  assert.equal(app.document.querySelector('#status-progress-track').getAttribute('aria-hidden'), 'true');
});

test('refresh plans one shared Git request for identical panel paths', t => {
  const saved = fixture(); saved.panes[1].tabs = ['/left'];
  const app = createApp(t, saved);
  const snapshot = observeRefresh(app);
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const git = app.messages.filter(message => message.type === 'git-status').at(-1);
  assert.deepEqual(Array.from(git.directories), ['/left']);
  assert.equal(snapshot().plan.totalSteps, 9);
  finishGit(app, git);
  assert.equal(activity(app).hidden, true);
});

test('directory names cannot collide with internal step identities in another visible directory', t => {
  for (const name of ['metadata', 'describe']) {
    const saved = fixture(), directory = `/left/${name}`; saved.panes[1].tabs = [directory]; saved.folders[directory] = [];
    const app = createApp(t, saved), errors = [];
    app.window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
    finishGit(app, app.messages.find(message => message.type === 'git-status'));
    app.action('refresh');
    assert.deepEqual(errors, []);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-refresh').length, 1);
  }
});

test('refresh recursively registers matrix rows and advances the same plan as those rows are processed', t => {
  const Progress = require('../media/commander-progress');
  const app = createApp(t, fixture());
  const snapshot = observeRefresh(app);
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  const refresh = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  for (const path of ['/left', '/right']) send(app, { type: 'filesystem-refresh-step', refreshRequestId: refresh.refreshRequestId, path, phase: 'done', completed: 100, total: 100 });
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const git = app.messages.filter(message => message.type === 'git-status').at(-1);
  const update = (path, completed, total) => send(app, { type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, partial: true, directories: { [path]: Progress.event({ phase: 'git-map-status', stage: 'inspect', ok: true, loading: true, overall: Progress.unknown('items', completed, 'enumerating'), current: Progress.known('items', completed, total) }) } });
  update('/left', 0, 100); update('/right', 0, 700);
  const overall = app.document.querySelector('#status-progress-overall');
  assert.equal(overall.hasAttribute('aria-valuenow'), false);
  assert.equal(snapshot().plan.totalSteps, 1013);
  assert.equal(snapshot().plan.completedSteps, 211);
  update('/left', 50, 100);
  assert.equal(snapshot().plan.completedSteps, 261);
  update('/right', 350, 700);
  assert.equal(snapshot().plan.completedSteps, 611);
  finishGit(app, git, ['/left']);
  assert.equal(snapshot().plan.completedSteps, 662);
  update('/right', 700, 700);
  assert.equal(snapshot().plan.completedSteps, 1012, 'publication still requires the final response');
  assert.equal(snapshot().plan.totalSteps, 1013);
  assert.equal(app.document.querySelector('#status-progress-file').hasAttribute('aria-valuenow'), false);
  finishGit(app, git, ['/right']);
  assert.equal(activity(app).hidden, true);
});

test('archive-only refresh plans no Git request and ends on filesystem confirmation', t => {
  const saved = fixture();
  saved.panes.forEach(p => { p.tabs = ['zip:/archive']; }); saved.folders['zip:/archive'] = [];
  const app = createApp(t, saved);
  const snapshot = observeRefresh(app);
  app.action('refresh');
  assert.equal(snapshot().plan.totalSteps, 6);
  assert.equal(snapshot().display.overallPercent, null);
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  assert.equal(activity(app).hidden, true);
  assert.equal(app.messages.some(message => message.type === 'git-status'), false);
});

test('refresh comment bytes use their own unit without changing planned step counts', t => {
  const Progress = require('../media/commander-progress'), app = createApp(t, fixture());
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  const request = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  const sendBytes = completed => send(app, { type: 'filesystem-refresh-step', refreshRequestId: request.refreshRequestId, path: '/left', phase: 'comments', completed: 3, total: 3, progress: Progress.event({ phase: 'directory-comments', overall: Progress.unknown('bytes', completed, 'enumerating'), current: Progress.known('bytes', completed, 100000) }) });
  sendBytes(1000);
  const overall = app.document.querySelector('#status-progress-overall'), current = app.document.querySelector('#status-progress-file');
  const count = overall.getAttribute('aria-valuenow'), total = overall.getAttribute('aria-valuemax');
  assert.equal(current.getAttribute('aria-valuenow'), '1000'); assert.equal(current.getAttribute('aria-valuemax'), '100000');
  sendBytes(65536);
  assert.equal(current.getAttribute('aria-valuenow'), '65536');
  assert.equal(overall.getAttribute('aria-valuenow'), count); assert.equal(overall.getAttribute('aria-valuemax'), total);
});

test('informational Git activity does not invent a completed program step', t => {
  const Progress = require('../media/commander-progress'), app = createApp(t, fixture());
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh'); send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const request = app.messages.filter(message => message.type === 'git-status').at(-1), overall = app.document.querySelector('#status-progress-overall');
  const count = overall.getAttribute('aria-valuenow'), total = overall.getAttribute('aria-valuemax');
  send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, partial: true, directories: { '/left': Progress.event({ phase: 'git-discover', activityOnly: true, ok: true, loading: true, overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.known('items', 1, 1) }) } });
  assert.equal(overall.getAttribute('aria-valuenow'), count); assert.equal(overall.getAttribute('aria-valuemax'), total);
});

test('native comparisons extend the running plan and confirm prior comparisons rather than their start', t => {
  const Progress = require('../media/commander-progress'), app = createApp(t, fixture());
  const snapshot = observeRefresh(app);
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh'); send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const request = app.messages.filter(message => message.type === 'git-status').at(-1), overall = app.document.querySelector('#status-progress-overall');
  const update = (paths, total, completed) => send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, partial: true, directories: { '/left': Progress.event({ phase: 'git-read-worktree', stage: 'inspect', ok: true, loading: true, nativeChecks: { paths, total, completed }, overall: Progress.unknown('items', completed, 'native-operation'), current: Progress.unknown('items', completed, 'native-operation') }) } });
  update(['/left/a', '/left/b'], 2, 1);
  assert.equal(overall.hasAttribute('aria-valuenow'), false);
  assert.equal(snapshot().plan.completedSteps, 13); assert.equal(snapshot().plan.totalSteps, 18);
  update(['/left/c'], 3, 2);
  assert.equal(snapshot().plan.completedSteps, 14); assert.equal(snapshot().plan.totalSteps, 19);
  update([], 3, 3);
  assert.equal(snapshot().plan.completedSteps, 15); assert.equal(snapshot().plan.totalSteps, 19);
  finishGit(app, request, ['/left']); finishGit(app, request, ['/right']);
  assert.equal(activity(app).hidden, true);
});

test('a failed child repository does not leave native comparisons attached to the next repository', t => {
  const Progress = require('../media/commander-progress'), app = createApp(t, fixture()), snapshot = observeRefresh(app), errors = [];
  app.window.addEventListener('error', event => { errors.push(event.message); event.preventDefault(); });
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh'); send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const request = app.messages.findLast(message => message.type === 'git-status');
  const update = input => send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, partial: true, directories: { '/left': Progress.event({ ok: true, loading: true, stage: 'inspect', overall: Progress.unknown('items', 0, 'native-operation'), current: Progress.unknown('items', 0, 'native-operation'), ...input }) } });
  update({ phase: 'git-read-worktree', nativeChecks: { paths: ['/left/first/a', '/left/first/b'], total: 2, completed: 1 } });
  update({ phase: 'git-discover', activityOnly: true, repositoryResult: { path: '/left/first', ok: false, error: 'Path too long' } });
  update({ phase: 'git-locate', path: '/left/next/.git' });
  update({ phase: 'git-read-worktree', nativeChecks: { paths: ['/left/next/a'], total: 1, completed: 0 } });
  update({ phase: 'git-read-worktree', nativeChecks: { paths: [], total: 1, completed: 1 } });
  finishGit(app, request);
  assert.deepEqual(errors, []); assert.equal(activity(app).hidden, true);
  assert.equal(snapshot().plan.state, 'error'); assert.equal(snapshot().plan.failedSteps, 1);
});

test('real directory and native Git progress complete one recursive refresh plan without a desktop session', async t => {
  const { dir } = await require('./support/git-fixture.cjs').repository(t);
  const directory = dir.replaceAll('\\', '/'), saved = fixture();
  saved.panes.forEach(p => { p.tabs = [directory]; }); saved.folders = { [directory]: [] };
  const app = createApp(t, saved), errors = [], samples = [];
  const snapshot = observeRefresh(app);
  app.window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  const request = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  const receive = message => {
    send(app, message);
    if (!activity(app).hidden) {
      const value = snapshot(); samples.push([value.plan.completedSteps, value.plan.totalSteps]);
      assert.equal(app.document.querySelector('#status-progress-overall').hasAttribute('aria-valuenow'), false);
    }
  };
  const provider = require('../filesystem-provider').createProvider({ roots: [directory] });
  const state = await provider.load({ visibleOnly: true, directories: [directory], onDirectory: update => receive({ type: 'filesystem-refresh-step', refreshRequestId: request.refreshRequestId, path: update.path, phase: update.phase || (update.done ? 'done' : 'metadata'), completed: update.completed, total: update.total, progress: update.progress }) });
  receive({ type: 'filesystem-result', ok: true, state });
  const git = app.messages.filter(message => message.type === 'git-status').at(-1);
  const Progress = require('../media/commander-progress'), engine = require('../git-status-engine').createGitStatusEngine();
  t.after(() => engine.close());
  const gitProgress = info => receive({ type: 'git-status-result', requestId: git.requestId, snapshotId: git.snapshotId, partial: true, directories: { [directory]: info } });
  const description = await engine.describe(directory, {}, update => gitProgress(Progress.event({ ...update, stage: 'describe' })));
  gitProgress(Progress.event({ ...description, phase: 'git-wait', stage: 'describe', loading: true, overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.unknown('items', 0, 'native-operation') }));
  const result = await engine.inspect(directory, {}, update => gitProgress(Progress.event({ ...update, stage: 'inspect' })));
  assert.equal(result.ok, true, result.error);
  assert.equal(activity(app).hidden, false, 'the matching final publication is still outstanding');
  gitProgress(result);
  assert.equal(activity(app).hidden, true);
  assert.deepEqual(errors, []);
  assert.ok(samples.every(([completed, total]) => total > completed));
  assert.ok(new Set(samples.map(([completed]) => completed)).size > 5);
  assert.ok(new Set(samples.map(([, total]) => total)).size > 2);
});

test('a new refresh plan cannot be completed by the previous query', t => {
  const app = createApp(t, fixture());
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const previous = app.messages.filter(message => message.type === 'git-status').at(-1);
  app.action('refresh');
  finishGit(app, previous);
  assert.equal(app.document.querySelector('#status-percent').textContent.split('/')[0], '—');
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  const current = app.messages.filter(message => message.type === 'git-status').at(-1);
  finishGit(app, previous);
  assert.equal(app.document.querySelector('#status-percent').textContent.split('/')[0], '—');
  finishGit(app, current);
  assert.equal(activity(app).hidden, true);
});

test('an obsolete filesystem completion cannot close the current refresh plan', t => {
  const app = createApp(t, fixture()); finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.action('refresh');
  const request = app.messages.filter(message => message.type === 'filesystem-refresh').at(-1);
  const before = app.messages.filter(message => message.type === 'git-status').length;
  send(app, { type: 'filesystem-result', refreshRequestId: 'obsolete', ok: true, state: app.state() });
  assert.equal(app.messages.filter(message => message.type === 'git-status').length, before);
  assert.equal(app.document.querySelector('#status-percent').textContent.split('/')[0], '—');
  send(app, { type: 'filesystem-result', refreshRequestId: request.refreshRequestId, ok: true, state: app.state() });
  assert.equal(app.messages.filter(message => message.type === 'git-status').length, before + 1);
});

test('navigation counts fresh metadata rows against the enumerated names without an extra scan', t => {
  const app = createApp(t, fixture()); finishGit(app, app.messages.find(message => message.type === 'git-status'));
  app.click(app.row('child')); app.key('Enter');
  const request = app.messages.find(message => message.type === 'filesystem-navigate');
  const before = app.messages.filter(message => message.type === 'filesystem-navigate').length;
  send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, names: ['a', 'b', 'c', 'd'], rows: [] });
  assert.equal(app.document.querySelector('#status-percent').textContent, '0%/0%');
  send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, rows: [{ id: 'a', name: 'a', type: 'text' }, { id: 'b', name: 'b', type: 'text' }] });
  assert.equal(app.document.querySelector('#status-percent').textContent, '50%/50%');
  send(app, { type: 'filesystem-directory', navigationRequestId: request.navigationRequestId, path: request.path, done: true, rows: [] });
  assert.equal(app.document.querySelector('#status-percent').textContent, '—/100%');
  assert.equal(app.messages.filter(message => message.type === 'filesystem-navigate').length, before);
});

test('activity does not change status ownership and yields to operation progress until reset', t => {
  const app = createApp(t, fixture());
  const bar = app.window.CommanderStatusbar.create({ t: value => value, actions: [], focusList() {} });
  bar.error('Failure'); const version = bar.version;
  const plan = app.window.CommanderProgress.statusPlan({ id: 'read', startedAt: 0, steps: ['read'] }); plan.start('read');
  bar.setActivity('Read directory', plan.snapshot());
  assert.equal(bar.version, version);
  assert.equal(app.document.querySelector('#status-message').textContent, 'Failure');
  assert.equal(activity(app).hidden, false);
  const copy = app.window.CommanderProgress.statusPlan({ id: 'copy', startedAt: 0, steps: ['copy'] }); copy.start('copy');
  bar.setProgress({ title: 'Copying', progress: copy.snapshot() });
  assert.equal(activity(app).hidden, true);
  assert.equal(app.document.querySelector('#status-message').textContent, 'Copying');
  copy.complete('copy'); bar.finishProgress({ message: 'Done', outcome: 'success', progress: copy.finishedSnapshot() });
  assert.equal(activity(app).hidden, false);
  assert.equal(app.document.querySelector('#status-message').textContent, 'Done');
  bar.reset(); assert.equal(activity(app).hidden, true); assert.equal(activity(app).textContent, '');
  bar.dispose();
});


test('Git query retains one overall measurement across phases and panel completions', t => {
  const Progress = require('../media/commander-progress');
  const app = createApp(t, fixture()), request = app.messages.find(message => message.type === 'git-status');
  const overall = app.document.querySelector('#status-progress-overall');
  assert.equal(overall.hasAttribute('aria-valuemax'), false);
  assert.equal(overall.hasAttribute('aria-valuenow'), false);
  for (const phase of ['git-locate', 'git-read-worktree', 'git-map-status']) {
    const progress = Progress.event({ phase, path: '/left/child', ok: true, loading: true, incremental: true, statuses: {}, overall: Progress.known('items', 3, 8), current: Progress.known('items', 3, 8) });
    send(app, { type: 'git-status-result', requestId: request.requestId, snapshotId: request.snapshotId, partial: true, directories: { '/left': progress } });
    assert.ok(activity(app).textContent.includes('Git-Abfrage'));
    assert.equal(activity(app).textContent.includes('/left/child'), false);
    assert.equal(overall.hasAttribute('aria-valuemax'), false);
    assert.equal(overall.hasAttribute('aria-valuenow'), false);
  }
  finishGit(app, request, ['/left']);
  assert.equal(overall.hasAttribute('aria-valuenow'), false);
  assert.equal(overall.hasAttribute('aria-valuemax'), false);
  finishGit(app, request, ['/right']);
  assert.equal(activity(app).hidden, true);
});


test('Git elapsed time covers the complete request while open planning leaves ETA unknown', t => {
  const app = createApp(t, fixture()), request = app.messages.find(message => message.type === 'git-status');
  const start = app.window.performance.now();
  Object.defineProperty(app.window.performance, 'now', { value: () => start + 4000 });
  finishGit(app, request, ['/left']);
  assert.equal(app.document.querySelector('#status-elapsed').textContent, '00:04');
  assert.equal(app.document.querySelector('#status-eta').textContent, '—');
  finishGit(app, request, ['/right']);
});


test('refresh leaves existing status text intact through filesystem completion', t => {
  const app = createApp(t, fixture());
  finishGit(app, app.messages.find(message => message.type === 'git-status'));
  send(app, { type: 'open-trash-result', ok: true });
  const status = app.document.querySelector('#status-message'), previous = status.textContent;
  assert.ok(previous);
  app.action('refresh');
  assert.equal(status.textContent, previous);
  send(app, { type: 'filesystem-result', ok: true, state: app.state() });
  assert.equal(status.textContent, previous);
});
