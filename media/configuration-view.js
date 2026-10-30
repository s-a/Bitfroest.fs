(() => {
  'use strict';
  const host = acquireVsCodeApi(), model = window.ConfigurationModel;
  const $ = selector => document.querySelector(selector);
  let t = window.CommanderI18n.create('de').t;
  let data = null, scope = 'user', revision, section = 'favorites', selected = null, dirty = false, saving = false, pendingBrowse = null;
  const expanded = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const error = value => { $('#configuration-error').textContent = value ? t(value) : ''; };
  const status = value => { $('#configuration-status').textContent = value ? t(value) : ''; };
  const current = () => data?.favorites.find(item => item.id === selected);
  function setSaving(value) {
    saving = value; $('main').inert = value; $('#scope').disabled = value;
    $('[data-save]').disabled = value; $('[data-discard]').disabled = value;
  }
  setSaving(true);
  for (const type of ['click', 'input', 'change', 'dragstart', 'drop', 'keydown']) document.addEventListener(type, event => { if ((saving || !data) && event.target.closest('main')) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  function modified() { dirty = true; status('Ungespeicherte Änderungen'); error(''); }
  function setSection(value) {
    section = value === 'columns' ? 'columns' : 'favorites';
    for (const button of document.querySelectorAll('[data-section]')) { button.setAttribute('aria-selected', String(button.dataset.section === section)); button.tabIndex = button.dataset.section === section ? 0 : -1; }
    $('#favorites-section').hidden = section !== 'favorites'; $('#columns-section').hidden = section !== 'columns';
  }
  function isDescendant(id, parent) {
    let node = data.favorites.find(item => item.id === id);
    while (node) { if (node.id === parent) return true; node = data.favorites.find(item => item.id === node.parent); }
    return false;
  }
  function renderTree() {
    const tree = $('#favorite-tree'); tree.replaceChildren();
    function append(parent, list) {
      for (const node of data.favorites.filter(item => item.parent === parent)) {
        const item = document.createElement('li'); item.dataset.node = node.id; item.setAttribute('role', 'treeitem'); item.setAttribute('aria-selected', String(selected === node.id)); item.tabIndex = selected === node.id ? 0 : -1; item.draggable = true;
        const row = document.createElement('span'); row.className = 'tree-row'; row.textContent = `${node.type === 'group' ? expanded.has(node.id) ? '▾ ' : '▸ ' : '☆ '}${node.name}`; item.append(row);
        if (node.type === 'group') {
          item.setAttribute('aria-expanded', String(expanded.has(node.id)));
          if (expanded.has(node.id)) { const children = document.createElement('ul'); children.setAttribute('role', 'group'); append(node.id, children); item.append(children); }
        }
        list.append(item);
      }
    }
    append(null, tree); $('#empty-favorites').hidden = data.favorites.length > 0;
    for (const button of document.querySelectorAll('[data-remove],[data-move]')) button.disabled = !current();
  }
  function renderDetails() {
    const node = current(), form = $('#favorite-details'); form.hidden = !node;
    if (!node) return;
    $('#favorite-name').value = node.name;
    $('[data-directory-fields]').hidden = node.type === 'group';
    $('#favorite-path').required = node.type === 'favorite';
    $('#favorite-path').value = node.path || ''; $('#favorite-target').value = node.target || '';
    const select = $('#favorite-parent'); select.replaceChildren(new Option(t('Hauptebene'), ''));
    function append(parent, depth) {
      for (const group of data.favorites.filter(item => item.type === 'group' && item.parent === parent)) {
        if (isDescendant(group.id, node.id)) continue;
        select.add(new Option(`${'— '.repeat(depth)}${group.name}`, group.id)); append(group.id, depth + 1);
      }
    }
    append(null, 0); select.value = node.parent || '';
  }
  function renderColumns() {
    const body = $('#column-rows'); body.replaceChildren();
    data.columns.forEach((column, index) => {
      const definition = window.CommanderColumnSettings.catalog.find(item => item.id === column.id);
      const row = document.createElement('tr'); row.dataset.columnRow = column.id;
      const cell = element => { const td = document.createElement('td'); if (typeof element === 'string') td.textContent = element; else td.append(element); row.append(td); };
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.visible = ''; checkbox.checked = column.visible; checkbox.setAttribute('aria-label', `${t('Sichtbar')}: ${t(definition.title)}`); checkbox.onchange = () => { column.visible = checkbox.checked; modified(); }; cell(checkbox);
      cell(t(definition.title));
      const title = document.createElement('input'); title.type = 'text'; title.dataset.title = ''; title.value = column.title; title.placeholder = t(definition.title); title.setAttribute('aria-label', `${t('Überschrift')}: ${t(definition.title)}`); title.oninput = () => { column.title = title.value; modified(); }; cell(title);
      const widths = document.createElement('select'); widths.dataset.width = ''; widths.setAttribute('aria-label', `${t('Breite (Pixel)')}: ${t(definition.title)}`);
      for (const width of [...new Set([64, 72, 80, 88, 96, 120, 154, 160, 200, 260, 320, 400, 600, 800, 1200, 1600, column.width])].sort((a, b) => a - b)) widths.add(new Option(String(width), String(width)));
      widths.value = String(column.width); widths.onchange = () => { column.width = Number(widths.value); modified(); }; cell(widths);
      const alignment = document.createElement('select'); alignment.dataset.alignment = ''; alignment.setAttribute('aria-label', `${t('Ausrichtung')}: ${t(definition.title)}`);
      for (const [value, label] of [['left', 'Linksbündig'], ['right', 'Rechtsbündig'], ['center', 'Zentriert']]) alignment.add(new Option(t(label), value));
      alignment.value = column.align; alignment.onchange = () => { column.align = alignment.value; modified(); }; cell(alignment);
      const actions = document.createElement('span');
      for (const direction of [-1, 1]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = direction < 0 ? '↑' : '↓'; button.setAttribute('aria-label', `${t(direction < 0 ? 'Nach oben' : 'Nach unten')}: ${t(definition.title)}`); button.disabled = index + direction < 0 || index + direction >= data.columns.length;
        button.onclick = () => { [data.columns[index], data.columns[index + direction]] = [data.columns[index + direction], data.columns[index]]; modified(); renderColumns(); document.querySelectorAll(`[data-column-row="${column.id}"] button`)[direction < 0 ? 0 : 1]?.focus(); }; actions.append(button);
      }
      cell(actions); body.append(row);
    });
  }
  function render() { renderTree(); renderDetails(); renderColumns(); setSection(section); }
  function select(id, focus = false) { selected = id; renderTree(); renderDetails(); if (focus) [...document.querySelectorAll('[data-node]')].find(item => item.dataset.node === id)?.focus(); }
  function add(type) {
    const node = current(), parent = node?.type === 'group' ? node.id : node?.parent || null;
    const item = { id: crypto.randomUUID(), type, name: t(type === 'group' ? 'Neue Gruppe' : 'Neuer Favorit'), parent };
    if (type === 'favorite') Object.assign(item, { path: '', target: '' });
    data.favorites.push(item); if (parent) expanded.add(parent); expanded.add(item.id); modified(); select(item.id); $('#favorite-name').focus(); $('#favorite-name').select();
  }
  $('[data-add-group]').onclick = () => add('group'); $('[data-add-favorite]').onclick = () => add('favorite');
  $('[data-remove]').onclick = () => { const node = current(); if (!node) return; data.favorites = data.favorites.filter(item => !isDescendant(item.id, node.id)); selected = data.favorites[0]?.id || null; modified(); renderTree(); renderDetails(); };
  $('#favorite-name').oninput = event => { if (current()) { current().name = event.target.value; modified(); renderTree(); } };
  for (const field of ['path', 'target']) $(`#favorite-${field}`).oninput = event => { if (current()) { current()[field] = event.target.value; modified(); } };
  $('#favorite-parent').onchange = event => {
    try { data.favorites = model.moveFavorite(data.favorites, selected, event.target.value); if (event.target.value) expanded.add(event.target.value); modified(); renderTree(); } catch (failure) { error(failure.message); renderDetails(); }
  };
  for (const button of document.querySelectorAll('[data-browse]')) button.onclick = () => {
    if (!current()) return;
    pendingBrowse = { requestId: crypto.randomUUID(), scope, id: selected, field: button.dataset.browse };
    host.postMessage({ type: 'configuration-browse', ...pendingBrowse });
  };
  for (const button of document.querySelectorAll('[data-move]')) button.onclick = () => {
    const node = current(); if (!node) return;
    const siblings = data.favorites.filter(item => item.parent === node.parent), index = siblings.indexOf(node), direction = Number(button.dataset.move), next = siblings[index + direction];
    if (!next) return;
    const a = data.favorites.indexOf(node), b = data.favorites.indexOf(next); [data.favorites[a], data.favorites[b]] = [data.favorites[b], data.favorites[a]]; modified(); renderTree();
  };
  $('#favorite-tree').onclick = event => { const item = event.target.closest('[data-node]'); if (item) select(item.dataset.node, true); };
  $('#favorite-tree').ondblclick = event => { const item = event.target.closest('[data-node]'); if (item && current()?.type === 'group') { if (expanded.has(item.dataset.node)) expanded.delete(item.dataset.node); else expanded.add(item.dataset.node); select(item.dataset.node, true); } };
  $('#favorite-tree').onkeydown = event => {
    const node = current(), rows = [...document.querySelectorAll('[data-node]')], index = rows.findIndex(item => item.dataset.node === selected);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); if (rows[next]) select(rows[next].dataset.node, true); }
    if (node?.type === 'group' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); if (event.key === 'ArrowRight') expanded.add(node.id); else expanded.delete(node.id); select(node.id, true); }
  };
  $('#favorite-tree').ondragstart = event => { const item = event.target.closest('[data-node]'); if (item) { event.dataTransfer.setData('application/x-favorite', item.dataset.node); event.dataTransfer.effectAllowed = 'move'; } };
  $('#favorite-tree').ondragover = event => { if ([...event.dataTransfer.types].includes('application/x-favorite')) event.preventDefault(); };
  $('#favorite-tree').ondrop = event => {
    event.preventDefault(); const id = event.dataTransfer.getData('application/x-favorite'), destination = data.favorites.find(item => item.id === event.target.closest('[data-node]')?.dataset.node);
    if (!id || id === destination?.id) return;
    try { data.favorites = model.moveFavorite(data.favorites, id, destination?.type === 'group' ? destination.id : destination?.parent, destination?.type === 'favorite' ? destination.id : undefined); if (destination?.type === 'group') expanded.add(destination.id); modified(); select(id, true); } catch (failure) { error(failure.message); }
  };
  for (const button of document.querySelectorAll('[data-section]')) {
    button.onclick = () => setSection(button.dataset.section);
    button.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setSection(section === 'favorites' ? 'columns' : 'favorites'); $(`[data-section="${section}"]`).focus(); } };
  }
  $('#scope').onchange = event => { if (dirty || saving) { event.target.value = scope; error('Änderungen zuerst speichern oder verwerfen.'); return; } host.postMessage({ type: 'configuration-scope', scope: event.target.value }); };
  $('#favorite-details').onsubmit = event => event.preventDefault();
  $('[data-discard]').onclick = () => { if (!saving) host.postMessage({ type: 'configuration-reload' }); };
  $('[data-save]').onclick = () => {
    if (!data || saving) return;
    try { model.validateFavorites(data.favorites); model.validateColumns(data.columns); } catch (failure) { error(failure.message); return; }
    setSaving(true); pendingBrowse = null; error(''); status('Speichern…');
    host.postMessage({ type: 'configuration-save', scope, revision, data: clone(data) });
  };
  document.addEventListener('keydown', event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); $('[data-save]').click(); } });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'configuration-state') {
      data = clone(message.data); scope = message.scope; revision = message.revision; t = window.CommanderI18n.create(message.language).t; section = message.section; dirty = false; pendingBrowse = null; setSaving(false);
      for (const element of document.querySelectorAll('[data-text]')) element.textContent = t(element.dataset.text);
      document.documentElement.lang = /^de/.test(message.language) ? 'de' : 'en';
      $('#scope').value = scope; $('#scope option[value="workspace"]').disabled = !message.workspace;
      selected = data.favorites[0]?.id || null; expanded.clear(); data.favorites.filter(item => item.type === 'group').forEach(item => expanded.add(item.id));
      $('[data-save]').disabled = false; $('[data-discard]').disabled = false; error(''); status(''); render();
    } else if (message?.type === 'configuration-section') setSection(message.section);
    else if (message?.type === 'configuration-saved') { data = clone(message.data); revision = message.revision; dirty = false; setSaving(false); render(); status('Gespeichert'); error(''); $('[data-save]').focus(); }
    else if (message?.type === 'configuration-error') { setSaving(false); error(message.error); status(dirty ? 'Ungespeicherte Änderungen' : ''); }
    else if (message?.type === 'configuration-browsed') {
      if (!pendingBrowse || pendingBrowse.requestId !== message.requestId || pendingBrowse.scope !== scope || message.scope !== scope || saving) return;
      pendingBrowse = null;
      const node = data.favorites.find(item => item.id === message.id); if (node?.type === 'favorite' && ['path', 'target'].includes(message.field)) { node[message.field] = message.value; modified(); if (node.id === selected) renderDetails(); }
    }
    else if (message?.type === 'configuration-changed') { if (dirty || saving) error('Die Konfiguration wurde außerhalb dieses Editors geändert. Bitte neu laden.'); else host.postMessage({ type: 'configuration-reload' }); }
  });
  host.postMessage({ type: 'configuration-ready' });
})();
