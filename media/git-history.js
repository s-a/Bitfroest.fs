(() => {
  'use strict';
  const host = window.acquireVsCodeApi(), model = window.GitHistoryModel;
  const $ = value => document.querySelector(value);
  let english = true, generation = 0, selection = 0, selected = null, commits = [], hasMore = false, loading = true, top = 43, middle = 12;
  const activities = new Map();
  const text = (de, en) => english ? en : de;
  const labels = { graph: ['Graph', 'Graph'], subject: ['Meldung', 'Message'], author: ['Autor', 'Author'], date: ['Datum', 'Date'], path: ['Pfad', 'Path'], extension: ['Erweiterung', 'Extension'], status: ['Status', 'Status'], added: ['Zeilen hinzugefügt', 'Lines added'], removed: ['Zeilen entfernt', 'Lines removed'] };
  const send = (type, data = {}) => host.postMessage({ type, generation, ...data });
  function cell(row, value, name) { const element = document.createElement('td'); element.textContent = value ?? '—'; if (name) element.className = name; row.append(element); return element; }
  function date(value) { if (!value || Number.isNaN(Date.parse(value))) return '—'; return new Date(value).toLocaleString(english ? 'en' : 'de'); }
  function status(message, error = false) { $('#activity').textContent = message; $('#activity').dataset.error = String(error); }
  function choose(hash, focus = false) {
    if (selected === hash) return;
    selected = hash; selection++; $('#file-rows').replaceChildren(); $('#message').textContent = ''; $('#commit-info').textContent = '';
    for (const row of document.querySelectorAll('[data-commit]')) { row.setAttribute('aria-selected', String(row.dataset.commit === hash)); row.tabIndex = row.dataset.commit === hash ? 0 : -1; if (focus && row.dataset.commit === hash) row.focus(); }
    send('history-select', { hash, selection });
  }
  const ns = 'http://www.w3.org/2000/svg';
  function svgNode(tag, attrs) { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; }
  function draw(graph, width) {
    const svg = svgNode('svg', { width: Math.max(28, width * 18 + 12), height: 28, 'aria-hidden': true });
    const x = lane => lane * 18 + 12;
    for (const edge of graph.edges) {
      svg.append(svgNode('path', { d: edge.pass ? `M ${x(edge.from)} 0 L ${x(edge.from)} 14 L ${x(edge.to)} 28` : `M ${x(edge.from)} 14 L ${x(edge.to)} 28`, stroke: 'currentColor', ...(edge.external ? { 'stroke-dasharray': '2 2' } : {}), class: `graph-line lane-${edge.to % 5}` }));
    }
    if (graph.incoming) svg.append(svgNode('path', { d: `M ${x(graph.lane)} 0 V 14`, stroke: 'currentColor', class: `graph-line lane-${graph.lane % 5}` }));
    svg.append(svgNode(graph.parents.length > 1 ? 'rect' : 'circle', graph.parents.length > 1
      ? { x: x(graph.lane) - 4, y: 10, width: 8, height: 8, fill: 'currentColor', class: `graph-dot lane-${graph.lane % 5}` }
      : { cx: x(graph.lane), cy: 14, r: 4, fill: 'currentColor', class: `graph-dot lane-${graph.lane % 5}` }));
    return svg;
  }
  function renderCommits() {
    const body = $('#commit-rows'), fragment = document.createDocumentFragment(), graph = model.graphRows(commits), width = Math.max(1, ...graph.map(g => g.width));
    for (const [index, commit] of commits.entries()) {
      const row = document.createElement('tr'); row.dataset.commit = commit.hash; row.tabIndex = commit.hash === selected || !selected && index === 0 ? 0 : -1; row.setAttribute('aria-selected', String(commit.hash === selected));
      cell(row, '', 'graph').append(draw(graph[index], width));
      cell(row, commit.message.split('\n')[0], 'subject').title = commit.message;
      cell(row, commit.author); cell(row, date(commit.date)); cell(row, commit.hash.slice(0, 8)).title = commit.hash;
      fragment.append(row);
    }
    body.replaceChildren(fragment);
    if (!selected && commits[0]) choose(commits[0].hash);
  }
  function more() { if (hasMore && !loading) { loading = true; send('history-more'); } }
  $('#commits').addEventListener('scroll', () => { const node = $('#commits'); if (node.scrollTop + node.clientHeight >= node.scrollHeight - 100) more(); });
  document.addEventListener('click', event => {
    const row = event.target.closest('[data-commit]'); if (row) choose(row.dataset.commit);
    const file = event.target.closest('[data-file]');
    if (file) for (const node of file.parentElement.children) { node.setAttribute('aria-selected', String(node === file)); node.tabIndex = node === file ? 0 : -1; }
  });
  function openFile(row) { if (row && selected) send('history-diff', { hash: selected, selection, index: Number(row.dataset.file) }); }
  $('#files').addEventListener('dblclick', event => openFile(event.target.closest('[data-file]')));
  document.addEventListener('keydown', event => {
    if (event.key === 'F5') { event.preventDefault(); loading = true; send('history-refresh'); return; }
    const row = event.target.closest('[data-commit], [data-file]'); if (!row) return;
    if (event.key === 'Enter' && row.hasAttribute('data-file')) { event.preventDefault(); openFile(row); return; }
    const rows = [...row.parentElement.children], index = rows.indexOf(row);
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
    if (next === null) return; event.preventDefault();
    if (next >= rows.length && row.hasAttribute('data-commit')) { more(); return; }
    const target = rows[Math.max(0, Math.min(next, rows.length - 1))];
    if (target.hasAttribute('data-commit')) choose(target.dataset.commit, true);
    else { rows.forEach(node => { node.tabIndex = node === target ? 0 : -1; node.setAttribute('aria-selected', String(node === target)); }); target.focus(); }
  });
  function resize(separator, value) {
    if (separator.dataset.split === 'top') top = Math.max(20, Math.min(65, value));
    else middle = Math.max(8, Math.min(25, value - top));
    document.documentElement.style.setProperty('--top', top); document.documentElement.style.setProperty('--middle', middle); document.documentElement.style.setProperty('--bottom', 100 - top - middle);
    $('#layout').style.gridTemplateRows = `minmax(80px, ${top}fr) 5px minmax(50px, ${middle}fr) 5px minmax(90px, ${100 - top - middle}fr)`;
    document.querySelector('[data-split="top"]').setAttribute('aria-valuenow', top);
    document.querySelector('[data-split="bottom"]').setAttribute('aria-valuenow', top + middle);
    document.querySelector('[data-split="bottom"]').setAttribute('aria-valuemin', top + 8);
    document.querySelector('[data-split="bottom"]').setAttribute('aria-valuemax', top + 25);
  }
  for (const separator of document.querySelectorAll('[data-split]')) {
    separator.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); resize(separator, Number(separator.getAttribute('aria-valuenow')) + (event.key === 'ArrowDown' ? 2 : -2)); });
    separator.addEventListener('pointerdown', event => {
      event.preventDefault(); separator.setPointerCapture(event.pointerId);
      const move = event => { const bounds = $('#layout').getBoundingClientRect(); if (bounds.height) resize(separator, (event.clientY - bounds.top) / bounds.height * 100); };
      const finish = () => { separator.removeEventListener('pointermove', move); separator.removeEventListener('pointerup', finish); separator.removeEventListener('pointercancel', finish); };
      separator.addEventListener('pointermove', move); separator.addEventListener('pointerup', finish); separator.addEventListener('pointercancel', finish);
    });
  }
  window.addEventListener('message', event => {
    const data = event.data; if (!data || typeof data.type !== 'string') return;
    if (data.type === 'history-init') {
      english = data.english; document.documentElement.lang = english ? 'en' : 'de'; $('#target').textContent = data.target; $('#target').title = data.target; $('#branch').textContent = data.branch;
      $('#notice').textContent = data.notice; $('#notice').title = data.notice;
      for (const node of document.querySelectorAll('[data-label]')) node.textContent = labels[node.dataset.label][english ? 1 : 0];
      $('#commits').setAttribute('aria-label', text('Commits', 'Commits')); $('#files').setAttribute('aria-label', text('Geänderte Dateien', 'Changed files')); $('#message-pane').setAttribute('aria-label', text('Commitmeldung', 'Commit message'));
      document.querySelector('[data-split="top"]').setAttribute('aria-label', text('Höhe der Commitliste', 'Commit list height')); document.querySelector('[data-split="bottom"]').setAttribute('aria-label', text('Höhe der Dateiliste', 'File list height'));
      return;
    }
    if (data.generation < generation) return;
    if (data.type === 'history-page' && Array.isArray(data.commits)) {
      if (data.reset) { commits = []; selected = null; selection = 0; activities.clear(); $('#message').textContent = ''; $('#commit-info').textContent = ''; $('#file-rows').replaceChildren(); }
      generation = data.generation; commits.push(...data.commits); hasMore = data.hasMore; loading = false;
      renderCommits(); status(commits.length ? `${commits.length} ${text('Commits geladen', 'commits loaded')}${hasMore ? ' …' : ''}` : text('Keine Commits für diesen Pfad.', 'No commits for this path.')); return;
    }
    if (data.generation !== generation && data.type !== 'history-activity') return;
    if (data.type === 'history-details' && data.selection === selection && data.commit.hash === selected) {
      $('#message').textContent = data.commit.message; $('#commit-info').textContent = `${data.commit.hash} · ${data.commit.author} · ${date(data.commit.date)}`;
      const fragment = document.createDocumentFragment();
      for (const [index, file] of data.files.entries()) {
        const row = document.createElement('tr'); row.dataset.file = index; row.tabIndex = index === 0 ? 0 : -1; row.setAttribute('aria-selected', 'false');
        const name = file.originalPath !== file.path ? `${file.originalPath} → ${file.path}` : file.path;
        cell(row, name).title = name; cell(row, /\.[^./]+$/.exec(file.path)?.[0] || ''); cell(row, model.status(file.status, english)); cell(row, file.insertions); cell(row, file.deletions); fragment.append(row);
      }
      $('#file-rows').replaceChildren(fragment); return;
    }
    if (data.type === 'history-error' && (data.selection === undefined || data.selection === selection)) { if (data.area === 'log') loading = false; status(data.message, true); }
    if (data.type === 'history-activity' && data.progress?.version === 1 && data.progress.plan?.id && ['running', 'complete', 'error', 'cancelled'].includes(data.progress.plan.state)) {
      if (data.generation > generation) activities.clear();
      generation = data.generation;
      if (data.progress.plan.state === 'running') activities.set(data.progress.plan.id, data.progress.phase); else activities.delete(data.progress.plan.id);
      $('#layout').setAttribute('aria-busy', String(activities.size > 0));
      const phase = [...activities.values()].at(-1);
      if (phase) status(phase === 'log' ? text('Commits werden geladen…', 'Loading commits…') : phase === 'changes' ? text('Dateiänderungen werden geladen…', 'Loading file changes…') : text('Diff wird geöffnet…', 'Opening diff…'));
      else if ($('#activity').dataset.error !== 'true') status(`${commits.length} ${text('Commits geladen', 'commits loaded')}`);
    }
  });
  send('history-ready');
})();
