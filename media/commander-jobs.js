(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderJobs = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function snapshot(value) {
    if (!value || typeof value !== 'object') return value;
    return Object.freeze(Array.isArray(value) ? value.map(snapshot) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])));
  }
  /** @param {import('./commander-jobs').BackgroundSupport['presentation']['placement']} placement
   * @param {import('./commander-jobs').BackgroundSupport['cancellation']['mode']} cancellation
   * @param {0 | 1} minItems
   * @returns {import('./commander-jobs').BackgroundSupport} */
  function background(placement, cancellation, minItems = 1) {
    return { enabled: true, execution: { isolation: 'exclusive' }, selection: { minItems }, progress: { required: true, contractVersion: 1 }, cancellation: { mode: cancellation }, presentation: { placement } };
  }
  /** @param {import('./commander-jobs').ForegroundSupport['reason']} reason
   * @returns {import('./commander-jobs').ForegroundSupport} */
  function foreground(reason) { return { enabled: false, reason, presentation: { progress: 'footer', interaction: 'locked' } }; }
  /** @type {import('./commander-jobs').CommandRegistry} */
  const definitions = {
    copy: { id: 'copy', supportsBackgroundOperation: background('pane-header', 'cooperative') },
    move: { id: 'move', supportsBackgroundOperation: background('pane-header', 'cooperative') },
    'zip-pack': { id: 'zip-pack', supportsBackgroundOperation: background('pane-header', 'cooperative') },
    'zip-unpack': { id: 'zip-unpack', supportsBackgroundOperation: background('pane-header', 'cooperative') },
    'zip-test': { id: 'zip-test', supportsBackgroundOperation: background('pane-header', 'cooperative') },
    'zip-update': { id: 'zip-update', supportsBackgroundOperation: background('pane-header', 'cooperative', 0) },
    delete: { id: 'delete', supportsBackgroundOperation: foreground('foreground-only') },
    rename: { id: 'rename', supportsBackgroundOperation: foreground('foreground-only') },
    'rename-many': { id: 'rename-many', supportsBackgroundOperation: foreground('foreground-only') },
    mkdir: { id: 'mkdir', supportsBackgroundOperation: foreground('foreground-only') },
    'new-file': { id: 'new-file', supportsBackgroundOperation: foreground('foreground-only') }
  };
  const commands = snapshot(definitions);
  /** @type {import('./commander-jobs').ActionCommands} */
  const actionDefinitions = {
    copy: 'copy', 'copy-same': 'copy', move: 'move', pack: 'zip-pack', 'pack-move': 'zip-pack', unpack: 'zip-unpack', 'test-archives': 'zip-test',
    delete: 'delete', remove: 'delete', 'delete-alternate': 'delete', 'delete-permanently': 'delete',
    'rename-one': 'rename', rename: 'rename-many', mkdir: 'mkdir', 'mkdir-other': 'mkdir', 'new-file': 'new-file'
  };
  const actionCommands = snapshot(actionDefinitions);
  const executionPolicy = snapshot({ mode: 'serial', maxConcurrent: 1 });
  function getCommand(id) {
    if (typeof id !== 'string' || !Object.hasOwn(commands, id)) throw new TypeError('Unknown operation command.');
    return commands[id];
  }
  function commandForAction(action) { return Object.hasOwn(actionCommands, action) ? getCommand(actionCommands[action]) : null; }
  /** @param {import('./commander-jobs').OperationInput} input
   * @returns {import('./commander-jobs').OperationRequest} */
  function operation(input) {
    const command = getCommand(input?.command), support = command.supportsBackgroundOperation;
    if (!support.enabled) throw new TypeError('Command does not support background operation.');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.includes('\0') || typeof input.target !== 'string' || !input.target.trim() || input.target.includes('\0')) throw new TypeError('Operation title and target are required.');
    if (!Array.isArray(input.sources) || input.sources.length < support.selection.minItems || input.sources.some(value => typeof value !== 'string' || !value || value.includes('\0'))) throw new TypeError('Operation sources are required.');
    if (input.label !== undefined && (typeof input.label !== 'string' || input.label.includes('\0'))) throw new TypeError('Operation label must be text.');
    if (input.targetLocation !== undefined && (![0, 1].includes(input.targetLocation?.pane) || typeof input.targetLocation?.tabId !== 'string' || !input.targetLocation.tabId || input.targetLocation.tabId.includes('\0'))) throw new TypeError('Operation target location is invalid.');
    return snapshot({ version: 1, command: input.command, title: input.title, target: input.target, sources: input.sources, ...(input.label === undefined ? {} : { label: input.label }), ...(input.targetLocation === undefined ? {} : { targetLocation: input.targetLocation }) });
  }
  function createQueue({ start, finish, cancel = () => {}, change = () => {} }) {
    const items = []; let sequence = 0, active = null, disposed = false;
    function advance() {
      if (disposed || active || !items.length) return;
      active = items[0]; active.state = 'running'; active.started = performance.now();
      change();
      const job = active;
      try { start(job); } catch (error) { complete(job.id, { ok: false, error: error.message }); }
    }
    function complete(id, result) {
      const job = items.find(item => item.id === id);
      if (!job || disposed || job !== active && !result.cancelled) return;
      items.splice(items.indexOf(job), 1); if (job === active) active = null;
      try { finish(job, result); } finally { change(); advance(); }
    }
    return {
      get items() { return items.slice(); }, get active() { return active; },
      add(request, run) {
        if (disposed) throw new Error('Queue is closed.');
        const validated = operation(request);
        const job = { id: `job-${Date.now()}-${++sequence}`, request: validated, command: getCommand(validated.command), run, state: 'waiting' };
        items.push(job); change(); advance(); return job;
      }, complete,
      cancel(id) {
        const job = items.find(item => item.id === id); if (!job || job.cancelling) return;
        if (job !== active) { complete(id, { cancelled: true }); return; }
        job.cancelling = true; cancel(job); change();
      },
      dispose() { disposed = true; if (active) cancel(active); items.length = 0; active = null; }
    };
  }
  function fraction(measurement) {
    if (measurement?.kind !== 'determinate' || !Number.isSafeInteger(measurement.total) || !Number.isSafeInteger(measurement.completed) || measurement.completed < 0 || measurement.total < measurement.completed) return null;
    return measurement.total === 0 ? 1 : measurement.completed / measurement.total;
  }
  function summarize(items) {
    const current = fraction(items.find(job => job.state === 'running')?.progress?.overall);
    const measurements = items.map(job => job.progress?.overall);
    if (!items.length || measurements.some(value => fraction(value) === null) || measurements.some(value => value.unit !== measurements[0].unit)) return { current, overall: null };
    const total = measurements.reduce((sum, value) => sum + value.total, 0), completed = measurements.reduce((sum, value) => sum + value.completed, 0);
    return { current, overall: Number.isSafeInteger(total) && Number.isSafeInteger(completed) ? total ? completed / total : 1 : null };
  }
  function createView({ t, getState, navigate, cancel }) {
    let currentItems = [], timer = null, reveal = null, selectedId = null, footerJobId = null;
    const footerCancel = document.querySelector('#status-cancel'), defaultCancel = footerCancel.onclick;
    const samePath = (left, right) => window.CommanderPaths.identity(left) === window.CommanderPaths.identity(right);
    const button = document.createElement('button'); button.type = 'button'; button.id = 'jobs-toggle'; button.className = 'statusbar-item';
    function ring(name, label) { const node = document.createElement('span'); node.className = 'jobs-ring'; node.dataset.jobRing = name; node.setAttribute('role', 'progressbar'); node.setAttribute('aria-label', t(label)); node.setAttribute('aria-valuemin', '0'); node.setAttribute('aria-valuemax', '100'); button.append(node); return node; }
    const currentRing = ring('current', 'Aktueller Auftrag'), overallRing = ring('overall', 'Gesamtfortschritt');
    const count = document.createElement('span'); count.className = 'jobs-count'; button.append(count);
    const panel = document.createElement('aside'); panel.id = 'jobs-center'; panel.className = 'notifications-center'; panel.hidden = true;
    const heading = document.createElement('strong'); heading.textContent = t('Aufträge'); panel.append(heading);
    const empty = document.createElement('p'); empty.textContent = t('Keine ausstehenden Aufträge');
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', t('Aufträge'));
    button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false');
    document.querySelector('#notifications-toggle').before(button); document.body.append(panel);
    function close() { panel.hidden = true; panel.classList.remove('visible'); button.setAttribute('aria-expanded', 'false'); }
    function select(job, element) {
      selectedId = job.id;
      const pane = element.closest('[data-pane]'); if (pane) { getState().active = Number(pane.dataset.pane); pane.querySelector('.list')?.focus({ preventScroll: true }); }
      close(); reveal = job.id;
      navigate(job);
      update(currentItems);
    }
    function place() { const top = button.getBoundingClientRect().bottom + 4; panel.style.top = `${top}px`; panel.style.maxHeight = `${Math.max(0, window.innerHeight - top - 12)}px`; }
    button.onclick = () => { panel.hidden = !panel.hidden; panel.classList.toggle('visible', !panel.hidden); button.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) place(); };
    const outside = event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', place);
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); button.focus(); } });
    function control(job, source, existing = null, simple = false) {
      const row = existing || document.createElement('div');
      if (!existing) {
        row.className = 'job-progress'; row.dataset.jobId = job.id;
        if (simple) row.onclick = event => { event.stopPropagation(); select(job, row); };
        const open = document.createElement('button'); open.type = 'button'; open.className = 'job-location';
        open.title = job.request.target; open.setAttribute('aria-label', `${t('Ziel')}: ${job.request.target}`);
        open.append(window.CommanderIcons.element('refresh'));
        open.onclick = event => { event.stopPropagation(); select(job, open); }; row.append(open);
        const content = document.createElement('div'); content.className = 'job-content'; content.tabIndex = 0; content.setAttribute('role', 'button');
        content.setAttribute('aria-label', `${job.request.title} · ${job.request.label || job.request.target}`);
        content.onclick = event => { event.stopPropagation(); select(job, content); };
        content.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); select(job, content); } };
        const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'job-cancel'; stop.innerHTML = window.CommanderIcons.svg('workbench', 'close'); stop.title = t('Abbrechen'); stop.setAttribute('aria-label', t('Abbrechen'));
        stop.addEventListener('pointerdown', event => {
          if (event.button !== 0 || !Number.isInteger(event.pointerId) || stop.disabled) return;
          event.stopPropagation(); stop.dataset.pressedPointer = String(event.pointerId); stop.setPointerCapture?.(event.pointerId);
        });
        for (const type of ['pointerup', 'pointercancel']) stop.addEventListener(type, () => { delete stop.dataset.pressedPointer; });
        stop.onclick = event => { event.stopPropagation(); cancel(job.id); }; row.append(content, stop);
      }
      const content = row.querySelector('.job-content'); content.setAttribute('aria-pressed', String(job.id === footerJobId)); content.replaceChildren();
      if (row.dataset.jobState !== job.state) {
        const spinner = row.querySelector('.job-location').firstElementChild;
        window.CommanderIcons.setFont(spinner, job.state === 'running' ? 'loading' : 'refresh', job.state === 'running'); row.dataset.jobState = job.state;
      }
      if (simple) {
        content.classList.add('job-summary');
        const title = document.createElement('span'); title.className = 'job-summary-title'; title.textContent = `${job.request.title} · ${job.request.label || job.request.target}`;
        const value = fraction(job.progress?.overall), percent = document.createElement('span'); percent.className = 'job-summary-percent';
        percent.textContent = job.cancelling ? t('Abbruch wird ausgeführt…') : job.state === 'waiting' ? t('Wartend') : value === null ? '—' : `${Math.floor(value * 100)}%`;
        const meter = document.createElement('span'); meter.className = 'job-summary-meter'; meter.setAttribute('role', 'progressbar');
        meter.setAttribute('aria-label', `${t('Gesamtfortschritt')}: ${job.request.title}`); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
        if (job.state === 'running' && value !== null) { meter.setAttribute('aria-valuenow', String(Math.floor(value * 100))); meter.style.setProperty('--job-progress', `${value * 100}%`); }
        else { meter.setAttribute('aria-valuetext', job.state === 'waiting' ? t('Wartend') : t('Gesamtfortschritt unbekannt')); meter.classList.toggle('indeterminate', job.state === 'running'); }
        content.append(title, percent, meter);
      } else if (job.state === 'running' && source && job.control) {
        for (const node of job.control.children) content.append(node.cloneNode(true));
        for (const node of content.querySelectorAll('[id]')) { node.classList.add(`job-${node.id}`); node.removeAttribute('id'); }
        for (const name of ['eta', 'elapsed']) { const value = content.querySelector(`.job-status-${name}`); if (value) value.textContent = document.querySelector(`#status-${name}`)?.textContent || value.textContent; }
        content.querySelectorAll('[data-status-icon]').forEach(icon => icon.remove());
        content.querySelectorAll('[aria-labelledby],[aria-describedby]').forEach(node => { node.removeAttribute('aria-labelledby'); node.removeAttribute('aria-describedby'); });
      } else { const label = document.createElement('span'); label.className = 'job-waiting-label'; label.textContent = `${t(job.state === 'running' ? 'Vorbereiten' : 'Wartend')} · ${job.request.title} · ${job.request.label || job.request.target}`; label.title = label.textContent; content.append(label); }
      row.querySelector('.job-cancel').disabled = Boolean(job.cancelling); return row;
    }
    function update(items) {
      currentItems = items;
      const state = getState(), location = state.panes[state.active].tabs[state.panes[state.active].tab];
      if (!items.some(job => job.id === selectedId)) selectedId = null;
      const local = items.filter(job => samePath(location, job.request.target));
      const visibleJobs = items.filter(job => state.panes.some(pane => samePath(pane.tabs[pane.tab], job.request.target)));
      const selected = visibleJobs.length === 1 ? visibleJobs[0] : local.find(job => job.id === selectedId) || local.find(job => job.state === 'running') || local[0];
      footerJobId = selected?.id;
      if (items.length && timer === null) timer = window.setInterval(() => update(currentItems), 1000);
      if (!items.length && timer !== null) { window.clearInterval(timer); timer = null; }
      const focused = document.activeElement.closest?.('[data-job-id]');
      const focusedJob = focused?.dataset.jobId, focusedPart = document.activeElement.classList.contains('job-cancel') ? 'job-cancel' : document.activeElement.classList.contains('job-content') ? 'job-content' : 'job-location';
      const focusedPane = document.activeElement.closest?.('[data-pane]')?.dataset.pane;
      count.textContent = String(items.length);
      button.title = t('Aufträge') + ` (${items.length})`; button.setAttribute('aria-label', button.title);
      button.classList.toggle('has-jobs', Boolean(items.length));
      const source = document.querySelector('#status-progress-region');
      const summary = summarize(items);
      for (const [node, value] of [[currentRing, summary.current], [overallRing, summary.overall]]) {
        node.classList.toggle('indeterminate', value === null && items.length > 0);
        if (value === null) { node.removeAttribute('aria-valuenow'); node.setAttribute('aria-valuetext', items.length ? t('Gesamtfortschritt unbekannt') : t('Keine ausstehenden Aufträge')); node.style.removeProperty('--job-progress'); }
        else { node.setAttribute('aria-valuenow', String(Math.floor(value * 100))); node.removeAttribute('aria-valuetext'); node.style.setProperty('--job-progress', `${value * 100}%`); }
      }
      overallRing.hidden = items.length < 2;
      const describe = value => value === null ? t('Gesamtfortschritt unbekannt') : `${Math.floor(value * 100)}%`;
      if (items.length) button.title += ` · ${t('Aktueller Auftrag')}: ${describe(summary.current)}${items.length > 1 ? ` · ${t('Gesamtfortschritt')}: ${describe(summary.overall)}` : ''}`;
      button.setAttribute('aria-label', button.title);
      const existingControls = new Map([...panel.querySelectorAll('.job-progress')].map(row => [row.dataset.jobId, row]));
      const desired = [heading, ...(items.length ? items.map(job => control(job, source, existingControls.get(job.id), true)) : [empty])];
      let cursor = panel.firstChild;
      for (const node of desired) { if (node === cursor) cursor = cursor.nextSibling; else panel.insertBefore(node, cursor); }
      for (const node of [...panel.childNodes]) if (!desired.includes(node)) node.remove();
      for (const section of document.querySelectorAll('[data-pane]')) {
        const region = section.querySelector('.pane-jobs'); if (!region) continue;
        const localJobs = items.filter(item => samePath(item.request.target, section.dataset.directory));
        const existingRows = new Map([...region.querySelectorAll('[data-job-row]')].map(row => [row.dataset.jobRow, row]));
        let cursor = region.firstChild;
        for (const job of localJobs) {
          const row = existingRows.get(job.id) || control(job, source); row.dataset.jobRow = job.id;
          if (existingRows.has(job.id)) control(job, source, row);
          if (row === cursor) cursor = cursor.nextSibling; else region.insertBefore(row, cursor);
          const stop = row.querySelector('.job-cancel');
          if (stop.dataset.pressedPointer !== undefined) stop.setPointerCapture?.(Number(stop.dataset.pressedPointer));
        }
        for (const [id, row] of existingRows) if (!localJobs.some(job => job.id === id)) row.remove();
        region.hidden = !localJobs.length;
      }
      const visible = Boolean(selected), bar = document.querySelector('#statusbar');
      bar.classList.toggle('job-context-hidden', Boolean(items.length && !visible));
      bar.classList.toggle('job-footer-pending', Boolean(selected && (selected.state !== 'running' || !selected.control)));
      if (selected) {
        bar.dataset.footerJobId = selected.id;
        const message = document.querySelector('#status-message'), metrics = document.querySelector('#status-metrics');
        if (selected.state === 'running' && selected.control) {
          message.replaceChildren(...Array.from(selected.control.querySelector('#status-message').childNodes, node => node.cloneNode(true)));
          metrics.hidden = selected.control.querySelector('#status-metrics').hidden;
          document.querySelector('#status-percent').textContent = selected.control.querySelector('#status-percent').textContent;
        } else { message.textContent = `${t(selected.state === 'running' ? 'Vorbereiten' : 'Wartend')} · ${selected.request.title} · ${selected.request.label || selected.request.target}`; metrics.hidden = true; }
        footerCancel.hidden = false; footerCancel.disabled = Boolean(selected.cancelling); footerCancel.onclick = () => cancel(selected.id);
      } else { delete bar.dataset.footerJobId; footerCancel.onclick = defaultCancel; }
      let normal = document.querySelector('#job-normal-status');
      if (!normal) { normal = document.createElement('span'); normal.id = 'job-normal-status'; document.querySelector('#statusbar').append(normal); }
      normal.hidden = !items.length || visible;
      let waiting = document.querySelector('#job-waiting-count');
      if (!waiting) { waiting = document.createElement('span'); waiting.id = 'job-waiting-count'; document.querySelector('#statusbar').append(waiting); }
      const waitingCount = items.filter(job => job.state === 'waiting' && job.id !== selected?.id).length;
      waiting.hidden = !visible || !waitingCount; waiting.textContent = `+${waitingCount} ${t('Wartend')}`;
      normal.textContent = t('Verzeichnis geöffnet: {path}', { path: state.panes[state.active].tabs[state.panes[state.active].tab] });
      if (reveal) { const row = document.querySelector(`.pane.active [data-job-row="${reveal}"]`); if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.add('job-revealed'); reveal = null; } }
      if (focusedJob) {
        const surface = focusedPane === undefined ? panel : document.querySelector(`[data-pane="${focusedPane}"]`);
        surface?.querySelector(`[data-job-id="${focusedJob}"] .${focusedPart}`)?.focus({ preventScroll: true });
      }
    }
    return { update, dispose() { if (timer !== null) window.clearInterval(timer); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); footerCancel.onclick = defaultCancel; document.querySelector('#statusbar').classList.remove('job-footer-pending', 'job-context-hidden'); delete document.querySelector('#statusbar').dataset.footerJobId; button.remove(); panel.remove(); document.querySelector('#job-normal-status')?.remove(); document.querySelector('#job-waiting-count')?.remove(); document.querySelectorAll('.pane-jobs').forEach(region => { region.replaceChildren(); region.hidden = true; }); } };
  }
  return { commands, actionCommands, getCommand, commandForAction, operation, executionPolicy, createQueue, createView, summarize };
});
