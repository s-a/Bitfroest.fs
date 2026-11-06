(function (root) {
  'use strict';
  root.BitfroestXray = { create };
  function create({ host, t, state, currentPath, files, settings, task, restoreFocus, compact, notify, beforeStart, isArchive, preview }) {
    const container = document.querySelector('#panes'), Progress = root.BitfroestProgress;
    let source = null, mode = 'off', timer = null, request = null, loadedId = null, sequence = 0, identity = null, sourceContext = null, editor = null, element = null, previousColumns = '';
    let viewedFile = null, displayedText;
    const context = pane => JSON.stringify([source, pane.tabStates?.[pane.tab]?.id, currentPath(pane)]);
    const instance = [...crypto.getRandomValues(new Uint8Array(8))].map(v => v.toString(16).padStart(2, '0')).join('');
    const steps = ['inspect', 'open', 'initial-check', 'read', 'final-check', 'encoding', 'decode', 'close', 'render'];
    const labels = { off: 'X-Ray aus', click: 'X-Ray bei Klick', hover: 'X-Ray Ultra: Vorschau beim Darüberfahren' };
    const icons = { off: 'eye-slash-fill', click: 'eye-fill', hover: 'eye' };
    function cancel(keepEditor = false) {
      clearTimeout(timer); timer = null;
      if (loadedId) { host?.postMessage({ type: 'xray-cancel', requestId: loadedId }); loadedId = null; }
      if (request) { host?.postMessage({ type: 'xray-cancel', requestId: request.id }); request.plan.terminate('cancelled'); task(request.id, null, null); request = null; }
      if (!keepEditor) { editor?.dispose(); editor = null; displayedText = undefined; }
    }
    function message(text) {
      editor?.dispose(); editor = null; displayedText = undefined;
      element.replaceChildren();
      const status = document.createElement('p'); status.role = 'status'; status.textContent = text; element.append(status);
    }
    function mount() {
      if (source !== null) container.dataset.xraySource = String(source);
      for (const side of [0, 1]) compact(side, side === source);
      document.querySelectorAll('.pane-metrics').forEach(metrics => { metrics.hidden = Number(metrics.closest('[data-pane]').dataset.pane) === source; });
      document.querySelectorAll('[data-xray-toggle]').forEach(button => {
        const active = Number(button.closest('[data-pane]').dataset.pane) === source ? mode : 'off';
        if (button.dataset.mode !== active) button.innerHTML = root.BitfroestIcons.svg('xray', icons[active]);
        button.dataset.mode = active; button.title = t(labels[active]); button.setAttribute('aria-label', t(labels[active])); button.setAttribute('aria-pressed', String(active !== 'off'));
      });
      if (source === null) return;
      const section = container.querySelector(`[data-pane="${1 - source}"]`);
      section.classList.add('has-xray');
      if (!element) { element = document.createElement('section'); element.dataset.xray = ''; element.tabIndex = 0; element.setAttribute('aria-label', 'X-Ray'); }
      if (!section.contains(element)) section.append(element);
      container.dataset.xraySource = String(source);
      container.style.gridTemplateColumns = source === 0 ? 'minmax(0, 2fr) minmax(0, 3fr)' : 'minmax(0, 3fr) minmax(0, 2fr)';
    }
    function stop(focus = false) {
      if (source === null) return;
      const oldSource = source;
      cancel(); identity = null; viewedFile = null; sourceContext = null; source = null; mode = 'off';
      element?.remove(); element = null;
      container.querySelectorAll('.has-xray').forEach(section => section.classList.remove('has-xray'));
      delete container.dataset.xraySource; container.style.gridTemplateColumns = previousColumns; preview?.release('xray');
      mount(); if (focus && oldSource !== null) restoreFocus(oldSource);
    }
    function show(file) {
      if (source === null) return;
      const pane = state().panes[source], path = currentPath(pane);
      const nextContext = context(pane);
      const fileKey = file && JSON.stringify([file.id, file.fsSource, file.name]);
      const key = JSON.stringify([nextContext, fileKey, file?.type, file?.fileRevision, file?.size, file?.mtimeMs, file?.date, file?.time]);
      if (key === identity) return;
      const keepEditor = Boolean(editor && fileKey && viewedFile?.key === fileKey && sourceContext === nextContext);
      cancel(keepEditor); identity = key; sourceContext = nextContext; viewedFile = file && { key: fileKey, id: file.id }; mount();
      if (!file || file.type === 'folder' || file.type === 'archive' || file.archive || isArchive(path)) { message(t('Keine Textvorschau verfügbar.')); return; }
      const configuredLimit = settings().xrayMaxFileSizeMiB;
      const maxBytes = (Number.isInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 100 ? configuredLimit : 5) * 1048576;
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) { message(t('X-Ray: Größenlimit überschritten.')); return; }
      const title = document.createElement('div'); title.className = 'xray-title'; title.textContent = file.name;
      const content = document.createElement('div'); content.className = 'xray-editor';
      function display(text) {
        if (editor && displayedText === text) return;
        const saved = editor?.saveViewState?.();
        const focused = element.contains(document.activeElement) && element !== document.activeElement;
        editor?.dispose(); editor = null;
        element.replaceChildren(title, content);
        if (!root.BitfroestXrayEditor) { message(t('X-Ray konnte nicht geladen werden.')); return; }
        editor = root.BitfroestXrayEditor.create(content, text, file.name, {
          copyLabel: t('Kopieren'),
          onCopy: text => { if (loadedId && typeof text === 'string') host?.postMessage({ type: 'xray-copy', requestId: loadedId, text }); },
          onOpenLine: line => { if (loadedId) host?.postMessage({ type: 'xray-open-line', requestId: loadedId, line }); }
        });
        displayedText = text;
        if (saved) editor.restoreViewState?.(saved);
        if (focused) editor.focus?.();
      }
      if (!host || !state().realFilesystem) { display(file.content || ''); return; }
      const id = `xray-${instance}-${++sequence}`;
      const plan = Progress.statusPlan({ id, startedAt: performance.now(), steps, mode: 'work' });
      const blocks = Array.from({ length: Math.ceil(file.size / root.BitfroestLister.readBlockSize) }, (_, index) => `block-${index * root.BitfroestLister.readBlockSize}`);
      const readSteps = blocks.length ? plan.append('read', blocks) : [];
      plan.start('inspect');
      request = { id, key, file, display, plan, steps: new Set([...steps, ...readSteps]) };
      if (!keepEditor) message(t('Datei wird geöffnet…'));
      plan.update('inspect', Progress.event({ phase: 'xray-inspect', overall: Progress.unknown('bytes', 0, 'remaining-work-unknown'), current: Progress.unknown('bytes', 0, 'remaining-work-unknown') }));
      task(id, t('Datei wird geöffnet…'), plan.snapshot());
      host.postMessage({ type: 'xray-open', requestId: id, path: file.fsSource, snapshotId: state().snapshotId, expectedSize: file.size });
    }
    function sync() {
      if (source === null) return;
      mount();
      const pane = state().panes[source], file = files(pane).find(value => value.id === pane.cursor);
      if (mode === 'click') show(file);
      else show(sourceContext === context(pane) && viewedFile ? files(pane).find(value => value.id === viewedFile.id) : undefined);
    }
    function click(event) {
      const button = event.target.closest('[data-xray-toggle]'); if (!button) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const side = Number(button.closest('[data-pane]').dataset.pane);
      if (source === side && mode === 'hover') { stop(true); return; }
      if (source !== side) { if (source !== null) stop(); beforeStart(); previousColumns = container.style.gridTemplateColumns; source = side; mode = 'click'; }
      else mode = 'hover';
      mount(); restoreFocus(side); sync();
    }
    function hover(event) {
      if (mode !== 'hover') return;
      const row = event.target.closest('[data-file-row][data-id]');
      if (!row || Number(row.closest('[data-pane]').dataset.pane) !== source || row.contains(event.relatedTarget)) return;
      clearTimeout(timer);
      const pane = state().panes[source], path = currentPath(pane), snapshot = state().snapshotId;
      timer = setTimeout(() => { timer = null; if (source !== null && state().panes[source] === pane && currentPath(pane) === path && state().snapshotId === snapshot) show(files(pane).find(file => String(file.id) === row.dataset.id)); }, 200);
    }
    function leave(event) { if (event.target.closest('[data-file-row]') && !event.target.closest('[data-file-row]').contains(event.relatedTarget)) { clearTimeout(timer); timer = null; } }
    function key(event) {
      if (source !== null && event.key === 'Escape' && event.target.closest('[data-xray]')) { event.preventDefault(); event.stopImmediatePropagation(); stop(true); }
    }
    function receive(event) {
      const data = event.data;
      if (data?.type === 'xray-action-result' && data.requestId === loadedId) { if (!data.ok) notify(data.error, 'error'); return; }
      if (!request || request.id !== data?.requestId) return;
      const pane = state().panes[source];
      if (sourceContext !== context(pane)) { cancel(); identity = null; viewedFile = null; message(t('Keine Textvorschau verfügbar.')); return; }
      if (data.type === 'xray-step') {
        if (!request.steps.has(data.step) || data.step === 'render' || !['start', 'complete'].includes(data.state)) return;
        try { request.plan[data.state === 'start' ? 'start' : 'complete'](data.step); } catch { return; }
        task(request.id, t('Datei wird geöffnet…'), request.plan.snapshot());
      } else if (data.type === 'xray-progress') {
        let progress; try { progress = Progress.read(data.progress); } catch { return; }
        try { request.plan.update('read', progress); } catch { return; }
        task(request.id, t('Datei wird geöffnet…'), request.plan.snapshot());
      } else if (data.type === 'xray-result') {
        const active = request; request = null;
        if (identity !== active.key) return;
        if (data.ok) {
          try { loadedId = active.id; active.plan.start('render'); active.display(data.text); active.plan.complete('render'); }
          catch (error) { active.plan.terminate('error'); host?.postMessage({ type: 'xray-cancel', requestId: active.id }); loadedId = null; message(t('X-Ray konnte nicht geladen werden.')); notify(error.message, 'error'); }
        }
        else { active.plan.terminate('error'); message(data.error || t('Keine Textvorschau verfügbar.')); }
        task(active.id, null, null);
      }
    }
    container.addEventListener('click', click, true); container.addEventListener('mouseover', hover); container.addEventListener('mouseout', leave);
    container.addEventListener('contextmenu', event => {
      if (!event.target.closest('[data-xray-toggle]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); stop(true);
    }, true);
    document.addEventListener('keydown', key, true); window.addEventListener('message', receive);
    window.addEventListener('blur', () => { clearTimeout(timer); timer = null; });
    window.addEventListener('pagehide', () => stop(), { once: true });
    return { mount, sync, stop, has: side => source !== null && side === 1 - source };
  }
})(globalThis);
