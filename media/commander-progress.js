(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderProgress = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const units = new Set(['bytes', 'items', 'requests', 'steps']);
  const statusSnapshots = new WeakMap();
  const reasons = new Set(['enumerating', 'stream-size-unknown', 'native-operation', 'awaiting-confirmation']);
  function validate(value) {
    if (!value || !units.has(value.unit) || !Number.isSafeInteger(value.completed) || value.completed < 0) throw new TypeError('Invalid progress measurement');
    if (value.kind === 'determinate') {
      if (!Number.isSafeInteger(value.total) || value.total < value.completed) throw new TypeError('Invalid progress total');
    } else if (value.kind !== 'indeterminate' || !reasons.has(value.reason)) throw new TypeError('An unknown progress total requires a reason');
    return Object.freeze({ ...value });
  }
  function known(unit, completed, total) { return validate({ kind: 'determinate', unit, completed, total }); }
  function unknown(unit, completed, reason) { return validate({ kind: 'indeterminate', unit, completed, reason }); }
  function event(input) {
    if (!input || typeof input.phase !== 'string' || !input.phase) throw new TypeError('A progress phase is required');
    return Object.freeze({ ...input, version: 1, overall: validate(input.overall), current: validate(input.current) });
  }
  function read(input) {
    if (input?.version !== 1) throw new TypeError('Unsupported progress contract');
    return event(input);
  }
  function statusPlan({ id, startedAt, steps, mode = 'steps' }) {
    if (typeof id !== 'string' || !id || !Number.isFinite(startedAt) || !['steps', 'work'].includes(mode)) throw new TypeError('Invalid status plan');
    const nodes = new Map(), planning = new Set(); let active = null, latest = null, totalSteps = 0, completedSteps = 0, failedSteps = 0, failures = 0, pendingSteps = 0, terminated = null;
    const history = new Array(512); let sequence = 0;
    const record = (action, step, details = {}) => { history[sequence % history.length] = Object.freeze({ sequence: ++sequence, timestamp: new Date().toISOString(), elapsedMs: Math.max(0, performance.now() - startedAt), action, step, ...details }); };
    const live = () => { if (terminated) throw new TypeError('Status plan is terminated'); };
    const get = key => { const node = nodes.get(key); if (!node) throw new TypeError('Unknown planned step'); return node; };
    const add = (parent, values) => {
      live();
      if (nodes.size && !pendingSteps) throw new TypeError('Cannot expand a complete plan');
      if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value) || new Set(values).size !== values.length) throw new TypeError('Invalid planned steps');
      const owner = parent === null ? null : get(parent);
      if (owner && !['pending', 'running'].includes(owner.state)) throw new TypeError('Cannot expand a complete or failed step');
      const keys = values.map(value => parent === null ? value : `${parent}/${value}`);
      if (keys.some(key => nodes.has(key))) throw new TypeError('Duplicate planned step');
      const leaves = totalSteps + keys.length - (owner && !owner.children.length && !owner.range ? 1 : 0);
      if (!Number.isSafeInteger(leaves) || !Number.isSafeInteger(pendingSteps + keys.length)) throw new TypeError('Invalid planned step total');
      totalSteps = leaves;
      pendingSteps += keys.length;
      for (const key of keys) {
        nodes.set(key, { id: key, parent, children: [], state: 'pending', measurement: null, range: null, error: null, startedAt: null, finishedAt: null });
        owner?.children.push(key);
        record('registered', key, { parent });
      }
      return Object.freeze(keys);
    };
    add(null, steps);
    const summary = () => Object.freeze({ id, totalSteps, completedSteps, failedSteps, openPlanningCount: planning.size, done: pendingSteps === 0 && !terminated, state: terminated || (pendingSteps ? 'running' : failures ? 'error' : 'complete'), activeStepId: active });
    const analyze = () => Object.freeze({ ...summary(), openPlanning: Object.freeze([...planning]), steps: Object.freeze([...nodes.values()].map(node => Object.freeze({ id: node.id, parent: node.parent, state: node.state, error: node.error, startedAt: node.startedAt, finishedAt: node.finishedAt, children: Object.freeze([...node.children]), measurement: node.measurement, range: node.range && Object.freeze({ ...node.range }) }))) });
    const report = () => {
      const analysis = analyze();
      const steps = Object.freeze(analysis.steps.map(node => Object.freeze({ ...node, measurement: node.measurement ? event({ phase: node.measurement.phase, path: node.measurement.path, overall: node.measurement.overall, current: node.measurement.current }) : null })));
      return Object.freeze({ plan: Object.freeze({ ...analysis, steps }), omittedEvents: Math.max(0, sequence - history.length), events: Object.freeze(Array.from({ length: Math.min(sequence, history.length) }, (_, index) => history[(Math.max(0, sequence - history.length) + index) % history.length])) });
    };
    return Object.freeze({
      append: add,
      analyze,
      openPlanning(key) { live(); if (!['pending', 'running'].includes(get(key).state)) throw new TypeError('Planned step is complete or failed'); if (!planning.has(key)) record('planning-opened', key); planning.add(key); },
      closePlanning(key) { live(); get(key); if (planning.delete(key)) record('planning-closed', key); },
      reserve(key, total) {
        live(); const node = get(key), previous = node.range?.total || 0;
        if (!['pending', 'running'].includes(node.state)) throw new TypeError('Planned step is complete or failed');
        if (!Number.isSafeInteger(total) || total < previous) throw new TypeError('Invalid planned step range');
        const delta = total - previous, leaves = totalSteps + delta - (!node.range && !node.children.length ? 1 : 0);
        if (!Number.isSafeInteger(leaves) || !Number.isSafeInteger(pendingSteps + delta)) throw new TypeError('Invalid planned step range');
        totalSteps = leaves; pendingSteps += delta;
        node.range = { total, completed: node.range?.completed || 0 };
        if (delta || !previous) record('range-planned', key, { total });
      },
      confirmRange(key, completed) {
        live(); const node = get(key), range = node.range;
        if (node.state !== 'running' || !range || !Number.isSafeInteger(completed) || completed < range.completed || completed > range.total) throw new TypeError('Invalid confirmed step range');
        const delta = completed - range.completed; completedSteps += delta; pendingSteps -= delta; range.completed = completed;
        if (delta) record('range-completed', key, { completed, total: range.total });
      },
      start(key) { live(); const node = get(key); if (!['pending', 'running'].includes(node.state)) throw new TypeError('Planned step is complete or failed'); if (node.parent !== null && get(node.parent).state !== 'running') throw new TypeError('Parent step is not running'); if (node.state !== 'running') { node.startedAt = performance.now(); record('started', key); } node.state = 'running'; active = key; },
      complete(key) {
        const node = get(key);
        if (node.state === 'complete') return;
        live();
        if (node.state !== 'running' || planning.has(key) || node.children.some(child => !['complete', 'error'].includes(get(child).state)) || node.range && node.range.completed !== node.range.total) throw new TypeError('Planned step has unfinished work');
        node.state = 'complete'; node.finishedAt = performance.now(); pendingSteps--; if (!node.children.length && !node.range) completedSteps++;
        record('completed', key);
      },
      fail(key, error) {
        live(); const node = get(key);
        if (!['pending', 'running'].includes(node.state) || typeof error !== 'string' || !error) throw new TypeError('Invalid failed step');
        const pending = [node]; failures++;
        while (pending.length) {
          const failed = pending.pop(); if (['complete', 'error'].includes(failed.state)) continue;
          pendingSteps--; planning.delete(failed.id);
          if (failed.range) { const remaining = failed.range.total - failed.range.completed; pendingSteps -= remaining; failedSteps += remaining; }
          else if (!failed.children.length) failedSteps++;
          pending.push(...failed.children.map(get)); const previousState = failed.state; failed.state = 'error'; failed.error = error; failed.finishedAt = performance.now();
          record('failed', failed.id, { error, previousState });
        }
      },
      update(key, input) { live(); const node = get(key); if (node.state !== 'running') throw new TypeError('Planned step is not running'); latest = read(input); node.measurement = latest; active = key; record('progress', key, { phase: latest.phase, path: latest.path, overall: latest.overall, current: latest.current }); },
      terminate(outcome) {
        if (!['error', 'cancelled'].includes(outcome)) throw new TypeError('Invalid termination outcome');
        if (!pendingSteps) throw new TypeError('Status plan is complete');
        if (terminated && terminated !== outcome) throw new TypeError('Status plan is terminated');
        terminated = outcome;
        record(outcome, active);
      },
      finishedSnapshot() { return readFinishedStatus(this.snapshot()); },
      snapshot() {
        const analysis = summary(), node = active && get(active);
        let overall = mode === 'work' && latest ? latest.overall : known('steps', analysis.completedSteps, analysis.totalSteps);
        if (mode === 'steps' && planning.size) overall = unknown('steps', analysis.completedSteps, 'enumerating');
        if (overall.kind === 'determinate' && overall.completed === overall.total && !analysis.done) overall = unknown(overall.unit, overall.completed, 'awaiting-confirmation');
        let current = node?.measurement?.current || unknown('steps', 0, 'awaiting-confirmation');
        if (node?.state !== 'complete' && current.kind === 'determinate' && (current.total === 0 || mode === 'steps' && current.completed === current.total)) current = unknown(current.unit, current.completed, 'awaiting-confirmation');
        const percent = measurement => measurement.kind === 'determinate' ? measurement.total ? measurement.completed / measurement.total * 100 : 100 : null;
        const snapshot = Object.freeze({ ...event({ id, startedAt, phase: node?.measurement?.phase || active || 'planning', overall, current }), plan: analysis,
          display: Object.freeze({ overallPercent: percent(overall), currentPercent: percent(current) }) });
        statusSnapshots.set(snapshot, report);
        return snapshot;
      }
    });
  }
  function readStatus(input) {
    if (!input || !statusSnapshots.has(input)) throw new TypeError('Status progress requires a status planner snapshot');
    return input;
  }
  function readFinishedStatus(input) {
    const snapshot = readStatus(input);
    if (snapshot.plan.state === 'running') throw new TypeError('Status plan is not finished');
    return snapshot;
  }
  function statusReport(input) { return statusSnapshots.get(readStatus(input))(); }
  return { known, unknown, event, read, statusPlan, readStatus, readFinishedStatus, statusReport };
});
