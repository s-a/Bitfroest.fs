(() => {
  'use strict';
  window.CommanderStartupResource?.step('initializing');
  const paths = window.CommanderPaths;
  /** @type {typeof import('./commander-progress')} */
  const Progress = window.CommanderProgress;
  const displayPath = value => paths.displayPath(value);
  const inputPath = (value, base) => paths.normalizePath(value, { base, input: true, platform: document.body.dataset.platform });
  document.addEventListener('keydown', event => {
    event.stopPropagation();
    const editing = event.target.closest('input,textarea,select,[contenteditable="true"]');
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    const textEdit = editing && (
      !modified && !/^F\d+$/.test(event.key) || event.isComposing || event.getModifierState('AltGraph') ||
      event.ctrlKey && event.altKey && !event.metaKey && event.key.length === 1 ||
      !event.altKey && (event.ctrlKey || event.metaKey) &&
        (['a', 'c', 'x', 'v', 'z', 'y'].includes(event.key.toLowerCase()) || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete'].includes(event.key))
    );
    if ((modified || /^F\d+$/.test(event.key)) && !textEdit) event.preventDefault();
  });
  document.addEventListener('keyup', event => event.stopPropagation());
  const { language, t, ui, count } = window.CommanderI18n.create(document.body.dataset.language || document.documentElement.lang);
  const nativePlatform = document.body.dataset.platform;
  const menus = window.CommanderMenus;
  const systemFileClipboardSupported = !nativePlatform || nativePlatform === 'win32';
  const nativeDesktopSupported = !nativePlatform || ['win32', 'linux'].includes(nativePlatform);
  document.documentElement.lang = language;
  document.querySelector('#modal-close').setAttribute('aria-label', t('Dialog schließen'));
  function decorateShortcut(item, keyStrings) {
    const mac = document.body.dataset.platform === 'darwin';
    const names = { ctrl: mac ? '⌘' : language === 'de' ? 'Strg' : 'Ctrl',
      cmd: '⌘', alt: mac ? '⌥' : 'Alt', shift: mac ? '⇧' : language === 'de' ? 'Umschalt' : 'Shift', left: '←',
      numpad_add: 'Num +', numpad_subtract: 'Num −', numpad_multiply: 'Num *', numpad_divide: 'Num /' };
    const accessible = { cmd: 'Meta', ctrl: mac ? 'Meta' : 'Control', alt: 'Alt', shift: 'Shift', left: 'ArrowLeft' };
    const shortcuts = keyStrings.map(shortcut => shortcut.split('+'));
    item.setAttribute('aria-keyshortcuts', shortcuts.map(keys => keys.map(key => accessible[key] || key.toUpperCase()).join('+')).join(' '));
    const displayShortcut = keys => keys.map(key => names[key] || key.toUpperCase()).join('+');
    item.title = `${item.firstChild.textContent.trim()} (${shortcuts.map(displayShortcut).join(' · ')})`;
    const hints = document.createElement('span');
    hints.className = 'menu-shortcuts'; hints.setAttribute('aria-hidden', 'true');
    const appendKeycaps = keys => {
      for (const key of keys) {
        const cap = document.createElement('kbd');
        cap.textContent = names[key] || key.toUpperCase();
        hints.append(cap);
      }
    };
    if (shortcuts.length === 1) appendKeycaps(shortcuts[0]);
    else {
      for (const [index, shortcut] of shortcuts.entries()) {
        if (index) {
          const separator = document.createElement('span');
          separator.className = 'menu-shortcut-separator'; separator.textContent = ' / ';
          hints.append(separator);
        }
        const combination = document.createElement('span');
        combination.className = 'menu-shortcut'; combination.textContent = displayShortcut(shortcut);
        hints.append(combination);
      }
    }
    item.append(hints);
  }
  const mainMenu = document.querySelector('[data-main-menu]');
  if (mainMenu) {
    const triggers = [...mainMenu.querySelectorAll(':scope > [aria-haspopup="true"]')];
    const popup = mainMenu.querySelector('[role="menu"]');
    mainMenu.setAttribute('aria-label', t('Hauptmenü'));
    triggers.forEach(trigger => {
      trigger.dataset.menuGroup = trigger.textContent.trim();
      trigger.textContent = t(`Menü: ${trigger.dataset.menuGroup}`).replace(/^Menü: /, '');
    });
    popup.querySelectorAll('[data-group]').forEach(item => {
      if (item.getAttribute('role') === 'separator') return;
      item.firstChild.textContent = `${t(item.firstChild.textContent.trim())} `;
      if (item.dataset.menuKeys) decorateShortcut(item, item.dataset.menuKeys.split(' '));
      menus.decorate(item, item.dataset.menuAction || '');
    });
    let items = [];
    let openTrigger = null;
    function closeMenu(returnFocus = false) {
      popup.hidden = true;
      openTrigger?.setAttribute('aria-expanded', 'false');
      if (returnFocus) openTrigger?.focus();
      openTrigger = null;
    }
    function showMenu(trigger) {
      window.dispatchEvent(new CustomEvent('commander-menu-open', { detail: 'main' }));
      openTrigger?.setAttribute('aria-expanded', 'false');
      openTrigger = trigger;
      trigger.setAttribute('aria-expanded', 'true');
      popup.setAttribute('aria-label', trigger.textContent.trim());
      popup.querySelectorAll('[data-group]').forEach(item => { item.hidden = item.dataset.group !== trigger.dataset.menuGroup; });
      items = [...popup.querySelectorAll('[role="menuitem"]:not([hidden])')];
      popup.hidden = false;
      menus.place(popup, { anchor: trigger });
      items[0]?.focus();
    }
    triggers.forEach(trigger => {
      trigger.addEventListener('click', () => { if (openTrigger === trigger && !popup.hidden) closeMenu(); else showMenu(trigger); });
      trigger.addEventListener('mouseenter', () => { if (openTrigger && !popup.hidden && openTrigger !== trigger) showMenu(trigger); });
    });
    popup.addEventListener('click', event => {
      const item = event.target.closest('[data-group]');
      if (!item) return;
      event.preventDefault();
      if (item.hidden || item.getAttribute('aria-disabled') === 'true' || !item.dataset.menuAction) return;
      closeMenu(true); run(item.dataset.menuAction);
    });
    mainMenu.addEventListener('keydown', event => {
      if (mainMenu.dataset.lister) return;
      event.stopPropagation();
      if (event.key !== 'Tab') event.preventDefault();
      if (!openTrigger) {
        if (triggers.includes(event.target) && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); showMenu(event.target);
        }
        return;
      }
      if (event.target.closest('[aria-disabled="true"]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); return; }
      if (event.target.dataset.menuAction && ['Enter', ' '].includes(event.key)) { event.target.click(); return; }
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
      const itemIndex = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = itemIndex < 0 ? 0 : (itemIndex + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const index = triggers.indexOf(openTrigger);
        const next = (index + (event.key === 'ArrowRight' ? 1 : triggers.length - 1)) % triggers.length;
        showMenu(triggers[next]);
      } else if (event.key === 'Tab') closeMenu();
    });
    document.addEventListener('click', event => { if (openTrigger && !mainMenu.contains(event.target)) closeMenu(); });
    window.addEventListener('lister-menu-change', () => closeMenu());
    window.addEventListener('resize', () => closeMenu());
    window.addEventListener('blur', () => closeMenu());
    window.addEventListener('commander-menu-open', event => { if (event.detail !== 'main') closeMenu(); });
  }
  const host = window.CommanderHost || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  let auxiliaryCompactRequest = null, auxiliaryCompactReported = false;
  function reportAuxiliaryCompactReady() {
    if (!host || !auxiliaryCompactRequest || auxiliaryCompactReported || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    auxiliaryCompactReported = true;
    host.postMessage({ type: 'auxiliary-compact-ready', requestId: auxiliaryCompactRequest });
  }
  window.addEventListener('focus', reportAuxiliaryCompactReady);
  document.addEventListener('focusin', reportAuxiliaryCompactReady);
  document.addEventListener('visibilitychange', reportAuxiliaryCompactReady);
  const $ = selector => document.querySelector(selector);
  window.CommanderStartupResource?.step('settings');
  let fileSettings = {};
  try { fileSettings = JSON.parse(decodeURIComponent(document.body.dataset.fileSettings || '%7B%7D')); } catch { fileSettings = {}; }
  window.CommanderIcons.configure(fileSettings.iconSize);
  const activeRow = id => [...document.querySelectorAll('.pane.active tr[data-id]')].find(row => row.dataset.id === id);
  const tabs = window.CommanderTabs;
  const columns = window.CommanderColumns;
  const columnModel = window.CommanderColumnSettings;
  let hostColumnSettings;
  try { hostColumnSettings = JSON.parse(decodeURIComponent(document.body.dataset.columnSettings || '%7B%7D')); } catch { hostColumnSettings = {}; }
  let favoriteSettings;
  try { favoriteSettings = JSON.parse(decodeURIComponent(document.body.dataset.favoriteSettings || '%7B%7D')); } catch { favoriteSettings = {}; }
  let favoriteTrigger = null;
  const favoritePath = value => paths.normalizePath(value, { input: true, platform: document.body.dataset.platform }) || '/';
  const favoriteIdentity = value => favoriteSettings.caseSensitive === false ? favoritePath(value).toLowerCase() : favoritePath(value);
  function closeFavorites(restore = true) {
    document.querySelector('[data-favorite-menu]')?.remove();
    const trigger = favoriteTrigger; favoriteTrigger = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (trigger?.isConnected) {
      const side = Number(trigger.closest('[data-pane]').dataset.pane), icon = trigger.querySelector('[data-location-icon]');
      if (icon && icon.dataset.locationIcon !== locationKind(state.panes[side])) icon.outerHTML = locationMarkup(state.panes[side]);
      refreshLocationColors();
    }
    if (restore && trigger?.isConnected) trigger.focus();
  }
  function openFavorite(name, side) {
    if (favoritesBlocked()) return;
    const settings = favoriteSettings, destination = settings.entries?.[name], opposite = settings.targets?.[name];
    if (typeof destination !== 'string') return;
    closeFavorites(false);
    const normalized = favoritePath;
    const navigate = (value, index, done) => {
      const target = normalized(value);
      const finish = () => {
        const existing = Object.keys(state.folders).find(path => favoriteIdentity(path) === favoriteIdentity(target));
        if (!existing) { toast(t('Dieser Pfad ist in den Beispieldaten nicht vorhanden.')); return; }
        tabs.navigate(state.panes[index], existing); state.active = side; render(true); done?.();
      };
      if (host && state.realFilesystem) {
        cacheDirectories();
        const existing = Object.keys(state.folders).find(path => favoriteIdentity(path) === favoriteIdentity(target)) || target;
        const cached = directoryCache.get(existing) || (!state.unloadedFolders?.includes(existing) ? state.folders[existing] : undefined);
        if (cached) { rememberScroll(); directoryListings.set(existing, cached); tabs.navigate(state.panes[index], existing); state.active = side; render(true, undefined, false); }
        requestFilesystem({ type: 'filesystem-navigate', path: existing, side: index }, cached ? done : finish);
      }
      else finish();
    };
    navigate(destination, side, () => { if (typeof opposite === 'string' && opposite.trim()) navigate(opposite, 1 - side); });
  }
  function favoritesBlocked() {
    return (filesystemPending && !operationQueue?.active && !refreshingFilesystem) || (transferPending && !operationQueue?.active) || (transferJob && !operationQueue?.active);
  }
  function showFavorites(trigger) {
    if (favoritesBlocked() || $('#modal').open) return;
    const wasOpen = trigger === favoriteTrigger;
    closeFavorites(false); if (wasOpen) return;
    window.dispatchEvent(new CustomEvent('commander-menu-open', { detail: 'favorites' }));
    favoriteTrigger = trigger; trigger.setAttribute('aria-expanded', 'true');
    const side = Number(trigger.closest('[data-pane]').dataset.pane);
    const origin = state.panes[side], originPath = currentPath(origin), originTab = origin.tabStates[origin.tab].id;
    const kind = locationKind(origin);
    const entries = favoriteSettings.entries || {}, groups = favoriteSettings.groups || {};
    const names = [...new Set([...(Array.isArray(favoriteSettings.order) ? favoriteSettings.order : []), ...Object.keys(entries)])].filter(name => Object.hasOwn(entries, name) && typeof entries[name] === 'string');
    const leaf = (name, label) => ({ id: name, label, favorite: name, icon: 'folder-opened', attrs: { 'data-favorite-entry': '' } });
    const group = (id, label, children) => ({ id, label, children, icon: 'folder', attrs: { 'data-favorite-group': '' } });
    let definitions;
    if (Array.isArray(favoriteSettings.items)) {
      const build = (parent, ancestors = new Set()) => favoriteSettings.items.filter(item => item.parent === parent && !ancestors.has(item.id)).map(item =>
        item.type === 'group' ? group(item.id, item.name, build(item.id, new Set([...ancestors, item.id]))) : leaf(item.id, item.name));
      definitions = build(null);
    } else {
      definitions = [];
      for (const name of names) {
        const parts = typeof groups[name] === 'string' ? groups[name].split('/').map(part => part.trim()).filter(Boolean) : [];
        let children = definitions, id = '';
        for (const part of parts) {
          id += `/${part}`;
          let parent = children.find(item => item.children && item.id === id);
          if (!parent) { parent = group(id, part, []); children.push(parent); }
          children = parent.children;
        }
        children.push(leaf(name, typeof favoriteSettings.labels?.[name] === 'string' ? favoriteSettings.labels[name] : name));
      }
    }
    const exists = names.some(name => favoriteIdentity(entries[name]) === favoriteIdentity(currentPath(state.panes[side])));
    definitions.push({ id: 'favorite-toggle', label: t(exists ? 'Aktuelles Verzeichnis entfernen' : 'Aktuelles Verzeichnis hinzufügen…'), icon: exists ? 'remove' : 'star-add', attrs: { 'data-favorite-toggle': '' } });
    definitions.push({ id: 'favorite-configure', label: t('Favoriten konfigurieren…'), icon: 'settings-gear', attrs: { 'data-favorite-configure': '' } });
    if (kind) {
      const actions = kind === 'git' ? [
        { id: 'git-branches', label: t('Verfügbare Branches'), icon: 'git-compare' },
        { id: 'git-refresh', label: t('Git-Status aktualisieren'), icon: 'refresh' }
      ] : [
        { id: 'archive-root', label: t('Archivwurzel öffnen'), icon: 'folder-opened' },
        { id: 'archive-exit', label: t('Archiv verlassen'), icon: 'arrow-left' }
      ];
      actions.forEach(action => { action.attrs = { 'data-location-action': action.id }; });
      definitions = [
        { id: 'location-favorites', label: t('Favoriten'), icon: 'star-full', children: definitions, attrs: { 'data-location-section': 'favorites' } },
        { id: `location-${kind}`, label: kind === 'git' ? 'Git' : 'ZIP', icon: kind === 'git' ? 'git-compare' : 'file-zip', children: actions, attrs: { 'data-location-section': kind } }
      ];
    }
    const popup = menus.create({ items: definitions, label: t(kind ? 'Ortsmenü: Favoriten und Aktionen' : 'Favoriten'), emptyLabel: t('Keine Einträge'),
      onClose: restore => closeFavorites(restore), onAction: item => {
        if (state.panes[side] !== origin || currentPath(origin) !== originPath || origin.tabStates[origin.tab].id !== originTab || favoritesBlocked()) { closeFavorites(false); return; }
        if (item.attrs?.['data-location-action']) {
          closeFavorites();
          if (item.id === 'git-branches') host?.postMessage({ type: 'git-branches', path: originPath, snapshotId: state.snapshotId });
          else if (item.id === 'git-refresh') { gitBindings.delete(originPath); requestGitStatus(); }
          else {
            const root = originPath.slice(0, originPath.indexOf('!') + 1);
            let destination = root;
            if (item.id === 'archive-exit') {
              const archive = state.archiveLocations?.[root]?.archive || state.archiveLocations?.[originPath]?.archive;
              destination = state.archiveLocations?.[root]?.parent || parent(archive || (root.startsWith('zip:') ? decodeURIComponent(root.slice(4, -1)) : root.slice(0, -1)));
            }
            state.active = side; go(destination);
          }
          return;
        }
        if (item.favorite !== undefined) { openFavorite(item.favorite, side); return; }
        if (item.id === 'favorite-toggle') { closeFavorites(); host?.postMessage({ type: 'favorite-toggle', path: originPath }); }
        else { closeFavorites(false); host?.postMessage({ type: 'configure-favorites' }); }
      }
    });
    popup.dataset.favoriteMenu = ''; trigger.parentElement.append(popup);
    menus.place(popup, { anchor: trigger }); popup.querySelector('button')?.focus();
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('[data-favorite-menu],[data-favorites]')) closeFavorites(false); });
  window.addEventListener('blur', () => closeFavorites(false));
  window.addEventListener('resize', () => closeFavorites(false));
  window.addEventListener('commander-menu-open', event => { if (event.detail !== 'favorites') closeFavorites(false); });
  function prepareColumns(p) {
    if (Array.isArray(hostColumnSettings?.sets) && hostColumnSettings.sets.length) {
      const sets = columnModel.normalizeColumnSets(hostColumnSettings.sets);
      const set = sets.find(item => item.id === hostColumnSettings.activeSet) || sets[0];
      const signature = JSON.stringify(set);
      if (p.columnSetSignature !== signature) { p.columns = columns.normalize(set.columns); p.columnSetSignature = signature; }
      else p.columns = columns.normalize(p.columns);
    } else { p.columns = columns.normalize(p.columns); }
    for (const column of p.columns) if (!columnModel.isColumnAvailable(column, nativePlatform)) column.visible = false;
  }
  const search = window.CommanderSearch;
  let clipboardSelection = null, nativeClipboardUnavailable = false, clipboardSequence = 0;
  let clipboardWriteRequestId = null, clipboardPasteGeneration = null, clipboardPasteRequestId = null;
  let clipboardGeneration = 0, clipboardAvailabilityRevision = 0, clipboardAvailable = false, clipboardStatusPending = false;
  const fileIdentity = value => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  function fileMarkerState(file, directory, markedPaths) {
    const marked = file && markedPaths.has(fileIdentity(file.fsSource || join(directory, file.name)));
    const cut = Boolean(marked && clipboardSelection.mode === 'move'), copied = Boolean(marked && clipboardSelection.mode === 'copy');
    const hidden = Boolean(file && (file.hidden === true || /h/i.test(String(file.attributes ?? file.attr ?? ''))));
    return { cut, copied, hidden, width: cut ? window.CommanderIcons.layout().size : copied ? window.CommanderIcons.layout().badge : 0 };
  }
  function refreshClipboardMarkers() {
    const paths = new Set(clipboardSelection?.paths.map(fileIdentity));
    document.querySelectorAll('.pane').forEach((section, index) => {
      const directory = currentPath(state.panes[index]);
      const byId = new Map(files(state.panes[index]).map(file => [file.id, file]));
      let markerWidth = 0;
      section.querySelectorAll('tr[data-id]').forEach(row => {
        const file = byId.get(row.dataset.id);
        const { cut, copied, hidden, width } = fileMarkerState(file, directory, paths);
        markerWidth = Math.max(markerWidth, width);
        row.classList.toggle('is-cut', Boolean(cut));
        row.classList.toggle('is-copied', Boolean(copied));
        row.classList.toggle('is-hidden', hidden);
        row.querySelectorAll('.cut-marker, .hidden-marker').forEach(marker => marker.remove());
        const descriptions = [hidden && t('Versteckt'), (cut || copied) && t(cut ? 'Zum Verschieben vorgemerkt' : 'Zum Kopieren vorgemerkt')].filter(Boolean);
        if (descriptions.length) row.setAttribute('aria-label', [file.name, ...descriptions].join(' · '));
        else row.removeAttribute('aria-label');
        for (const [enabled, className, glyph, description] of [[hidden, 'hidden-marker', 'eye-closed', t('Versteckt')], [cut, 'cut-marker', 'arrow-right', t('Zum Verschieben vorgemerkt')]]) {
          if (!enabled) continue;
          const marker = window.CommanderIcons.element(glyph, { class: className, title: description });
          const icon = row.querySelector('.fileicon');
          if (hidden && className === 'hidden-marker' && icon) {
            let wrapper = icon.closest('.git-icon,.filename-icon');
            if (!wrapper) { wrapper = document.createElement('span'); wrapper.className = 'filename-icon'; icon.before(wrapper); wrapper.append(icon); }
            wrapper.append(marker);
          } else (icon?.closest('.git-icon,.filename-icon') || icon)?.before(marker);
        }
      });
      const table = section.querySelector('.file-table');
      table?.style.setProperty('--file-marker-width', `${markerWidth}px`);
      table?.style.setProperty('--file-marker-gap', markerWidth ? `${window.CommanderIcons.layout().gap}px` : '0px');
    });
    if (startupReady) reportFocus();
  }
  function setClipboardSelection(selection) {
    clipboardAvailabilityRevision++;
    clipboardSelection = selection;
    clipboardAvailable = Boolean(selection?.paths?.length);
    refreshClipboardMarkers();
  }
  function refreshClipboardAvailability() {
    if (!host || !state.realFilesystem || !systemFileClipboardSupported || nativeClipboardUnavailable) {
      clipboardAvailable = Boolean(clipboardSelection?.paths?.length);
      if (startupReady) reportFocus();
      return;
    }
    if (clipboardStatusPending || shellMenuPending || transferPending || transferJob) return;
    const revision = clipboardAvailabilityRevision;
    clipboardStatusPending = true;
    clipboardRequest({ type: 'clipboard-status' }, response => {
      clipboardStatusPending = false;
      if (revision !== clipboardAvailabilityRevision) { refreshClipboardAvailability(); return; }
      if (response.unavailable) {
        nativeClipboardUnavailable = true;
        clipboardAvailable = Boolean(clipboardSelection?.paths?.length);
      } else clipboardAvailable = response.ok === true && response.available === true;
      if (!clipboardAvailable && clipboardSelection?.source === 'system') { clipboardGeneration++; setClipboardSelection(null); }
      else reportFocus();
    });
  }
  const clipboardRequests = new Map(), clipboardStatusRequests = new Map();
  const clipboardDocumentId = window.crypto.randomUUID();
  function clipboardRequest(message, complete) {
    const status = message.type === 'clipboard-status';
    const requestId = status ? `clipboard-status-${clipboardDocumentId}-${++clipboardSequence}` : `clipboard-${++clipboardSequence}`;
    (status ? clipboardStatusRequests : clipboardRequests).set(requestId, complete);
    if (!status) statusTask(requestId, t('Auswahl wird übertragen…') + ` · ${t('Hostbestätigung')}`);
    host.postMessage({ ...message, requestId });
    return requestId;
  }
  function copyClipboard(mode, contextSelection) {
    if (selected().some(row => row.archive)) { toast(t('Dateioperationen innerhalb von Archiven sind nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.')); return; }
    let captured;
    try { captured = window.CommanderClipboard.capture(contextSelection ? { ...state, panes: state.panes.map((p, index) => index === state.active ? { ...p, selected: contextSelection.ids, cursor: null } : p) } : state, mode); }
    catch (error) { toast(t(error.message)); return; }
    if (!captured) return;
    clipboardPasteGeneration = null; clipboardPasteRequestId = null;
    const generation = ++clipboardGeneration;
    setClipboardSelection({ ...captured, source: 'internal' });
    if (!host || !state.realFilesystem) { toast(t(mode === 'move' ? 'Dateiauswahl intern zum Verschieben vorgemerkt.' : 'Dateiauswahl intern in die Zwischenablage übernommen.'), 'success'); return; }
    if (!systemFileClipboardSupported) { nativeClipboardUnavailable = true; toast(t('System-Datei-Zwischenablage nicht verfügbar; Auswahl nur intern übernommen.'), 'info'); return; }
    toast(t('Auswahl wird übertragen…'), 'info');
    const statusVersion = statusbar.version;
    clipboardWriteRequestId = clipboardRequest({ type: 'clipboard-write', ...captured }, response => {
      if (generation !== clipboardGeneration) return;
      if (response.ok) { setClipboardSelection(response.selection); nativeClipboardUnavailable = false; reportStatus(t(mode === 'move' ? 'Dateiauswahl zum Verschieben in die System-Zwischenablage übernommen.' : 'Dateiauswahl in die System-Zwischenablage übernommen.'), 'success', statusVersion); }
      else if (response.unavailable) { nativeClipboardUnavailable = true; reportStatus(t('System-Datei-Zwischenablage nicht verfügbar; Auswahl nur intern übernommen.'), 'error', statusVersion); }
      else { setClipboardSelection(null); reportStatus(t(response.error), 'error', statusVersion); }
    });
  }
  function resetClipboard() {
    const selection = clipboardSelection, sourceRequestId = clipboardWriteRequestId;
    const generation = ++clipboardGeneration;
    clipboardPasteGeneration = null; clipboardPasteRequestId = null; clipboardWriteRequestId = null;
    setClipboardSelection(null);
    toast(t('Kopier- und Ausschneidevormerkung aufgehoben.'), 'info');
    const statusVersion = statusbar.version;
    if (!selection || !host || !state.realFilesystem || !systemFileClipboardSupported || nativeClipboardUnavailable) {
      return;
    }
    clipboardRequest({ type: 'clipboard-reset', paths: selection.paths, mode: selection.mode, ...(selection.token ? { token: selection.token } : { sourceRequestId }) }, response => {
      if (generation !== clipboardGeneration) return;
      if (!response.ok) { reportStatus(t(response.error), 'error', statusVersion); refreshClipboardAvailability(); return; }
      if (!response.matched) refreshClipboardAvailability();
    });
  }
  function pasteClipboard() {
    if (clipboardPasteGeneration !== null) return;
    const targetPath = currentPath(pane()), targetSide = state.active;
    const targetPane = pane(), targetTab = targetPane.tabStates[targetPane.tab].id, snapshotId = state.snapshotId;
    const validRead = () => !contextPopup && !shellMenuPending && document.activeElement?.closest('.list') === document.querySelectorAll('[data-pane]')[targetSide]?.querySelector('.list') && !document.activeElement?.closest('[data-lister],.lister') && !$('#modal').open && !transferJob && !transferPending && !filesystemPending && state.active === targetSide && state.panes[targetSide] === targetPane && currentPath(targetPane) === targetPath && targetPane.tabStates[targetPane.tab].id === targetTab && state.snapshotId === snapshotId;
    const start = selection => {
      setClipboardSelection(selection);
      if (!selection) { toast(t('Die Zwischenablage enthält keine Dateien.')); return; }
      let plan;
      try { plan = window.CommanderClipboard.inspectPaste(state, selection, targetPath); }
      catch (error) { toast(t(error.message)); return; }
      if (!plan.ready) { requestFilesystem({ type: 'filesystem-prepare', paths: plan.directories, action: 'clipboard-paste', recursive: false }, () => start(selection)); return; }
      const completions = [], policyState = { value: 'ask' };
      const finish = () => {
        const remainingPaths = window.CommanderClipboard.remaining(selection, completions);
        setClipboardSelection(remainingPaths.length ? { ...selection, paths: remainingPaths } : null);
        if (selection.source === 'system' && selection.mode === 'move' && completions.some(({ result }) => result.confirmed && result.completedIds?.length)) {
          clipboardRequest({ type: 'clipboard-ack', token: selection.token, paths: selection.paths, mode: selection.mode, remainingPaths }, response => {
            if (!response.ok) toast(t(response.error));
            else if (!response.matched) { setClipboardSelection(null); toast(t('Dateien übertragen; inzwischen geänderte Zwischenablage bleibt unverändert.'), 'success'); }
          });
        }
      };
      const next = index => {
        if (index >= plan.groups.length) { finish(); return; }
        const group = plan.groups[index];
        const sourceSide = state.panes.findIndex(p => currentPath(p) === group.sourcePath);
        const options = { ...group, sourceSide: sourceSide < 0 ? targetSide : sourceSide, filter: '*.*', policyState, onComplete: result => {
          completions.push({ group, result });
          if (result.confirmed !== true || result.cancelled || result.errors?.length) finish();
          else next(index + 1);
        } };
        executeTransfer(options).catch(error => failTransferExecution(error, options.onComplete));
      };
      next(0);
    };
    if (host && state.realFilesystem && !systemFileClipboardSupported) {
      if (clipboardSelection) start(clipboardSelection);
      else toast(t('Die System-Datei-Zwischenablage wird auf diesem Betriebssystem noch nicht unterstützt.'), 'info');
      return;
    }
    if (!host || !state.realFilesystem || nativeClipboardUnavailable) { start(clipboardSelection); return; }
    const generation = clipboardGeneration; clipboardPasteGeneration = generation;
    const requestId = clipboardRequest({ type: 'clipboard-read' }, response => {
      if (clipboardPasteGeneration !== generation || clipboardPasteRequestId !== requestId) return;
      clipboardPasteGeneration = null; clipboardPasteRequestId = null;
      if (generation !== clipboardGeneration || !validRead()) return;
      if (response.ok) start(response.selection);
      else if (response.unavailable) { nativeClipboardUnavailable = true; start(clipboardSelection); }
      else toast(t(response.error));
    });
    clipboardPasteRequestId = requestId;
  }
  const nativeIcons = new Map();
  const requestedIcons = new Set();
  let iconTheme = {};
  try { iconTheme = JSON.parse(decodeURIComponent(document.body.dataset.iconTheme || '%7B%7D')); } catch { iconTheme = {}; }
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const join = paths.joinPath;
  const parent = paths.parentPath;
  const base = value => paths.baseName(value) || displayPath(value);
  let nextId = Date.now();
  const entry = (name, type, size = 0, content = '') => ({ id: String(nextId++), name, type, size, content, date: '29.10.2026 14:32' });
  const readme = '# Bitfroest.fs\n\nEin Arbeitsbereich für Dateien.\n\n## Im Prototyp ausprobieren\n\n- Ordner und Archive mit Enter öffnen\n- Mit Tab die Dateiliste wechseln\n- Mit F5 auf die Gegenseite kopieren\n- Mehrere Dateien markieren und umbenennen\n\nAlle Dateien sind Beispieldaten.\n';
  function initial() {
    return {
      version: 1, active: 0,
      panes: [
        { tabs: ['/workspace/bitfroest', '/workspace/bitfroest/docs', '/workspace/bitfroest/assets'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false },
        { tabs: ['/home/demo/Downloads', '/home/demo/Backups'], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false }
      ],
      folders: {
        '/': [entry('workspace', 'folder'), entry('home', 'folder')],
        '/workspace': [entry('bitfroest', 'folder')],
        '/home': [entry('demo', 'folder')],
        '/home/demo': [entry('Downloads', 'folder'), entry('Backups', 'folder')],
        '/workspace/bitfroest': [entry('assets', 'folder'), entry('docs', 'folder'), entry('src', 'folder'), entry('tests', 'folder'), entry('.gitignore', 'text', 128, 'node_modules/\ndist/\n'), entry('CHANGELOG.md', 'markdown', 1840, '# Änderungen\n\n## 0.1.0\n\n- Zwei Dateilisten\n- Ordner-Tabs\n- Archivnavigation\n'), entry('package.json', 'code', 1462, '{\n  "name": "bitfroest-fs",\n  "version": "0.1.0"\n}\n'), entry('README.md', 'markdown', 3264, readme), entry('tsconfig.json', 'code', 624, '{\n  "compilerOptions": { "strict": true }\n}\n'), entry('workspace.code-workspace', 'code', 248, '{ "folders": [] }\n')],
        '/workspace/bitfroest/docs': [entry('api', 'folder'), entry('architecture.md', 'markdown', 4820, '# Architektur\n\n## Anbieter\n\n- Dateisystem\n- Archive\n- Vorschau\n'), entry('keyboard-shortcuts.md', 'markdown', 1720, '# Tastatur\n\n- F3 Anzeigen\n- F4 Bearbeiten\n- F5 Kopieren\n'), entry('release-notes.md', 'markdown', 2340, '# Release Notes\n\nErste interaktive Vorschau.\n')],
        '/workspace/bitfroest/docs/api': [entry('providers.md', 'markdown', 1250, '# Anbieter\n\nAnbieter registrieren ihre unterstützten Operationen.\n')],
        '/workspace/bitfroest/assets': [entry('icons', 'folder'), entry('frost-palette.json', 'code', 420, '{ "accent": "#83d5df" }\n'), entry('wordmark.svg', 'code', 1480, '<svg xmlns="http://www.w3.org/2000/svg"/>\n')],
        '/workspace/bitfroest/assets/icons': [entry('folder.svg', 'code', 460, '<svg xmlns="http://www.w3.org/2000/svg"/>\n')],
        '/workspace/bitfroest/src': [entry('commands', 'folder'), entry('extension.ts', 'code', 4820, 'export function activate() {\n  return { ready: true };\n}\n'), entry('panels.ts', 'code', 6720, 'export const panelCount = 2;\n')],
        '/workspace/bitfroest/src/commands': [],
        '/workspace/bitfroest/tests': [entry('navigation.test.ts', 'code', 1220, 'export const scenario = "navigation";\n')],
        '/home/demo/Downloads': [entry('Design-Referenzen', 'folder'), entry('Dokumente', 'folder'), entry('bitfroest-assets.zip', 'archive', 2483200), entry('Projektarchiv.zip', 'archive', 1425800), entry('Abnahmeprotokoll.md', 'markdown', 4620, '# Abnahmeprotokoll\n\n## Prüfumfang\n\n- Navigation\n- Dateiauswahl\n- Vorschau\n'), entry('Bild_001.txt', 'text', 820, 'Erste Bildbeschreibung.\n'), entry('Bild_002.txt', 'text', 940, 'Zweite Bildbeschreibung.\n'), entry('Bild_003.txt', 'text', 780, 'Dritte Bildbeschreibung.\n'), entry('Farbpalette.json', 'code', 1240, '{ "background": "#11151b" }\n'), entry('Notizen.txt', 'text', 2130, 'Prototyp besprechen:\n\nOrdner-Tabs, Tastaturbedienung und Vorschau prüfen.\n'), entry('Projektplan.csv', 'text', 8460, 'Aufgabe;Status\nNavigation;Offen\nArchive;Offen\n'), entry('Release-Checkliste.md', 'markdown', 2860, '# Release-Checkliste\n\n- Version prüfen\n- Paket erstellen\n- Update prüfen\n')],
        '/home/demo/Downloads/Design-Referenzen': [entry('Farben.md', 'markdown', 1240, '# Farben\n\nEisblau, Schiefer und warme Ordnerfarben.\n')],
        '/home/demo/Downloads/Dokumente': [],
        '/home/demo/Backups': [entry('Oktober', 'folder'), entry('workspace-2026-10-28.zip', 'archive', 8420000), entry('manifest.json', 'code', 1820, '{ "created": "2026-10-28" }\n')],
        '/home/demo/Backups/Oktober': [],
        '/home/demo/Downloads/bitfroest-assets.zip!': [entry('icons', 'folder'), entry('palette.json', 'code', 640, '{ "accent": "#83d5df" }\n'), entry('README.md', 'markdown', 1024, '# Asset-Paket\n\nDieses Beispielarchiv enthält Icons und eine Farbpalette.\n')],
        '/home/demo/Downloads/bitfroest-assets.zip!/icons': [entry('folder.svg', 'code', 460, '<svg xmlns="http://www.w3.org/2000/svg"/>\n')],
        '/home/demo/Downloads/Projektarchiv.zip!': [entry('src', 'folder'), entry('README.md', 'markdown', 3264, readme)],
        '/home/demo/Downloads/Projektarchiv.zip!/src': [entry('main.ts', 'code', 1860, 'export const version = "0.1.0";\n')],
        '/home/demo/Backups/workspace-2026-10-28.zip!': [entry('README.md', 'markdown', 3264, readme)]
      }
    };
  }
  window.CommanderStartupResource?.step('restore');
  let saved;
  try { const injected = JSON.parse(document.body.dataset.initialState || 'null'); saved = host ? injected?.realFilesystem ? injected : host.getState() || injected : JSON.parse(sessionStorage.getItem('bitfroest-demo')); } catch { saved = null; }
  let state = saved?.version === 1 && saved.folders && saved.panes?.length === 2 ? saved : initial();
  for (const pane of state.panes) if (typeof pane.filter !== 'string') pane.filter = '';
  nextId = Math.max(Date.now(), ...Object.values(state.folders).flat().map(item => Number(item.id) + 1).filter(Number.isFinite));
  let confirmedFolders = JSON.stringify(state.folders);
  const directoryCache = window.CommanderDirectoryCache.create();
  const columnSizing = new WeakMap();
  const directoryListings = new Map();
  const navigationRequests = new Map();
  const navigationByTab = new Map();
  const deferredNavigationReads = new Map();
  const navigationKey = request => `${request.side}:${request.tabId}`;
  let navigationSequence = 0, validatedNavigation;
  function cacheDirectories() {
    for (const p of state.panes) {
      const path = p.tabs[p.tab];
      if (state.folders[path] && !state.unloadedFolders?.includes(path)) directoryCache.set(path, state.folders[path]);
    }
  }
  cacheDirectories();
  let filesystemPending = false;
  let pendingFilesystemKind = null;
  let filesystemTaskId = null, filesystemTaskSequence = 0;
  let refreshingFilesystem = false, refreshRequestId = null, refreshSequence = 0, refreshStartedAt = 0;
  let refreshPlan = null;
  const refreshStages = new Map();
  const refreshMeasurements = new Map(), statusTasks = new Map();
  const statusPlans = new Map();
  /** @returns {import('./commander-progress').StatusSnapshot} */
  function plannedStatus(input) {
    const progress = Progress.read(input), id = typeof progress.id === 'string' ? progress.id : progress.phase;
    let plan = statusPlans.get(id);
    if (!plan) {
      plan = Progress.statusPlan({ id, startedAt: typeof progress.startedAt === 'number' && Number.isFinite(progress.startedAt) ? progress.startedAt : performance.now(), steps: ['operation'], mode: 'work' });
      plan.start('operation'); statusPlans.set(id, plan);
    }
    plan.update('operation', progress);
    return plan.snapshot();
  }
  /** @param {import('./commander-progress').ProgressEvent | null} progress */
  function statusTask(id, label, progress = null) {
    if (!label) { statusTasks.delete(id); statusPlans.delete(id); }
    else {
      const event = progress ? Progress.read(progress) : Progress.event({ phase: 'awaiting-confirmation', overall: Progress.unknown('requests', 0, 'awaiting-confirmation'), current: Progress.unknown('requests', 0, 'awaiting-confirmation') });
      const startedAt = statusTasks.get(id)?.startedAt ?? performance.now();
      statusTasks.set(id, { label, startedAt, progress: Progress.event({ phase: event.phase, overall: event.overall, current: event.current, id, startedAt }) });
    }
    updateDirectoryActivity();
  }
  function beginDirectoryRefresh() {
    refreshingFilesystem = true; refreshStartedAt = performance.now(); refreshStages.clear(); refreshMeasurements.clear(); refreshRequestId = `refresh-${++refreshSequence}`;
    const directories = [...new Set(state.panes.filter(p => !resultView(p)).map(currentPath))];
    if (!directories.length) { refreshPlan = null; return; }
    const git = directories.filter(path => !isArchiveLocation(path));
    const plan = Progress.statusPlan({ id: refreshRequestId, startedAt: refreshStartedAt, steps: [...directories.map(path => `filesystem:${JSON.stringify(path)}`), 'state-save', ...git.map(path => `git:${JSON.stringify(path)}`)] });
    const filesystem = new Map(), repositories = new Map();
    for (const path of directories) {
      const root = `filesystem:${JSON.stringify(path)}`, [names, metadata, comments, validation, publication] = plan.append(root, ['names', 'metadata', 'comments', 'validation', 'publication']);
      plan.start(root); plan.start(names);
      plan.openPlanning(metadata);
      filesystem.set(path, { root, names, metadata, comments, validation, publication, total: null });
    }
    for (const path of git) {
      const root = `git:${JSON.stringify(path)}`, [describe, inspect, publication] = plan.append(root, ['describe', 'inspect', 'publication']);
      plan.openPlanning(root);
      repositories.set(path, { root, describe, inspect, publication, active: null, stage: null, key: null, sequence: 0, total: 0, completed: 0 });
    }
    refreshPlan = { progress: plan, filesystem, repositories, confirmed: new Set(), directories, gitDirectories: git, filesystemDone: false, saving: false, gitRequest: null };
  }
  function confirmRefreshStep(id) {
    if (refreshPlan.confirmed.has(id)) return;
    refreshPlan.progress.start(id); refreshPlan.progress.complete(id); refreshPlan.confirmed.add(id);
  }
  /** @param {import('./commander-progress').DeterminateMeasurement | null} count */
  function updateRefreshDirectory(path, phase, count) {
    const job = refreshPlan?.filesystem.get(path); if (!job) return;
    const plan = refreshPlan.progress;
    confirmRefreshStep(job.names);
    if (count && job.total === null) { plan.reserve(job.metadata, count.total); job.total = count.total; plan.closePlanning(job.metadata); }
    if (!refreshPlan.confirmed.has(job.metadata)) plan.start(job.metadata);
    if (count && job.total !== null && !refreshPlan.confirmed.has(job.metadata)) plan.confirmRange(job.metadata, count.completed);
    if (count && !refreshPlan.confirmed.has(job.metadata)) plan.update(job.metadata, Progress.event({ phase: 'metadata', overall: count, current: count }));
    if (['comments', 'validation', 'publication', 'done'].includes(phase)) {
      if (job.total !== null && !refreshPlan.confirmed.has(job.metadata)) plan.confirmRange(job.metadata, job.total);
      plan.closePlanning(job.metadata);
      confirmRefreshStep(job.metadata);
      if (!refreshPlan.confirmed.has(job.comments)) plan.start(job.comments);
    }
    if (['validation', 'publication', 'done'].includes(phase)) { confirmRefreshStep(job.comments); if (!refreshPlan.confirmed.has(job.validation)) plan.start(job.validation); }
    if (['publication', 'done'].includes(phase)) { confirmRefreshStep(job.validation); plan.start(job.publication); }
  }
  function updateRefreshGit(path, info) {
    const job = refreshPlan?.repositories.get(path); if (!job || !info) return;
    if (!info.repositoryChecks && info.repositoryResult?.ok === false && job.active) {
      refreshPlan.progress.fail(job.active, info.repositoryResult.error || t('Git-Status nicht verfügbar: {error}', { error: info.repositoryResult.path }));
      refreshPlan.confirmed.add(job.active); job.active = null; job.key = null; job.stage = null; job.total = 0; job.completed = 0;
    }
    if (info.activityOnly) return;
    const plan = refreshPlan.progress;
    if (info.phase === 'git-wait') { if (job.active) confirmRefreshStep(job.active); confirmRefreshStep(job.describe); job.active = null; job.stage = null; job.key = null; return; }
    if (info.version !== 1) return;
    const progress = Progress.read(info), stage = info.stage === 'describe' ? job.describe : job.inspect;
    if (stage === job.inspect && !refreshPlan.confirmed.has(job.describe)) {
      if (job.active) confirmRefreshStep(job.active);
      confirmRefreshStep(job.describe); job.active = null; job.key = null;
    }
    plan.start(stage);
    if (info.repositoryChecks) {
      const checks = info.repositoryChecks;
      if (!Number.isSafeInteger(checks.total) || !Number.isSafeInteger(checks.completed) || checks.completed < 0 || checks.completed > checks.total) throw new TypeError('Invalid repository check plan');
      if (!job.repositorySteps) {
        if (!Array.isArray(checks.paths) || checks.paths.length !== checks.total || checks.paths.some(path => typeof path !== 'string') || new Set(checks.paths).size !== checks.paths.length || checks.completed !== 0) throw new TypeError('Repository check identities are missing');
        if (job.active) confirmRefreshStep(job.active);
        job.active = null; job.key = null; job.total = 0; job.repositoryCompleted = 0;
        job.repositoryPaths = checks.paths;
        const steps = checks.paths.length ? plan.append(stage, checks.paths.map(path => `repository:${JSON.stringify(path)}`)) : [];
        if (!checks.paths.length) plan.reserve(stage, 0);
        job.repositorySteps = new Map(checks.paths.map((path, index) => [path, steps[index]]));
        plan.closePlanning(job.root);
      }
      if (checks.total !== job.repositorySteps.size || checks.completed < job.repositoryCompleted || checks.completed > job.repositoryCompleted + 1) throw new TypeError('Invalid repository check completion');
      if (checks.active !== null) {
        const step = job.repositorySteps.get(checks.active); if (!step) throw new TypeError('Unknown repository check');
        if (!refreshPlan.confirmed.has(step)) plan.start(step);
        if (checks.completed > job.repositoryCompleted) {
          if (checks.active !== job.repositoryPaths[job.repositoryCompleted] || info.repositoryResult?.path !== checks.active || typeof info.repositoryResult.ok !== 'boolean') throw new TypeError('Repository completion is not confirmed');
          if (info.repositoryResult.ok) confirmRefreshStep(step);
          else { plan.fail(step, info.repositoryResult.error || t('Git-Prüfung fehlgeschlagen: {error}', { error: checks.active })); refreshPlan.confirmed.add(step); }
          job.repositoryCompleted = checks.completed;
        }
      }
      plan.update(stage, progress); return;
    }
    const key = `${progress.phase}:${progress.phase === 'git-locate' ? progress.path : ''}`;
    if (job.key !== key || job.stage !== stage) {
      if (job.active) confirmRefreshStep(job.active);
      [job.active] = plan.append(stage, [`step-${++job.sequence}`]); plan.start(job.active);
      job.key = key; job.stage = stage; job.total = 0; job.completed = 0;
    }
    if (progress.phase === 'git-map-status' && progress.current.kind === 'determinate') {
      plan.reserve(job.active, progress.current.total); job.total = progress.current.total; plan.confirmRange(job.active, progress.current.completed); job.completed = progress.current.completed;
    }
    if (progress.nativeChecks) {
      const checks = progress.nativeChecks;
      if (!Array.isArray(checks.paths) || checks.paths.some(path => typeof path !== 'string') || !Number.isSafeInteger(checks.total) || !Number.isSafeInteger(checks.completed) || checks.completed < job.completed || checks.completed > checks.total) throw new TypeError('Invalid native comparison plan');
      if (checks.total !== job.total + checks.paths.length) throw new TypeError('Native comparison steps are missing');
      if (checks.total > 0) { plan.reserve(job.active, checks.total); plan.confirmRange(job.active, checks.completed); }
      job.total = checks.total; job.completed = checks.completed;
    }
    plan.update(job.active, progress);
  }
  const folderSizes = new Map(), folderSizeRequests = new Map();
  let folderSizeSequence = 0;
  let folderSizeBatch = null;
  function cancelFolderSizes() {
    for (const operationId of folderSizeRequests.keys()) host?.postMessage({ type: 'filesystem-cancel', operationId });
    for (const operationId of folderSizeRequests.keys()) statusTasks.delete(operationId);
    folderSizeRequests.clear();
    folderSizeBatch = null;
  }
  function displayFile(file, p) {
    const value = file.type === 'folder' ? folderSizes.get(entryPath(p, file)) : undefined;
    return value === undefined ? file : { ...file, folderSize: value };
  }
  function displayBytes(file, p) {
    return file.type === 'folder' ? folderSizes.get(entryPath(p, file)) || 0 : file.size || 0;
  }
  function calculateFolder(file, p) {
    const path = entryPath(p, file);
    if ([...folderSizeRequests.values()].some(request => request.path === path)) return;
    if (state.realFilesystem && host) {
      if (!folderSizeRequests.size) folderSizeBatch = { error: null, cancelled: false };
      const operationId = `folder-size-${++folderSizeSequence}`;
      const request = { type: 'folder-size', operationId, snapshotId: state.snapshotId, path };
      folderSizeRequests.set(operationId, request);
      statusTask(operationId, t('Ordnergröße wird ermittelt…'), Progress.event({ phase: 'folder-size', overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.unknown('items', 0, 'enumerating') }));
      toast(t('Ordnergröße wird ermittelt…'), 'info');
      folderSizeBatch.statusVersion = statusbar.version;
      host.postMessage(request);
      return;
    }
    let total = 0;
    const pending = [path], visited = new Set();
    while (pending.length) {
      const directory = pending.pop();
      if (visited.has(directory)) continue;
      visited.add(directory);
      for (const child of state.folders[directory] || []) {
        if (child.type === 'folder') pending.push(join(directory, child.name));
        else total += child.size || 0;
      }
    }
    folderSizes.set(path, total);
    refreshFolderSizeDisplay(path);
    toast(t('Ordnergröße ermittelt.'), 'success');
  }
  let filesystemResume = null;
  let creationFailure = null;
  let renameFailure = null;
  let transferCompletion = null;
  let transferCheckpoint = null;
  let transferJob = null, transferSequence = 0;
  let transferStatusPlan = null;
  /** @returns {import('./commander-progress').TerminalStatusSnapshot | null} */
  function finishTransferStatus(outcome) {
    if (!transferStatusPlan) return null;
    if (transferStatusPlan.analyze().state === 'running') {
      if (outcome === 'error' || outcome === 'cancelled') transferStatusPlan.terminate(outcome);
      else transferStatusPlan.complete('operation');
    }
    return transferStatusPlan.finishedSnapshot();
  }
  let operationQueue = null, jobView = null, deferredQueueJob = null, deferredQueueRun = null;
  const jobTabFallbacks = new Map();
  /** @param {0 | 1} targetPane */
  function operationTargetLocation(targetPane) {
    const target = state.panes[targetPane];
    return { pane: targetPane, tabId: target.tabStates[target.tab].id };
  }
  /** @param {import('./commander-jobs').OperationInput} request
   * @param {(job: import('./commander-jobs').Job) => unknown} run
   * @param {0 | 1} [targetPane] */
  function enqueueOperation(request, run, targetPane = state.active) { return operationQueue.add({ ...request, targetLocation: operationTargetLocation(targetPane) }, run); }
  function runQueuedOperation(job, run) {
    if (operationQueue.active !== job) { if (deferredQueueJob === job) { deferredQueueJob = null; deferredQueueRun = null; } return; }
    if (filesystemPending || navigationRequests.size || transferPlanning) { deferredQueueJob = job; deferredQueueRun = run; return; }
    deferredQueueJob = null; deferredQueueRun = null;
    try { run(); } catch (error) { operationQueue.complete(job.id, { ok: false, error: error.message }); }
  }
  function flushDeferredNavigationReads() {
    if (transferPlanning || transferPending || !deferredNavigationReads.size) return;
    const pending = [...deferredNavigationReads.values()]; deferredNavigationReads.clear();
    statusbar.setStatus(operationQueue?.active ? t('Dateioperation läuft…') : '');
    for (const request of pending) {
      const origin = state.panes[request.message.side];
      if (!origin || origin.tabStates[origin.tab].id !== request.tabId) continue;
      requestFilesystem(request.message, request.resume);
    }
  }
  function flushQueuedOperation() {
    if (filesystemPending || navigationRequests.size || transferPlanning || !deferredQueueJob) return;
    const job = deferredQueueJob, run = deferredQueueRun; runQueuedOperation(job, run);
  }
  function cancelTransfer() {
    if (!transferJob || transferJob.cancelRequested) return;
    transferJob.cancelRequested = true;
    if (transferJob.hostActive === false) {
      transferJob.controller?.abort();
      if ($('#modal').open) $('#modal').close();
      transferProgress(); return;
    }
    document.querySelectorAll('[data-cancel-transfer]').forEach(button => { button.disabled = true; });
    transferProgress(); host.postMessage({ type: 'filesystem-cancel', operationId: transferJob.id });
  }
  function jobDialogOpen() { return Boolean(transferJob?.modalPreparation || $('#modal').querySelector('[data-conflict-action]')); }
  $('#modal').addEventListener('cancel', event => {
    if (!jobDialogOpen()) return;
    event.preventDefault();
  });
  function transferProgress(progress = {}) {
    const reported = progress.version === 1 ? Progress.read(progress) : null;
    let element = document.querySelector('.transfer-progress');
    if (!transferJob) { element?.remove(); return; }
    if (!element) {
    element = document.createElement('section'); element.className = 'transfer-progress'; element.setAttribute('role', 'region'); element.setAttribute('aria-labelledby', 'transfer-progress-title');
      const title = document.createElement('strong'); title.id = 'transfer-progress-title'; title.dataset.progressTitle = ''; title.textContent = t(transferJob.context.mode === 'delete' ? 'Löschen läuft…' : transferJob.context.mode === 'move' ? 'Verschieben läuft…' : 'Kopieren läuft…');
      const paths = document.createElement('dl');
      for (const [key, label, value] of [['source', 'Quelle', transferJob.context.sources.map(displayPath).join('\n')], ['target', 'Ziel', displayPath(transferJob.context.target)]]) {
        const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = t(label); detail.dataset[key === 'source' ? 'progressSource' : 'progressTarget'] = ''; detail.tabIndex = 0; detail.textContent = value; paths.append(term, detail);
      }
      const meters = document.createElement('div'); meters.className = 'transfer-progress-meters';
      for (const [key, label, countKey] of [['overall', 'Gesamtfortschritt', 'overallCount'], ['current-file', 'Aktuelle Datei', 'currentFileCount']]) {
        const detail = document.createElement('div'), caption = document.createElement('span'), count = document.createElement('span'); detail.className = 'transfer-progress-detail'; caption.textContent = t(label); count.dataset[countKey] = ''; count.textContent = t('Dateioperation läuft…'); detail.append(caption, count);
        if (key === 'current-file') { const filename = document.createElement('span'); filename.dataset.currentFilePath = ''; filename.className = 'transfer-progress-file'; detail.append(filename); }
        meters.append(detail);
      }
      const actions = document.createElement('div'); actions.className = 'transfer-progress-actions';
      const label = document.createElement('span'), button = document.createElement('button'); label.dataset.progressCount = ''; label.setAttribute('role', 'status');
      button.type = 'button'; button.dataset.cancelTransfer = ''; button.replaceChildren(window.CommanderIcons.element('close')); button.setAttribute('aria-label', t('Abbrechen')); button.title = t('Abbrechen');
      button.onclick = cancelTransfer;
      actions.append(label, button); element.append(title, paths, meters, actions); (transferJob.modalPreparation ? $('#modal-body') : document.body).append(element);
    }
    element.hidden = Boolean(operationQueue?.active && !transferJob.modalPreparation);
    const progressContainer = transferJob.modalPreparation ? $('#modal-body') : document.body;
    if (element.parentElement !== progressContainer) progressContainer.append(element);
    if (transferJob.modalPreparation) $('#modal-cancel').hidden = true;
    if (['packing', 'verifying', 'retaining', 'finalizing', 'publishing', 'removing-sources'].includes(progress.phase) && progress.phase !== transferJob.phase) {
      transferJob.currentPath = null; transferJob.currentTransferred = 0; transferJob.currentTotal = undefined;
      transferJob.totalBytes = undefined; transferJob.completedBytes = 0;
      transferJob.reportedProgress = null;
      transferJob.filesScanned = undefined;
      element.querySelector('[data-progress-count]').textContent = '';
    }
    if (progress.phase) transferJob.phase = progress.phase;
    const progressPath = progress.sourcePath || progress.path || progress.currentPath;
    if (progressPath && progressPath !== transferJob.currentPath) { transferJob.currentPath = progressPath; transferJob.currentTransferred = 0; transferJob.currentTotal = progress.total; }
    if (progress.filesScanned !== undefined) { transferJob.filesScanned = progress.filesScanned; element.querySelector('[data-progress-count]').textContent = t(transferJob.zipWrite && transferJob.phase === 'preparing' ? '{count} Einträge erfasst' : '{count} Einträge geprüft', { count: progress.filesScanned }); }
    else if (progress.totalBytes !== undefined) element.querySelector('[data-progress-count]').textContent = size(progress.completedBytes || 0) + ' / ' + size(progress.totalBytes);
    else if (!element.querySelector('[data-progress-count]').textContent) element.querySelector('[data-progress-count]').textContent = t('Dateioperation läuft…');
    if (progress.totalBytes !== undefined) { transferJob.totalBytes = progress.totalBytes; transferJob.completedBytes = progress.completedBytes || 0; }
    element.querySelector('[data-overall-count]').textContent = Number.isFinite(transferJob.totalBytes) && transferJob.totalBytes > 0 ? size(transferJob.completedBytes || 0) + ' / ' + size(transferJob.totalBytes) : t('Dateioperation läuft…');
    if (progress.transferred !== undefined) transferJob.currentTransferred = Math.max(transferJob.currentTransferred || 0, progress.transferred);
    if (progress.total !== undefined) transferJob.currentTotal = progress.total;
    if (reported) {
      transferJob.reportedProgress = reported;
      transferJob.totalBytes = reported.overall.kind === 'determinate' && reported.overall.unit === 'bytes' ? reported.overall.total : undefined;
      transferJob.completedBytes = reported.overall.unit === 'bytes' ? reported.overall.completed : 0;
      transferJob.currentTotal = reported.current.kind === 'determinate' && reported.current.unit === 'bytes' ? reported.current.total : undefined;
      transferJob.currentTransferred = reported.current.unit === 'bytes' ? reported.current.completed : 0;
    }
    if (progress.phase === 'published' && Number.isFinite(transferJob.currentTotal)) transferJob.currentTransferred = transferJob.currentTotal;
    if (transferJob.currentPath) element.querySelector('[data-current-file-path]').textContent = displayPath(transferJob.currentPath);
    element.querySelector('[data-current-file-count]').textContent = Number.isFinite(transferJob.currentTotal) && transferJob.currentTotal > 0 ? size(transferJob.currentTransferred || 0) + ' / ' + size(transferJob.currentTotal) : t('Dateioperation läuft…');
    const zipPhaseLabels = { retaining: 'Archiveinträge übernehmen', finalizing: 'ZIP abschließen', publishing: 'ZIP speichern', 'removing-sources': 'Quellen entfernen' };
    const operationLabel = transferJob.phase === 'deleting' ? 'Löschen' : zipPhaseLabels[transferJob.phase] || (transferJob.phase === 'preparing' ? transferJob.zipWrite ? 'ZIP-Dateien erfassen' : 'Vorbereiten' : transferJob.phase === 'packing' ? 'ZIP erstellen' : transferJob.phase === 'verifying' ? 'Archiv prüfen' : transferJob.phase === 'validating' ? 'Prüfen' : transferJob.context.mode === 'move' ? 'Verschieben' : 'Kopieren');
    const fileName = transferJob.currentPath?.split(/[\\/]/).filter(Boolean).at(-1);
    const detailedPhase = transferJob.zipWrite && (transferJob.phase === 'preparing' || zipPhaseLabels[transferJob.phase]);
    const title = transferJob.cancelRequested ? t('Abbruch wird ausgeführt…') : detailedPhase ? t(operationLabel) + (fileName ? `: ${fileName}` : '') : fileName ? t(`${operationLabel}: {file}`, { file: fileName }) : t(operationLabel === 'Vorbereiten' ? 'Dateien werden vorbereitet…' : operationLabel === 'ZIP erstellen' ? 'ZIP-Archiv wird erstellt…' : operationLabel === 'Archiv prüfen' ? 'Archiv wird geprüft…' : operationLabel === 'Prüfen' ? 'Dateien werden geprüft…' : operationLabel === 'Verschieben' ? 'Verschieben läuft…' : 'Kopieren läuft…');
    const statusTitle = transferJob.cancelRequested ? title : t(operationLabel) + (transferJob.zipWrite && transferJob.phase === 'preparing' && Number.isFinite(transferJob.filesScanned) ? ` · ${t('{count} Einträge erfasst', { count: transferJob.filesScanned })}` : '');
    element.querySelector('[data-progress-title]').textContent = title;
    const formatMeasurement = value => value.kind === 'determinate' ? value.unit === 'bytes' ? `${size(value.completed)} / ${size(value.total)}` : `${value.completed} / ${value.total} ${t(value.unit === 'items' ? 'Einträge' : 'Bestätigte Aufträge')}` : t('Gesamtfortschritt unbekannt');
    const overallValueText = transferJob.reportedProgress ? formatMeasurement(transferJob.reportedProgress.overall) : Number.isFinite(transferJob.totalBytes) && transferJob.totalBytes >= 0 ? `${size(transferJob.completedBytes || 0)} / ${size(transferJob.totalBytes)}` : t('Gesamtfortschritt unbekannt');
    const fileValueText = transferJob.reportedProgress ? formatMeasurement(transferJob.reportedProgress.current) : Number.isFinite(transferJob.currentTotal) && transferJob.currentTotal >= 0 ? `${size(transferJob.currentTransferred || 0)} / ${size(transferJob.currentTotal)}` : t('Fortschritt der aktuellen Datei unbekannt');
    if (transferJob.reportedProgress) { element.querySelector('[data-overall-count]').textContent = overallValueText; element.querySelector('[data-current-file-count]').textContent = fileValueText; }
    const cancelButton = element.querySelector('[data-cancel-transfer]');
    cancelButton.hidden = false;
    cancelButton.disabled = Boolean(transferJob.cancelRequested);
    const measurement = (completed, total) => Number.isSafeInteger(total) && total >= (completed || 0) ? Progress.known('bytes', completed || 0, total) : Progress.unknown('bytes', completed || 0, transferJob.phase === 'preparing' ? 'enumerating' : 'stream-size-unknown');
    /** @type {import('./commander-progress').ProgressEvent} */
    const statusProgress = reported || transferJob.reportedProgress || Progress.event({ phase: transferJob.phase || 'preparing', overall: measurement(transferJob.completedBytes, transferJob.totalBytes), current: measurement(transferJob.currentTransferred, transferJob.currentTotal) });
    const statusPlanId = transferJob.queueJobId || transferJob.id;
    const statusSnapshot = plannedStatus(Progress.event({ ...statusProgress, id: statusPlanId })); transferStatusPlan = statusPlans.get(statusPlanId);
    statusbar.setProgress({ quiet: Boolean(operationQueue?.active), title, statusTitle, progress: statusSnapshot, statusPath: transferJob.currentPath && displayPath(transferJob.currentPath), overallValueText, fileValueText, element, modal: transferJob.modalPreparation, cancelRequested: transferJob.cancelRequested, cancelAvailable: true });
    if (operationQueue?.active) { operationQueue.active.progress = statusSnapshot; operationQueue.active.control = $('#status-progress-region').cloneNode(true); operationQueue.active.cancelling = Boolean(transferJob.cancelRequested); operationQueue.active.currentPath = transferJob.currentPath; }
    jobView?.update(operationQueue.items);
  }
  let transferPreparationFailure = null;
  let startupReady = false;
  let focusRefreshRequested = false;
  let transferPending = false;
  let transferPlanning = false;
  let rightDropChoice = null, rightDropSequence = 0;
  let shellMenuPending = null, shellMenuSequence = 0;
  let gitMenuSelection = null, pendingGitDiff = null;
  let conflictAction = null;
  function flushFocusRefresh() {
    if (!startupReady || !focusRefreshRequested || filesystemPending || navigationRequests.size || transferPending || rightDropChoice || shellMenuPending || $('#modal').open) return;
    focusRefreshRequested = false;
    if (lister.has(state.active)) return;
    requestFilesystem({ type: 'filesystem-refresh' });
  }
  window.addEventListener('focus', () => {
    if (!host || !state.realFilesystem) return;
    refreshClipboardAvailability();
  });
  window.addEventListener('message', event => {
    if (!host || !state.realFilesystem || event.data?.type !== 'window-focus' || shellMenuPending) return;
    focusRefreshRequested = true;
    flushFocusRefresh();
  });
  $('#modal').addEventListener('close', () => queueMicrotask(flushFocusRefresh));
  const pane = () => state.panes[state.active];
  const currentPath = p => p.tabs[p.tab];
  const resultView = p => p.tabStates?.[p.tab]?.searchResult;
  const entryPath = (p, file) => resultView(p) ? file.fsSource : join(currentPath(p), file.name);
  const files = p => {
    const result = resultView(p);
    if (!result) return directoryListings.get(currentPath(p)) || state.folders[currentPath(p)] || [];
    const archived = new Map((result.archiveRows || []).map(row => [row.fsSource, row])), directories = new Map();
    return result.paths.map(path => {
      if (archived.has(path)) return archived.get(path);
      const directory = parent(path);
      if (!directories.has(directory)) directories.set(directory, new Map((state.folders[directory] || []).map(row => [join(directory, row.name), row])));
      return directories.get(directory).get(path);
    }).filter(Boolean);
  };
  function requestFilesystem(message, resume) {
    if (message.type === 'zip-open' && operationQueue?.active) {
      const origin = state.panes[message.side], navigationRequestId = `directory-${++navigationSequence}`;
      const request = { ...message, navigationRequestId, startedAt: performance.now(), tabId: origin.tabStates[origin.tab].id, originPath: currentPath(origin), activeAtStart: state.active, resume: () => { if (request.archivePath) go(request.archivePath); } };
      navigationRequests.set(navigationRequestId, request); navigationByTab.set(navigationKey(request), request);
      updateDirectoryActivity(); host.postMessage({ ...message, navigationRequestId, navigationTabId: request.tabId, state }); return true;
    }
    if (filesystemPending && !(operationQueue?.active && message.type === 'filesystem-navigate')) return true;
    if (message.type === 'filesystem-navigate') {
      if (transferPlanning) {
        const origin = state.panes[message.side];
        if (origin) {
          const tabId = origin.tabStates[origin.tab].id;
          for (const [key, pending] of deferredNavigationReads) if (pending.message.side === message.side && pending.tabId !== tabId) deferredNavigationReads.delete(key);
          deferredNavigationReads.set(`${message.side}:${tabId}`, { message: { ...message }, resume, tabId });
        }
        statusbar.setStatus(t('Verzeichnisanfrage wartet auf Kopierplanung.'), 'info');
        return true;
      }
      cacheDirectories();
      const navigationRequestId = `directory-${++navigationSequence}`;
      const origin = state.panes[message.side];
      const request = { ...message, navigationRequestId, startedAt: performance.now(), resume, tabId: origin.tabStates[origin.tab].id, originPath: currentPath(origin), activeAtStart: state.active, pathNavigation: pendingPathNavigation };
      pendingPathNavigation = null;
      navigationRequests.set(navigationRequestId, request); navigationByTab.set(navigationKey(request), request);
      for (const path of directoryListings.keys()) if (!state.panes.some(p => currentPath(p) === path)) directoryListings.delete(path);
      gitBindings.delete(message.path); gitPending.delete(message.path);
      const cached = directoryCache.get(message.path);
      if (cached && currentPath(origin) === message.path && !directoryListings.has(message.path)) { directoryListings.set(message.path, cached); render(false, undefined, false); }
      updateDirectoryActivity();
      host.postMessage({ ...message, navigationRequestId, navigationTabId: request.tabId, state });
      return true;
    }
    if (navigationRequests.size) return true;
    refreshingFilesystem = message.type === 'filesystem-refresh';
    if (refreshingFilesystem) beginDirectoryRefresh();
    pendingFilesystemKind = message.type;
    rememberScroll();
    filesystemResume = resume;
    if (message.type === 'filesystem-prepare' && ['copy', 'move'].includes(message.action)) {
      transferJob = { id: `prepare-${Date.now()}-${++transferSequence}`, phase: 'preparing', hostActive: true, context: Object.freeze({ mode: message.action, sources: Object.freeze([...message.paths]), target: currentPath(state.panes[1 - state.active]) }) };
      transferJob.modalPreparation = $('#modal').open;
      if (transferJob.modalPreparation) { if ($('#value')) $('#value').disabled = true; $('#modal-confirm').disabled = true; }
      message.operationId = transferJob.id; transferProgress();
    }
    filesystemPending = true; $('#panes').inert = !operationQueue?.active && !refreshingFilesystem; $('#functionbar').inert = !operationQueue?.active && !refreshingFilesystem;
    if (!transferJob && !refreshingFilesystem) {
      filesystemTaskId = message.taskRequestId = `filesystem-task-${++filesystemTaskSequence}`;
      statusTask('filesystem', t(message.type === 'filesystem-delete' ? 'Löschen wird ausgeführt' : 'Aktion wird ausgeführt…') + ` · ${t('Hostbestätigung')}`);
    }
    if (message.type === 'filesystem-delete') toast(t('Löschen wird ausgeführt'), 'info');
    host.postMessage({ ...message, ...(refreshingFilesystem ? { refreshRequestId } : {}), state });
    return true;
  }
  function prepareFolders(paths, action, resume, recursive = true) {
    if (!host || !state.realFilesystem) return false;
    const directories = [...new Set(paths)].filter(path => (state.unloadedFolders || []).some(unloaded => unloaded === path || recursive && unloaded.startsWith(`${path}/`)));
    return directories.length ? requestFilesystem({ type: 'filesystem-prepare', paths: directories, action, recursive }, resume) : false;
  }
  function receiveDirectoryMessage(data) {
    const request = navigationRequests.get(data.navigationRequestId) || (!data.navigationRequestId && !filesystemPending && data.type === 'filesystem-result' && navigationRequests.size === 1 ? navigationRequests.values().next().value : undefined);
    if (!request) return Boolean(data.navigationRequestId);
    const latest = navigationByTab.get(navigationKey(request)) === request;
    const origin = state.panes[request.side];
    const contextValid = latest && origin.tabStates[origin.tab].id === request.tabId && [request.originPath, request.path].includes(currentPath(origin)) && state.active === request.activeAtStart;
    const displayed = currentPath(state.panes[request.side]) === request.path;
    if (data.type === 'filesystem-directory') {
      if (!latest || origin.tabStates[origin.tab].id !== request.tabId || !displayed || data.path !== request.path) return true;
      if (data.done) { request.metadataCompleted = request.metadataTotal; updateDirectoryActivity(); return true; }
      if (Array.isArray(data.names)) { request.metadataReading = true; request.metadataTotal = data.names.length; request.metadataCompleted = 0; }
      else request.metadataCompleted = Math.min(request.metadataTotal || 0, (request.metadataCompleted || 0) + (data.rows?.length || 0));
      rememberScroll(); const previousViews = state.panes.map(paneDisplayState);
      let rows = directoryListings.get(request.path) || directoryCache.get(request.path) || state.folders[request.path] || [];
      if (Array.isArray(data.names)) { const names = new Set(data.names); rows = rows.filter(row => names.has(row.name)); }
      const byName = new Map(rows.map(row => [row.name, row]));
      for (const row of data.rows || []) byName.set(row.name, row);
      directoryListings.set(request.path, [...byName.values()]);
      const valid = new Set([...byName.values()].map(row => row.id));
      for (const p of state.panes) if (currentPath(p) === request.path) { p.selected = p.selected.filter(id => valid.has(id)); if (!valid.has(p.cursor)) p.cursor = null; }
      render(false, previousViews, false); return true;
    }
    if (data.type !== 'filesystem-result') return false;
    if (request.type === 'zip-open' && data.resumeNavigation) request.archivePath = data.resumeNavigation.path;
    const success = data.ok && !data.cancelled;
    rememberScroll(); const previousViews = state.panes.map(paneDisplayState), view = state.panes, active = state.active;
    navigationRequests.delete(request.navigationRequestId);
    if (latest) navigationByTab.delete(navigationKey(request));
    if (data.state?.realFilesystem) { state = data.state; state.panes = view; state.active = active; confirmedFolders = JSON.stringify(state.folders); }
    if (success && state.folders[request.path]) directoryCache.set(request.path, state.folders[request.path]);
    if (latest) {
      if (success) directoryListings.delete(request.path);
      else { const cached = directoryCache.get(request.path); if (cached) directoryListings.set(request.path, cached); }
      if (displayed && origin.tabStates[origin.tab].id === request.tabId) {
        const valid = new Set(files(state.panes[request.side]).map(row => row.id)), p = state.panes[request.side];
        p.selected = p.selected.filter(id => valid.has(id)); if (!valid.has(p.cursor)) p.cursor = null;
        gitBindings.delete(request.path);
      }
    }
    render(false, previousViews, false);
    if (request.pathNavigation) request.pathNavigation.valid = contextValid && request.pathNavigation.generation === pathRequestGeneration && document.activeElement === request.pathNavigation.input;
    if (contextValid && success) {
      validatedNavigation = request.path;
      try { if (request.resume) request.resume(); }
      finally { validatedNavigation = undefined; }
    } else if (latest && origin.tabStates[origin.tab].id === request.tabId && !data.ok) toast(data.error || t('Dateioperation fehlgeschlagen.'), 'error');
    requestGitStatus(); updateDirectoryActivity(); flushQueuedOperation(); flushFocusRefresh();
    return true;
  }
  const selected = () => selectedFor(pane());
  const size = value => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
  function persist() {
    if (transferPending && !transferCompletion) return;
    state.panes.forEach(p => tabs.remember(p));
    if (host && state.realFilesystem && filesystemPending) host.postMessage({ type: 'view-state', panes: state.panes, active: state.active });
    if (host) {
      host.setState(state);
      const proposedState = transferCompletion?.proposedState || state;
      if (state.realFilesystem && JSON.stringify(proposedState.folders) !== confirmedFolders) {
        if (!filesystemPending) { pendingFilesystemKind = 'filesystem-apply'; filesystemPending = true; $('#panes').inert = !operationQueue?.active; $('#functionbar').inert = true; if (!transferJob) { toast(t('Dateioperation läuft…'), 'info'); statusTask('filesystem', t('Dateioperation läuft…') + ` · ${t('Hostbestätigung')}`); } host.postMessage({ type: 'filesystem-apply', state: proposedState, ...(transferJob ? { operationId: transferJob.id, transfer: transferJob.transfer } : {}) }); }
      } else if (!filesystemPending) host.postMessage({ type: 'state', state });
    }
    else { try { sessionStorage.setItem('bitfroest-demo', JSON.stringify(state)); } catch { /* Storage may be unavailable. */ } }
  }
  const selectionRanges = new WeakMap();
  function rememberSelectionAnchor(p) {
    selectionRanges.set(p, { tab: p.tabStates?.[p.tab]?.id, anchor: p.cursor, base: [...p.selected] });
  }
  function extendSelection(p, id, additive) {
    const list = visible(p), tab = p.tabStates?.[p.tab]?.id;
    let range = selectionRanges.get(p);
    if (!range || range.tab !== tab || !list.some(file => file.id === range.anchor)) {
      range = { tab, anchor: p.cursor || id, base: [...p.selected] }; selectionRanges.set(p, range);
    }
    const a = list.findIndex(file => file.id === range.anchor), b = list.findIndex(file => file.id === id);
    p.selected = [...new Set([...(additive ? range.base : []), ...list.slice(Math.min(a, b), Math.max(a, b) + 1).map(file => file.id)])];
  }
  function visible(p) {
    const column = p.columns?.find(column => column.key === p.sort);
    const list = columns.sort(files(p), column?.field === undefined ? p.sort : column, p.descending);
    const groups = resultView(p)?.groups;
    return groups && Object.keys(groups).length ? list.sort((a, b) => (groups[a.fsSource] ?? -1) - (groups[b.fsSource] ?? -1)) : list;
  }
  function extension(file) { return file.type === 'folder' ? t('Ordner') : file.name.includes('.') ? file.name.split('.').pop() : '—'; }
  const gitDirectories = new Map();
  const gitInfo = directory => gitDirectories.get(directory) || directoryCache.getGit(directory);
  let gitSequence = 0;
  const gitBindings = new Map();
  const gitPending = new Set();
  function updateDirectoryActivity() {
    const activities = [], gitActivities = new Map();
    /** @type {import('./commander-progress').ProgressEvent | null} */
    let measured = null;
    /** @type {import('./commander-progress').StatusSnapshot | null} */
    let planned = null;
    document.querySelectorAll('.pane').forEach((section, side) => {
      const path = currentPath(state.panes[side]);
      const gitProgress = gitBindings.get(path)?.progress;
      const reading = [...navigationRequests.values()].find(request => request.side === side && request.tabId === state.panes[side].tabStates[state.panes[side].tab].id && [request.path, request.originPath].includes(path) && navigationByTab.get(navigationKey(request)) === request);
      const refreshing = refreshingFilesystem && refreshStages.get(path) !== 'done';
      const busy = Boolean(reading || gitPending.has(path) || refreshing);
      const stages = [];
      if (reading || refreshing) stages.push(t(({ comments: 'Verzeichniskommentare lesen', validation: 'Verzeichnisbestand prüfen', publication: 'Dateiliste bereitstellen' })[refreshStages.get(path)] || (reading?.metadataReading || refreshStages.get(path) === 'metadata' ? 'Dateieigenschaften lesen' : 'Verzeichnis einlesen')));
      if (gitPending.has(path)) {
        const binding = gitBindings.get(path);
        if (!gitActivities.has(binding.requestId) || side === state.active) gitActivities.set(binding.requestId, { paths: binding.directories.map(displayArchivePath), phase: gitProgress?.phase });
      }
      /** @param {import('./commander-progress').ProgressEvent} value */
      const setMeasurement = value => {
        if (!measured || side === state.active) measured = Progress.event({ phase: value.phase, overall: value.overall, current: value.current,
          id: reading?.navigationRequestId || (refreshing ? refreshRequestId : gitBindings.get(path)?.requestId),
          startedAt: reading?.startedAt ?? (refreshing ? refreshStartedAt : gitBindings.get(path)?.startedAt) });
      };
      if (reading || refreshing) {
        const count = reading && Number.isSafeInteger(reading.metadataTotal) ? Progress.known('items', reading.metadataCompleted || 0, reading.metadataTotal) : null;
        setMeasurement(count ? Progress.event({ phase: 'metadata', overall: count, current: count }) : refreshMeasurements.get(path) || Progress.event({ phase: 'directory-reading', overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.unknown('items', 0, 'enumerating') }));
      } else if (gitPending.has(path)) {
        const binding = gitBindings.get(path);
        const completed = binding.directories.filter(directory => !gitPending.has(directory) && gitBindings.get(directory)?.requestId === binding.requestId).length;
        setMeasurement(Progress.event({ phase: 'git-query', overall: Progress.known('items', completed, binding.directories.length), current: gitProgress ? Progress.read(gitProgress).current : Progress.unknown('items', 0, 'native-operation') }));
      }
      if (stages.length) activities.push(t(side === 0 ? 'Links: {step} · {path}' : 'Rechts: {step} · {path}', { step: stages.join(' / '), path: displayArchivePath(reading?.path || path) }));
      section.querySelector('[data-refresh]')?.setAttribute('aria-busy', String(busy));
      const refreshIcon = section.querySelector('[data-refresh-icon]');
      if (refreshIcon) window.CommanderIcons.setFont(refreshIcon, busy ? 'loading' : 'refresh', busy);
      section.querySelector('[data-location-icon]')?.setAttribute('aria-busy', String(gitPending.has(path)));
      section.querySelector('[data-git-branch]')?.setAttribute('aria-busy', String(gitPending.has(path)));
    });
    for (const { paths, phase } of gitActivities.values()) {
      const step = ({ 'git-locate': 'Git-Repository suchen', 'git-read-head': 'Git-Branch und Referenzen lesen', 'git-wait': 'Git-Prüfung wartet auf Ausführung', 'git-read-worktree': 'Git-Index und Arbeitsbaum prüfen', 'git-map-status': 'Git-Dateistatus zuordnen', 'git-discover': 'Git-Unterverzeichnisse prüfen', 'git-dirty-check': 'Git-Änderungsstatus prüfen', 'git-cache': 'Gespeicherten Git-Status übernehmen' })[phase];
      activities.push(`${t('Git-Abfrage')}${step ? ` · ${t(step)}` : ''} · ${paths.join(' | ')}`);
    }
    if (refreshPlan) {
      const snapshot = refreshPlan.progress.snapshot();
      if (snapshot.plan.done) refreshPlan = null;
      else {
        planned = snapshot;
        if (refreshPlan.saving) activities.push(t('Ansichtszustand speichern'));
        if (!activities.length) activities.push(t(refreshPlan.filesystemDone ? 'Git-Abfrage' : 'Dateiliste bereitstellen'));
      }
    }
    for (const task of statusTasks.values()) { activities.push(task.label); if (!refreshPlan) measured = task.progress; }
    statusbar.setActivity(activities.join(' | '), planned || (measured ? plannedStatus(measured) : null));
    if (!measured && !transferJob && transferStatusPlan?.snapshot().plan.state !== 'running') statusPlans.clear();
  }
  function invalidateChangedDirectories(previousFolders, forced = []) {
    const changed = [...new Set(state.panes.filter(pane => !resultView(pane)).map(currentPath))].filter(directory => JSON.stringify(previousFolders[directory]) !== JSON.stringify(state.folders[directory]));
    for (const directory of [...changed, ...forced]) gitBindings.delete(directory);
    const affected = value => [...changed, ...forced].some(directory => value === directory || value.startsWith(directory + '/') || directory.startsWith(value + '/'));
    for (const directory of folderSizes.keys()) if (affected(directory)) folderSizes.delete(directory);
    for (const [operationId, request] of folderSizeRequests) if (affected(request.path)) { host?.postMessage({ type: 'filesystem-cancel', operationId }); folderSizeRequests.delete(operationId); statusTasks.delete(operationId); }
    if (!folderSizeRequests.size) folderSizeBatch = null;
  }
  function requestGitStatus() {
    if (!host || !startupReady || !state.realFilesystem) return;
    const directories = [...new Set(state.panes.filter(p => !resultView(p)).map(currentPath).filter(path => !isArchiveLocation(path)))];
    for (const directory of gitPending) if (!directories.includes(directory) || !gitBindings.has(directory)) gitPending.delete(directory);
    for (const directory of gitDirectories.keys()) if (!directories.includes(directory)) gitDirectories.delete(directory);
    for (const directory of gitBindings.keys()) if (!directories.includes(directory)) { gitBindings.delete(directory); gitDirectories.delete(directory); gitPending.delete(directory); }
    const requested = directories.filter(directory => !gitBindings.has(directory) && ![...navigationRequests.values()].some(request => request.path === directory));
    if (!requested.length) { updateDirectoryActivity(); return; }
    const request = { type: 'git-status', requestId: `git-${++gitSequence}`, snapshotId: state.snapshotId, directories: requested, visibleDirectories: directories };
    if (!refreshPlan) {
      const progress = Progress.statusPlan({ id: request.requestId, startedAt: performance.now(), steps: requested.map(path => `git:${JSON.stringify(path)}`) }), repositories = new Map();
      for (const path of requested) {
        const root = `git:${JSON.stringify(path)}`, [describe, inspect, publication] = progress.append(root, ['describe', 'inspect', 'publication']);
        progress.openPlanning(root);
        repositories.set(path, { root, describe, inspect, publication, active: null, stage: null, key: null, sequence: 0, total: 0, completed: 0 });
      }
      refreshPlan = { progress, filesystem: new Map(), repositories, confirmed: new Set(), directories: [], gitDirectories: requested, filesystemDone: true, saving: false, gitRequest: null };
    }
    if (refreshPlan?.filesystemDone && !refreshPlan.gitRequest && !refreshPlan.progress.snapshot().plan.done) {
      refreshPlan.gitRequest = { ...request, pending: new Set(requested) };
      for (const path of requested) { const job = refreshPlan.repositories.get(path); if (job) { refreshPlan.progress.start(job.root); refreshPlan.progress.start(job.describe); } }
    }
    const startedAt = performance.now();
    for (const directory of requested) { gitBindings.set(directory, { ...request, startedAt }); gitPending.add(directory); }
    refreshVisibleIcons();
    updateDirectoryActivity();
    host.postMessage(request);
  }
  function isArchiveLocation(path) {
    return Boolean(state.archiveLocations?.[path] || path.startsWith('zip:') || !state.realFilesystem && /\.zip!(?:\/|$)/i.test(path));
  }
  function locationKind(p) {
    const path = currentPath(p);
    if (isArchiveLocation(path)) return 'zip';
    const info = gitInfo(path);
    return info?.repositoryDetected || info?.ok && info.repository ? 'git' : '';
  }
  function locationMarkup(p) {
    return window.CommanderIcons.location(locationKind(p));
  }
  function branchMarkup(p) {
    const info = gitInfo(currentPath(p));
    if (!info?.ok || !info.repository) return '';
    const branch = info.detached ? `${t('Detached HEAD')} ${String(info.head || '').slice(0, 8)}` : info.branch;
    return branch ? `<button type="button" data-git-branch aria-busy="${gitPending.has(currentPath(p))}" title="${escape(t('Verfügbare Branches'))}" aria-label="${escape(t('Verfügbare Branches'))}: ${escape(branch)}">(${escape(branch)})</button>` : '';
  }
  function icon(file, directory) {
    const original = baseIcon(file, directory);
    const info = gitInfo(directory);
    const error = gitEntryError(directory, file.name);
    if (error) {
      const label = escape(t('Git-Prüfung fehlgeschlagen: {error}', { error }));
      return `<span class="git-icon">${original}<span data-git-status="error" role="img" aria-label="${label}" title="${label}">${window.CommanderIcons.svg('workbench', 'error')}</span></span>`;
    }
    const status = info?.ok && info.statuses?.[file.name];
    if (!status && emptyGitFolder(directory, file)) {
      const label = escape(t('Leer – von Git nicht erfasst'));
      return `<span class="git-icon">${original}<span data-git-status="empty" role="img" aria-label="${label}" title="${label}">${window.CommanderIcons.svg('status', 'empty')}</span></span>`;
    }
    const labels = { clean: 'Unverändert', modified: 'Geändert', added: 'Hinzugefügt', deleted: 'Gelöscht', untracked: 'Unversioniert', ignored: 'Ignoriert', conflict: 'Konflikt' };
    if (!labels[status]) {
      const confirmed = info?.ok && info.loading && (info.repository || file.type === 'folder' && info.loadingRepositories?.includes(file.name));
      if (!confirmed) return host && state.realFilesystem ? `<span class="git-icon">${original}</span>` : original;
      return `<span class="git-icon">${original}<span data-git-placeholder role="img" aria-label="${escape(t('Git-Status wird geladen'))}" title="${escape(t('Git-Status wird geladen'))}">${window.CommanderIcons.svg('status', 'untracked')}</span></span>`;
    }
    return `<span class="git-icon">${original}<span data-git-status="${status}" role="img" aria-label="${escape(t(labels[status]))}" title="${escape(t(labels[status]))}">${window.CommanderIcons.svg('status', status)}</span></span>`;
  }
  function gitEntryError(directory, name) {
    const errors = gitInfo(directory)?.repositoryErrors;
    return errors && Object.hasOwn(errors, name) && typeof errors[name] === 'string' ? errors[name] : null;
  }
  function emptyGitFolder(directory, file) {
    const info = gitInfo(directory), target = file.fsSource || join(directory, file.name);
    return file.type === 'folder' && info?.ok && !info.error && info.repository && !info.loading && !info.statuses?.[file.name] &&
      !gitEntryError(directory, file.name) && !state.archiveLocations?.[directory] &&
      Object.hasOwn(state.folders, target) && !state.unloadedFolders?.includes(target) && state.folders[target].length === 0;
  }
  function refreshGitDisplay() {
    refreshVisibleIcons();
    document.querySelectorAll('.pane').forEach((section, index) => {
      const icon = section.querySelector('[data-location-icon]');
      if (icon && !section.querySelector('[data-favorites][aria-expanded="true"]') && icon.dataset.locationIcon !== locationKind(state.panes[index])) icon.outerHTML = locationMarkup(state.panes[index]);
      const location = section.querySelector('[data-git-location]');
      if (!location) return;
      const info = gitInfo(currentPath(state.panes[index]));
      section.querySelector('.path-input').title = info?.error ? t('Git-Status nicht verfügbar: {error}', { error: info.error }) : '';
      const html = branchMarkup(state.panes[index]);
      const template = document.createElement('template'); template.innerHTML = html;
      if (location.innerHTML !== template.innerHTML) {
        const focused = location.contains(document.activeElement);
        const next = location.cloneNode(false); next.innerHTML = html; patchView(location, next);
        if (focused) (location.querySelector('button') || section.querySelector('.path-input')).focus({ preventScroll: true });
      }
    });
    refreshLocationColors();
    updateDirectoryActivity();
    refreshSelection();
  }
  const fileColorCache = new Map();
  let fileColorRuleSource, matchFileColor;
  function refreshLocationColors() {
    const colors = window.CommanderFileColors;
    const body = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
    const variable = name => body.getPropertyValue(name).trim() || root.getPropertyValue(name).trim();
    const base = colors.composite(variable('--vscode-sideBar-background') || variable('--vscode-editor-background') || '#252526', '#252526');
    const foreground = variable('--vscode-foreground') || '#cccccc';
    document.querySelectorAll('[data-favorites]').forEach(button => {
      const section = button.closest('[data-pane]');
      const panel = section.classList.contains('active') ? colors.composite(variable('--vscode-list-inactiveSelectionBackground') || base, base) : base;
      const background = colors.composite(getComputedStyle(button.parentElement).backgroundColor, panel) || panel;
      const hover = colors.composite(variable('--vscode-toolbar-hoverBackground') || variable('--vscode-list-hoverBackground') || '#2a2d2e', background) || background;
      const active = colors.composite(variable('--vscode-toolbar-activeBackground') || hover, background) || hover;
      const kind = button.querySelector('[data-location-icon]')?.dataset.locationIcon || '';
      const context = kind === 'git' ? 'Git' : kind === 'zip' ? 'ZIP' : t('Favoriten');
      button.setAttribute('aria-description', context);
      button.title = `${t('Ortsmenü: Favoriten und Aktionen')} · ${context}`;
      const desired = kind === 'git' ? '#f03c2e' : kind === 'zip' ? '#bd7900' : '#e5bc22';
      const values = {
        '--location-color': colors.readable(desired, background, foreground),
        '--location-hover-color': colors.readable(desired, hover, foreground),
        '--location-active-color': colors.readable(desired, active, foreground),
        '--location-hover-background': hover,
        '--location-active-background': active,
        '--location-star-color': colors.readable('#e5bc22', background, foreground),
        '--location-badge-background': background
      };
      for (const [name, value] of Object.entries(values)) if (button.style.getPropertyValue(name) !== value) button.style.setProperty(name, value);
    });
  }
  function refreshFileColors() {
    refreshLocationColors();
    const colors = window.CommanderFileColors, settings = fileSettings.colors || {};
    const requestedSize = fileSettings.gitStatus?.iconSizePercent;
    const iconSize = Number.isFinite(requestedSize) ? Math.round(Math.max(25, Math.min(100, requestedSize))) : window.CommanderIconLayout.defaults.badgeRatio * 100;
    if (!matchFileColor || fileColorRuleSource !== settings.rules) {
      fileColorRuleSource = settings.rules;
      matchFileColor = colors.compile(settings.rules || {});
    }
    const body = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
    const variable = name => body.getPropertyValue(name).trim() || root.getPropertyValue(name).trim();
    const background = variable('--vscode-sideBar-background') || variable('--vscode-editor-background') || '#252526';
    const foreground = variable('--vscode-sideBar-foreground') || variable('--vscode-foreground') || body.color;
    const hoverSource = variable('--vscode-list-hoverBackground') || variable('--hover');
    const hover = colors.composite(colors.parse(hoverSource) ? hoverSource : '#2a2d2e', background);
    const contrast = document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light');
    const badgeColors = {
      clean: ['gitDecoration-addedResourceForeground', '#008000'],
      modified: ['gitDecoration-modifiedResourceForeground', '#806000'],
      added: ['charts-blue', '#005bbb'],
      deleted: ['gitDecoration-deletedResourceForeground', '#b00020'],
      untracked: ['terminal-ansiCyan', '#007b83'],
      ignored: ['gitDecoration-ignoredResourceForeground', '#666666'],
      conflict: ['terminal-ansiMagenta', '#9b008a'],
      error: ['errorForeground', '#d13438']
    };
    const statusColor = status => {
      const entry = badgeColors[status];
      return entry ? variable(`--vscode-${entry[0]}`) || entry[1] : null;
    };
    const safe = (desired, back) => {
      const key = JSON.stringify([desired, back, foreground]);
      if (!fileColorCache.has(key)) fileColorCache.set(key, colors.readable(desired, back, foreground));
      return fileColorCache.get(key) || '';
    };
    const set = (element, key, value) => {
      if (element.style.getPropertyValue(key) !== value) value ? element.style.setProperty(key, value) : element.style.removeProperty(key);
    };
    document.querySelectorAll('.pane').forEach((section, index) => {
      const p = state.panes[index], entries = new Map(files(p).map(file => [String(file.id), file]));
      const surface = variable('--surface');
      const tabsBackground = colors.composite(variable('--vscode-editorGroupHeader-tabsBackground') || (colors.parse(surface) ? surface : variable('--vscode-sideBar-background') || '#252526'), background);
      for (const tab of section.querySelectorAll('[data-tab]')) {
        const tabPath = p.tabs[Number(tab.dataset.tab)];
        const archive = state.archiveLocations?.[tabPath]?.archive;
        const archiveColor = !contrast && settings.enabled !== false && archive ? matchFileColor(base(archive)) : null;
        const selected = tab.getAttribute('aria-selected') === 'true';
        const tabBackground = colors.composite(variable(selected ? '--vscode-tab-activeBackground' : '--vscode-tab-inactiveBackground') || (selected ? background : 'transparent'), tabsBackground);
        const tabHover = colors.composite(variable('--vscode-tab-hoverBackground') || 'transparent', tabBackground);
        set(tab, '--archive-tab-color', archiveColor ? safe(archiveColor, tabBackground) : '');
        set(tab, '--archive-tab-hover', archiveColor ? safe(archiveColor, tabHover) : '');
      }
      const table = section.querySelector('.file-table');
      if (!table) return;
      for (const selection of ['active', 'inactive']) {
        const back = colors.composite(variable(`--vscode-list-${selection}SelectionBackground`), background);
        const front = variable(`--vscode-list-${selection}SelectionForeground`) || foreground;
        set(table, `--${selection}-selection-text`, safe(front, back));
        set(table, `--${selection}-space-mark-text`, contrast ? '' : safe(variable('--vscode-list-highlightForeground') || variable('--vscode-textLink-foreground') || front, back));
      }
      for (const row of section.querySelectorAll('tr[data-id]')) {
        const file = entries.get(row.dataset.id), name = row.querySelector('[data-filename]');
        if (!file || !name) continue;
        const desired = !contrast && settings.enabled !== false && file.type !== 'folder' ? matchFileColor(file.name) : null;
        const error = gitEntryError(currentPath(p), file.name);
        const title = error ? t('Git-Prüfung fehlgeschlagen: {error}', { error }) : emptyGitFolder(currentPath(p), file) ? t('Leer – von Git nicht erfasst') : '';
        if (row.title !== title) row.title = title;
        const status = error ? 'error' : gitInfo(currentPath(p))?.statuses?.[file.name];
        const gitColor = !contrast && settings.git !== false ? statusColor(status) : null;
        const nameColor = file.type === 'folder' ? gitColor : desired;
        const rowColor = file.type !== 'folder' && (!status || ['clean', 'untracked', 'ignored'].includes(status)) ? desired : gitColor;
        set(name, '--file-type-color', nameColor ? safe(nameColor, background) : '');
        set(name, '--file-type-hover', nameColor ? safe(nameColor, hover) : '');
        set(row, '--git-text-color', rowColor ? safe(rowColor, background) : '');
        set(row, '--git-hover-color', rowColor ? safe(rowColor, hover) : '');
      }
      for (const placeholder of section.querySelectorAll('[data-git-placeholder]')) {
        set(placeholder, 'width', `${iconSize}%`);
        set(placeholder, 'height', `${iconSize}%`);
      }
      for (const badge of section.querySelectorAll('[data-git-status]')) {
        set(badge, 'width', `${iconSize}%`);
        set(badge, 'height', `${iconSize}%`);
        const status = badge.dataset.gitStatus;
        if (status === 'empty') { badge.style.removeProperty('--git-badge-color'); continue; }
        const desired = statusColor(status) || statusColor('modified');
        set(badge, '--git-badge-color', safe(desired, '#ffffff'));
      }
    });
    if (fileColorCache.size > 512) fileColorCache.clear();
  }
  function baseIcon(file, directory) {
    if (file.type === 'folder') return window.CommanderIcons.folder();
    const key = file.iconKey || join(directory || '', file.name);
    if (nativeIcons.get(key)) return window.CommanderIcons.native(nativeIcons.get(key));

    const baseTheme = iconTheme.base || {};
    const override = document.body.classList.contains('vscode-high-contrast') ? iconTheme.highContrast : document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? iconTheme.light : {};
    const association = { ...baseTheme, ...override };
    const name = file.name.toLowerCase(), parentName = base(directory || '').toLowerCase();
    const mapping = key => ({ ...baseTheme[key], ...override?.[key] });
    let themed;
    if (file.type === 'folder') themed = mapping('folderNames')[`${parentName}/${name}`] || mapping('folderNames')[name] || association.folder;
    else {
      themed = mapping('fileNames')[`${parentName}/${name}`] || mapping('fileNames')[name];
      const extensions = mapping('fileExtensions');
      for (let dot = name.indexOf('.'); !themed && dot !== -1; dot = name.indexOf('.', dot + 1)) {
        const suffix = name.slice(dot + 1);
        themed = extensions[`${parentName}/${suffix}`] || extensions[suffix];
      }
      const language = ({ md: 'markdown', ts: 'typescript', js: 'javascript', json: 'json', svg: 'xml', txt: 'plaintext', csv: 'csv' })[extension(file)];
      themed ||= mapping('languageIds')[language] || association.file;
    }
    return themed ? window.CommanderIcons.theme(themed) : window.CommanderIcons.fallback(file.type);
  }
  function requestIcons() {
    if (!host) return;
    const requests = new Map();
    state.panes.forEach(p => {
      files(p).forEach(file => {
        if (file.type === 'folder') return;
        const key = entryPath(p, file);
        requests.set(key, { key, path: key, name: file.name, type: file.type === 'folder' ? 'folder' : 'file' });
      });
    });
    const pending = [...requests.values()].filter(item => !requestedIcons.has(item.key)).slice(0, 128);
    if (!pending.length) return;
    pending.forEach(item => requestedIcons.add(item.key));
    host.postMessage({ type: 'icons', requests: pending });
  }
  function displayedIconEntries() {
    return new Map(state.panes.flatMap(p => files(p).filter(file => file.type !== 'folder').map(file => [entryPath(p, file), JSON.stringify(file)])));
  }
  function refreshVisibleIcons() {
    document.querySelectorAll('.pane').forEach((section, index) => {
      const p = state.panes[index];
      const byId = new Map(files(p).map(file => [file.id, file]));
      const replace = (element, html) => {
        if (!element) return;
        const temp = document.createElement('template'); temp.innerHTML = html;
        const fresh = temp.content.firstElementChild;
        const original = element.matches('.fileicon') ? element : element.querySelector('.fileicon');
        const nextOriginal = fresh.matches('.fileicon') ? fresh : fresh.querySelector('.fileicon');
        if (original.outerHTML !== nextOriginal.outerHTML) original.replaceWith(nextOriginal);
        const retained = original.isConnected ? original : nextOriginal;
        if (!fresh.matches('.git-icon')) {
          if (element.matches('.git-icon')) element.replaceWith(retained);
          return;
        }
        if (!element.matches('.git-icon')) {
          const wrapper = document.createElement('span'); wrapper.className = 'git-icon';
          retained.replaceWith(wrapper); wrapper.append(retained);
          element = wrapper;
        }
        const oldBadge = element.querySelector('[data-git-status]'), newBadge = fresh.querySelector('[data-git-status]');
        const placeholder = element.querySelector('[data-git-placeholder]');
        if (newBadge) {
          if (oldBadge?.dataset.gitStatus === newBadge.dataset.gitStatus) {
            if (oldBadge.title !== newBadge.title) { oldBadge.title = newBadge.title; oldBadge.setAttribute('aria-label', newBadge.getAttribute('aria-label')); }
            return;
          }
          oldBadge?.remove();
          if (placeholder) {
            placeholder.classList.add('git-placeholder-leave');
            placeholder.setAttribute('aria-hidden', 'true'); placeholder.removeAttribute('role');
            placeholder.removeAttribute('aria-label'); placeholder.removeAttribute('title');
            newBadge.classList.add('git-status-enter');
          }
          element.append(newBadge);
        } else {
          oldBadge?.remove();
          const nextPlaceholder = fresh.querySelector('[data-git-placeholder]');
          if (!nextPlaceholder) { placeholder?.remove(); return; }
          if (!placeholder || placeholder.classList.contains('git-placeholder-leave')) {
            placeholder?.remove(); element.append(nextPlaceholder);
          }
        }
      };
      section.querySelectorAll('tr[data-id]').forEach(row => {
        const file = byId.get(row.dataset.id);
        if (file) replace(row.querySelector('.git-icon') || row.querySelector('.fileicon'), icon(file, currentPath(p)));
      });
    });
    refreshFileColors();
  }
  function refreshHighlight() {
    const highlight = CommanderContrast.highlight(getComputedStyle(document.body).getPropertyValue('--vscode-list-filterMatchBackground'));
    $('#panes').style.setProperty('--match-background', highlight.background);
    $('#panes').style.setProperty('--match-foreground', highlight.foreground);
  }
  function applySearch(query, direction = 0, focusList = true) {
    const p = pane();
    p.filter = query;
    const found = search.find(visible(p), query, p.cursor, direction);
    if (found) { p.cursor = found.id; p.selected = [found.id]; }
    render(focusList);
    if (found) activeRow(found.id)?.scrollIntoView({ block: 'nearest' });
  }
  let renameTimer;
  let lastNameClick = 0;
  function moveResultReferences(before, after) {
    const moves = (Array.isArray(before) ? before : [[before, after]]).sort((a, b) => b[0].length - a[0].length);
    for (const p of state.panes) for (const tab of p.tabStates || []) {
      const result = tab.searchResult; if (!result) continue;
      const replace = value => { const move = moves.find(([before]) => value === before || value.startsWith(before + '/')); return move ? move[1] + value.slice(move[0].length) : value; };
      result.paths = result.paths.map(replace);
      if (result.groups) result.groups = Object.fromEntries(Object.entries(result.groups).map(([key, value]) => [replace(key), value]));
    }
  }
  function startRename(proposal, confirmed) {
    if (filesystemPending || navigationRequests.size) return;
    clearTimeout(renameTimer);
    const p = pane(), file = files(p).find(item => item.id === p.cursor) || selected()[0];
    if (!file) return;
    const source = resultView(p) ? parent(file.fsSource) : currentPath(p);
    if (confirmed && (confirmed.side !== state.active || confirmed.source !== source || confirmed.id !== file.id || confirmed.name !== file.name)) return;
    if (file.archive && !state.archiveLocations?.[source]) return toast(t('Dateioperationen innerhalb von Archiven sind nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.'));
    const target = activeRow(file.id)?.querySelector('[data-filename]');
    if (!target) return;
    const existing = target.querySelector('input');
    if (existing) { existing.focus(); existing.setSelectionRange(0, columns.splitName({ ...file, name: existing.value }).name.length); return; }
    const oldName = file.name;
    const originalNameNodes = [...target.childNodes];
    const input = document.createElement('input'); input.className = 'inline-rename'; input.value = typeof proposal === 'string' ? proposal : oldName; input.setAttribute('aria-label', t('Name bearbeiten'));
    target.replaceChildren(input); input.focus(); input.select();
    let finished = false;
    function finish(commit, completed) {
      if (finished) return;
      const name = input.value;
      const reserved = /^[a-z]:\//i.test(source) && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0].trimEnd());
      if (commit && name !== oldName && (!validName(name) || [...name].some(character => character.charCodeAt(0) < 32) || reserved || (state.folders[source] || []).some(other => other !== file && other.name.toLowerCase() === name.toLowerCase()))) { toast(t('Der Name ist ungültig oder bereits vergeben.')); input.focus(); return; }
      if (commit && name !== oldName && file.type === 'folder') {
        const context = { side: state.active, source, id: file.id, name: oldName };
        if (prepareFolders([join(source, oldName)], 'rename-one', () => startRename(name, context))) { finished = true; return; }
      }
      finished = true;
      if (commit && name !== oldName) rememberSelection(p);
      if (commit && name !== oldName && state.archiveLocations?.[source]) {
        render(true); sendZipWrite({ action: 'rename', path: source, ids: [file.id], name }, completed); return;
      }
      if (commit && name !== oldName) {
        if (state.realFilesystem) renameFailure = { before: clone(state), side: state.active, source, oldName, proposal: name };
        const before = join(source, oldName), after = join(source, name);
        moveResultReferences(before, after);
        const moved = Object.entries(state.folders).filter(([key]) => inTree(key, before, file.type === 'archive'));
        moved.forEach(([key]) => delete state.folders[key]); moved.forEach(([key, value]) => { state.folders[after + key.slice(before.length)] = value; });
        state.panes.forEach(side => {
          side.tabs = side.tabs.map(path => inTree(path, before, file.type === 'archive') ? after + path.slice(before.length) : path);
        });
        file.name = name;
      }
      const pending = state.realFilesystem && JSON.stringify(state.folders) !== confirmedFolders;
      if (pending && completed) filesystemResume = completed;
      render(true);
      if (commit && name !== oldName && !pending) toast(t('Eintrag umbenannt.'), 'success');
      if (!pending) completed?.();
    }
    input.addEventListener('keydown', event => {
      if (event.key === 'F6' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); startRename(); return; }
      if (['ArrowUp', 'ArrowDown'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && file.type !== 'folder' && p.selected.length === 1 && p.selected[0] === file.id) {
        const list = visible(p).filter(item => item.type !== 'folder'), index = list.findIndex(item => item.id === file.id);
        const next = list[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (!next) return;
        event.preventDefault(); event.stopPropagation();
        const side = state.active, name = next.name, fsSource = next.fsSource;
        finish(true, () => {
          const view = state.panes[side];
          if (currentPath(view) !== source) return;
          const adjacent = (state.folders[source] || []).find(item => fsSource ? item.fsSource === fsSource : item.name === name);
          if (!adjacent) return;
          state.active = side; view.cursor = adjacent.id; view.selected = [adjacent.id]; render(true); startRename();
        }); return;
      }
      if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter'); }
    });
    input.addEventListener('blur', event => {
      if (finished || event.relatedTarget?.closest('.operation-error')) return;
      finished = true; target.replaceChildren(...originalNameNodes); queueMicrotask(reportFocus);
    });
    if (confirmed) finish(true);
  }
  function restoreRename(failure) {
    const view = state.panes[failure.side];
    const original = (state.folders[failure.source] || []).find(file => file.name === failure.oldName);
    if (!original || currentPath(view) !== failure.source) return false;
    state.active = failure.side; view.cursor = original.id; view.selected = [original.id];
    render(); startRename(failure.proposal);
    return Boolean(document.querySelector('.inline-rename'));
  }
  function highlight(value, query) {
    const text = String(value);
    const hit = search.range(text, query);
    return hit ? `${escape(text.slice(0, hit.start))}<mark>${escape(text.slice(hit.start, hit.end))}</mark>${escape(text.slice(hit.end))}` : escape(text);
  }
  function isFilenameColumn(column) {
    return column.field === undefined ? column.key === 'name' : /\[=(?:file|tc)\.(?:name|fullname)\]/.test(column.field);
  }
  function renderFileCell(original, column, p) {
      const file = displayFile(original, p);
      const result = column.field === undefined ? null : columnModel.evaluateColumnTemplate(file, column.field);
      const unavailable = result?.unavailableFields;
      const text = unavailable?.length ? t('Nicht verfügbar: {field}', { field: unavailable.join(', ') }) : columns.displayValue(file, column.field === undefined ? column.key : column);
      const isName = isFilenameColumn(column);
      const content = isName ? `<span class="filename">${icon(file, currentPath(p))}<span data-filename>${highlight(text, p.filter)}</span>${resultView(p) ? `<span data-result-source class="result-source" title="${escape(displayPath(file.fsSource))}">${escape(displayPath(parent(file.fsSource)))}</span>` : ''}</span>` : highlight(text, column.key === 'type' && p.filter.startsWith('.') ? p.filter.slice(1) : p.filter);
      return `<td data-cell="${escape(column.key)}" title="${escape(file.name)}" class="column-align-${column.align || 'left'}">${content}</td>`;
  }
  function sizePaneColumns(section, p, forcedKey) {
    const table = section.querySelector('.file-table');
    if (!table) return;
    const signature = JSON.stringify(p.columns.map(({ key, label, field, visible, align }) => ({ key, label, field, visible, align })));
    const path = currentPath(p), rows = files(p), source = resultView(p) || rows;
    const cellStyle = getComputedStyle(table.querySelector('td') || section);
    const font = cellStyle.font || `${cellStyle.fontSize || '13px'} ${cellStyle.fontFamily || 'sans-serif'}`;
    const previous = columnSizing.get(p), changed = !previous || previous.path !== path || previous.signature !== signature;
    const cached = directoryCache.getColumns(path)?.[state.panes.indexOf(p)];
    const restored = changed && cached?.signature === signature;
    let manual = changed ? restored ? { ...cached.manual } : {} : previous.manual;
    if (restored) p.columns = p.columns.map(column => ({ ...column, width: cached.widths[column.key] ?? column.width }));
    const measure = forcedKey !== undefined || restored && cached.font !== font || !restored && (changed || previous.source !== source || previous.count !== rows.length || previous.font !== font);
    if (measure) {
      const context = document.createElement('canvas').getContext('2d');
      if (context) {
        const widths = new Map();
        context.font = font;
        const grid = window.CommanderIcons.layout(), fileIconSize = grid.size;
        const byId = new Map(rows.map(file => [file.id, file]));
        const clipboardPaths = new Set(clipboardSelection?.paths.map(fileIdentity));
        let markerWidth = 0;
        for (const row of table.querySelectorAll('tr[data-id]')) {
          const marked = fileMarkerState(byId.get(row.dataset.id), path, clipboardPaths);
          markerWidth = Math.max(markerWidth, marked.cut ? fileIconSize : marked.copied ? fileIconSize / 2 : 0);
        }
        for (const header of table.querySelectorAll('th[data-column]')) {
          const key = header.dataset.column;
          if (forcedKey !== undefined ? key !== forcedKey : manual[key]) continue;
          const button = header.querySelector('button'), headerStyle = getComputedStyle(button);
          context.font = headerStyle.font || `${headerStyle.fontSize || '12px'} ${headerStyle.fontFamily || 'sans-serif'}`;
          const inset = header.classList.contains('filename-column') ? fileIconSize + grid.gap + markerWidth + (markerWidth ? grid.gap : 0) : 0;
          const padding = 10 + (button.querySelector('.column-sort') ? fileIconSize + grid.gap : 0);
          widths.set(key, context.measureText(button.querySelector('.column-caption').textContent).width + padding + inset);
        }
        context.font = font;
        for (const cell of table.querySelectorAll('tbody td[data-cell]')) {
          const key = cell.dataset.cell;
          if (!widths.has(key)) continue;
          const padding = cell.querySelector('.filename') ? 10 + grid.gap + fileIconSize + markerWidth + (markerWidth ? grid.gap : 0) : 16;
          widths.set(key, Math.max(widths.get(key), context.measureText(cell.textContent.trim()).width + padding));
        }
        for (const [key, width] of widths) p.columns = columns.resizeColumn(p.columns, key, width);
        if (forcedKey !== undefined) manual = { ...manual, [forcedKey]: true };
      }
    }
    columnSizing.set(p, { path, signature, source, count: rows.length, font, manual });
    layoutPaneColumns(section, p);
    if (!directoryCache.get(path) && state.folders[path] && !state.unloadedFolders?.includes(path)) directoryCache.set(path, state.folders[path]);
    const widths = Object.fromEntries(p.columns.map(column => [column.key, column.width]));
    if (JSON.stringify(cached) !== JSON.stringify({ signature, widths, manual, font })) cacheColumnWidths(p, { signature, widths, manual, font });
  }
  function layoutPaneColumns(section, p) {
    const table = section.querySelector('.file-table');
    if (!table) return;
    const visible = p.columns.filter(column => column.visible !== false);
    const name = visible.find(isFilenameColumn) || visible.at(-1), available = section.querySelector('.list').clientWidth;
    const widths = new Map(visible.map(column => [column.key, column.width]));
    if (name && available > 0) {
      const manual = columnSizing.get(p)?.manual || {};
      const minimumWidth = column => column !== name && manual[column.key] ? column.width : column.minWidth;
      const minimum = visible.reduce((sum, column) => sum + minimumWidth(column), 0);
      const otherWidth = visible.reduce((sum, column) => sum + (column === name ? 0 : column.width), 0);
      const otherMinimum = minimum - name.minWidth;
      const manualName = manual[name.key];
      const reserved = Math.min(name.width, available - otherMinimum);
      const factor = otherWidth > otherMinimum ? Math.min(1, (available - reserved - otherMinimum) / (otherWidth - otherMinimum)) : 1;
      let used = 0;
      for (const column of visible) {
        if (column === name) continue;
        const minWidth = minimumWidth(column);
        const width = Math.floor(minimum > available ? minWidth * available / minimum : minWidth + (column.width - minWidth) * factor);
        widths.set(column.key, width); used += width;
      }
      widths.set(name.key, manualName && factor === 1 ? Math.min(name.width, available - used) : available - used);
    }
    let total = 0;
    for (const col of table.querySelectorAll('col[data-col]')) {
      const column = visible.find(column => column.key === col.dataset.col);
      const width = widths.get(column.key);
      col.width = width; total += width;
    }
    table.style.width = `${total}px`;
  }
  const columnResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const { target } of entries) {
      const section = target.closest('[data-pane]');
      if (section?.isConnected) layoutPaneColumns(section, state.panes[Number(section.dataset.pane)]);
    }
  }) : null;
  window.addEventListener('resize', () => document.querySelectorAll('.pane').forEach((section, index) => layoutPaneColumns(section, state.panes[index])));
  window.addEventListener('pagehide', () => columnResizeObserver?.disconnect(), { once: true });
  function cacheColumnWidths(p, value) {
    const path = currentPath(p);
    directoryCache.setColumns(path, { ...directoryCache.getColumns(path), [state.panes.indexOf(p)]: value });
  }
  function rememberColumnWidth(p, key) {
    const sizing = columnSizing.get(p);
    if (!sizing || sizing.path !== currentPath(p)) return;
    sizing.manual[key] = true;
    cacheColumnWidths(p, { signature: sizing.signature, widths: Object.fromEntries(p.columns.map(column => [column.key, column.width])), manual: sizing.manual, font: sizing.font });
  }
  function renderPane(p, index) {
    tabs.ensure(p);
    prepareColumns(p);
    const displayColumns = p.columns.filter(column => column.visible !== false);
    const list = visible(p), marked = selectedFor(p), selectedIds = new Set(p.selected), spaceIds = new Set(spaceMarks(p));
    const cell = (file, column) => renderFileCell(file, column, p);
    return ui`<section class="pane ${state.active === index ? 'active' : ''}" data-pane="${index}" data-tab-key="${p.tabStates[p.tab].id}" data-directory="${escape(currentPath(p))}" aria-label="${index === 0 ? t('Linke') : t('Rechte')} Dateiliste">
      <div class="pane-label"><span>${index === 0 ? t('LINKE') : t('RECHTE')} DATEILISTE</span><span>${state.active === index ? t('AKTIV') : t('GEGENSEITE')}</span></div>
      <div class="tabs" data-vscode-context='{"webviewSection":"address","preventDefaultContextMenuItems":true}' role="tablist" aria-label="Ordner-Tabs ${index === 0 ? t('links') : t('rechts')}">${p.tabs.map((path, tab) => ui`<div class="tab-wrap ${p.tab === tab ? 'selected' : ''}" draggable="true" data-tab-drag="${tab}"><button class="tab" role="tab" aria-selected="${p.tab === tab}" data-tab="${tab}" title="${escape(displayArchivePath(path))} · Doppelklick schließt">${window.CommanderIcons.font('folder', { class: 'tab-icon' })}<span data-tab-label>${escape(p.tabStates[tab].searchResult?.label || archiveTabName(path))}</span></button></div>`).join('')}<button class="add-tab" data-new-tab title="Ordner-Tab hinzufügen" aria-label="Ordner-Tab hinzufügen">+</button></div>
      <div class="pathbar" data-vscode-context='{"webviewSection":"address","preventDefaultContextMenuItems":true}'><button data-favorites title="${escape(t('Ortsmenü: Favoriten und Aktionen'))}" aria-label="${escape(t('Ortsmenü: Favoriten und Aktionen'))}" aria-haspopup="menu" aria-expanded="false">${locationMarkup(p)}</button><div class="path"><div class="path-address"><div class="path-breadcrumbs">${breadcrumbMarkup(p)}<span data-path-edit></span></div><input class="path-input" data-vscode-context='{"webviewSection":"textInput","preventDefaultContextMenuItems":false}' aria-label="Pfad ${index === 0 ? t('links') : t('rechts')}" value="${escape(displayArchivePath(currentPath(p)))}" spellcheck="false"></div><span data-git-location>${branchMarkup(p)}</span></div><button data-refresh title="Liste aktualisieren" aria-label="Liste aktualisieren">${window.CommanderIcons.font('refresh', { 'data-refresh-icon': '' })}</button></div>
      <div class="pane-jobs" role="region" aria-label="${escape(t('Aufträge'))}" hidden></div>
      <div class="list" tabindex="0" aria-label="Dateien ${index === 0 ? t('links') : t('rechts')}"><table class="file-table" aria-label="Dateien und Ordner ${index === 0 ? t('links') : t('rechts')}"><colgroup>${displayColumns.map(column => `<col data-col="${escape(column.key)}" width="${column.width}">`).join('')}</colgroup><thead data-vscode-context='{"webviewSection":"columns","preventDefaultContextMenuItems":true}'><tr>${displayColumns.map(column => ui`<th data-column="${escape(column.key)}" class="column-align-${column.align || 'left'} ${isFilenameColumn(column) ? 'filename-column' : ''}" draggable="true" aria-sort="${p.sort === column.key ? p.descending ? 'descending' : 'ascending' : 'none'}"><button data-sort="${escape(column.key)}" title="${escape(t(column.label))}" aria-label="${escape(t(column.label))}"><span class="column-caption">${escape(t(column.label))}</span>${p.sort === column.key ? `${window.CommanderIcons.font(p.descending ? 'arrow-down' : 'arrow-up', { class: 'column-sort' }, p.descending ? ' ↓' : ' ↑')}` : ''}</button><span class="column-resize" data-resize="${escape(column.key)}" role="separator" aria-label="Breite ${escape(t(column.label))}" title="Ziehen: Breite ändern · Doppelklick: an Inhalt anpassen"></span></th>`).join('')}</tr></thead><tbody><tr class="parent-row" data-parent aria-label="${escape(t('Übergeordnetes Verzeichnis'))}" title="${escape(t('Übergeordnetes Verzeichnis'))}">${displayColumns.map(column => `<td data-cell="${escape(column.key)}">${column.key === 'name' ? '<span class="filename"><span>…</span></span>' : ''}</td>`).join('')}</tr>${list.map((file, rowIndex) => `<tr data-id="${escape(file.id)}" draggable="${!resultView(p)}" aria-selected="${selectedIds.has(file.id)}" class="${resultView(p)?.groups && rowIndex > 0 && resultView(p).groups[file.fsSource] !== resultView(p).groups[list[rowIndex - 1].fsSource] ? 'search-group-start' : ''} ${selectedIds.has(file.id) ? 'selected' : ''} ${spaceIds.has(file.id) ? 'space-marked' : ''} ${p.cursor === file.id ? 'focused' : ''}">${displayColumns.map(column => cell(file, column)).join('')}</tr>`).join('')}</tbody></table>${!displayColumns.length ? `<div class="empty">${t('Keine sichtbaren Spalten')}</div>` : list.length ? '' : ui(['<div class="empty">Keine Einträge</div>'])}</div>
      <div class="pane-status"><span><strong>${marked.length ? ui`${marked.length} markiert` : count('file', files(p).filter(f => f.type !== 'folder').length)}</strong> · ${count('folder', files(p).filter(f => f.type === 'folder').length)}</span><span>${size((marked.length ? marked : files(p)).reduce((sum, f) => sum + displayBytes(f, p), 0))}</span></div></section>`;
  }
  function selectedFor(p) { const ids = new Set(p.selected); return files(p).filter(file => ids.has(file.id)); }
  function spaceMarks(p) {
    const selected = new Set(p.selected);
    p.spaceMarked = (p.spaceMarked || []).filter(id => selected.has(id));
    return p.spaceMarked;
  }
  function refreshFolderSizeDisplay(path) {
    document.querySelectorAll('.pane').forEach((section, index) => {
      const p = state.panes[index];
      if (currentPath(p) !== parent(path)) return;
      const file = files(p).find(file => join(currentPath(p), file.name) === path);
      if (!file) return;
      const row = [...section.querySelectorAll('tr[data-id]')].find(row => row.dataset.id === file.id);
      for (const column of p.columns) {
        const cell = row && [...row.querySelectorAll('[data-cell]')].find(item => item.dataset.cell === column.key);
        if (!cell || cell.querySelector('input')) continue;
        const template = document.createElement('template');
        template.innerHTML = `<table><tbody><tr>${renderFileCell(file, column, p)}</tr></tbody></table>`;
        const html = template.content.querySelector('td').innerHTML;
        if (cell.innerHTML !== html) cell.innerHTML = html;
      }
      const marked = selectedFor(p);
      section.querySelector('.pane-status > span:last-child').textContent = size((marked.length ? marked : files(p)).reduce((sum, file) => sum + displayBytes(file, p), 0));
    });
  }
  function refreshSelection() {
    document.querySelectorAll('.pane').forEach((section, index) => {
      const p = state.panes[index], active = state.active === index, selectedIds = new Set(p.selected), spaceIds = new Set(spaceMarks(p));
      section.classList.toggle('active', active);
      section.querySelector('.pane-label span:last-child').innerHTML = active ? ui(['<i></i> AKTIV']) : t('GEGENSEITE');
      if (lister.has(index)) return;
      const workbenchContext = fileSettings.useSystemContextMenu !== true || ['linux', 'darwin'].includes(document.body.dataset.platform);
      const entriesById = workbenchContext ? new Map(files(p).map(file => [file.id, file])) : null;
      const effective = p.selected.length ? p.selected : p.cursor ? [p.cursor] : [];
      const folderContext = workbenchContext && state.realFilesystem && !resultView(p) && !state.archiveLocations?.[currentPath(p)] && effective.length === 1 && entriesById.get(effective[0])?.type === 'folder';
      const frozenContext = { directory: currentPath(p), ids: effective, snapshotId: state.snapshotId };
      const gitFile = Boolean(workbenchContext && state.realFilesystem && !resultView(p) && !state.archiveLocations?.[currentPath(p)] && effective.length === 1 && entriesById.get(effective[0]) && entriesById.get(effective[0]).type !== 'folder' && gitInfo(currentPath(p))?.ok && gitInfo(currentPath(p))?.repository);
      if (workbenchContext) section.querySelector('.list').dataset.vscodeContext = JSON.stringify({ webviewSection: folderContext ? 'folder' : 'files', preventDefaultContextMenuItems: true, fileMenu: true, gitFile, ...frozenContext });
      section.querySelectorAll('[data-id]').forEach(row => {
        if (workbenchContext) row.dataset.vscodeContext = JSON.stringify({ webviewSection: folderContext && row.dataset.id === effective[0] ? 'folder' : 'files', preventDefaultContextMenuItems: true, fileMenu: true, gitFile: gitFile && row.dataset.id === effective[0], ...frozenContext });
        row.classList.toggle('selected', selectedIds.has(row.dataset.id));
        row.classList.toggle('space-marked', spaceIds.has(row.dataset.id));
        row.classList.toggle('focused', p.cursor === row.dataset.id);
        row.setAttribute('aria-selected', String(selectedIds.has(row.dataset.id)));
      });
      const marked = selectedFor(p);
      section.querySelector('.pane-status').innerHTML = ui`<span><strong>${marked.length ? ui`${marked.length} markiert` : count('file', files(p).filter(f => f.type !== 'folder').length)}</strong> · ${count('folder', files(p).filter(f => f.type === 'folder').length)}</span><span>${size((marked.length ? marked : files(p)).reduce((sum, f) => sum + displayBytes(f, p), 0))}</span>`;
    });
    lister.updateMenu();
    persist();
  }
  const actions = [['F2', t('Umbenennen'), 'rename-one'], ['F3', t('Anzeigen'), 'view'], ['F4', t('Bearbeiten'), 'edit'], ['F5', t('Kopieren'), 'copy'], ['F6', t('Verschieben'), 'move'], ['F7', t('Neuer Ordner'), 'mkdir'], ['F8', t('Löschen'), 'delete']];
  const lister = window.CommanderListerView.create({ host, state: () => state, t, escape, modal, restore: render, edit: file => preview(file, true), notify: toast, report: reportStatus, remember: rememberScroll, task: statusTask });
  const fileSearch = window.CommanderFileSearch.create({ host, t, escape, report: reportStatus, task: statusTask,
    context: () => ({ path: currentPath(pane()), selected: selected().map(row => row.fsSource || join(currentPath(pane()), row.name)), side: state.active, state }),
    apply: (fresh, rows, source, id, name) => {
      const view = clone(state.panes); state = fresh; state.panes = view; state.active = source.side;
      confirmedFolders = JSON.stringify(state.folders); rememberScroll();
      const p = state.panes[source.side], previous = tabs.remember(p);
      const returnTo = { id: previous.id, path: previous.path, view: clone(previous.view) };
      tabs.openPath(p, source.path);
      p.tabStates[p.tab].searchResult = { id, label: `${t('Suche')}: ${name}`, source: source.path, returnTo, paths: rows.map(row => row.fsSource), archiveRows: rows.filter(row => row.archive), groups: Object.fromEntries(rows.filter(row => row.group !== undefined).map(row => [row.fsSource, row.group])) };
      render(true);
    },
    navigate: (message, source) => {
      const view = clone(state.panes); state = message.state; state.panes = view; state.active = source.side; confirmedFolders = JSON.stringify(state.folders);
      if (message.newTab) tabs.openPath(pane(), parent(message.path)); else { delete pane().tabStates[pane().tab].searchResult; tabs.navigate(pane(), parent(message.path)); }
      const row = files(pane()).find(row => row.fsSource === message.path); pane().cursor = row?.id || null; render(true);
    },
    preview: (row, edit) => preview(row, edit),
    restoreFocus: () => { document.querySelector('.pane.active .list')?.focus(); }
  });
  function rememberScroll() {
    document.querySelectorAll('.pane').forEach((section, index) => {
      const p = state.panes[index]; tabs.ensure(p);
      if (section.dataset.tabKey === p.tabStates[p.tab].id && section.dataset.directory === currentPath(p) && section.querySelector('.list')) p.scrollTop = section.querySelector('.list').scrollTop;
    });
  }
  function paneDisplayState(p, index) {
    return JSON.stringify([p, index === state.active, state.realFilesystem, p.tabs.map(displayArchivePath), files(p).map(file => displayFile(file, p))]);
  }
  function patchView(current, next) {
    if (current.nodeType === 3) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
    if (current.nodeType !== 1) return;
    if (current.classList.contains('pane-jobs') && next.classList.contains('pane-jobs')) return;
    const changedValue = current.matches('input') && current.getAttribute('value') !== next.getAttribute('value');
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of next.attributes) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (changedValue) current.value = next.value;
    const key = node => node.nodeType === 1 ? node.getAttribute('data-id') || node.id || undefined : undefined;
    const keyed = new Map([...current.childNodes].filter(node => key(node)).map(node => [key(node), node]));
    let cursor = current.firstChild;
    for (const child of [...next.childNodes]) {
      const childKey = key(child);
      let retained = childKey ? keyed.get(childKey) : cursor && !key(cursor) ? cursor : undefined;
      if (retained && (retained.nodeType !== child.nodeType || retained.nodeName !== child.nodeName)) retained = undefined;
      if (!retained) { retained = child.cloneNode(true); current.insertBefore(retained, cursor); }
      else {
        if (retained !== cursor) current.insertBefore(retained, cursor);
        patchView(retained, child);
      }
      if (childKey) keyed.delete(childKey);
      cursor = retained.nextSibling;
    }
    while (cursor) { const removed = cursor; cursor = cursor.nextSibling; removed.remove(); }
  }
  function render(focusList = false, previousViews, git = true) {
    const container = $('#panes');
    const cachedSides = state.panes.flatMap((p, index) => {
      tabs.ensure(p);
      const section = container.querySelector(`[data-pane="${index}"]`), path = currentPath(p);
      const changed = section && (section.dataset.directory !== path || section.dataset.tabKey !== p.tabStates[p.tab].id);
      const cached = state.realFilesystem && validatedNavigation !== path && (directoryListings.has(path) || directoryCache.get(path) !== undefined || Object.hasOwn(state.folders, path) && !state.unloadedFolders?.includes(path));
      return changed && cached ? [index] : [];
    });
    if (!cachedSides.length) return renderView(focusList, previousViews, git);
    const previous = container.getAttribute('data-cache-paint');
    container.setAttribute('data-cache-paint', cachedSides.join(' '));
    try { return renderView(focusList, previousViews, git); }
    finally {
      try {
        for (const side of cachedSides) {
          const section = container.querySelector(`[data-pane="${side}"]`);
          section.querySelectorAll('.git-status-enter').forEach(badge => badge.classList.remove('git-status-enter'));
          section.querySelectorAll('[data-git-placeholder]').forEach(placeholder => placeholder.setAttribute('data-cache-visible', ''));
          section.getBoundingClientRect();
        }
      } finally {
        if (previous === null) container.removeAttribute('data-cache-paint'); else container.setAttribute('data-cache-paint', previous);
      }
    }
  }
  function renderView(focusList = false, previousViews, git = true) {
    closeFavorites(false);
    rememberScroll();
    refreshHighlight();
    if ($('#panes').querySelector('[data-pane]')) {
      state.panes.forEach((p, index) => {
        if (previousViews && paneDisplayState(p, index) === previousViews[index]) return;
        const template = document.createElement('template'); template.innerHTML = renderPane(p, index);
        patchView(document.querySelector(`[data-pane="${index}"]`), template.content.firstElementChild);
      });
    } else $('#panes').innerHTML = state.panes.map(renderPane).join('');
    refreshFileColors();
    columnResizeObserver?.disconnect();
    document.querySelectorAll('.pane').forEach((section, index) => {
      const list = section.querySelector('.list');
      if (!list) return;
      list.scrollTop = state.panes[index].scrollTop || 0;
      sizePaneColumns(section, state.panes[index]);
      columnResizeObserver?.observe(list);
    });
    lister.mount();
    if (focusList) { if (lister.has(state.active)) lister.focus(); else document.querySelector('.pane.active .list')?.focus({ preventScroll: true }); }
    refreshClipboardMarkers();
    persist();
    requestIcons();
    if (git) requestGitStatus();
    updateDirectoryActivity();
    jobView?.update(operationQueue.items);
  }
  function focusSelection() {
    refreshSelection();
    if (lister.has(state.active)) lister.focus();
    else document.querySelector('.pane.active .list')?.focus({ preventScroll: true });
  }
  const rememberedSelections = [undefined, undefined];
  const selectionRequests = new Map();
  const uiActionRequests = new Map();
  let selectionSequence = 0;
  let uiActionSequence = 0;
  function hostAction(type, payload = {}) {
    if (!host) return;
    if (!nativeDesktopSupported && ['open', 'open-trash'].includes(type)) { toast(t('Diese Funktion wird auf diesem Betriebssystem noch nicht unterstützt.'), 'info'); return; }
    const requestId = `ui-action-${++uiActionSequence}`;
    toast(t('Aktion wird ausgeführt…'), 'info');
    uiActionRequests.set(requestId, { type, statusVersion: statusbar.version });
    statusTask(requestId, t('Aktion wird ausgeführt…') + ` · ${t('Hostbestätigung')}`);
    host.postMessage({ type, ...payload, requestId });
  }
  function captureGitDiff(selection) {
    if (!selection || selection.snapshotId !== state.snapshotId || !Array.isArray(selection.ids) || selection.ids.length !== 1) return null;
    const file = state.folders[selection.directory]?.find(file => file.id === selection.ids[0]);
    if (!file || file.type === 'folder') return null;
    return { directory: selection.directory, ids: [...selection.ids], snapshotId: selection.snapshotId, path: file.fsSource || join(selection.directory, file.name) };
  }
  function requestGitDiff(selection) {
    const matches = gitMenuSelection && selection?.directory === gitMenuSelection.directory && selection.snapshotId === gitMenuSelection.snapshotId && selection.ids?.length === 1 && selection.ids[0] === gitMenuSelection.ids[0];
    const captured = matches ? gitMenuSelection : captureGitDiff(selection);
    if (!captured) { toast(t('Ungültige Dateiauswahl für Git Diff.'), 'error'); return; }
    if (filesystemPending && refreshingFilesystem && !transferPending && !navigationRequests.size) { gitMenuSelection = captured; pendingGitDiff = captured; return; }
    if (filesystemPending || transferPending || navigationRequests.size) { toast(t('Eine Dateisystemoperation läuft bereits.'), 'info'); return; }
    const file = state.folders[captured.directory]?.find(file => file.id === captured.ids[0]);
    if (![captured.snapshotId, captured.refreshSnapshot].includes(state.snapshotId) || !state.panes.some(p => currentPath(p) === captured.directory) || !file || file.type === 'folder' || (file.fsSource || join(captured.directory, file.name)) !== captured.path) { gitMenuSelection = null; toast(t('Ungültige Dateiauswahl für Git Diff.'), 'error'); return; }
    gitMenuSelection = null;
    hostAction('git-diff', { directory: captured.directory, ids: captured.ids, snapshotId: state.snapshotId });
  }
  window.addEventListener('message', event => {
    const result = event.data;
    if (result?.type !== 'ui-action-result') return;
    const request = uiActionRequests.get(result.requestId); if (!request) return;
    uiActionRequests.delete(result.requestId);
    statusTask(result.requestId, null);
    const labels = { edit: 'Datei zum Bearbeiten geöffnet.', open: 'Datei geöffnet.', preview: 'Datei angezeigt.', 'open-settings': 'Einstellungen geöffnet.', 'show-licenses': 'Lizenzen geöffnet.', 'open-trash': 'Papierkorb geöffnet.', 'open-terminal': 'Terminal geöffnet.', 'git-diff': 'Git-Diff geöffnet.' };
    reportStatus(result.cancelled ? t('Aktion abgebrochen.') : result.ok ? t(labels[request.type]) : result.error || t('Dateiaktion fehlgeschlagen.'), result.cancelled ? 'cancelled' : result.ok ? 'success' : result.unsupported ? 'info' : 'error', request.statusVersion);
  });
  function rememberSelection(p = pane()) {
    rememberedSelections[state.panes.indexOf(p)] = selectedFor(p).map(file => file.name);
  }
  function restoreSelection(p, names) {
    const wanted = new Set(names.map(name => name.toLocaleLowerCase()));
    p.cursorSelection = null;
    p.selected = visible(p).filter(file => wanted.has(file.name.toLocaleLowerCase())).map(file => file.id);
    focusSelection();
  }
  function selectionContext(p) {
    const path = currentPath(p), tab = p.tabStates?.[p.tab]?.id, snapshot = state.snapshotId;
    return () => state.panes.includes(p) && currentPath(p) === path && p.tabStates?.[p.tab]?.id === tab && state.snapshotId === snapshot;
  }
  function selectionIO(action, text, pathRanges, successMessage) {
    if (!host) { toast(t('Diese Auswahlaktion benötigt den Erweiterungshost.')); return; }
    const requestId = `selection-${++selectionSequence}`;
    toast(t('Auswahl wird übertragen…'), 'info');
    selectionRequests.set(requestId, { p: pane(), valid: selectionContext(pane()), action, statusVersion: statusbar.version, successMessage });
    statusTask(requestId, t('Auswahl wird übertragen…') + ` · ${t('Hostbestätigung')}`);
    host.postMessage({ type: 'selection-io', requestId, action, text, ...(pathRanges?.length ? { pathRanges } : {}) });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'selection-io-result') return;
    const request = selectionRequests.get(message.requestId);
    if (!request) return;
    selectionRequests.delete(message.requestId);
    statusTask(message.requestId, null);
    if (!request.valid()) return;
    if (message.cancelled) { reportStatus(t('Auswahlübertragung abgebrochen.'), 'cancelled', request.statusVersion); return; }
    if (!message.ok) { reportStatus(message.error || t('Auswahl konnte nicht übertragen werden.'), 'error', request.statusVersion); return; }
    if (request.action === 'load' && typeof message.text === 'string') restoreSelection(request.p, message.text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).map(line => line.replace(/^"(.*)"$/, '$1')));
    reportStatus(request.successMessage || t('Auswahl übertragen.'), 'success', request.statusVersion);
  });
  function selectionMatches(rows, mask) {
    if (mask.startsWith('<')) {
      const expression = new RegExp(mask.slice(1), 'iu');
      return rows.filter(row => expression.test(row.name));
    }
    const related = mask.indexOf('>');
    if (related > 0) {
      const source = mask.slice(0, related), target = mask.slice(related + 1);
      const found = rows.filter(row => window.CommanderTransfer.matches(row.name, source));
      const companions = new Set(found.map(row => window.CommanderTransfer.applyNameMask(row.name, target).toLocaleLowerCase()));
      return rows.filter(row => found.includes(row) || companions.has(row.name.toLocaleLowerCase()));
    }
    return rows.filter(row => window.CommanderTransfer.matches(row.name, mask));
  }
  function selectionCommand(command, reverseDirectories = false) {
    const p = pane(), rows = visible(p), includeDirectories = (fileSettings.selectDirectories !== false) !== reverseDirectories;
    const report = () => {
      const messages = { 'select-all': includeDirectories ? 'Alle Einträge markiert.' : 'Alle Dateien markiert.', clear: 'Auswahl aufgehoben.', invert: 'Auswahl umgekehrt.',
        'select-group': 'Gruppe markiert.', 'unselect-group': 'Gruppenmarkierung entfernt.',
        'select-extension': 'Dateien mit gleicher Erweiterung markiert.', 'unselect-extension': 'Markierung gleicher Erweiterungen entfernt.' };
      toast(t(messages[command]), 'success');
    };
    const merge = (matched, remove) => {
      p.cursorSelection = null;
      const ids = new Set(matched.map(row => row.id));
      p.selected = remove ? p.selected.filter(id => !ids.has(id)) : [...new Set([...p.selected, ...ids])];
      focusSelection(); report();
    };
    if (command === 'select-group' || command === 'unselect-group') {
      const remove = command === 'unselect-group', valid = selectionContext(p);
      modal(t(remove ? 'Gruppenauswahl rückgängig...' : 'Gruppe markieren...'), field(t('Dateitypen'), '*.*') + `<p>${t('Masken mit | ausschließen, < für reguläre Ausdrücke, > für gespeicherte Suchen.')}</p>`, t('OK'), () => {
        if (!valid()) return true;
        const mask = $('#value').value.trim();
        const eligible = rows.filter(row => row.type !== 'folder' || (remove ? !reverseDirectories : includeDirectories));
        try {
          if (mask.startsWith('>')) {
            const dialog = $('#value');
            fileSearch.evaluatePreset(mask.slice(1), eligible, true).then(ids => {
              if (!valid() || $('#value') !== dialog || !$('#modal').open) return;
              merge(eligible.filter(row => ids.includes(row.id)), remove); $('#modal').close();
            }).catch(error => toast(error.message));
            return false;
          }
          merge(selectionMatches(eligible, mask), remove); return true;
        } catch { toast(t('Ungültiger Auswahlfilter.')); return false; }
      });
      return true;
    }
    if (command === 'select-extension' || command === 'unselect-extension') {
      const file = rows.find(row => row.id === p.cursor);
      if (file && file.type !== 'folder') {
        const ext = name => name.includes('.') ? name.slice(name.lastIndexOf('.')).toLocaleLowerCase() : '';
        merge(rows.filter(row => row.type !== 'folder' && ext(row.name) === ext(file.name)), command === 'unselect-extension');
      }
      return true;
    }
    if (command === 'save-selection') { rememberSelection(p); toast(t('Auswahl gemerkt.'), 'success'); return true; }
    if (command === 'restore-selection') { const names = rememberedSelections[state.panes.indexOf(p)]; if (names) { restoreSelection(p, names); toast(t('Auswahl wiederhergestellt.'), 'success'); } else toast(t('Keine gemerkte Auswahl vorhanden.')); return true; }
    if (command === 'save-selection-file' || command === 'load-selection-file') {
      selectionIO(command === 'save-selection-file' ? 'save' : 'load', rows.filter(row => p.selected.includes(row.id)).map(row => row.name).join('\r\n'));
      return true;
    }
    if (['copy-names', 'copy-full-names', 'copy-details', 'copy-full-details'].includes(command)) {
      const marked = rows.filter(row => p.selected.includes(row.id)), picked = marked.length ? marked : rows.filter(row => row.id === p.cursor);
      const full = command.includes('full'), details = command.includes('details');
      const pathRanges = [];
      let offset = 0;
      const text = picked.map(row => {
        const name = full ? displayPath(entryPath(p, row)) : row.name;
        if (!details) { if (full) pathRanges.push({ start: offset, length: name.length }); offset += name.length + 2; return name; }
        const nameField = column => column.field === undefined ? column.key === 'name' : /^\[=(?:file|tc)\.(?:name|fullname)\]$/i.test(column.field);
        const extensionField = column => column.field === undefined ? column.key === 'type' : /^\[=(?:file|tc)\.ext\]$/i.test(column.field);
        const shown = (p.columns || columns.defaults()).filter(column => column.visible !== false);
        const line = shown.filter(column => !extensionField(column) || !shown.some(nameField)).map(column => {
          const value = nameField(column) ? name : columns.displayValue(displayFile(row, p), column.field === undefined ? column.key : column);
          if (full && (nameField(column) || /^\[=(?:file|tc)\.fullpath\]$/i.test(column.field || '')) && value.length) pathRanges.push({ start: offset, length: value.length });
          offset += value.length + 1; return value;
        }).join('\t');
        offset++; return line;
      }).join('\r\n');
      if (picked.length) selectionIO('copy', text, pathRanges);
      return true;
    }
    if (['select-all', 'clear', 'invert'].includes(command)) {
      const eligible = rows.filter(row => row.type !== 'folder' || (command === 'clear' ? !reverseDirectories : includeDirectories));
      if (command === 'clear') merge(eligible, true);
      else if (command === 'select-all') merge(eligible, false);
      else { const ids = new Set(eligible.map(row => row.id)); p.cursorSelection = null; p.selected = [...p.selected.filter(id => !ids.has(id)), ...eligible.filter(row => !p.selected.includes(row.id)).map(row => row.id)]; focusSelection(); report(); }
      return true;
    }
    return false;
  }
  function toast(text, outcome = 'error') { const message = t(text); statusbar.setStatus(message, outcome); $('#toast').classList.remove('visible'); $('#toast').textContent = ''; }
  function reportStatus(message, outcome = 'info', version) {
    if (version !== undefined && version !== statusbar.version) return;
    toast(message, outcome); return statusbar.version;
  }
  function go(path) {
    path = Object.keys(state.archiveLocations || {}).find(value => displayArchivePath(value) === path) || path;
    path = inputPath(path, displayArchivePath(currentPath(pane())));
    path = Object.keys(state.archiveLocations || {}).find(value => paths.identity(inputPath(displayArchivePath(value))) === paths.identity(path)) || path;
    const existing = Object.keys(state.folders).find(value => paths.identity(value) === paths.identity(path));
    if (existing) path = existing;
    if (host && state.realFilesystem && !path.includes('!') && validatedNavigation !== path && (!Object.hasOwn(state.folders, path) || state.unloadedFolders?.includes(path) || path !== currentPath(pane()))) {
      const side = state.active;
      cacheDirectories();
      const cached = directoryCache.get(path) || (!state.unloadedFolders?.includes(path) ? state.folders[path] : undefined);
      if (cached) {
        rememberScroll(); const previousViews = state.panes.map(paneDisplayState);
        directoryListings.set(path, cached); delete pane().tabStates[pane().tab].searchResult; tabs.navigate(pane(), path); render(true, previousViews, false);
      }
      requestFilesystem({ type: 'filesystem-navigate', path, side }, cached ? undefined : () => { state.active = side; go(path); }); return;
    }
    if (!Object.hasOwn(state.folders, path)) return toast(t('Dieser Pfad ist in den Beispieldaten nicht vorhanden.'));
    rememberScroll(); const previousViews = state.panes.map(paneDisplayState); delete pane().tabStates[pane().tab].searchResult; tabs.navigate(pane(), path); render(true, previousViews); toast(t('Verzeichnis geöffnet: {path}', { path: displayArchivePath(path) }), 'success');
  }
  function breadcrumbMarkup(p) {
    const segments = [], seen = new Set();
    let path = currentPath(p);
    while (path && !seen.has(path)) {
      seen.add(path); segments.unshift(path);
      const up = state.archiveLocations?.[path]?.parent || parent(path);
      if (up === path) break;
      path = up;
    }
    return segments.map((value, index) => {
      const shown = displayArchivePath(value), previous = index ? displayArchivePath(segments[index - 1]) : '';
      const label = previous && shown.startsWith(previous) ? shown.slice(previous.length).replace(/^[\\/]/, '') : shown;
      const separator = index && !/[\\/]$/.test(previous) ? `<span aria-hidden="true">${paths.isWindowsPath(shown) ? '\\' : '/'}</span>` : '';
      return `${separator}<button type="button" data-breadcrumb="${escape(value)}" title="${escape(shown)}"${value === currentPath(p) ? ' aria-current="location"' : ''}>${escape(label)}</button>`;
    }).join('');
  }
  function openBreadcrumb(path, newTab) {
    if (!newTab) { go(path); return; }
    const side = state.active, sourcePane = pane(), sourceTab = sourcePane.tabStates[sourcePane.tab].id;
    const open = () => {
      if (state.panes[side] !== sourcePane || sourcePane.tabStates[sourcePane.tab].id !== sourceTab) return;
      state.active = side; rememberScroll(); tabs.openPath(sourcePane, path); go(path);
    };
    if (host && state.realFilesystem && !state.archiveLocations?.[path]) requestFilesystem({ type: 'filesystem-navigate', path, side }, open);
    else open();
  }
  function displayArchivePath(value) {
    const archive = state.archiveLocations?.[value]?.archive;
    return displayPath(archive ? archive + value.slice(value.indexOf('!')) : value);
  }
  function archiveTabName(value) {
    const archive = state.archiveLocations?.[value]?.archive;
    return base(archive ? value.slice(value.indexOf('!') + 1) || archive : value);
  }
  function leaveResults() {
    const p = pane(), result = resultView(p); if (!result) return false;
    rememberScroll();
    if (tabs.close(p)) {
      const previous = p.tabStates.findIndex(tab => tab.id === result.returnTo?.id);
      if (previous >= 0) tabs.activate(p, previous);
    } else {
      delete p.tabStates[p.tab].searchResult;
      tabs.navigate(p, result.returnTo?.path || result.source);
      if (result.returnTo?.view) { Object.assign(p, clone(result.returnTo.view)); tabs.remember(p); }
    }
    render(true); return true;
  }
  function goUp() { if (leaveResults()) return; const path = currentPath(pane()); go(state.archiveLocations?.[path]?.parent || (path.endsWith('!') ? parent(path.slice(0, -1)) : parent(path))); }
  let pathRequestGeneration = 0, pendingPathNavigation = null;
  window.addEventListener('blur', () => { pathRequestGeneration++; });
  document.addEventListener('input', () => { pathRequestGeneration++; });
  document.addEventListener('focusin', () => { pathRequestGeneration++; });
  function focusPath(fromClipboard = false) {
    if ($('#modal').open || document.querySelector('.inline-rename') || filesystemPending || navigationRequests.size || transferPending) return;
    const input = document.querySelectorAll('.path-input')[state.active];
    input.closest('.path-address').classList.add('is-editing');
    input.focus(); input.select();
    const generation = ++pathRequestGeneration, side = state.active, activePane = pane(), originalPath = currentPath(activePane);
    if (!fromClipboard || !host) return;
    clipboardRequest({ type: 'clipboard-path-read' }, response => {
      if (generation !== pathRequestGeneration || document.activeElement !== input || state.active !== side || pane() !== activePane || currentPath(activePane) !== originalPath || $('#modal').open || filesystemPending || navigationRequests.size || transferPending) return;
      if (!response.ok) { toast(response.error); return; }
      input.value = displayPath(response.path); input.select();
      if (state.realFilesystem) {
        const navigation = { generation, input, side, valid: false };
        pendingPathNavigation = navigation;
        requestFilesystem({ type: 'filesystem-navigate', path: response.path, side }, () => {
          if (!navigation.valid) return;
          const identity = value => paths.identity(value, { platform: document.body.dataset.platform });
          const destination = Object.keys(state.folders).find(value => identity(value) === identity(response.path));
          if (destination) { state.active = side; go(destination); }
        });
      }
      else go(response.path);
    });
  }
  function openFile(file) {
    if (!file) return;
    if (file.type === 'folder') {
      if (resultView(pane())) {
        const path = file.fsSource, side = state.active;
        const open = () => { state.active = side; rememberScroll(); tabs.openPath(pane(), path); go(path); };
        if (host && state.realFilesystem && (!Object.hasOwn(state.folders, path) || state.unloadedFolders?.includes(path))) requestFilesystem({ type: 'filesystem-navigate', path, side }, open);
        else open();
      } else go(join(currentPath(pane()), file.name));
    }
    else if (state.archiveLocations?.[currentPath(pane())]) modal(file.name, `<dl><dt>${t('Pfad')}</dt><dd>${escape(file.archiveEntry || file.name)}</dd><dt>${t('Größe')}</dt><dd>${size(file.size || 0)}</dd><dt>${t('Komprimierte Größe')}</dt><dd>${size(file.compressedSize || 0)}</dd><dt>${t('Kompressionsverhältnis')}</dt><dd>${file.size ? Math.round(100 * (file.compressedSize || 0) / file.size) + ' %' : '–'}</dd><dt>${t('Kompressionsmethode')}</dt><dd>${escape(String(file.compressionMethod ?? ''))}</dd><dt>${t('Verschlüsselung')}</dt><dd>${escape(file.encryption || 'none')}</dd></dl>`, t('Entpacken und öffnen'), () => { host.postMessage({ type: 'zip-open-entry', path: file.fsSource }); return true; });
    else if (host && state.realFilesystem && /\.zip$/i.test(file.name)) requestFilesystem({ type: 'zip-open', path: file.fsSource, side: state.active });
    else if (file.type === 'archive' && !state.realFilesystem) go(`${join(currentPath(pane()), file.name)}!`);
    else if (host && state.realFilesystem) hostAction('open', { path: file.fsSource });
    else preview(file, false);
  }
  let confirmAction = null;
  let operationFailure = null, operationFailureDiagnostic = null, operationErrorDialog = false, operationFailureInline = false, failureFocus = null;
  function operationDiagnosticText(diagnostic) {
    if (!diagnostic || typeof diagnostic !== 'object') return '';
    const lines = [
      `${t('Operation')}: ${diagnostic.request?.type || t('Unbekannt')}`,
      ...(diagnostic.request?.directory !== undefined ? [`${t('Pfad')}: ${diagnostic.request.directory}`] : []),
      ...(diagnostic.request?.ids ? [`IDs: ${diagnostic.request.ids.join(', ')}`] : []),
      ...(diagnostic.request?.requestId ? [`${t('Auftragskennung')}: ${diagnostic.request.requestId}`] : []),
      ...(['action', 'mode', 'path', 'paths', 'target', 'archive', 'side', 'recursive'].filter(key => diagnostic.request?.[key] !== undefined).map(key => `${t(({ action: 'Aktion', mode: 'Modus', path: 'Pfad', paths: 'Pfade', target: 'Ziel', archive: 'Archiv', side: 'Seite', recursive: 'Rekursiv' })[key])}: ${Array.isArray(diagnostic.request[key]) ? diagnostic.request[key].join('\n  ') : diagnostic.request[key]}`)),
      ...(diagnostic.request?.transfer ? Object.entries(diagnostic.request.transfer).map(([key, value]) => `${t(({ mode: 'Modus', sourcePath: 'Quellpfad', sourceSide: 'Quellseite', targetPath: 'Zielpfad' })[key] || key)}: ${value}`) : []),
      ...(diagnostic.request?.operationId ? [`${t('Auftragskennung')}: ${diagnostic.request.operationId}`] : []),
      ...(diagnostic.request?.snapshotId ? [`${t('Snapshotkennung')}: ${diagnostic.request.snapshotId}`] : []),
      ...(diagnostic.panelPaths?.length ? [`${t('Aktive Bereichspfade')}:\n  ${diagnostic.panelPaths.join('\n  ')}`] : []),
      ...(diagnostic.timestamp ? [`${t('Zeitstempel')}: ${diagnostic.timestamp}`] : []),
      `${t('Plattform')}: ${diagnostic.platform || t('Unbekannt')}`,
      ...(diagnostic.architecture ? [`${t('Prozessorarchitektur')}: ${diagnostic.architecture}`] : []),
      ...(diagnostic.osRelease ? [`${t('Betriebssystemversion')}: ${diagnostic.osRelease}`] : []),
      `${t('Erweiterungsversion')}: ${diagnostic.extensionVersion || t('Unbekannt')}`,
      `${t('VS-Code-Version')}: ${diagnostic.vscodeVersion || t('Unbekannt')}`,
      `${t('Laufzeitversion')}: ${diagnostic.runtimeVersion || t('Unbekannt')}`
    ];
    const appendFailure = (failure, label = null, depth = 0) => {
      if (!failure || depth > 6) return;
      if (label) lines.push(`${'  '.repeat(depth)}${t('Ursache')}:`);
      for (const [key, label] of Object.entries({ name: 'Fehlername', code: 'Fehlercode', nativeCode: 'Nativer Fehlercode', nativeStage: 'Native Phase', hresult: 'HRESULT', nativeCommand: 'Nativer Befehl', nativeCommandId: 'Native Befehlskennung', operation: 'Native Operation', requestId: 'Native Anfragekennung', generation: 'Sitzungsgeneration', message: 'Fehlermeldung', path: 'Pfad', scanPhase: 'Scan-Phase' })) if (failure[key] !== undefined && failure[key] !== null && failure[key] !== '') lines.push(`${t(label)}: ${failure[key]}`);
      if (failure.stack) lines.push(`${'  '.repeat(depth)}${t('Stack')}:\n${failure.stack}`);
      if (failure.cause) appendFailure(failure.cause, true, depth + 1);
    };
    appendFailure(diagnostic.failure);
    return lines.join('\n');
  }
  function operationFailureReport() {
    const title = t('Dateioperation fehlgeschlagen');
    return `${title}${operationFailureDiagnostic ? `\n\n${operationDiagnosticText(operationFailureDiagnostic)}` : ''}\n\n${operationFailure}`;
  }
  function mountOperationFailure() {
    document.querySelector('.operation-error')?.remove();
    if (!operationFailure) return;
    const area = document.createElement('section'); area.className = 'operation-error'; area.setAttribute('role', 'alert');
    area.innerHTML = `${$('#operation-error-art').innerHTML}<p class="operation-error-intro">${t('Es ist ein unvorhergesehener Fehler aufgetreten.')}</p><details class="operation-error-details"><summary>${t('Details')}</summary><h3>${t('Details für Computer-Nerds')}</h3><label for="operation-error-text">${t('Fehlerdetails und Wiederherstellungspfade')}</label><textarea id="operation-error-text" class="operation-error-text" readonly rows="6"></textarea><button type="button" data-select-error>${t('Details auswählen')}</button></details><div class="operation-error-actions"><button type="button" data-copy-error>${t('Fehlerdetails kopieren')}</button>${operationErrorDialog ? '' : `<button type="button" data-dismiss-error>${t('Fehler bestätigen')}</button>`}</div>`;
    area.querySelector('textarea').value = operationFailureReport();
    if (operationFailureInline) { area.classList.add('operation-error-inline'); $('#statusbar').before(area); }
    else $('#modal-body').prepend(area);
  }
  function showOperationFailure(message, { inline = false, diagnostic = null, notify = true } = {}) {
    if (notify) statusbar.error(message); else statusbar.setStatus(message, 'error');
    clearTimeout(toast.timer); $('#toast').classList.remove('visible');
    operationFailure = message;
    operationFailureDiagnostic = diagnostic;
    operationFailureInline = inline && Boolean(document.querySelector('.inline-rename'));
    failureFocus = document.activeElement;
    if (!$('#modal').open && !operationFailureInline) {
      modal(t('Dateioperation fehlgeschlagen'), '', null, null);
      operationErrorDialog = true;
    }
    mountOperationFailure();
  }
  function modal(title, body, label, callback, eyebrow = t('DATEIAKTION')) {
    clearTimeout(renameTimer);
    operationErrorDialog = false; operationFailureInline = false;
    $('#modal-title').textContent = title; $('#modal-eyebrow').textContent = eyebrow; $('#modal-body').innerHTML = body;
    $('#modal-confirm').textContent = label; $('#modal-confirm').hidden = !label; $('#modal-cancel').hidden = false; $('#modal-cancel').textContent = label ? t('Abbrechen') : t('Schließen');
    const description = $('#modal-body').querySelector('#modal-description');
    if (description) $('#modal').setAttribute('aria-describedby', 'modal-description');
    else $('#modal').removeAttribute('aria-describedby');
    confirmAction = callback; $('#modal').showModal();
    const input = $('#modal-body').querySelector('input:not([type="checkbox"]):not([type="radio"]), textarea');
    if (input) { input.focus(); input.select(); }
    if (operationFailure) mountOperationFailure();
  }
  function field(label, value, id = 'value') { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${escape(paths.isWindowsPath(value) ? displayPath(value) : value)}" required autocomplete="off"></div>`; }
  function validName(name) { return name.trim() && !/[\\/:*?"<>|]/.test(name) && !['.', '..'].includes(name) && !/[. ]$/.test(name); }
  function uniqueName(items, name) { return !items.some(file => file.name.toLocaleLowerCase() === name.toLocaleLowerCase()); }
  function copyTree(from, to) {
    if (!Object.hasOwn(state.folders, from)) return;
    state.folders[to] = state.folders[from].map(file => ({ ...clone(file), id: String(nextId++) }));
    state.folders[from].forEach(file => {
      if (file.type === 'folder') copyTree(join(from, file.name), join(to, file.name));
      if (file.type === 'archive') copyTree(`${join(from, file.name)}!`, `${join(to, file.name)}!`);
    });
  }
  function inTree(key, path, archive = false) {
    return key === path || key.startsWith(`${path}/`) || archive && (key === `${path}!` || key.startsWith(`${path}!/`));
  }
  function removeTree(path, archive = false) { Object.keys(state.folders).filter(key => inTree(key, path, archive)).forEach(key => delete state.folders[key]); }
  function preview(file, edit) {
    if (file.type === 'folder' || edit && file.type === 'archive' && !state.realFilesystem) { openFile(file); return; }
    if (!edit) { lister.open(state.active, file); return; }
    if (host) {
      hostAction(edit ? 'edit' : 'preview', { content: file.content || '', language: file.type === 'markdown' ? 'markdown' : 'plaintext', ...(state.realFilesystem ? { path: file.fsSource } : {}) });
      return;
    }
    let body;
    if (edit) body = ui`<p>Editor-Vorschau mit Beispieldaten.</p><textarea class="editor" aria-label="Dateiinhalt">${escape(file.content)}</textarea>`;
    else if (file.type === 'markdown') {
      const lines = (file.content || '').split('\n');
      body = `<article class="markdown-preview">${lines.map(line => line.startsWith('## ') ? `<h2>${escape(line.slice(3))}</h2>` : line.startsWith('# ') ? `<h1>${escape(line.slice(2))}</h1>` : line.startsWith('- ') ? `<ul><li>${escape(line.slice(2))}</li></ul>` : `<p>${escape(line)}</p>`).join('')}</article>`;
    } else body = `<pre class="preview-text">${escape(file.content || t('Keine Textvorschau verfügbar.'))}</pre>`;
    modal(file.name, body, edit ? t('Mockup speichern') : null, () => { file.content = $('.editor').value; file.size = new TextEncoder().encode(file.content).length; render(); toast(t('Beispieldatei aktualisiert'), 'success'); return true; }, edit ? t('BEARBEITEN · F4') : t('VORSCHAU · F3'));
  }
  function transferConflict(conflict) {
    return new Promise(resolve => {
      const choices = [['overwrite', t('Überschreiben')], ['overwrite-all', t('Alle überschreiben')], ['skip', t('Überspringen')], ['skip-all', t('Alle überspringen')], ['rename-source', t('Kopie umbenennen')], ['rename-target', t('Ziel umbenennen')], ['autorename-source', t('Kopien automatisch umbenennen')], ['autorename-target', t('Ziele automatisch umbenennen')], ['overwrite-older', t('Alle älteren überschreiben')], ['overwrite-older-equal', t('Alle älteren und gleich alten überschreiben')], ['rename-older-target', t('Ältere Ziele umbenennen, neuere überspringen')], ['larger', t('Nur größere kopieren')], ['smaller', t('Nur kleinere kopieren')], ['append', t('Anhängen')], ['cancel', t('Abbrechen')]];
      const text = file => `${size(file.size || 0)} · ${file.date || t('Datum unbekannt')}`;
      const labels = Object.fromEntries(choices);
      const ordinaryFiles = !['folder', 'archive'].includes(conflict.source.type) && !['folder', 'archive'].includes(conflict.target.type);
      const nativeComparison = host && state.realFilesystem && ordinaryFiles && typeof conflict.source.fsSource === 'string' && typeof conflict.target.fsSource === 'string';
      const sampleComparison = !state.realFilesystem && ordinaryFiles && typeof conflict.source.content === 'string' && typeof conflict.target.content === 'string';
      const button = value => {
        const samePathDisabled = conflict.samePath && ['overwrite', 'overwrite-all', 'overwrite-older', 'overwrite-older-equal', 'rename-older-target', 'larger', 'smaller', 'append', 'rename-target', 'autorename-target'].includes(value);
        const appendDisabled = value === 'append' && (state.realFilesystem && (!conflict.source.fsSource || !conflict.target.fsSource) || ['folder', 'archive'].includes(conflict.source.type) || ['folder', 'archive'].includes(conflict.target.type));
        const reason = samePathDisabled ? t('Quelle und Ziel sind identisch. Zum Kopieren einen neuen Namen wählen.') : appendDisabled ? t('Anhängen ist für diese Dateien nicht verfügbar.') : '';
        return `<button type="button" data-conflict-action="${value}" ${value.startsWith('overwrite') || value === 'append' ? 'data-destructive="true"' : ''} ${reason ? `disabled title="${escape(reason)}" aria-describedby="conflict-limitations"` : ''}>${labels[value]}</button>`;
      };
      const fileCard = (file, role, path) => `<section class="file-comparison" data-conflict-file="${role}" aria-label="${t(role === 'source' ? 'Quelle' : 'Ziel')}"><h3>${t(role === 'source' ? 'Quelle' : 'Ziel')}</h3><div class="comparison-name">${escape(file.name)}</div><div class="comparison-path">${escape(displayPath(path))}</div><div class="comparison-meta"><span class="comparison-meta-label">${t('Größe / Datum')}</span><span>${escape(text(file))}</span></div></section>`;
      modal(t('Datei bereits vorhanden'), `<p id="modal-description" class="dialog-description">${t('Eine Datei mit diesem Namen ist bereits im Ziel vorhanden.')}</p><div class="file-comparison-grid">${fileCard(conflict.source, 'source', conflict.sourcePath)}${fileCard(conflict.target, 'target', conflict.targetPath)}</div>${conflict.samePath ? `<p class="dialog-notice">${t('Quelle und Ziel sind identisch. Zum Kopieren einen neuen Namen wählen.')}</p>` : ''}${field(t('Neuer Name für Kopie oder Ziel'), window.CommanderTransfer.uniqueName([conflict.source, conflict.target], conflict.source.name), 'conflict-name')}<fieldset class="conflict-single"><legend>${t('Für diese Datei')}</legend><div class="conflict-actions">${['overwrite', 'skip', 'rename-source', 'rename-target', 'append'].map(button).join('')}</div></fieldset><details class="dialog-options"><summary>${t('Weitere Konfliktentscheidungen')}</summary><div class="conflict-actions">${['overwrite-all', 'skip-all', 'autorename-source', 'autorename-target', 'overwrite-older', 'overwrite-older-equal', 'rename-older-target', 'larger', 'smaller'].map(button).join('')}</div></details><p id="conflict-limitations" class="dialog-hint">${conflict.samePath ? t('Identische Dateien können nicht überschrieben werden.') : t('Entscheidungen für alle Dateien gelten für weitere Konflikte dieses Auftrags.')}</p><button type="button" id="conflict-compare" class="dialog-link" ${typeof conflict.source.content !== 'string' || typeof conflict.target.content !== 'string' || ['folder', 'archive'].includes(conflict.source.type) || ['folder', 'archive'].includes(conflict.target.type) ? `disabled title="${t('Keine vollständigen Textdaten für einen Vergleich vorhanden')}"` : ''}>${t('Inhalt vergleichen')}</button><pre id="conflict-comparison" class="preview-text" hidden></pre>`, null, () => false, t('KOPIER-/VERSCHIEBEKONFLIKT'));
      $('#modal-cancel').textContent = t('Abbrechen');
      $('#modal-cancel').dataset.conflictAction = 'cancel';
      $('#modal-cancel').hidden = true;
      const dialog = $('#modal');
      let settled = false;
      const finish = decision => {
        if (settled) return;
        if (['rename-source', 'rename-target'].includes(decision.action)) {
          const name = decision.name, input = $('#conflict-name');
          const reserved = /^[a-z]:\//i.test(conflict.targetPath) && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0].trimEnd());
          const occupied = (state.folders[parent(conflict.targetPath)] || []).some(file => file.name.toLocaleLowerCase() === name.toLocaleLowerCase());
          if (!validName(name) || [...name].some(character => character.charCodeAt(0) < 32) || reserved || occupied) {
            toast(t('Der neue Dateiname ist ungültig oder bereits vorhanden.')); input.focus(); return;
          }
        }
        settled = true; conflictAction = null; dialog.removeEventListener('close', cancelled); $('#modal-body').removeEventListener('click', clicked); delete $('#modal-cancel').dataset.conflictAction;
        dialog.close(); resolve(decision);
      };
      const cancelled = () => { if (!dialog.open) finish({ action: 'cancel' }); };
      const clicked = event => {
        const button = event.target.closest('[data-conflict-action]');
        if (button && !button.disabled) finish({ action: button.dataset.conflictAction, name: $('#conflict-name').value });
      };
      dialog.addEventListener('close', cancelled);
      $('#modal-body').addEventListener('click', clicked);
      conflictAction = command => {
        if (!['conflict-target', 'conflict-source', 'conflict-target-plain', 'conflict-source-plain', 'conflict-compare', 'conflict-compare-internal'].includes(command)) return false;
        if (command.includes('compare')) {
          if (nativeComparison) host.postMessage({ type: 'compare', sourcePath: conflict.source.fsSource, targetPath: conflict.target.fsSource });
          else if (sampleComparison) { const output = $('#conflict-comparison'); output.hidden = false; output.textContent = ui`QUELLE\n${conflict.source.content}\n\nZIEL\n${conflict.target.content}`; }
          else toast(t('Keine vollständigen Dateien für einen Vergleich verfügbar.'));
        } else {
          const file = command.includes('source') ? conflict.source : conflict.target;
          if (host && (!state.realFilesystem && typeof file.content === 'string' || state.realFilesystem && typeof file.fsSource === 'string')) host.postMessage({ type: state.realFilesystem ? 'conflict-preview' : 'preview', ...(state.realFilesystem ? { path: file.fsSource } : { content: file.content }), plain: command.endsWith('plain'), language: command.endsWith('plain') ? 'plaintext' : file.type === 'markdown' ? 'markdown' : 'plaintext' });
          else if (!state.realFilesystem && typeof file.content === 'string') { const output = $('#conflict-comparison'); output.hidden = false; output.textContent = file.content; }
          else toast(t('Keine vollständigen Dateien für einen Vergleich verfügbar.'));
        }
        return true;
      };
      $('#conflict-compare').disabled = !nativeComparison && !sampleComparison;
      if (!$('#conflict-compare').disabled) $('#conflict-compare').removeAttribute('title');
      $('#conflict-compare').onclick = () => conflictAction?.('conflict-compare');
      reportFocus();
    });
  }
  function transferIndividualName(source, directory) {
    return new Promise(resolve => {
      const dialog = $('#modal'), folders = state.folders;
      let settled = false;
      const finish = decision => { if (settled) return; settled = true; dialog.removeEventListener('close', cancelled); dialog.close(); resolve(decision); };
      const cancelled = () => { if (!dialog.open) finish({ action: 'cancel' }); };
      modal(t('Jede Datei einzeln umbenennen'), `${field(t('Neuer Name für Kopie oder Ziel'), source.name)}<button type="button" id="transfer-skip">${t('Überspringen')}</button>`, t('Kopieren'), () => {
        const name = $('#value').value;
        if (!validName(name) || [...name].some(character => character.charCodeAt(0) < 32) || /^[a-z]:\//i.test(directory) && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) { toast(t('Der neue Dateiname ist ungültig oder bereits vorhanden.')); $('#value').focus(); return false; }
        if (source.type === 'folder') {
          const target = join(directory, name);
          if (prepareFolders([target], 'copy', () => {
            for (const [path, rows] of Object.entries(state.folders)) if (inTree(path, target)) folders[path] = rows;
            state.folders = folders;
            finish({ name });
          })) {
            transferPreparationFailure = cancelled => { if (cancelled) finish({ action: 'cancel' }); else { toast(t('Dateioperation fehlgeschlagen; Verzeichnisse erneut eingelesen')); $('#value')?.focus(); } };
            return false;
          }
        }
        finish({ name }); return false;
      });
      $('#transfer-skip').onclick = () => finish({ action: 'skip' });
      dialog.addEventListener('close', cancelled);
    });
  }
  async function executeTransfer(options) {
    if (!host || !state.realFilesystem) return executeTransferNow(options);
    const captured = { ...options, validateSelection: undefined, ids: [...options.ids] };
    const target = window.CommanderTransfer.planTarget({ ...captured, folders: state.folders }).directory;
    enqueueOperation({ command: options.mode === 'move' ? 'move' : 'copy', title: t(options.mode === 'move' ? 'Verschieben' : 'Kopieren'), target, sources: options.ids.map(id => (state.folders[options.sourcePath] || []).find(file => file.id === id)).filter(Boolean).map(file => file.fsSource || join(options.sourcePath, file.name)) }, job => executeTransferNow(captured).catch(error => {
      failTransferExecution(error, captured.onComplete);
      operationQueue.complete(job.id, { ok: false, error: error.message });
    }), options.targetSide ?? 1 - options.sourceSide);
  }
  async function executeTransferNow(options) {
    const queuedJob = operationQueue?.active;
    const failed = error => { failTransferExecution(error, options.onComplete); operationQueue?.complete(queuedJob?.id, { ok: false, error: error.message }); };
    if (filesystemPending || navigationRequests.size) { runQueuedOperation(queuedJob, () => executeTransferNow(options).catch(failed)); return; }
    if (options.validateSelection && !options.validateSelection()) throw new Error(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.'));
    if (host && state.realFilesystem && !Object.hasOwn(state.folders, options.sourcePath)) {
      requestFilesystem({ type: 'filesystem-prepare', paths: [options.sourcePath], action: options.mode, recursive: false }, () => executeTransferNow(options).catch(failed));
      return;
    }
    const plan = window.CommanderTransfer.planTarget({ ...options, folders: state.folders });
    const targetDirectory = plan.directory;
    const progressSources = new Map((state.folders[options.sourcePath] || []).filter(file => options.ids.includes(file.id)).map(file => [file.id, join(options.sourcePath, file.name)]));
    if (!transferJob) {
      transferJob = { id: `transfer-ui-${Date.now()}-${++transferSequence}`, queueJobId: queuedJob?.id, hostActive: false, phase: 'copying', context: Object.freeze({ mode: options.mode, sources: Object.freeze(options.ids.map(id => progressSources.get(id)).filter(Boolean)), target: targetDirectory }) };
      transferProgress();
    } else if (transferJob.hostActive === false && transferJob.phase === 'preparing') {
      transferJob.phase = 'copying'; transferJob.currentPath = null; transferJob.currentTransferred = 0; transferJob.currentTotal = undefined; transferProgress();
    }
    const resume = () => executeTransferNow(options).catch(failed);
    if (prepareFolders([plan.directories.length ? parent(plan.directories[0]) : targetDirectory], options.mode, resume, false)) { transferPreparationFailure = cancelled => options.onComplete?.({ confirmed: false, completed: 0, completedIds: [], errors: cancelled ? [] : [t('Dateioperation fehlgeschlagen; Verzeichnisse erneut eingelesen')], cancelled: Boolean(cancelled) }); return; }
    const selectedFolders = (state.folders[options.sourcePath] || []).filter(file => options.ids.includes(file.id) && file.type === 'folder');
    if (prepareFolders(selectedFolders.flatMap(file => [join(options.sourcePath, file.name), join(targetDirectory, plan.name || (plan.mask ? window.CommanderTransfer.applyNameMask(file.name, plan.mask) : file.name))]), options.mode, resume)) { transferPreparationFailure = cancelled => options.onComplete?.({ confirmed: false, completed: 0, completedIds: [], errors: cancelled ? [] : [t('Dateioperation fehlgeschlagen; Verzeichnisse erneut eingelesen')], cancelled: Boolean(cancelled) }); return; }
    transferPending = true;
    const planningJob = transferJob;
    planningJob.controller = new AbortController();
    let originalFolders = clone(state.folders);
    let committedResult = { completed: 0, directories: 0, completedIds: [] };
    const pendingTransfer = () => ({ mode: options.mode, sourcePath: options.sourcePath, sourceSide: options.sourceSide,
      ids: options.ids.filter(id => !committedResult.completedIds.includes(id) && (originalFolders[options.sourcePath] || []).some(row => row.id === id)) });
    try {
    const confirmedView = host && state.realFilesystem ? { folders: originalFolders, panes: clone(state.panes) } : null;
    const flushCompleted = async partial => {
      if (!confirmedView || JSON.stringify(state.folders) === confirmedFolders) return true;
      const plannedFolders = state.folders, proposed = clone(state);
      state.folders = originalFolders;
      planningJob.hostActive = true;
      planningJob.id = `transfer-checkpoint-${Date.now()}-${++transferSequence}`;
      planningJob.transfer = pendingTransfer();
      filesystemPending = true; transferPending = false;
      render(true); transferProgress();
      return new Promise((resolve, reject) => {
        transferCheckpoint = { id: planningJob.id, cancel: () => resolve(false), complete: message => {
          const nativeState = message.state?.realFilesystem ? message.state : message.ok ? proposed : { ...state, folders: originalFolders };
          const view = { panes: state.panes, active: state.active };
          for (const key of Object.keys(plannedFolders)) if (!Object.hasOwn(nativeState.folders, key)) delete plannedFolders[key];
          for (const [key, incoming] of Object.entries(nativeState.folders)) {
            const rows = plannedFolders[key] || [];
            const updated = incoming.map(fresh => {
              const row = rows.find(previous => previous.id === fresh.id);
              if (!row) return clone(fresh);
              for (const property of Object.keys(row)) delete row[property];
              return Object.assign(row, clone(fresh));
            });
            rows.splice(0, rows.length, ...updated); plannedFolders[key] = rows;
          }
          state = { ...nativeState, folders: plannedFolders, active: view.active };
          view.panes.forEach((p, index) => {
            if (!p.tabs.every(path => Object.hasOwn(plannedFolders, path))) return;
            const valid = new Set((plannedFolders[currentPath(p)] || []).map(file => file.id));
            p.selected = p.selected.filter(id => valid.has(id)); if (!valid.has(p.cursor)) p.cursor = null;
            state.panes[index] = p;
          });
          confirmedFolders = JSON.stringify(plannedFolders);
          originalFolders = clone(plannedFolders); confirmedView.folders = originalFolders; confirmedView.panes = clone(state.panes);
          const outcome = message.operationOutcome;
          if (message.ok && !message.cancelled && !outcome?.cancelled) committedResult = { completed: partial.completed, directories: partial.directories, completedIds: [...partial.completedIds] };
          else if (outcome) {
            const additional = (outcome.completedIds || []).filter(id => !committedResult.completedIds.includes(id));
            committedResult = { ...committedResult, completed: committedResult.completed + additional.length, completedIds: [...committedResult.completedIds, ...additional] };
          }
          const sourcePane = state.panes[options.sourceSide];
          if (currentPath(sourcePane) === options.sourcePath) sourcePane.selected = sourcePane.selected.filter(id => !committedResult.completedIds.includes(id));
          confirmedView.panes = clone(state.panes);
          filesystemPending = false; transferPending = true; planningJob.hostActive = false;
          if (message.cancelled || message.operationOutcome?.cancelled) {
            planningJob.cancelRequested = true; planningJob.controller.abort();
          }
          render(true); transferProgress();
          if (!message.ok) reject(new Error(message.error || t('Dateioperation fehlgeschlagen; Verzeichnisse erneut eingelesen')));
          else resolve(!planningJob.cancelRequested);
        } };
        host.postMessage({ type: 'filesystem-apply', operationId: planningJob.id, transfer: planningJob.transfer, state: proposed });
      });
    };
    transferPlanning = true;
    const result = await window.CommanderTransfer.execute({ ...options, policy: options.policyState?.value || options.policy, signal: planningJob.controller.signal, folders: state.folders, createId: () => String(nextId++),
      onBeforeDecision: flushCompleted, onConflict: async (...args) => { const decision = await transferConflict(...args); if (options.policyState && window.CommanderTransfer.policies.includes(decision?.action) && decision.action !== 'ask') options.policyState.value = decision.action; return decision; }, onRename: transferIndividualName });
    if (transferJob !== planningJob) return;
    if (planningJob.cancelRequested) {
      state.folders = originalFolders;
      const sourcePane = state.panes[options.sourceSide], completedIds = state.realFilesystem ? committedResult.completedIds : result.completedIds;
      if (currentPath(sourcePane) === options.sourcePath) sourcePane.selected = sourcePane.selected.filter(id => !completedIds.includes(id));
      Object.assign(result, committedResult, { cancelled: true });
      transferPending = false;
      render(true); finishTransfer({ result, options }, true); operationQueue?.complete(operationQueue.active?.id, { cancelled: true }); return result;
    }
    const sourcePane = state.panes[options.sourceSide];
    const remaining = new Set((state.folders[options.sourcePath] || []).map(file => file.id));
    if (currentPath(sourcePane) === options.sourcePath) {
      sourcePane.selected = sourcePane.selected.filter(id => remaining.has(id) && !result.completedIds.includes(id));
      if (!remaining.has(sourcePane.cursor)) sourcePane.cursor = null;
    }
    const completion = { result, options, committedResult };
    const needsCommit = host && state.realFilesystem && JSON.stringify(state.folders) !== confirmedFolders;
    if (needsCommit) { transferCompletion = completion; document.querySelector('.transfer-progress')?.remove(); transferJob = { id: `transfer-${Date.now()}-${++transferSequence}`, queueJobId: queuedJob?.id, hostActive: true, context: Object.freeze({ mode: options.mode, sources: Object.freeze(result.completedIds.map(id => progressSources.get(id))), target: plan.name || plan.mask ? join(targetDirectory, plan.name || plan.mask) : targetDirectory }), transfer: pendingTransfer() }; transferProgress(); }
    if (needsCommit) {
      completion.proposedState = clone(state); const currentPanes = state.panes;
      state.folders = confirmedView.folders;
      currentPanes.forEach((currentPane, index) => {
        const confirmedPane = confirmedView.panes[index];
        if (currentPath(currentPane) === currentPath(confirmedPane) && currentPane.tabStates[currentPane.tab].id === confirmedPane.tabStates[confirmedPane.tab].id) {
          currentPane.selected = confirmedPane.selected; currentPane.cursor = confirmedPane.cursor;
        }
      });
      state.panes = currentPanes;
    }
    transferPending = false;
    render(true);
    if (!needsCommit) { finishTransfer(completion, true); operationQueue?.complete(operationQueue.active?.id, { ok: true, cancelled: result.cancelled, message: transferSummary(completion) }); }
    return result;
    } catch (error) {
      if (transferJob === planningJob) state.folders = originalFolders;
      if (committedResult.completed || committedResult.completedIds.length) error.confirmedTransfer = committedResult;
      throw error;
    } finally { transferPlanning = false; if (transferJob === planningJob || !transferJob || transferJob.hostActive) transferPending = false; flushDeferredNavigationReads(); flushQueuedOperation(); flushFocusRefresh(); }
  }
  function transferSummary(completion) {
    const { result, options } = completion;
    return result.errors[0] || ui`${count('file', result.completed)} ${options.mode === 'move' ? t('verschoben') : t('kopiert')}, ${result.skipped} übersprungen${result.cancelled ? ui([' · Abgebrochen']) : ''}`;
  }
  function failTransferExecution(error, onComplete) {
    const progress = finishTransferStatus('error');
    if (progress) statusbar.finishProgress({ message: error.message, severity: window.CommanderWorkbench.Severity.Error, progress });
    if (transferJob?.hostActive === false) { transferJob = null; transferProgress(); }
    if (state.realFilesystem) { render(true); showOperationFailure(error.message, { notify: !operationQueue?.active }); } else toast(error.message);
    onComplete?.({ completed: 0, completedIds: [], ...error.confirmedTransfer, confirmed: Boolean(error.confirmedTransfer), errors: [error.message], cancelled: false });
  }
  function finishTransfer(completion, confirmed, error) {
    const { result, options } = completion;
    if (!error) {
      const message = transferSummary(completion);
      const outcome = result.errors.length ? 'error' : result.cancelled ? 'cancelled' : result.skipped || !confirmed ? 'info' : 'success';
      const progress = finishTransferStatus(outcome);
      if (progress) statusbar.finishProgress({ message, outcome, progress, ...(result.errors.length ? { severity: window.CommanderWorkbench.Severity.Error } : {}) }); statusbar.setStatus(message, outcome);
      if (transferJob?.hostActive === false) { transferJob = null; transferProgress(); }
    }
    const accepted = confirmed || completion.actualOutcome;
    const stable = accepted ? result : { completed: 0, completedIds: [], ...completion.committedResult };
    options.onComplete?.({ ...result, ...stable, confirmed: Boolean(accepted || stable.completed || stable.completedIds.length), ...(confirmed ? {} : { errors: [error, ...result.errors].filter(Boolean) }) });
  }
  function runZipCopy(sourceSide, sourcePath, picked, targetPath) {
    if (!picked.length) return;
    modal(t('Archiv entpacken'), `<p>${count('selectedEntry', picked.length)}</p>${zipUnpackFields(targetPath || currentPath(state.panes[1 - sourceSide]))}`, t('Entpacken'), () => {
      const enteredTarget = $('#value').value.trim();
      const target = enteredTarget ? inputPath(enteredTarget, targetPath || currentPath(state.panes[1 - sourceSide])) : '';
      if (state.archiveLocations?.[target]) { toast(t('Ein Zielordner ist erforderlich.')); return false; }
      sendZipWrite({ messageType: 'zip-copy', path: sourcePath, sourceSide, targetSide: 1 - sourceSide, ids: picked.map(row => row.id), target, ...zipUnpackOptions() });
      return true;
    });
    $('#value').required = false;
  }
  function zipUnpackFields(target, all = false) { return field(t('Zielordner'), target) + (all ? field(t('Zu entpackende Dateien'), '*.*', 'zip-filter') : '') + `<label><input id="zip-paths" type="checkbox" checked> ${t('Pfade mit entpacken')}</label><label><input id="zip-overwrite" type="checkbox"> ${t('Bestehende Dateien überschreiben')}</label>` + (all ? `<label><input id="zip-separate" type="checkbox"> ${t('Jedes Archiv in separates Verzeichnis entpacken')}</label>` : ''); }
  function zipUnpackOptions() { return { paths: $('#zip-paths').checked, overwrite: $('#zip-overwrite').checked, ...($('#zip-filter') ? { filter: $('#zip-filter').value, separate: $('#zip-separate').checked } : {}) }; }
  function sendZipWrite(request, completed) {
    const { targetSide = state.active, ...hostRequest } = request;
    delete hostRequest.sourceSide;
    const captured = clone(hostRequest);
    const destination = request.target || (request.messageType === 'zip-test' ? request.path : request.archive ? parent(request.archive) : request.path || request.sourcePath);
    /** @type {import('./commander-jobs').BackgroundCommandId} */
    const command = request.messageType === 'zip-test' ? 'zip-test' : ['zip-unpack', 'zip-copy'].includes(request.messageType) ? 'zip-unpack' : request.action === 'pack' ? 'zip-pack' : 'zip-update';
    const sourceRows = state.folders[request.sourcePath || request.path] || [];
    const sourcePaths = (request.ids || []).map(id => sourceRows.find(file => file.id === id)).filter(Boolean).map(file => file.fsSource || join(request.sourcePath || request.path, file.name));
    if (command === 'zip-test' && !sourcePaths.length && state.archiveLocations?.[request.path]?.archive) sourcePaths.push(state.archiveLocations[request.path].archive);
    const actionCommand = request.action && window.CommanderJobs.commandForAction(request.action);
    if (actionCommand && !actionCommand.supportsBackgroundOperation.enabled) { sendZipWriteNow(captured, completed, true); return; }
    enqueueOperation({ command, title: t(request.messageType === 'zip-test' ? 'Archiv prüfen' : ['zip-unpack', 'zip-copy'].includes(request.messageType) ? 'Entpacken' : 'ZIP erstellen'), target: destination, label: request.archive || destination, sources: sourcePaths }, () => sendZipWriteNow(captured, completed), targetSide);
  }
  function sendZipWriteNow(request, completed, foreground = false) {
    if (filesystemPending || navigationRequests.size) {
      if (foreground) { toast(t('Während einer Dateisystemoperation ist diese Aktion nicht verfügbar.')); return; }
      runQueuedOperation(operationQueue.active, () => sendZipWriteNow(request, completed)); return;
    }
    const operationId = `zip-write-${Date.now()}-${++transferSequence}`;
    const { messageType = 'zip-write', ...payload } = request;
    transferJob = { id: operationId, ...(foreground ? {} : { queueJobId: operationQueue?.active?.id }), phase: request.action === 'remove' ? 'deleting' : messageType === 'zip-test' ? 'verifying' : 'preparing', zipWrite: messageType === 'zip-write', hostActive: true, context: Object.freeze({ mode: request.action === 'remove' ? 'delete' : 'copy', sources: Object.freeze([]), target: request.archive || request.target || displayArchivePath(request.path) || '' }) };
    transferProgress(); requestFilesystem({ type: messageType, operationId, ...payload }, completed);
  }
  function zipPack(picked, sourcePath, targetPath, move = false, sourceSide = state.active) {
    if (!picked.length) return;
    const targetLocation = state.archiveLocations?.[targetPath];
    const archiveName = (picked.length === 1 ? columns.splitName(picked[0]).name : base(sourcePath)) + '.zip';
    const archive = targetLocation?.archive || join(targetPath, archiveName);
    modal(t('Auswahl packen'), `<p id="modal-description" class="dialog-description">${count('selectedEntry', picked.length)}</p>${field(t('Archivname'), archive)}<fieldset class="zip-pack-group"><legend>${t('Kompression und Verschlüsselung')}</legend><div class="zip-pack-settings"><div class="field"><label for="zip-level">${t('Kompressionsrate')}</label><input id="zip-level" type="number" min="0" max="9" value="6"></div><div class="field"><label for="zip-encryption">${t('Verschlüsselung')}</label><select id="zip-encryption"><option value="none">${t('Keine')}</option><option value="zipcrypto">ZIP2.0</option><option value="aes128">AES-128</option><option value="aes192">AES-192</option><option value="aes256">AES-256</option></select></div></div></fieldset><fieldset class="zip-pack-group"><legend>${t('Dateioptionen')}</legend><label class="zip-pack-check"><input id="zip-paths" type="checkbox" checked><span>${t('Pfade speichern')}</span></label><label class="zip-pack-check"><input id="zip-recursive" type="checkbox" checked><span>${t('Unterverzeichnisse rekursiv speichern')}</span></label><label class="zip-pack-check"><input id="zip-move" type="checkbox" ${move ? 'checked' : ''}><span>${t('Nach dem Packen Quellen entfernen')}</span></label></fieldset>`, t('Packen'), () => {
      const entered = $('#value').value.trim();
      if (!entered) return false;
      const normalized = inputPath(entered, parent(archive));
      const destination = /\.zip$/i.test(normalized) || targetLocation && paths.identity(normalized) === paths.identity(archive) ? normalized : normalized + '.zip';
      sendZipWrite({ action: 'pack', archive: destination, ...(targetLocation && paths.identity(destination) === paths.identity(archive) ? { path: targetPath } : {}), sourcePath, sourceSide, targetSide: 1 - sourceSide, ids: picked.map(row => row.id), level: Number($('#zip-level').value), encryption: $('#zip-encryption').value, paths: $('#zip-paths').checked, recursive: $('#zip-recursive').checked, move: $('#zip-move').checked }); return true;
    });
    $('#zip-level').value = String(fileSettings.zip?.level ?? 6);
    $('#zip-paths').checked = fileSettings.zip?.paths !== false;
    $('#zip-recursive').checked = fileSettings.zip?.recursive !== false;
  }
  function runTransfer({ sourceSide = state.active, targetSide = 1 - sourceSide, sourcePath: providedSourcePath, ids, targetPath, mode = 'copy', onComplete, validateSelection, sourceGroups }) {
    if ((filesystemPending && !operationQueue?.active && !refreshingFilesystem) || transferPending) return;
    if (validateSelection && !validateSelection()) return toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.'));
    const sourcePane = state.panes[sourceSide];
    rememberSelection(sourcePane);
    const sourcePath = providedSourcePath || currentPath(sourcePane);
    if (state.archiveLocations?.[sourcePath]) {
      if (mode !== 'copy') return toast(t('Änderungen innerhalb von ZIP-Archiven sind im Pilot nicht verfügbar.'));
      const chosen = ids || (sourcePane.selected.length ? sourcePane.selected : [sourcePane.cursor]);
      const target = targetPath || currentPath(state.panes[1 - sourceSide]);
      if (state.archiveLocations?.[target]) return zipPack((state.folders[sourcePath] || []).filter(row => chosen.includes(row.id)), sourcePath, target, false, sourceSide);
      return runZipCopy(sourceSide, sourcePath, (state.folders[sourcePath] || []).filter(row => chosen.includes(row.id)), targetPath);
    }
    if (state.archiveLocations?.[targetPath || currentPath(state.panes[1 - sourceSide])]) {
      const selected = ids || (sourcePane.selected.length ? sourcePane.selected : [sourcePane.cursor]);
      return zipPack((state.folders[sourcePath] || []).filter(row => selected.includes(row.id)), sourcePath, targetPath || currentPath(state.panes[1 - sourceSide]), mode === 'move', sourceSide);
    }
    const pickedIds = ids || (sourcePane.selected.length ? sourcePane.selected : sourcePane.cursor ? [sourcePane.cursor] : []);
    const picked = (state.folders[sourcePath] || []).filter(file => pickedIds.includes(file.id));
    if (!picked.length) { toast(t('Zuerst eine Datei oder einen Ordner auswählen.')); onComplete?.({ confirmed: false, completed: 0, completedIds: [], errors: [], cancelled: true }); return; }
    const policies = [['ask', t('Bei Konflikten nachfragen')], ['overwrite-all', t('Alle überschreiben')], ['skip-all', t('Alle vorhandenen überspringen')], ['overwrite-older', t('Alle älteren überschreiben')], ['overwrite-older-equal', t('Alle älteren und gleich alten überschreiben')], ['rename-older-target', t('Ältere Ziele umbenennen, neuere überspringen')], ['autorename-source', t('Kopien automatisch umbenennen')], ['autorename-target', t('Vorhandene Ziele automatisch umbenennen')], ['larger', t('Nur größere Dateien kopieren')], ['smaller', t('Nur kleinere Dateien kopieren')]];
    const cancelled = () => { if ($('#modal').open) return; $('#modal').removeEventListener('close', cancelled); onComplete?.({ confirmed: false, completed: 0, completedIds: [], errors: [], cancelled: true }); };
    modal(mode === 'move' ? t('Verschieben') : t('Kopieren'), `<p id="modal-description" class="dialog-description">${count('selectedEntry', picked.length)}</p><div class="transfer-source"><span>${t('Quelle')}</span><div data-transfer-source>${escape(displayPath(sourcePath))}</div></div>${field(mode === 'move' ? t('Verschieben nach') : t('Kopieren nach'), targetPath || currentPath(state.panes[1 - sourceSide]))}${field(t('Nur Dateien dieses Typs'), '*.*', 'transfer-filter')}<label><input type="checkbox" id="transfer-individual"> ${t('Jede Datei einzeln umbenennen')}</label><details class="dialog-options"><summary>${t('Optionen')}</summary><div class="field"><label for="transfer-policy">${t('Bei vorhandenen Zieldateien')}</label><select id="transfer-policy">${policies.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div><p class="dialog-hint">${t('Bei einer einzelnen Datei kann das Ziel auch einen neuen Dateinamen enthalten. Filter unterstützen * und ? sowie Ausschlüsse hinter |.')}</p></details>`, mode === 'move' ? t('Verschieben') : t('Kopieren'), () => {
      let destination = $('#value').value;
      if (sourceGroups?.length && sourceGroups.reduce((sum, group) => sum + group.ids.length, 0) > 1 && destination.trim() && !/[\\/]$/.test(destination)) destination += '/';
      if (validateSelection && !validateSelection()) { toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.')); return false; }
      try { for (const group of sourceGroups || [{ sourcePath, ids: picked.map(file => file.id) }]) window.CommanderTransfer.planTarget({ folders: state.folders, sourcePath: group.sourcePath, ids: group.ids, targetPath: destination }); }
      catch (error) { toast(error.message); return false; }
      const options = { sourceSide, targetSide, sourcePath, ids: picked.map(file => file.id), targetPath: destination, mode, individualNames: $('#transfer-individual').checked, filter: $('#transfer-filter').value, policy: $('#transfer-policy').value, onComplete, validateSelection };
      if (sourceGroups?.length) {
        options.policyState = { value: options.policy };
        let index = 0;
        options.onComplete = result => {
          index++;
          if (result.confirmed && !result.cancelled && !result.errors?.length && index < sourceGroups.length) {
            const group = sourceGroups[index];
            executeTransfer({ ...options, sourcePath: group.sourcePath, ids: group.ids }).catch(error => failTransferExecution(error, onComplete));
          } else onComplete?.(result);
        };
      }
      $('#modal').removeEventListener('close', cancelled);
      $('#modal').close();
      executeTransfer(options).catch(error => failTransferExecution(error, onComplete));
      return false;
    });
    if (sourceGroups?.length) { $('#modal-description').textContent = count('selectedEntry', sourceGroups.reduce((sum, group) => sum + group.ids.length, 0)); document.querySelector('[data-transfer-source]').textContent = sourceGroups.map(group => displayPath(group.sourcePath)).join('\n'); }
    $('#value').dataset.transferName = mode;
    $('#value').required = false;
    reportFocus();
    if (onComplete) $('#modal').addEventListener('close', cancelled);
  }
  function transferResultSelection(picked, mode, targetPath) {
    if (!picked.length) return;
    if (picked.some(row => row.archive)) return toast(t('Dateioperationen innerhalb von Archiven sind nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.'));
    const groups = [];
    for (const row of picked) { const sourcePath = parent(row.fsSource); let group = groups.find(group => group.sourcePath === sourcePath); if (!group) { group = { sourcePath, ids: [] }; groups.push(group); } group.ids.push(row.id); }
    runTransfer({ sourceSide: state.active, sourcePath: groups[0].sourcePath, ids: groups[0].ids, sourceGroups: groups, targetPath, mode });
  }
  function selectTransferName(key) {
    const input = document.activeElement;
    if (!$('#modal').open || !input?.matches('#value[data-transfer-name]')) return;
    if (key && key !== (input.dataset.transferName === 'move' ? 'F6' : 'F5')) return;
    const value = input.value;
    if (!value || /[\\/]$/.test(value) || Object.hasOwn(state.folders, value.replace(/\\/g, '/'))) return;
    const start = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1;
    const dot = value.lastIndexOf('.');
    if (input.dataset.nameSelectionValue !== value) input.dataset.nameSelectionStep = '0';
    input.dataset.nameSelectionValue = value;
    const step = Math.min(2, Number(input.dataset.nameSelectionStep || 0) + 1);
    input.dataset.nameSelectionStep = String(step);
    input.setSelectionRange(start, step === 1 && dot > start ? dot : value.length);
  }
  function startTransferName() {
    const input = document.activeElement;
    if (!$('#modal').open || !input?.matches('#value[data-transfer-name]')) return;
    const start = Math.max(input.value.lastIndexOf('/'), input.value.lastIndexOf('\\')) + 1;
    input.setSelectionRange(start, start);
  }
  function validDraggedFiles(source) {
    if (source?.kind !== 'files' || currentPath(state.panes[source.side]) !== source.sourcePath || !source.items.length) return false;
    const byId = new Map((state.folders[source.sourcePath] || []).map(file => [file.id, file]));
    return source.items.every(item => JSON.stringify(byId.get(item.id)) === item.signature);
  }
  function internalDeleteDrop(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    return !types.length || types.includes('application/x-bitfroest-files');
  }
  function action(kind, frozen) {
    const command = window.CommanderJobs.commandForAction(kind);
    if ((filesystemPending && !((operationQueue?.active || refreshingFilesystem) && (command?.supportsBackgroundOperation.enabled || ['parent', 'up', 'open'].includes(kind)))) || navigationRequests.size && !command?.supportsBackgroundOperation.enabled || transferPending) return;
    if (frozen && !validDraggedFiles(frozen)) return toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.'));
    if (state.realFilesystem && kind === 'reset') return toast(t('Diese Aktion ist für das reale Dateisystem noch nicht verfügbar.'));
    const p = frozen ? state.panes[frozen.side] : pane(), source = currentPath(p), marked = selected(), picked = frozen ? files(p).filter(file => frozen.ids.includes(file.id)) : marked.length ? marked : files(p).filter(file => file.id === p.cursor);
    if (['copy', 'copy-same', 'move', 'delete', 'delete-alternate', 'delete-permanently', 'rename', 'pack', 'pack-move', 'unpack', 'mkdir', 'mkdir-other', 'new-file'].includes(kind)) rememberSelection(p);
    if (state.realFilesystem && ['pack', 'pack-move'].includes(kind)) return zipPack(picked, source, currentPath(state.panes[1 - state.active]), kind === 'pack-move');
    if (state.realFilesystem && kind === 'test-archives' && !picked.length && !state.archiveLocations?.[source]) return toast(t('Zuerst eine Datei oder einen Ordner auswählen.'));
    if (state.realFilesystem && kind === 'test-archives') return sendZipWrite({ messageType: 'zip-test', path: source, sourcePath: source, sourceSide: state.active, targetSide: state.active, ids: picked.map(row => row.id) });
    if (state.realFilesystem && kind === 'unpack') {
      if (!picked.length || picked.some(row => !/\.zip$/i.test(row.name))) return toast(t('Zum Entpacken zuerst ein ZIP-Archiv markieren.'));
      modal(t('Archiv entpacken'), zipUnpackFields(currentPath(state.panes[1 - state.active]), true), t('Entpacken'), () => { const target = $('#value').value.trim(); sendZipWrite({ messageType: 'zip-unpack', sourcePath: source, sourceSide: state.active, targetSide: 1 - state.active, ids: picked.map(row => row.id), target: target ? inputPath(target, currentPath(state.panes[1 - state.active])) : '', ...zipUnpackOptions() }); return true; }); $('#value').required = false; return;
    }
    if (state.archiveLocations?.[source] && ['delete', 'delete-alternate', 'delete-permanently'].includes(kind)) {
      if (!picked.length) return;
      return modal(t('Auswahl löschen'), `<p>${count('selectedEntry', picked.length)}</p>`, t('Löschen'), () => { sendZipWrite({ action: 'remove', path: source, ids: picked.map(row => row.id) }); return true; });
    }
    if (state.archiveLocations?.[source] && !['copy', 'swap', 'mkdir', 'new-file', 'view', 'edit'].includes(kind)) return toast(t('Diese Aktion ist innerhalb eines ZIP-Archivs nicht verfügbar.'));
    if (state.archiveLocations?.[source] && kind === 'copy') return state.archiveLocations?.[currentPath(state.panes[1 - state.active])] ? zipPack(picked, source, currentPath(state.panes[1 - state.active])) : runZipCopy(frozen?.side ?? state.active, source, picked);
    if (state.archiveLocations?.[source] && ['mkdir', 'new-file'].includes(kind)) return modal(t(kind === 'mkdir' ? 'Neuer Ordner' : 'Neue Textdatei'), field(t('Name'), ''), t('Erstellen'), () => {
      const name = $('#value').value; if (!validName(name)) return false;
      sendZipWrite({ action: kind, path: source, name }, kind === 'new-file' ? () => { const file = state.folders[source]?.find(row => row.name === name); if (file) hostAction('edit', { path: file.fsSource }); } : undefined); return true;
    });
    if (kind === 'reset') { state = initial(); render(true); toast(t('Beispieldaten zurückgesetzt'), 'success'); return; }
    if (kind === 'swap') { state.panes.reverse(); rememberedSelections.reverse(); state.active = 1 - state.active; render(true); toast(t('Seiten getauscht.'), 'success'); return; }
    if (kind === 'mkdir' || kind === 'mkdir-other' || kind === 'new-file') {
      const targetPane = kind === 'mkdir-other' ? state.panes[1 - state.active] : p, targetPath = currentPath(targetPane);
      const file = kind === 'new-file', openedAt = new Date(), cursor = files(p).find(item => item.id === p.cursor);
      const dot = cursor?.name.lastIndexOf('.') ?? -1;
      const proposed = cursor ? cursor.type !== 'folder' && dot > 0 ? cursor.name.slice(0, dot) : cursor.name : t('Neuer Ordner');
      const create = () => {
        let plan;
        const entered = $('#value').value;
        try { plan = window.CommanderFileNames.plan(entered, { base: targetPath, folders: state.folders, kind: file ? 'file' : 'folder', allowExisting: !file, now: openedAt, currentName: cursor?.name, currentType: cursor?.type }); }
        catch (error) { toast(t(error.message)); return false; }
        if (prepareFolders([...plan.paths, ...plan.directories].map(parent), kind, create, false)) return false;
        window.CommanderFileNames.ensureDirectories(state.folders, plan.directories, name => entry(name, 'folder'));
        if (file) for (const path of plan.paths) state.folders[parent(path)].push(entry(base(path), 'text'));
        const focusCreated = () => {
          if (plan.paths.length !== 1 || parent(plan.paths[0]) !== targetPath) return;
          const created = (state.folders[targetPath] || []).find(item => item.name === base(plan.paths[0]));
          const view = state.panes[kind === 'mkdir-other' ? 1 - state.active : state.active];
          view.cursor = created.id; view.selected = [created.id]; render(true);
        };
        const afterCreation = () => {
          focusCreated();
          if (!state.realFilesystem || changed) toast(t(file ? plan.paths.length === 1 ? 'Datei erstellt' : 'Dateien erstellt' : plan.paths.length === 1 ? 'Ordner erstellt' : 'Mehrere Ordner erstellt'), 'success');
          if (file && plan.openEditor) {
            const path = plan.paths[0], created = state.folders[parent(path)].find(item => item.name === base(path));
            preview(created, true);
          }
        };
        const changed = JSON.stringify(state.folders) !== confirmedFolders;
        if (state.realFilesystem && changed) { filesystemResume = afterCreation; creationFailure = () => show(entered); }
        $('#modal').close(); render(true);
        if (!state.realFilesystem || !changed) afterCreation();
        return false;
      };
      const show = value => modal(t(file ? 'Neue Textdatei' : 'Neuer Ordner'), ui`<p>Erstellen in <strong>${escape(displayPath(targetPath))}</strong></p>${field(t(file ? 'Dateiname' : 'Ordnername'), value)}`, t(file ? 'Datei erstellen' : 'Ordner erstellen'), create);
      show(file ? '' : proposed); return;
    }
    if (!picked.length) return toast(t('Zuerst eine oder mehrere Dateien markieren.'));
    if (picked.some(row => row.archive) && !['view', 'edit'].includes(kind)) return toast(t('Dateioperationen innerhalb von Archiven sind nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.'));
    if (['delete', 'delete-alternate', 'delete-permanently', 'rename'].includes(kind) && prepareFolders(picked.filter(file => file.type === 'folder').map(file => resultView(p) ? file.fsSource : join(source, file.name)), kind, () => action(kind, frozen))) return;
    if (kind === 'view' || kind === 'edit') return preview(picked[0], kind === 'edit');
    if (['delete', 'delete-alternate', 'delete-permanently'].includes(kind)) {
      const useTrash = kind === 'delete-permanently' ? false : kind === 'delete-alternate' ? fileSettings.deleteToTrash === false : fileSettings.deleteToTrash !== false;
      modal(state.realFilesystem ? t(useTrash ? 'In den Papierkorb verschieben?' : 'Endgültig löschen?') : t('Auswahl löschen?'), ui`<p>${count('entry', picked.length)} ${state.realFilesystem ? t(useTrash ? picked.length === 1 ? 'wird in den Papierkorb verschoben.' : 'werden in den Papierkorb verschoben.' : picked.length === 1 ? 'wird endgültig gelöscht.' : 'werden endgültig gelöscht.') : t(picked.length === 1 ? 'wird aus den Beispieldaten entfernt.' : 'werden aus den Beispieldaten entfernt.')}</p><p>${picked.map(file => escape(file.name)).join('<br>')}</p>`, state.realFilesystem ? t(useTrash ? 'In den Papierkorb' : 'Endgültig löschen') : t('Mockup löschen'), () => {
        if (frozen && !validDraggedFiles(frozen)) { toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.')); return false; }
        if (state.realFilesystem) {
          const paths = picked.map(file => resultView(p) ? file.fsSource : join(source, file.name));
          $('#modal').close();
          transferJob = { id: `delete-${Date.now()}-${++transferSequence}`, phase: 'deleting', hostActive: true, context: { mode: 'delete', sources: paths, target: source } };
          transferProgress(); requestFilesystem({ type: 'filesystem-delete', operationId: transferJob.id, paths, useTrash });
          return false;
        }
        picked.forEach(file => removeTree(join(source, file.name), file.type === 'archive'));
        state.folders[source] = files(p).filter(file => !picked.some(item => item.id === file.id)); p.selected = []; p.cursor = null; render(true); toast(state.realFilesystem ? t('Löschen wird ausgeführt') : t('Auswahl aus Beispieldaten gelöscht'), state.realFilesystem ? 'info' : 'success'); return true;
      }); return;
    }
    if (kind === 'copy' || kind === 'move') {
      if (resultView(p)) {
        transferResultSelection(picked, kind, currentPath(state.panes[1 - state.active]));
      } else runTransfer({ sourceSide: state.active, targetPath: currentPath(state.panes[1 - state.active]), mode: kind });
      return;
    }
    if (kind === 'rename') return rename(picked, source);
    if (kind === 'pack') {
      modal(t('Auswahl packen'), ui`<p>${picked.length} Einträge als neues Beispielarchiv zusammenfassen.</p>${field(t('Archivname'), 'Auswahl.zip')}`, t('ZIP erstellen'), () => {
        const name = $('#value').value;
        if (!validName(name) || !name.toLowerCase().endsWith('.zip') || !uniqueName(files(p), name)) { toast(t('Bitte einen freien ZIP-Dateinamen eingeben.')); return false; }
        const target = `${join(source, name)}!`;
        state.folders[target] = picked.map(file => ({ ...clone(file), id: String(nextId++) }));
        picked.forEach(file => { copyTree(join(source, file.name), join(target, file.name)); if (file.type === 'archive') copyTree(`${join(source, file.name)}!`, `${join(target, file.name)}!`); });
        files(p).push(entry(name, 'archive', Math.round(picked.reduce((sum, f) => sum + f.size, 0) * .7))); render(); toast(t('Beispielarchiv erstellt · keine echte Kompression'), 'success'); return true;
      }); return;
    }
    if (kind === 'unpack') {
      const archive = picked.find(file => file.type === 'archive');
      if (!archive) return toast(t('Zum Entpacken zuerst ein ZIP-Archiv markieren.'));
      const contentPath = `${join(source, archive.name)}!`;
      if (!Object.hasOwn(state.folders, contentPath)) return toast(t('Für dieses Archiv sind keine Beispieldaten hinterlegt.'));
      const target = currentPath(state.panes[1 - state.active]);
      modal(t('Archiv entpacken'), ui`<p>${escape(archive.name)} → Gegenseite</p>${field(t('Zielordner'), target)}`, t('Entpacken'), () => {
        const destination = $('#value').value;
        if (!Object.hasOwn(state.folders, destination) || destination === contentPath || destination.startsWith(`${contentPath}/`)) { toast(t('Bitte einen anderen vorhandenen Zielordner wählen.')); return false; }
        if (state.folders[contentPath].some(file => !uniqueName(state.folders[destination], file.name))) { toast(t('Namenskonflikt im Ziel. Bitte einen anderen Zielordner wählen.')); return false; }
        state.folders[contentPath].forEach(file => { state.folders[destination].push({ ...clone(file), id: String(nextId++) }); copyTree(join(contentPath, file.name), join(destination, file.name)); if (file.type === 'archive') copyTree(`${join(contentPath, file.name)}!`, `${join(destination, file.name)}!`); });
        render(); toast(t('Beispielarchiv entpackt'), 'success'); return true;
      });
    }
  }
  function rename(picked, source) {
    const directories = picked.map(file => resultView(pane()) ? parent(file.fsSource) : source);
    modal(t('Mehrfach-Umbenennen'), ui(['<p>Die Vorschau wird beim Eingeben aktualisiert. [N] = Name, [C] = Zähler.</p><div class="field-row">']) + field(t('Namensmaske'), '[N]_[C]', 'mask') + field(t('Zähler beginnt bei'), '1', 'counter') + '</div><div class="field-row">' + field(t('Suchen (optional)'), '', 'search') + field(t('Ersetzen durch'), '', 'replacement') + ui(['</div><div class="field"><label for="casing">Groß-/Kleinschreibung</label><select id="casing"><option value="keep">Unverändert</option><option value="lower">kleinbuchstaben</option><option value="upper">GROSSBUCHSTABEN</option></select></div><table class="rename-table"><thead><tr><th>Alter Name</th><th>Neuer Name</th></tr></thead><tbody id="rename-preview"></tbody></table>']), t('Umbenennen'), () => {
      const names = renamedNames();
      if (names.some(name => !validName(name)) || new Set(names.map((name, index) => join(directories[index], name).toLowerCase())).size !== names.length || names.some((name, index) => (state.folders[directories[index]] || []).some(file => !picked.includes(file) && file.name.toLowerCase() === name.toLowerCase()))) { toast(t('Die Vorschau enthält ungültige Namen oder Namenskonflikte.')); return false; }
      const previous = picked.map(file => file.name);
      const trees = [];
      picked.forEach((file, index) => {
        const oldPath = join(directories[index], previous[index]);
        Object.entries(state.folders).forEach(([key, value]) => { if (inTree(key, oldPath, file.type === 'archive')) trees.push([key, join(directories[index], names[index]) + key.slice(oldPath.length), value]); });
      });
      moveResultReferences(picked.map((file, index) => [join(directories[index], previous[index]), join(directories[index], names[index])]));
      trees.forEach(([old]) => delete state.folders[old]); trees.forEach(([, target, value]) => { state.folders[target] = value; });
      picked.forEach((file, index) => { file.name = names[index]; });
      const completed = () => toast(`${count('entry', picked.length)} ${t('umbenannt')}${state.realFilesystem ? '' : ui([' · Beispieldaten'])}`, 'success');
      const pending = state.realFilesystem && JSON.stringify(state.folders) !== confirmedFolders;
      if (pending) filesystemResume = completed;
      render(); if (!pending) completed(); return true;
    }, t('WERKZEUGE · STRG M'));
    $('#search').required = false; $('#replacement').required = false; $('#counter').type = 'number'; $('#counter').min = '0';
    function renamedNames() {
      return picked.map((file, index) => {
        const dot = file.type === 'folder' ? -1 : file.name.lastIndexOf('.');
        const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
        const suffix = dot > 0 ? file.name.slice(dot) : '';
        let name = $('#mask').value.replaceAll('[N]', stem).replaceAll('[C]', String(Number($('#counter').value || 0) + index));
        if ($('#search').value) name = name.split($('#search').value).join($('#replacement').value);
        name += suffix;
        return $('#casing').value === 'lower' ? name.toLowerCase() : $('#casing').value === 'upper' ? name.toUpperCase() : name;
      });
    }
    function update() { $('#rename-preview').innerHTML = renamedNames().map((name, index) => `<tr><td>${escape(picked[index].name)}</td><td>${escape(name)}</td></tr>`).join(''); }
    $('#modal-body').oninput = update; update();
    $('#modal').addEventListener('close', () => { $('#modal-body').oninput = null; }, { once: true });
  }
  let languageReloadTimer;
  window.addEventListener('pagehide', () => clearTimeout(languageReloadTimer), { once: true });
  function requestLanguageReload() {
    clearTimeout(languageReloadTimer);
    if (filesystemPending || navigationRequests.size || transferPending || transferJob || rightDropChoice || shellMenuPending || clipboardRequests.size || $('#modal').open || fileSearch.isOpen || document.querySelector('.inline-rename')) {
      languageReloadTimer = setTimeout(requestLanguageReload, 100);
      return;
    }
    rememberScroll();
    persist();
    document.body.inert = true;
    host.postMessage({ type: 'language-reload', state });
  }
  const statusLogRequests = new Map(); let statusLogSequence = 0;
  const statusHostEvents = []; let omittedHostEvents = 0;
  function recordHostEvent(value) {
    statusHostEvents.push({ receivedAt: new Date().toISOString(), ...value });
    if (statusHostEvents.length > 256) { statusHostEvents.shift(); omittedHostEvents++; }
  }
  window.addEventListener('message', event => {
    const value = event.data;
    if (!value || typeof value.type !== 'string' || !/^(filesystem-|git-|transfer-|zip-|folder-size-|search-)/.test(value.type)) return;
    const fields = Object.fromEntries(['type', 'emittedAt', 'requestId', 'refreshRequestId', 'navigationRequestId', 'taskRequestId', 'operationId', 'snapshotId', 'path', 'phase', 'completed', 'total', 'ok', 'partial', 'cancelled', 'error', 'diagnostic'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    if (value.progress) fields.progress = { phase: value.progress.phase, path: value.progress.path, overall: value.progress.overall, current: value.progress.current };
    if (value.directories) fields.directories = Object.entries(value.directories).map(([path, info]) => ({ path, phase: info?.phase, stage: info?.stage, ok: info?.ok, loading: info?.loading, error: info?.error, repositoryResult: info?.repositoryResult, overall: info?.overall, current: info?.current }));
    if (typeof value.emittedAt === 'number' && Number.isFinite(value.emittedAt)) fields.transportDelayMs = Math.max(0, Date.now() - value.emittedAt);
    recordHostEvent(fields);
  });
  window.addEventListener('error', event => recordHostEvent({ type: 'webview-error', message: event.message, source: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack }));
  window.addEventListener('unhandledrejection', event => recordHostEvent({ type: 'webview-rejection', message: String(event.reason?.message || event.reason), stack: event.reason?.stack }));
  function copyStatusLog(text) {
    return new Promise((resolve, reject) => {
      if (!host) { reject(new Error(t('Diese Auswahlaktion benötigt den Erweiterungshost.'))); return; }
      const requestId = `status-log-${++statusLogSequence}`;
      const timer = window.setTimeout(() => { statusLogRequests.delete(requestId); reject(new Error(t('Keine Antwort auf die Zwischenablage-Anfrage.'))); }, 15000);
      statusLogRequests.set(requestId, { resolve, reject, timer });
      host.postMessage({ type: 'status-log-copy', requestId, text });
    });
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'status-log-copy-result') return;
    const request = statusLogRequests.get(event.data.requestId); if (!request) return;
    statusLogRequests.delete(event.data.requestId); window.clearTimeout(request.timer);
    if (event.data.ok) request.resolve(); else request.reject(new Error(event.data.error || t('Protokoll konnte nicht kopiert werden.')));
  });
  window.addEventListener('pagehide', () => { for (const request of statusLogRequests.values()) { window.clearTimeout(request.timer); request.reject(new Error(t('Die Dateiverwaltung wurde geschlossen.'))); } statusLogRequests.clear(); }, { once: true });
  const statusbar = window.CommanderStatusbar.create({ t, onCopyLog: copyStatusLog,
    getLogContext: () => ({ snapshotId: state.snapshotId, language: document.body.dataset.language, timeOrigin: performance.timeOrigin, hostEvents: [...statusHostEvents], omittedHostEvents, activePane: state.active, panes: state.panes.map(p => ({ path: currentPath(p), tab: p.tab })), filesystemPending, refreshingFilesystem, refreshRequestId, pendingFilesystemKind,
      gitPending: [...gitPending], gitRequests: [...gitBindings].map(([path, request]) => ({ path, requestId: request.requestId, snapshotId: request.snapshotId, startedAt: request.startedAt })), navigationRequests: [...navigationRequests.keys()], activeJob: operationQueue?.active && { id: operationQueue.active.id, command: operationQueue.active.command } }),
    onLanguage: () => { if (host) host.postMessage({ type: 'choose-language' }); }, version: decodeURIComponent(document.body.dataset.extensionVersion || ''), actions, onCancel: cancelTransfer, focusList: () => { const list = document.querySelectorAll('.list')[state.active]; if (list instanceof HTMLElement) list.focus({ preventScroll: true }); } });
  operationQueue = window.CommanderJobs.createQueue({
    start: job => runQueuedOperation(job, () => job.run(job)),
    cancel: job => { if (deferredQueueJob === job) { deferredQueueJob = null; deferredQueueRun = null; operationQueue.complete(job.id, { cancelled: true }); } else cancelTransfer(); },
    finish: (job, result) => {
      jobTabFallbacks.delete(job.id);
      if (result.error && operationFailure !== result.error) showOperationFailure(result.error, { notify: false });
      statusbar.notify(`${job.request.title} · ${job.request.target} · ${result.error || result.message || t(result.cancelled ? 'Abgebrochen' : 'Dateioperation beendet')}`, result.error || result.ok === false ? window.CommanderWorkbench.Severity.Error : undefined, job.id);
    },
    change: () => jobView?.update(operationQueue.items)
  });
  jobView = window.CommanderJobs.createView({ t, getState: () => state, cancel: id => operationQueue.cancel(id), navigate: job => {
    const location = job.request.targetLocation;
    const needsLoad = !Object.hasOwn(state.folders, job.request.target) || state.unloadedFolders?.includes(job.request.target);
    if (location && [0, 1].includes(location.pane)) {
      const targetPane = state.panes[location.pane];
      let index = targetPane.tabStates.findIndex(tab => tab.id === location.tabId);
      if (index < 0) {
        const fallbackId = jobTabFallbacks.get(job.id);
        index = fallbackId ? targetPane.tabStates.findIndex(tab => tab.id === fallbackId) : -1;
        if (index < 0) { index = tabs.openPath(targetPane, job.request.target); jobTabFallbacks.set(job.id, targetPane.tabStates[index].id); }
      }
      state.active = location.pane;
      tabs.activate(targetPane, index);
      render(true);
    }
    if (needsLoad || window.CommanderPaths.identity(currentPath(pane())) !== window.CommanderPaths.identity(job.request.target)) go(job.request.target);
    queueMicrotask(() => document.querySelector(`.pane.active [data-job-row="${job.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  } });
  window.addEventListener('pagehide', () => { operationQueue.dispose(); jobView.dispose(); }, { once: true });

  function markDuplicateResults() {
    const p = pane(), result = resultView(p);
    if (!result?.groups || !Object.keys(result.groups).length || $('#modal').open) return;
    const rows = visible(p).map(row => ({ ...row, group: result.groups[row.fsSource] }));
    const select = (id, label, options) => `<label class="field">${t(label)}<select id="${id}">${options.map(([value, text]) => `<option value="${value}">${t(text)}</option>`).join('')}</select></label>`;
    const folders = [...new Set(rows.map(row => parent(row.fsSource)))].sort();
    const dateOptions = [['none', 'Keine Einschränkung'], ['older', 'Alle älteren Dateien'], ['newer', 'Alle neueren Dateien'], ['oldest', 'Nur die älteste Datei'], ['newest', 'Nur die neueste Datei']];
    const sizeOptions = [['none', 'Keine Einschränkung'], ['larger', 'Alle größer als die kleinste Datei'], ['smaller', 'Alle kleiner als die größte Datei'], ['largest', 'Nur die größte Datei'], ['smallest', 'Nur die kleinste Datei']];
    const keep = [['newest', 'Neueste'], ['oldest', 'Älteste'], ['largest', 'Größte'], ['smallest', 'Kleinste'], ['first', 'Erste pro Gruppe'], ['last', 'Letzte pro Gruppe']];
    let applying = false;
    const applySelection = async close => {
      if (applying) return; applying = true;
      const activeId = p.tabStates[p.tab].id;
      const settings = { include: $('#duplicate-name').value, exclude: $('#duplicate-remove').value, date: $('#duplicate-date').value, size: $('#duplicate-size').value, includeChildren: $('#duplicate-subfolders').checked, folderPattern: $('#duplicate-pattern').value, directParent: $('#duplicate-parent').checked, keepOne: $('#duplicate-keep-one').checked, keep: [1, 2, 3].map(i => $(`#duplicate-keep-${i}`).value) };
      if ($('#duplicate-use-folders').checked) settings.folders = [...$('#duplicate-folders').selectedOptions].map(option => option.value);
      try {
        if (settings.include.startsWith('>')) settings.includeIds = await fileSearch.evaluatePreset(settings.include.slice(1), rows);
        if (settings.exclude.startsWith('>')) settings.excludeIds = await fileSearch.evaluatePreset(settings.exclude.slice(1), rows);
        if (!$('#modal').open || p.tabStates[p.tab].id !== activeId) return;
        p.selected = window.CommanderSearchDuplicates.selectDuplicates(rows, settings); render();
        if (close) { $('#modal').close(); render(true); }
      } catch (error) { toast(error.message); }
      finally { applying = false; }
    };
    modal(t('Doppelte Dateien markieren'), `<div class="field-row">${field(t('Markieren nach Name/Erweiterung'), '*', 'duplicate-name')}${field(t('Markierung entfernen nach Name/Erweiterung'), '', 'duplicate-remove')}</div><div class="field-row">${select('duplicate-date', 'Markieren nach Datum/Zeit', dateOptions)}${select('duplicate-size', 'Markieren nach Dateigröße', sizeOptions)}</div><details class="dialog-options"><summary>${t('Markieren nach Ordner')}</summary><label><input id="duplicate-use-folders" type="checkbox"> ${t('Nur in gewählten Ordnern markieren')}</label><select id="duplicate-folders" multiple size="5" aria-label="${t('Ordner')}">${folders.map(folder => `<option value="${escape(folder)}" selected>${escape(displayPath(folder))}</option>`).join('')}</select><div>${['all', 'none', 'invert'].map((key, index) => `<button type="button" data-duplicate-folders="${key}">${t(['Alle', 'Keine', 'Umkehren'][index])}</button>`).join('')}</div><label><input id="duplicate-subfolders" type="checkbox"> ${t('Auch alle Unterordner markieren')}</label>${field(t('Ordner mit Muster markieren'), '', 'duplicate-pattern')}<label><input id="duplicate-parent" type="checkbox"> ${t('Dieses Muster nur auf das direkte Vaterverzeichnis anwenden')}</label></details><label><input id="duplicate-keep-one" type="checkbox"> ${t('Mindestens eine Datei pro Gruppe nicht markieren')}</label><div class="field-row">${[1, 2, 3].map(i => select(`duplicate-keep-${i}`, `${t('Priorität')} ${i}`, keep)).join('')}</div><p class="dialog-hint">${t('Masken, reguläre Ausdrücke mit < und gespeicherte Suchen mit > werden unterstützt.')}</p><button type="button" data-duplicate-apply>${t('Anwenden')}</button>`, t('OK'), () => { applySelection(true); return false; });
    for (const id of ['duplicate-name', 'duplicate-remove', 'duplicate-pattern']) $('#' + id).required = false;
    $('#duplicate-keep-2').value = 'largest'; $('#duplicate-keep-3').value = 'first';
    $('[data-duplicate-apply]').onclick = () => applySelection(false);
    for (const button of document.querySelectorAll('[data-duplicate-folders]')) button.onclick = () => {
      for (const option of $('#duplicate-folders').options) option.selected = button.dataset.duplicateFolders === 'all' || button.dataset.duplicateFolders === 'invert' && !option.selected;
    };
  }
  function run(command, reverseDirectories = false, contextSelection) {
    if (command === 'git-diff') { requestGitDiff(contextSelection); return; }
    if (typeof command !== 'string') return;
    if (navigationRequests.size && !window.CommanderJobs.commandForAction(command)?.supportsBackgroundOperation.enabled && !['parent', 'up', 'back', 'forward', 'new-tab', 'background-tab', 'close-tab', 'next-tab', 'previous-tab', 'open-dir-tab', 'open-dir-other-tab', 'open', 'filter', 'path', 'toggle-selection-next', 'select-all', 'clear', 'invert'].includes(command) && !command.startsWith('sort:')) return;
    if (command === 'open-terminal') {
      if ($('#modal').open || document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') || !document.activeElement?.closest('.list') || filesystemPending) return;
      if (state.archiveLocations?.[currentPath(pane())] || currentPath(pane()).startsWith('zip:')) return toast(t('Diese Aktion ist innerhalb eines ZIP-Archivs nicht verfügbar.'));
      if (pane().tabStates?.[pane().tab]?.searchResult) return;
      hostAction('open-terminal', { path: currentPath(pane()) }); return;
    }
    const selectionAction = ['select-group', 'unselect-group', 'select-all', 'clear', 'invert', 'select-extension', 'unselect-extension', 'save-selection', 'restore-selection', 'save-selection-file', 'load-selection-file', 'copy-names', 'copy-full-names', 'copy-details', 'copy-full-details'].includes(command);
    if (selectionAction && ($('#modal').open || document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'))) return;
    if (command === 'git-branches') { if (gitInfo(currentPath(pane()))?.repository) host?.postMessage({ type: 'git-branches', path: currentPath(pane()), snapshotId: state.snapshotId }); return; }
    if (command === 'settings') { hostAction('configure-settings'); return; }
    if (command === 'licenses') { hostAction('show-licenses'); return; }
    if (state.archiveLocations?.[currentPath(pane())] && ['shell-context-menu', 'inspect-folder-locks', 'clipboard-copy', 'clipboard-cut', 'clipboard-paste', 'copy-same'].includes(command)) return toast(t('Diese Aktion ist innerhalb eines ZIP-Archivs nicht verfügbar.'));
    if (command.startsWith('search-key:')) { fileSearch.key(command.slice(11)); return; }
    if (command === 'search' || command === 'search-separate') { if (!filesystemPending && !transferPending && !$('#modal').open) fileSearch.open(command === 'search-separate'); return; }
    if (fileSearch.contains(document.activeElement)) return;
    if (command === 'search-duplicates') { markDuplicateResults(); return; }
    if (command === 'search-normal') command = 'refresh';
    if (command === 'close-tab' && leaveResults()) return;
    if (lister.run(command)) return;
    if (command === 'shell-context-menu') { requestShellMenu(true); return; }
    if (command === 'inspect-folder-locks') { requestShellMenu(true, true); return; }
    if (filesystemPending && !operationQueue?.active && !(refreshingFilesystem && window.CommanderJobs.commandForAction(command)?.supportsBackgroundOperation.enabled) && (!transferJob || !['toggle-selection-next', 'select-all', 'clear', 'invert', 'filter', 'path', 'new-tab', 'background-tab', 'close-tab', 'next-tab', 'previous-tab'].includes(command))) return;
    if (filesystemPending && !operationQueue?.active && ['next-tab', 'previous-tab'].includes(command)) {
      const p = pane(), next = (p.tab + (command === 'next-tab' ? 1 : -1) + p.tabs.length) % p.tabs.length;
      if (state.unloadedFolders?.includes(p.tabs[next])) return;
    }
    if (selectionAction && selectionCommand(command, reverseDirectories)) return;
    if (command === 'open-trash') { if (host) hostAction('open-trash'); else toast(t('Die Papierkorbansicht ist auf diesem System nicht verfügbar.')); return; }
    if (command === 'toggle-selection-next') {
      if (!document.activeElement?.closest('.list') || document.activeElement.matches('input,textarea,select,[contenteditable="true"]') || $('#modal').open) return;
      const p = pane(), list = visible(p), index = list.findIndex(file => file.id === p.cursor);
      if (index < 0) return;
      p.cursorSelection = null;
      p.selected = p.selected.includes(p.cursor) ? p.selected.filter(id => id !== p.cursor) : [...p.selected, p.cursor];
      p.cursor = list[Math.min(index + 1, list.length - 1)].id;
      rememberSelectionAnchor(p); focusSelection(); activeRow(p.cursor)?.scrollIntoView({ block: 'nearest' }); toast(t('Markierung geändert.'), 'success'); return;
    }
    if (command === 'clipboard-copy' || command === 'clipboard-cut') { copyClipboard(command === 'clipboard-cut' ? 'move' : 'copy', contextSelection); return; }
    if (command === 'clipboard-paste') { pasteClipboard(); return; }
    if (command === 'copy-same') {
      const picked = selected().length ? selected() : files(pane()).filter(item => item.id === pane().cursor);
      if (resultView(pane())) { transferResultSelection(picked, 'copy', picked.length === 1 ? picked[0].fsSource : currentPath(pane())); return; }
      runTransfer({ sourceSide: state.active, targetSide: state.active, ids: picked.map(file => file.id), targetPath: picked.length === 1 ? join(currentPath(pane()), picked[0].name) : currentPath(pane()), mode: 'copy' }); return;
    }
    if (command === 'swap-paths') {
      rememberScroll(); const left = currentPath(state.panes[0]), right = currentPath(state.panes[1]);
      tabs.navigate(state.panes[0], right); tabs.navigate(state.panes[1], left); render(true); toast(t('Pfade getauscht.'), 'success'); return;
    }
    if (['new-tab', 'background-tab', 'close-tab', 'next-tab', 'previous-tab', 'open-dir-tab', 'open-dir-other-tab', 'back', 'forward'].includes(command)) {
      rememberScroll(); const p = pane(), previousViews = state.panes.map(paneDisplayState), previousPath = currentPath(p), previousTab = p.tabStates[p.tab].id, previousSide = state.active;
      if (command === 'new-tab' || command === 'background-tab') tabs.duplicate(p, { background: command === 'background-tab' });
      if (command === 'close-tab' && !tabs.close(p, contextSelection?.tabId ? p.tabStates.findIndex(tab => tab.id === contextSelection.tabId) : p.tab)) return toast(t('Der letzte Ordner-Tab bleibt geöffnet.'));
      if (command === 'next-tab' || command === 'previous-tab') tabs.step(p, command === 'next-tab' ? 1 : -1);
      if (command === 'back' || command === 'forward') tabs[command](p);
      if (command === 'open-dir-tab' || command === 'open-dir-other-tab') {
        const file = files(p).find(item => item.id === p.cursor);
        if (!file || !['folder', 'archive'].includes(file.type)) return;
        const destination = entryPath(p, file) + (file.type === 'archive' ? '!' : '');
        if (!Object.hasOwn(state.folders, destination)) return;
        if (host && state.realFilesystem && state.unloadedFolders?.includes(destination)) {
          requestFilesystem({ type: 'filesystem-navigate', path: destination, side: command === 'open-dir-other-tab' ? 1 - state.active : state.active }, () => run(command)); return;
        }
        const other = command === 'open-dir-other-tab';
        tabs.openPath(state.panes[other ? 1 - state.active : state.active], destination);
        if (other) state.active = 1 - state.active;
      }
      if (host && state.realFilesystem && !resultView(pane()) && (state.unloadedFolders?.includes(currentPath(pane())) || currentPath(pane()) !== previousPath || pane().tabStates[pane().tab].id !== previousTab || state.active !== previousSide)) {
        render(true, previousViews, false);
        requestFilesystem({ type: 'filesystem-navigate', path: currentPath(pane()), side: state.active }, () => { focusSelection(); toast(t('Ordner-Tab geändert.'), 'success'); }); return;
      }
      render(true, previousViews); toast(t('Ordner-Tab geändert.'), 'success'); return;
    }
    if (command === 'rename-one') { startRename(); return; }
    if (command === 'search-next' || command === 'search-previous') { applySearch(pane().filter, command === 'search-next' ? 1 : -1); return; }
    if (command.startsWith('sort:')) {
      const sort = command.slice(5);
      if (!['name', 'type', 'date', 'size'].includes(sort)) return;
      const p = pane(); p.descending = p.sort === sort ? !p.descending : false; p.sort = sort;
      const labels = { name: 'Name', type: 'Erweiterung', date: 'Datum und Zeit', size: 'Größe' };
      const message = t('Sortiert nach {0} ({1}).')
        .replace('{0}', t(labels[sort])).replace('{1}', t(p.descending ? 'absteigend' : 'aufsteigend'));
      render(true); toast(message, 'success'); return;
    }
    if (command === 'refresh' && operationQueue?.active) { requestFilesystem({ type: 'filesystem-navigate', path: currentPath(pane()), side: state.active }); return; }
    if (command === 'refresh') { requestedIcons.clear(); nativeIcons.clear(); if (state.realFilesystem && host) { pendingFilesystemKind = 'filesystem-refresh'; beginDirectoryRefresh(); filesystemPending = true; $('#panes').inert = true; $('#functionbar').inert = true; updateDirectoryActivity(); host.postMessage({ type: 'filesystem-refresh', refreshRequestId, state }); } else { render(true); } return; }
    if (command === 'path' || command === 'path-clipboard') { focusPath(command === 'path-clipboard'); return; }
    if (command === 'filter') { document.querySelectorAll('.list')[state.active].focus(); return; }
    if (command === 'help') modal(t('Tastatur & Prototyp'), ui(['<p>Tab wechselt die Dateiliste. Pfeiltasten navigieren. Enter öffnet Ordner und Archive. Rücktaste geht eine Ebene nach oben. Leertaste markiert; Strg-Klick und Umschalt-Klick erweitern die Auswahl.</p><p>F3–F8 bedienen die Dateiaktionen. Strg+M öffnet das Mehrfach-Umbenennen. Alt+F5 packt, Alt+F9 entpackt.</p><p>Alle Dateiaktionen verändern ausschließlich Beispieldaten. Im VS-Code-Host öffnet F4 ein ungespeichertes Dokument. Aufruf der Erweiterung: Strg+Alt+Umschalt+F12.</p>']), null, null, t('BEDIENUNG'));
    else action(command);
  }
  document.addEventListener('click', event => {
    const target = event.target;
    if (target.closest('[data-resize]') || target.closest('.inline-rename')) return;
    clearTimeout(renameTimer);
    const section = target.closest('[data-pane]');
    if (section) {
      state.active = Number(section.dataset.pane);
      queueMicrotask(() => jobView?.update(operationQueue.items));
      const p = pane();
      if (target.closest('[data-tab]')) {
        if (Number(target.closest('[data-tab]').dataset.tab) === p.tab) { focusSelection(); return; }
        if (filesystemPending && !operationQueue?.active && state.unloadedFolders?.includes(p.tabs[Number(target.closest('[data-tab]').dataset.tab)])) return;
        rememberScroll(); tabs.activate(p, Number(target.closest('[data-tab]').dataset.tab));
        render(true, undefined, false);
        if (host && state.realFilesystem && !resultView(p)) requestFilesystem({ type: 'filesystem-navigate', path: currentPath(p), side: state.active }, () => { focusSelection(); toast(t('Ordner-Tab geändert.'), 'success'); });
        else requestGitStatus();
        return;
      }
      if (target.closest('[data-new-tab]')) { run('new-tab'); return; }
      if (target.closest('[data-git-branch]')) { host?.postMessage({ type: 'git-branches', path: currentPath(p), snapshotId: state.snapshotId }); return; }
      if (target.closest('[data-favorites]')) { showFavorites(target.closest('[data-favorites]')); return; }
      if (target.closest('[data-refresh]')) { run('refresh'); return; }
      const breadcrumb = target.closest('[data-breadcrumb]');
      if (breadcrumb) { openBreadcrumb(breadcrumb.dataset.breadcrumb, event.ctrlKey); return; }
      if (target.closest('[data-path-edit]') || target.classList.contains('path-breadcrumbs')) { focusPath(); return; }
      if (target.closest('[data-sort]')) { const sort = target.closest('[data-sort]').dataset.sort; p.descending = p.sort === sort ? !p.descending : false; p.sort = sort; render(true); return; }
      const row = target.closest('tr[data-id]');
      if (row) {
        const id = row.dataset.id;
        const renameClick = p.cursor === id && p.selected.includes(id) && Date.now() - lastNameClick > 500 && event.detail === 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey && target.closest('[data-filename]');
        if (event.shiftKey && p.cursor) extendSelection(p, id, event.ctrlKey || event.metaKey);
        else if (event.ctrlKey || event.metaKey) p.selected = p.selected.includes(id) ? p.selected.filter(value => value !== id) : [...p.selected, id];
        else { p.selected = [id]; p.spaceMarked = []; }
        p.cursorSelection = !event.shiftKey && !event.ctrlKey && !event.metaKey ? id : null;
        p.cursor = id; if (!event.shiftKey) rememberSelectionAnchor(p); refreshSelection(); section.querySelector('.list').focus({ preventScroll: true });
        lastNameClick = Date.now();
        if (renameClick) renameTimer = setTimeout(startRename, 350);
        return;
      }
      refreshSelection();
    }
    const command = target.closest('[data-action]'); if (command) run(command.dataset.action);
  });
  $('#panes').addEventListener('dblclick', event => {
    clearTimeout(renameTimer); clearTimeout(run.tabTimer);
    const section = event.target.closest('[data-pane]'); if (!section) return;
    state.active = Number(section.dataset.pane);
    const tab = event.target.closest('[data-tab]');
    if (tab) { rememberScroll(); tabs.close(pane(), Number(tab.dataset.tab)); render(true); return; }
    const resize = event.target.closest('[data-resize]');
    if (resize) {
      sizePaneColumns(section, pane(), resize.dataset.resize);
      render(true); return;
    }
    if (event.target.closest('[data-parent]')) return goUp();
    const row = event.target.closest('[data-id]'); if (row) openFile(files(pane()).find(file => file.id === row.dataset.id));
  });
  $('#panes').addEventListener('auxclick', event => {
    const tab = event.target.closest('[data-tab]');
    if (!tab || event.button !== 1) return;
    event.preventDefault(); rememberScroll(); state.active = Number(tab.closest('[data-pane]').dataset.pane);
    tabs.close(pane(), Number(tab.dataset.tab)); render(true);
  });
  let dragged;
  let rightPointer = null, suppressRightContext = false;
  function finishRightDrop(action, requestId) {
    const choice = rightDropChoice;
    if (!choice || choice.requestId !== requestId) return;
    rightDropChoice = null;
    if (action === 'copy' || action === 'move') runTransfer({ sourceSide: choice.source.side, sourcePath: choice.source.sourcePath, ids: choice.source.ids, targetPath: choice.path, mode: action, validateSelection: choice.validate });
    reportFocus(); flushFocusRefresh();
  }
  function chooseRightDrop(source, destination) {
    if (filesystemPending || navigationRequests.size || transferPending || rightDropChoice || $('#modal').open) return;
    if (!validFileDropTarget(source, destination)) return;
    const path = destination.path, parentRow = (state.folders[parent(path)] || []).find(file => file.type === 'folder' && file.name === base(path));
    const signature = parentRow && JSON.stringify(parentRow);
    const validate = () => validDraggedFiles(source) && Object.hasOwn(state.folders, path) && (!signature || JSON.stringify((state.folders[parent(path)] || []).find(file => file.type === 'folder' && file.name === base(path))) === signature);
    if (!validate()) { toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.')); return; }
    const requestId = `right-drop-${++rightDropSequence}`;
    rightDropChoice = { source, path, validate, requestId };
    if (host) { host.postMessage({ type: 'choose-drop-action', requestId }); return; }
    modal(t('Aktion für die gezogene Auswahl'), `<div class="conflict-actions"><button type="button" data-right-drop="copy">${t('Hier kopieren')}</button><button type="button" data-right-drop="move">${t('Hier verschieben')}</button></div>`, null, null);
    $('#modal-cancel').textContent = t('Abbrechen');
    const dialog = $('#modal');
    $('#modal-body').querySelectorAll('[data-right-drop]').forEach(button => { button.onclick = () => { const action = button.dataset.rightDrop; rightDropChoice = null; dialog.close(); rightDropChoice = { source, path, validate, requestId }; finishRightDrop(action, requestId); }; });
    dialog.addEventListener('close', () => { if (rightDropChoice?.requestId === requestId) finishRightDrop('cancel', requestId); }, { once: true });
  }
  function pointerDestination(event) {
    const target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
    return target?.closest ? fileDropTarget(target) : null;
  }
  document.addEventListener('pointerdown', event => {
    if (event.button !== 2) return;
    suppressRightContext = false;
    const row = event.target.closest('#panes tr[data-id]');
    if (!row || event.target.closest('input,textarea,select,[contenteditable="true"]') || filesystemPending || navigationRequests.size || transferPending || rightDropChoice || $('#modal').open) return;
    const side = Number(row.closest('[data-pane]').dataset.pane), p = state.panes[side], ids = p.selected.includes(row.dataset.id) ? [...p.selected] : [row.dataset.id];
    if (resultView(p)) return;
    const source = { kind: 'files', side, sourcePath: currentPath(p), ids, items: files(p).filter(file => ids.includes(file.id)).map(file => ({ id: file.id, signature: JSON.stringify(file) })) };
    rightPointer = { source, rowId: row.dataset.id, id: event.pointerId, x: event.clientX, y: event.clientY, list: row.closest('.list'), active: false };
  });
  document.addEventListener('pointermove', event => {
    const gesture = rightPointer;
    if (!gesture || gesture.cancelled || gesture.id !== event.pointerId || !(event.buttons & 2)) return;
    if (!gesture.active && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
    if (!validDraggedFiles(gesture.source)) { rightPointer = null; clearDropTarget(); return; }
    event.preventDefault(); clearTimeout(renameTimer);
    if (!gesture.active) {
      gesture.active = true; state.active = gesture.source.side;
      const p = pane(); p.selected = [...gesture.source.ids]; if (!p.selected.includes(p.cursor)) p.cursor = gesture.rowId;
      refreshSelection(); gesture.list.setPointerCapture?.(gesture.id);
    }
    clearDropTarget(); const destination = pointerDestination(event);
    if (validFileDropTarget(gesture.source, destination)) destination.element.classList.add('drop-target');
  });
  document.addEventListener('pointerup', event => {
    const gesture = rightPointer;
    if (!gesture || gesture.id !== event.pointerId || event.button !== 2) return;
    rightPointer = null;
    if (!gesture.active) return;
    event.preventDefault(); suppressRightContext = true; clearDropTarget();
    gesture.list.releasePointerCapture?.(gesture.id);
    if (window.CommanderTransfer.dropMode(event) === 'link') { toast(t('Verknüpfungen sind für diese Dateiaktion noch nicht verfügbar.')); return; }
    const destination = pointerDestination(event);
    if (destination && !gesture.cancelled) chooseRightDrop(gesture.source, destination);
  });
  document.addEventListener('pointercancel', event => { if (rightPointer?.id === event.pointerId) { suppressRightContext = rightPointer.active; rightPointer = null; clearDropTarget(); } });
  document.addEventListener('keydown', event => { if (rightPointer?.active && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); rightPointer.cancelled = true; clearDropTarget(); } }, true);
  document.addEventListener('contextmenu', event => {
    const text = event.target.closest('input,textarea,[contenteditable="true"]');
    if (text) { text.dataset.vscodeContext = JSON.stringify({ webviewSection: 'textInput', preventDefaultContextMenuItems: false }); suppressRightContext = false; return; }
    if (suppressRightContext) { suppressRightContext = false; if (event.target.closest('thead') || event.button !== 2) return; event.preventDefault(); event.stopPropagation(); }
  }, true);
  function clearDropTarget() {
    document.querySelectorAll('.drop-target').forEach(element => element.classList.remove('drop-target'));
    delete $('#panes').dataset.dropMode;
  }
  function validFileDropTarget(source, destination) {
    if (!destination || !Object.hasOwn(state.folders, destination.path)) return false;
    const identity = value => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
    const target = identity(destination.path);
    if (target === identity(source.sourcePath)) return false;
    return !(state.folders[source.sourcePath] || []).some(file => {
      if (file.type !== 'folder' || !source.ids.includes(file.id)) return false;
      const path = identity(join(source.sourcePath, file.name));
      return target === path || target.startsWith(`${path}/`);
    });
  }
  function fileDropTarget(target) {
    const section = target.closest('[data-pane]');
    if (!section) return null;
    const side = Number(section.dataset.pane), p = state.panes[side];
    const tab = target.closest('[data-tab]');
    if (tab) return { side, path: p.tabs[Number(tab.dataset.tab)], element: tab };
    if (!target.closest('.list')) return null;
    const row = target.closest('tr[data-id]');
    const file = row && files(p).find(item => item.id === row.dataset.id);
    const destination = target.closest('[data-parent]') ? parent(currentPath(p)) : file?.type === 'folder' ? entryPath(p, file) : currentPath(p);
    return { side, path: destination, element: file?.type === 'folder' ? row : section.querySelector('.list') };
  }
  $('#panes').addEventListener('dragstart', event => {
    if (rightPointer || filesystemPending) { event.preventDefault(); return; }
    const tab = event.target.closest('[data-tab-drag]'), header = event.target.closest('[data-column]'), row = event.target.closest('tr[data-id]');
    if (!tab && !header && !row || event.target.closest('[data-resize]')) return;
    clearTimeout(renameTimer);
    if (row) {
      const side = Number(row.closest('[data-pane]').dataset.pane), p = state.panes[side];
      if (resultView(p)) { event.preventDefault(); return; }
      state.active = side;
      if (!p.selected.includes(row.dataset.id)) { p.selected = [row.dataset.id]; p.cursor = row.dataset.id; refreshSelection(); }
      dragged = { kind: 'files', side, ids: [...p.selected], sourcePath: currentPath(p), items: files(p).filter(file => p.selected.includes(file.id)).map(file => ({ id: file.id, signature: JSON.stringify(file) })) };
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('application/x-bitfroest-files', JSON.stringify(dragged)); }
      return;
    }
    dragged = { kind: tab ? 'tab' : 'column', side: Number(event.target.closest('[data-pane]').dataset.pane), key: header?.dataset.column, index: Number(tab?.dataset.tabDrag) };
    event.dataTransfer?.setData('application/x-bitfroest-item', JSON.stringify(dragged));
  });
  $('#panes').addEventListener('dragover', event => {
    if (dragged?.kind === 'files') {
      const destination = fileDropTarget(event.target); clearDropTarget();
      if (!validFileDropTarget(dragged, destination)) { if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
      event.preventDefault();
      const mode = window.CommanderTransfer.dropMode(event);
      if (mode === 'link' && dragged.mode !== 'link') toast(t('Verknüpfungen sind für diese Dateiaktion noch nicht verfügbar.'));
      dragged.mode = mode;
      if (event.dataTransfer) event.dataTransfer.dropEffect = mode === 'link' ? 'none' : mode;
      destination.element.classList.add('drop-target'); $('#panes').dataset.dropMode = mode;
      return;
    }
    if (dragged && event.target.closest(dragged.kind === 'tab' ? '.tabs' : '[data-column]')) event.preventDefault();
  });
  $('#panes').addEventListener('dragend', () => { dragged = null; clearDropTarget(); });
  $('#functionbar').addEventListener('dragover', event => {
    const target = event.target.closest('[data-action="delete"]');
    if (!target || !internalDeleteDrop(event) || !validDraggedFiles(dragged) || filesystemPending || $('#modal').open || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  $('#functionbar').addEventListener('drop', event => {
    const source = dragged; dragged = null; clearDropTarget();
    if (!event.target.closest('[data-action="delete"]') || !internalDeleteDrop(event) || filesystemPending || $('#modal').open || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!validDraggedFiles(source)) { if (source?.kind === 'files') toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.')); return; }
    event.preventDefault(); action(event.shiftKey ? 'delete-alternate' : 'delete', source);
  });
  $('#functionbar').addEventListener('dragend', () => { dragged = null; clearDropTarget(); });
  $('#panes').addEventListener('drop', event => {
    if (!dragged) return;
    const section = event.target.closest('[data-pane]'); if (!section) return;
    event.preventDefault(); rememberScroll(); const side = Number(section.dataset.pane);
    if (dragged.kind === 'files') {
      const destination = fileDropTarget(event.target), source = dragged;
      dragged = null; clearDropTarget();
      const mode = window.CommanderTransfer.dropMode(event);
      if (mode === 'link') { toast(t('Verknüpfungen sind für diese Dateiaktion noch nicht verfügbar.')); return; }
      if (validFileDropTarget(source, destination)) runTransfer({ sourceSide: source.side, targetSide: destination.side, ids: source.ids, targetPath: destination.path, mode });
      return;
    }
    if (dragged.kind === 'column' && side === dragged.side) {
      const header = event.target.closest('[data-column]');
      if (header) state.panes[side].columns = columns.moveColumn(state.panes[side].columns, dragged.key, header.dataset.column);
    } else if (dragged.kind === 'tab' && event.target.closest('.tabs')) {
      const target = event.target.closest('[data-tab-drag]');
      tabs.move(state.panes[dragged.side], dragged.index, state.panes[side], target ? Number(target.dataset.tabDrag) : state.panes[side].tabs.length, { copy: event.ctrlKey || event.metaKey });
      state.active = side;
    }
    dragged = null; render(true);
  });
  let suppressPointerClick = false;
  $('#panes').addEventListener('click', event => {
    if (!suppressPointerClick) return;
    suppressPointerClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  $('#panes').addEventListener('selectstart', event => {
    if (event.target.closest('.list') && !event.target.closest('input,textarea,[contenteditable="true"]')) event.preventDefault();
  });
  $('#panes').addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-resize]');
    if (!handle && event.button === 0) {
      const list = event.target.closest('.list');
      if (!list || event.target.closest('thead,tr[data-id],[data-parent],input,textarea,button,[contenteditable="true"],[data-filename],.fileicon')) return;
      event.preventDefault(); clearTimeout(renameTimer);
      const section = list.closest('[data-pane]'), side = Number(section.dataset.pane), p = state.panes[side];
      const initial = [...p.selected], initialCursor = p.cursor, additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const startX = event.clientX, startY = event.clientY;
      state.active = side; list.focus({ preventScroll: true }); list.setPointerCapture?.(event.pointerId);
      const marquee = document.createElement('div'); marquee.className = 'selection-marquee';
      marquee.setAttribute('aria-hidden', 'true');
      let selecting = false;
      const move = current => {
        if (!selecting && Math.hypot(current.clientX - startX, current.clientY - startY) < 4) return;
        selecting = true;
        if (!marquee.parentNode) list.appendChild(marquee);
        const bounds = list.getBoundingClientRect();
        const left = Math.max(bounds.left, Math.min(startX, current.clientX)), right = Math.min(bounds.right, Math.max(startX, current.clientX));
        const top = Math.max(bounds.top, Math.min(startY, current.clientY)), bottom = Math.min(bounds.bottom, Math.max(startY, current.clientY));
        Object.assign(marquee.style, { left: `${left - bounds.left + list.scrollLeft}px`, top: `${top - bounds.top + list.scrollTop}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
        const hits = [...list.querySelectorAll('tr[data-id]')].filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
        }).map(row => row.dataset.id);
        p.selected = [...new Set([...(additive ? initial : []), ...hits])];
        if (hits.length) p.cursor = current.clientY >= startY ? hits.at(-1) : hits[0];
        refreshSelection();
      };
      const finish = current => {
        list.removeEventListener('pointermove', move); list.removeEventListener('pointerup', finish); list.removeEventListener('pointercancel', finish);
        marquee.remove();
        if (current.type === 'pointercancel') { p.selected = initial; p.cursor = initialCursor; refreshSelection(); }
        if (selecting && current.type !== 'pointercancel') { suppressPointerClick = true; setTimeout(() => { suppressPointerClick = false; }, 0); }
        persist();
      };
      list.addEventListener('pointermove', move); list.addEventListener('pointerup', finish); list.addEventListener('pointercancel', finish);
      return;
    }
    if (!handle || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const section = handle.closest('[data-pane]'), p = state.panes[Number(section.dataset.pane)];
    const key = handle.dataset.resize, start = event.clientX, path = currentPath(p);
    const width = handle.closest('th').getBoundingClientRect().width || p.columns.find(column => column.key === key).width;
    handle.setPointerCapture?.(event.pointerId);
    const move = event => {
      if (event.pointerId !== undefined && event.pointerId !== initialPointer) return;
      if (currentPath(p) !== path || !section.isConnected || !p.columns.some(column => column.key === key)) { finish(event); return; }
      p.columns = columns.resizeColumn(p.columns, key, width + event.clientX - start);
      const sizing = columnSizing.get(p);
      if (sizing) sizing.manual[key] = true;
      layoutPaneColumns(section, p);
    };
    const initialPointer = event.pointerId;
    const finish = event => {
      if (event.pointerId !== undefined && event.pointerId !== initialPointer) return;
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish); window.removeEventListener('blur', finish);
      if (handle.hasPointerCapture?.(initialPointer)) handle.releasePointerCapture(initialPointer);
      if (currentPath(p) === path) rememberColumnWidth(p, key);
      persist();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish); window.addEventListener('blur', finish);
  });
  $('#panes').addEventListener('focusin', event => { const section = event.target.closest('[data-pane]'); if (section) { state.active = Number(section.dataset.pane); refreshSelection(); lister.updateMenu(); } });
  document.addEventListener('keydown', event => {
    if (event.target.closest('[data-lister]') && !$('#modal').open) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd' && event.target.closest('.list') && !$('#modal').open) {
      event.preventDefault(); showFavorites(document.querySelectorAll('[data-favorites]')[state.active]); return;
    }
    if (event.target.closest('[data-file-search]')) return;
    if (event.key === 'F7' && event.altKey && !event.ctrlKey && !event.metaKey && event.target.closest('.list') && !$('#modal').open) { event.preventDefault(); run(event.shiftKey ? 'search-separate' : 'search'); return; }
    if (event.key === '+' && event.code === 'NumpadAdd' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && resultView(pane()) && event.target.closest('.list')) { event.preventDefault(); run('search-duplicates'); return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'l') {
      event.preventDefault(); focusPath(event.shiftKey); return;
    }
    if ($('#modal').open) {
      if (event.target.matches('#value[data-transfer-name]') && event.key === 'Home' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); startTransferName(); return; }
      if (event.target.matches('#value[data-transfer-name]') && ['F5', 'F6'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); selectTransferName(event.key); return; }
      if (conflictAction && event.key === 'F3' && !((event.ctrlKey || event.metaKey) && event.altKey)) {
        event.preventDefault(); conflictAction(event.ctrlKey || event.metaKey ? event.shiftKey ? 'conflict-compare-internal' : 'conflict-compare' : `conflict-${event.shiftKey ? 'source' : 'target'}${event.altKey ? '-plain' : ''}`);
      }
      if (['F5', 'F6'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) event.preventDefault();
      return;
    }
    clearTimeout(renameTimer);
    if (event.target.matches('input,textarea,select')) {
      if ((event.target.matches('.inline-rename') || event.target.closest('.operation-error')) && ['F5', 'F6'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) event.preventDefault();
      if (event.key === 'Enter' && event.target.classList.contains('path-input')) { event.preventDefault(); go(event.target.value || '/'); }
      if (event.key === 'Escape') { if (event.target.classList.contains('path-input')) event.target.value = displayArchivePath(currentPath(pane())); render(true); }
      return;
    }
    if ((event.key === 'ContextMenu' && !event.ctrlKey && !event.metaKey && !event.altKey || event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) && event.target.closest('[data-pane]') && (fileSettings.useSystemContextMenu !== true || ['linux', 'darwin'].includes(document.body.dataset.platform) || !event.target.closest('.list'))) {
      event.preventDefault();
      const target = event.target.closest('.list') ? activeRow(pane().cursor) || event.target : event.target;
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab' && event.target.closest('[data-pane]') && !event.target.closest('[data-lister]')) {
      event.preventDefault(); run(event.shiftKey ? 'previous-tab' : 'next-tab'); return;
    }
    if (!event.target.closest('.list')) return;
    if (event.key === 'Escape' && folderSizeRequests.size) { event.preventDefault(); cancelFolderSizes(); return; }
    if (event.key === 'Enter' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!filesystemPending && !transferPending) { for (const file of visible(pane())) if (file.type === 'folder') calculateFolder(file, pane()); render(true); }
      return;
    }
    if (event.key === 'ContextMenu' && !event.ctrlKey && !event.metaKey && !event.altKey || event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { if (fileSettings.useSystemContextMenu !== true || ['linux', 'darwin'].includes(document.body.dataset.platform)) return; event.preventDefault(); requestShellMenu(true); return; }
    if (event.key === 'Insert' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); run('toggle-selection-next'); return; }
    if (['NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide'].includes(event.code) && (!event.metaKey || document.body.dataset.platform === 'darwin') && !(event.altKey && (event.ctrlKey || event.metaKey || event.shiftKey))) {
      const primary = event.ctrlKey || event.metaKey;
      const command = event.code === 'NumpadDivide' ? !primary && !event.altKey && !event.shiftKey && 'restore-selection'
        : event.code === 'NumpadMultiply' ? !primary && !event.altKey && 'invert'
          : event.altKey ? event.code === 'NumpadAdd' ? 'select-extension' : 'unselect-extension'
            : primary ? event.code === 'NumpadAdd' ? !event.shiftKey && 'select-extension' : 'clear' : event.code === 'NumpadAdd' ? 'select-group' : 'unselect-group';
      if (command) { event.preventDefault(); run(command, event.shiftKey); return; }
    }
    if (/^F\d+$/.test(event.key)) {
      const unsupported = event.ctrlKey || event.metaKey || event.altKey && (event.shiftKey || !['F3', 'F5', 'F6', 'F9'].includes(event.key)) || event.shiftKey && !event.altKey && !['F3', 'F4', 'F5', 'F6', 'F7', 'F8'].includes(event.key);
      if (unsupported) { event.preventDefault(); return; }
    }
    if ((event.ctrlKey || event.metaKey) && event.target.closest('.list')) {
      if (event.altKey) return;
      if (!event.shiftKey && event.key.toLowerCase() === 'y' && (event.ctrlKey || event.metaKey && document.body.dataset.platform === 'darwin')) { event.preventDefault(); run('copy-full-names'); return; }
      if (!event.altKey && !event.shiftKey && ['c', 'x', 'v'].includes(event.key.toLowerCase())) { event.preventDefault(); run(({ c: 'clipboard-copy', x: 'clipboard-cut', v: 'clipboard-paste' })[event.key.toLowerCase()]); return; }
      if (event.key.toLowerCase() === 'u') { event.preventDefault(); run(event.shiftKey ? 'swap' : 'swap-paths'); return; }
      const commands = event.shiftKey ? { t: 'background-tab', Tab: 'previous-tab', ArrowUp: 'open-dir-other-tab' } : { t: 'new-tab', w: 'close-tab', Tab: 'next-tab', ArrowUp: 'open-dir-tab', r: 'refresh', f: 'filter', m: 'rename', a: 'select-all' };
      const command = commands[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (command) { event.preventDefault(); run(command); }
      return;
    }
    if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.shiftKey) { event.preventDefault(); run(event.key === 'ArrowLeft' ? 'back' : 'forward'); return; }
    if (event.altKey && !/^F\d+$/.test(event.key)) return;
    if (event.target.closest('.list') && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'F6' && event.shiftKey) { event.preventDefault(); startRename(); return; }
    if (event.target.closest('.list') && pane().filter && ['ArrowDown', 'ArrowUp'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); applySearch(pane().filter, event.key === 'ArrowDown' ? 1 : -1); return; }
    const keyboard = { F2: 'rename-one', F3: 'view', F4: event.shiftKey ? 'new-file' : 'edit', F5: event.altKey ? 'pack' : event.shiftKey ? 'copy-same' : 'copy', F6: event.altKey ? 'unpack' : 'move', F7: event.shiftKey ? 'mkdir-other' : 'mkdir', F8: event.shiftKey ? 'delete-alternate' : 'delete', Delete: event.shiftKey ? 'delete-alternate' : 'delete', F9: event.altKey ? 'unpack' : 'open-terminal' };
    if (keyboard[event.key]) { event.preventDefault(); run(keyboard[event.key]); return; }
    if (event.target.closest('.list') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === 'Escape' && pane().filter) { event.preventDefault(); applySearch(''); return; }
      if (event.key === 'Escape' && !filesystemPending && !transferPending && (clipboardSelection || clipboardPasteGeneration !== null)) { event.preventDefault(); resetClipboard(); return; }
      if (event.key === 'Backspace' && pane().filter) { event.preventDefault(); applySearch(pane().filter.slice(0, -1)); return; }
      if (event.key.length === 1 && event.key !== ' ') {
        event.preventDefault(); const now = Date.now();
        const query = now - (run.lastTyped || 0) > 1600 ? event.key : pane().filter + event.key;
        run.lastTyped = now; applySearch(query); return;
      }
    }
    if (event.key === 'Tab' && event.target.closest('.list')) { event.preventDefault(); state.active = 1 - state.active; focusSelection(); return; }
    if (event.key === 'Backspace' && event.target.closest('.list')) { event.preventDefault(); goUp(); return; }
    if (event.key === 'Enter' && event.target.closest('.list')) { event.preventDefault(); openFile(files(pane()).find(file => file.id === pane().cursor) || selected()[0]); return; }
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.target.closest('.list')) {
      event.preventDefault();
      if (filesystemPending || transferPending || event.repeat) return;
      const p = pane(), file = files(p).find(file => file.id === p.cursor);
      if (file) {
        const marks = spaceMarks(p), marked = p.selected.includes(file.id) && (p.cursorSelection !== file.id || p.selected.length !== 1 || marks.includes(file.id));
        p.cursorSelection = null;
        p.selected = marked ? p.selected.filter(value => value !== file.id) : [...new Set([...p.selected, file.id])];
        p.spaceMarked = marked ? marks.filter(id => id !== file.id) : [...new Set([...marks, file.id])];
        if (!marked && !navigationRequests.size && file.type === 'folder' && fileSettings.countFolderSizeOnSpace !== false) calculateFolder(file, p);
        if (!state.realFilesystem) refreshFolderSizeDisplay(entryPath(p, file));
      }
      focusSelection(); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target.closest('.list')) {
      event.preventDefault(); const p = pane(), list = visible(p); if (!list.length) return;
      const old = list.findIndex(file => file.id === p.cursor);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, old + (event.key === 'ArrowDown' ? 1 : -1)));
      if (event.shiftKey) extendSelection(p, list[index].id, event.ctrlKey || event.metaKey);
      p.cursor = list[index].id;
      if (!event.shiftKey) {
        if (!spaceMarks(p).length) { p.selected = [p.cursor]; p.cursorSelection = p.cursor; }
        else p.cursorSelection = null;
        rememberSelectionAnchor(p);
      } else p.cursorSelection = null;
      focusSelection(); activeRow(p.cursor)?.scrollIntoView({ block: 'nearest' });
    }
  });
  $('#modal-form').addEventListener('submit', event => { event.preventDefault(); if (transferJob?.modalPreparation && filesystemPending) return; if (!confirmAction || confirmAction() !== false) $('#modal').close(); });
  $('#modal-close').replaceChildren(window.CommanderIcons.element('close'));
  $('#modal-close').onclick = () => { if (jobDialogOpen()) { cancelTransfer(); return; } $('#modal').close(); if (!$('#modal').open) focusSelection(); };
  $('#modal-cancel').onclick = () => { if (jobDialogOpen()) return; $('#modal').close(); if (!$('#modal').open) focusSelection(); };
  $('#modal').addEventListener('close', () => {
    if ($('#modal').open) return;
    if (operationFailureInline && document.querySelector('.inline-rename')) return;
    if (operationErrorDialog) { operationFailure = null; operationErrorDialog = false; $('#modal-body').querySelector('.operation-error')?.remove(); }
    else if (operationFailure) showOperationFailure(operationFailure);
  });
  document.body.classList.toggle('browser-preview', !host);
  function browserMenu() { modal(t('Dateimanager-Befehle'), '<div class="browser-command-list">' + [[t('Seiten tauschen'), 'swap'], [t('Packen'), 'pack'], [t('Entpacken'), 'unpack'], [t('Mehrfach-Umbenennen'), 'rename'], [t('Alle markieren'), 'select-all'], [t('Auswahl umkehren'), 'invert'], [t('Auswahl aufheben'), 'clear'], [t('Beispieldaten zurücksetzen'), 'reset'], [t('Hilfe'), 'help']].map(([label, command]) => `<button type="button" data-browser-action="${command}">${label}</button>`).join('') + '</div>', null, null); }
  function requestShellMenu(keyboard, inspectLocks = false, contextSelection) {
    const directory = contextSelection ? contextSelection.directory : currentPath(pane());
    if (state.archiveLocations?.[directory] || directory?.startsWith('zip:')) { toast(t('Diese Aktion ist innerhalb eines ZIP-Archivs nicht verfügbar.'), 'info'); return; }
    if (nativePlatform && (inspectLocks ? !['win32', 'linux'].includes(nativePlatform) : nativePlatform !== 'win32')) { toast(t('Diese Funktion wird auf diesem Betriebssystem noch nicht unterstützt.'), 'info'); return; }
    if (!host || !state.realFilesystem || shellMenuPending || $('#modal').open) return;
    if (filesystemPending || navigationRequests.size || transferPending) { toast(t('Während einer Dateioperation ist das Systemmenü nicht verfügbar.')); return; }
    const p = pane(), ids = contextSelection && Array.isArray(contextSelection.ids) ? [...contextSelection.ids] : p.selected.length ? [...p.selected] : p.cursor ? [p.cursor] : [];
    if (!ids.length) { toast(t('Für das Systemmenü zuerst eine Datei oder einen Ordner auswählen.')); return; }
    const requestId = `shell-menu-${++shellMenuSequence}`;
    shellMenuPending = { requestId };
    statusTask(requestId, t('Aktion wird ausgeführt…') + ` · ${t('Hostbestätigung')}`);
    host.postMessage({ type: 'shell-context-menu', requestId, directory, ids, snapshotId: contextSelection ? contextSelection.snapshotId : state.snapshotId, keyboard: Boolean(keyboard), ...(inspectLocks ? { inspectLocks: true } : {}) });
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-copy-error]')) { if (operationFailure) selectionIO('copy', operationFailureReport(), undefined, t('Fehlerdetails kopiert.')); return; }
    if (event.target.closest('[data-select-error]')) { const text = $('#operation-error-text'); text.focus(); text.select(); return; }
    if (event.target.closest('[data-dismiss-error]')) { operationFailure = null; operationFailureDiagnostic = null; document.querySelector('.operation-error')?.remove(); if (failureFocus?.isConnected) failureFocus.focus(); return; }
    const button = event.target.closest('[data-browser-action]');
    if (button) { $('#modal').close(); run(button.dataset.browserAction); }
  });
  window.addEventListener('message', event => {
    if (host && event.data?.type === 'auxiliary-compact-check' && typeof event.data.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(event.data.requestId)) {
      auxiliaryCompactRequest = event.data.requestId; auxiliaryCompactReported = false; reportAuxiliaryCompactReady(); return;
    }
    if (host && event.data?.type === 'filesystem-refresh-step') {
      if (refreshingFilesystem && refreshPlan && event.data.refreshRequestId === refreshRequestId && event.data.phase === 'state-save') {
        refreshPlan.progress.start('state-save'); refreshPlan.saving = true; updateDirectoryActivity(); return;
      }
      if (!refreshingFilesystem || event.data.refreshRequestId !== refreshRequestId || !['metadata', 'comments', 'validation', 'publication', 'done'].includes(event.data.phase) || typeof event.data.path !== 'string') return;
      const directory = state.panes.map(currentPath).find(path => paths.identity(path) === paths.identity(event.data.path));
      if (directory) {
        refreshStages.set(directory, event.data.phase);
        const count = Number.isSafeInteger(event.data.total) && Number.isSafeInteger(event.data.completed) ? Progress.known('items', event.data.completed, event.data.total) : null;
        if (count) refreshMeasurements.set(directory, Progress.event({ phase: 'metadata', overall: count, current: count }));
        updateRefreshDirectory(directory, event.data.phase, count);
        if (event.data.progress && refreshPlan) refreshPlan.progress.update(refreshPlan.filesystem.get(directory).comments, Progress.read(event.data.progress));
        updateDirectoryActivity();
      }
      return;
    }
    if (host && ['filesystem-directory', 'filesystem-result'].includes(event.data?.type) && receiveDirectoryMessage(event.data)) return;
    if (host && event.data?.type === 'shell-context-menu-result') {
      if (shellMenuPending?.requestId !== event.data.requestId) return;
      statusTask(shellMenuPending.requestId, null); shellMenuPending = null;
      if (event.data.clipboardInvalidated) { clipboardGeneration++; setClipboardSelection(null); refreshClipboardAvailability(); }
      if (event.data.refreshed) focusRefreshRequested = false;
      if (event.data.action === 'git-diff') toast(event.data.ok ? t('Git-Diff geöffnet.') : event.data.error, event.data.ok ? 'success' : 'error');
      else if (!event.data.ok) { if (event.data.unsupported) toast(event.data.error, 'info'); else showOperationFailure(event.data.error || t('Das native Systemmenü konnte nicht geöffnet werden.'), { diagnostic: event.data.diagnostic }); }
      flushFocusRefresh(); return;
    }
    if (host && event.data?.type === 'drop-action-result') { if (rightDropChoice?.requestId !== event.data.requestId) return; if (event.data.error) { rightDropChoice = null; showOperationFailure(event.data.error); } else finishRightDrop(event.data.action, event.data.requestId); return; }
    if (host && event.data?.type === 'clipboard-changed') {
      if (systemFileClipboardSupported && state.realFilesystem) { clipboardGeneration++; setClipboardSelection(null); refreshClipboardAvailability(); }
      return;
    }
    if (host && event.data?.type === 'clipboard-result') {
      const complete = clipboardRequests.get(event.data.requestId) || clipboardStatusRequests.get(event.data.requestId);
      if (complete) { clipboardRequests.delete(event.data.requestId); clipboardStatusRequests.delete(event.data.requestId); statusTask(event.data.requestId, null); complete(event.data); }
      return;
    }
    if (host && event.data?.type === 'action' && event.data.action === 'transfer-name-parts') { selectTransferName(event.data.key); return; }
    if (host && event.data?.type === 'action' && event.data.action === 'transfer-name-start') { startTransferName(); return; }
    if (host && event.data?.type === 'language-changed') { document.body.inert = false; requestLanguageReload(); return; }
    if (host && event.data?.type === 'language-picker-closed') { document.querySelector('#language-toggle').focus(); return; }
    if (host && event.data?.type === 'file-settings') {
      fileSettings = event.data.settings || {};
      const before = window.CommanderIcons.layout().size;
      const after = window.CommanderIcons.configure(fileSettings.iconSize).size;
      refreshFileColors(); refreshSelection();
      if (before !== after) document.querySelectorAll('[data-pane]').forEach(section => {
        const p = state.panes[Number(section.dataset.pane)], previous = columnSizing.get(p);
        if (previous) previous.font = null;
        sizePaneColumns(section, p);
      });
      return;
    }
    if (host && event.data?.type === 'open-trash-result') { if (!event.data.ok) showOperationFailure(event.data.error || t('Der Papierkorb konnte nicht geöffnet werden.'), { inline: Boolean(document.querySelector('.inline-rename')) }); else toast(t('Papierkorb geöffnet.'), 'success'); return; }
    if (host && event.data?.type === 'filesystem-progress') { if (transferJob?.id === event.data.operationId) transferProgress(event.data.progress); return; }
    if (host && event.data?.type === 'filesystem-task-progress') {
      if (transferJob && event.data.operationId === transferJob.id) { transferProgress(event.data.progress); return; }
      if (filesystemPending && pendingFilesystemKind === 'filesystem-delete' && event.data.taskRequestId === filesystemTaskId) statusTask('filesystem', t('Löschen wird ausgeführt') + ` · ${displayPath(event.data.progress.path || '')}`, Progress.read(event.data.progress));
      return;
    }
    if (host && event.data?.type === 'folder-size-progress') {
      const request = folderSizeRequests.get(event.data.operationId);
      if (request && request.snapshotId === event.data.snapshotId && request.path === event.data.path && request.snapshotId === state.snapshotId) statusTask(request.operationId, t('Ordnergröße wird ermittelt…') + ` · ${displayPath(event.data.progress.path || request.path)}`, Progress.read(event.data.progress));
      return;
    }
    if (host && event.data?.type === 'folder-size-result') {
      const result = event.data, request = folderSizeRequests.get(result.operationId);
      if (!request) return;
      if (result.snapshotId !== request.snapshotId || result.path !== request.path) return;
      folderSizeRequests.delete(result.operationId);
      statusTask(result.operationId, null);
      if (request.snapshotId !== state.snapshotId) return;
      if (result.ok && Number.isSafeInteger(result.size) && result.size >= 0) { folderSizes.set(result.path, result.size); refreshFolderSizeDisplay(result.path); }
      else if (!result.cancelled) {
        const message = result.error || t('Die Ordnergröße konnte nicht ermittelt werden.');
        if (folderSizeBatch) folderSizeBatch.error = message;
        if (folderSizeBatch?.statusVersion === statusbar.version) { statusbar.error(message); folderSizeBatch.statusVersion = statusbar.version; }
        else statusbar.notify(message, window.CommanderWorkbench.Severity.Error);
      } else if (folderSizeBatch) folderSizeBatch.cancelled = true;
      if (!folderSizeRequests.size) {
        reportStatus(folderSizeBatch?.error || t(folderSizeBatch?.cancelled ? 'Ordnergrößenberechnung abgebrochen.' : 'Ordnergröße ermittelt.'), folderSizeBatch?.error ? 'error' : folderSizeBatch?.cancelled ? 'cancelled' : 'success', folderSizeBatch?.statusVersion);
        folderSizeBatch = null;
      }
      return;
    }
    if (host && event.data?.type === 'filesystem-result') {
      if (Object.hasOwn(event.data, 'refreshRequestId') && (!refreshingFilesystem || event.data.refreshRequestId !== refreshRequestId)) return;
      if (event.data.taskRequestId && event.data.taskRequestId !== filesystemTaskId) return;
      if (transferCheckpoint) {
        if (event.data.operationId !== transferCheckpoint.id) return;
        const checkpoint = transferCheckpoint; transferCheckpoint = null;
        checkpoint.complete(event.data); return;
      }
      if (event.data.operationId && event.data.operationId !== transferJob?.id) return;
      statusTask('filesystem', null);
      filesystemTaskId = null;
      const completedFilesystemKind = pendingFilesystemKind; pendingFilesystemKind = null;
      const pathNavigation = pendingPathNavigation; pendingPathNavigation = null;
      if (pathNavigation) pathNavigation.valid = pathNavigation.generation === pathRequestGeneration && document.activeElement === pathNavigation.input && state.active === pathNavigation.side;
      rememberScroll();
      const navigatingFilesystem = completedFilesystemKind === 'filesystem-navigate';
      const previousFolders = !refreshingFilesystem && confirmedFolders ? JSON.parse(confirmedFolders) : null;
      const previousViews = refreshingFilesystem || navigatingFilesystem ? state.panes.map(paneDisplayState) : undefined;
      const previousIcons = refreshingFilesystem ? displayedIconEntries() : undefined;
      if (refreshingFilesystem) { cancelFolderSizes(); folderSizes.clear(); gitBindings.clear(); }
      const readingView = (transferJob || refreshingFilesystem || navigatingFilesystem) && { panes: clone(state.panes), active: state.active };
      if (refreshingFilesystem && refreshPlan) {
        if (!event.data.ok) { refreshPlan.progress.terminate(event.data.cancelled ? 'cancelled' : 'error'); refreshPlan = null; }
        else {
          for (const path of refreshPlan.directories) {
            const count = refreshMeasurements.get(path)?.overall;
            updateRefreshDirectory(path, 'done', count?.kind === 'determinate' ? Progress.known('items', count.total, count.total) : null);
            const job = refreshPlan.filesystem.get(path); confirmRefreshStep(job.publication); confirmRefreshStep(job.root);
          }
          confirmRefreshStep('state-save'); refreshPlan.saving = false; refreshPlan.filesystemDone = true;
        }
      }
      refreshingFilesystem = false; refreshRequestId = null; refreshStages.clear();
      if (transferJob?.modalPreparation) { if ($('#value')) $('#value').disabled = false; $('#modal-confirm').disabled = false; }
      const completedTransferJob = transferJob;
      const failedRename = renameFailure; renameFailure = null;
      const failedTransferPreparation = transferPreparationFailure; transferPreparationFailure = null;
      const resume = filesystemResume, failedCreation = creationFailure; filesystemResume = null; creationFailure = null;
      const completion = transferCompletion; transferCompletion = null;
      const continuePreparation = Boolean(completedTransferJob && event.data.ok && !event.data.cancelled && resume);
      transferJob = continuePreparation ? { ...completedTransferJob, hostActive: false, cancelRequested: false } : null;
      if (!continuePreparation) transferProgress();
      filesystemPending = false; $('#panes').inert = false; $('#functionbar').inert = false;
      if (event.data.state?.realFilesystem) { state = event.data.state; confirmedFolders = JSON.stringify(state.folders); nextId = Math.max(Date.now(), ...Object.values(state.folders).flat().map(item => Number(item.id) + 1).filter(Number.isFinite)); }
      else if (!event.data.ok && failedRename) { state = failedRename.before; confirmedFolders = JSON.stringify(state.folders); }
      if (gitMenuSelection && completedFilesystemKind === 'filesystem-refresh' && event.data.ok) gitMenuSelection.refreshSnapshot = state.snapshotId;
      directoryListings.clear(); cacheDirectories();
      if (previousFolders) invalidateChangedDirectories(previousFolders, navigatingFilesystem && event.data.ok && event.data.resumeNavigation ? [event.data.resumeNavigation.path] : event.data.refreshGitDirectories || []);
      if (readingView) {
        state.active = readingView.active;
        readingView.panes.forEach((p, index) => {
          if (!p.tabs.every(path => Object.hasOwn(state.folders, path))) return;
          const valid = new Set(files(p).map(file => file.id));
          p.selected = p.selected.filter(id => valid.has(id)); if (!valid.has(p.cursor)) p.cursor = null;
          state.panes[index] = p;
        });
      }
      if (previousIcons) {
        const currentIcons = displayedIconEntries();
        for (const [key, entry] of previousIcons) {
          if (currentIcons.get(key) === entry) continue;
          requestedIcons.delete(key); nativeIcons.delete(key);
        }
      }
      render(!$('#modal').open && (!pathNavigation || pathNavigation.valid), previousViews);
      if (previousViews) refreshSelection();
      const error = event.data.error || t('Dateioperation fehlgeschlagen; Verzeichnisse erneut eingelesen');
      if (completion && event.data.operationOutcome) {
        const outcome = event.data.operationOutcome;
        const completedIds = [...new Set([...(completion.committedResult?.completedIds || []), ...(outcome.completedIds || [])])];
        completion.actualOutcome = true;
        completion.result = { ...completion.result, completedIds, completed: completedIds.length, cancelled: Boolean(outcome.cancelled || completion.result.cancelled) };
      }
      if (completion) {
        const completedIds = event.data.ok && !event.data.cancelled || event.data.operationOutcome ? completion.result.completedIds : completion.committedResult?.completedIds || [];
        const sourcePane = state.panes[completion.options.sourceSide];
        if (currentPath(sourcePane) === completion.options.sourcePath) sourcePane.selected = sourcePane.selected.filter(id => !completedIds.includes(id));
        render(!$('#modal').open);
      }
      const cancelled = event.data.cancelled || event.data.operationOutcome?.cancelled || completion?.result.cancelled;
      const outcome = !event.data.ok || completion?.result.errors.length ? 'error' : cancelled ? 'cancelled' : 'success';
      const resultMessage = event.data.ok ? event.data.notice || (cancelled ? t('Dateiübertragung abgebrochen.') : completion ? transferSummary(completion) : completedTransferJob ? t('Dateioperation beendet') : '') : error;
      if (completedTransferJob && !continuePreparation) { const progress = finishTransferStatus(outcome); if (progress) statusbar.finishProgress({ message: resultMessage, outcome, progress, severity: event.data.ok ? undefined : window.CommanderWorkbench.Severity.Error }); }
      if (completion) finishTransfer(completion, Boolean(event.data.ok), event.data.ok ? undefined : error);
      else if (event.data.ok && !resume && !continuePreparation && (event.data.notice || cancelled || completedTransferJob)) statusbar.setStatus(resultMessage, outcome);
      if (event.data.ok && !event.data.cancelled && resume) resume();
      if (event.data.ok && !event.data.cancelled && !resume && event.data.resumeNavigation) {
        state.active = event.data.resumeNavigation.side;
        if (resultView(pane())) { rememberScroll(); tabs.openPath(pane(), event.data.resumeNavigation.path); }
        go(event.data.resumeNavigation.path);
      }
      if (!event.data.ok) { clearTimeout(toast.timer); $('#toast').textContent = ''; $('#toast').classList.remove('visible'); }
      if (!event.data.ok && failedCreation) failedCreation();
      if (!event.data.ok && failedTransferPreparation) failedTransferPreparation();
      if (event.data.cancelled && failedTransferPreparation) failedTransferPreparation(true);
      if (!event.data.ok) showOperationFailure(error, { inline: Boolean(failedRename && restoreRename(failedRename)), diagnostic: event.data.diagnostic, notify: !operationQueue?.active });
      if (pendingGitDiff) { const selection = pendingGitDiff; pendingGitDiff = null; if (event.data.ok) requestGitDiff(selection); else { gitMenuSelection = null; toast(t('Ungültige Dateiauswahl für Git Diff.'), 'error'); } }
    if (completedTransferJob?.queueJobId && operationQueue.active?.id === completedTransferJob.queueJobId && !continuePreparation) operationQueue.complete(completedTransferJob.queueJobId, { ok: event.data.ok, cancelled, message: resultMessage, ...(!event.data.ok ? { error } : {}) });
      flushQueuedOperation(); flushFocusRefresh(); return;
    }
    if (host && event.data?.type === 'git-settings-changed') {
      gitBindings.clear(); gitDirectories.clear(); directoryCache.clearGit(); refreshGitDisplay(); requestGitStatus(); return;
    }
    if (host && event.data?.type === 'git-status-result') {
      if (!event.data.directories || typeof event.data.directories !== 'object') return;
      let displayChanged = false;
      for (const [directory, request] of gitBindings) {
        if (event.data.requestId !== request.requestId || event.data.snapshotId !== request.snapshotId) continue;
        const info = event.data.directories[directory];
        if (info?.version === 1) request.progress = Progress.read(info);
        if (!event.data.partial || info && !info.loading) gitPending.delete(directory);
        if (info) {
          const previous = gitInfo(directory);
          const next = !info.ok && previous?.ok ? { ...previous, error: info.error, loading: false } : info.incremental || info.ok && info.loading ? { ...previous, ...info, statuses: { ...previous?.statuses, ...info.statuses } } : info;
          if (info.ok && !info.error && next !== info) delete next.error;
          const changed = !previous || !info.loading || Object.entries(info.statuses || {}).some(([name, status]) => previous.statuses?.[name] !== status) || ['ok', 'repository', 'loading', 'error', 'branch', 'head', 'detached', 'unborn'].some(key => previous[key] !== next[key]) || JSON.stringify(previous.loadingRepositories) !== JSON.stringify(next.loadingRepositories) || JSON.stringify(previous.repositoryErrors) !== JSON.stringify(next.repositoryErrors);
          displayChanged ||= changed;
          gitDirectories.set(directory, next);
          if (changed && next.ok && !next.error) {
            const cached = { ...next }; delete cached.loading; delete cached.loadingRepositories; delete cached.incremental;
            directoryCache.setGit(directory, cached);
          }
        } else if (!event.data.partial) { displayChanged = true; gitDirectories.delete(directory); directoryCache.clearGit(directory); }
      }
      const planned = refreshPlan?.gitRequest;
      if (planned && planned.requestId === event.data.requestId && planned.snapshotId === event.data.snapshotId) {
        for (const directory of planned.pending) {
          const info = event.data.directories[directory];
          updateRefreshGit(directory, info);
          if (!event.data.partial || info && !info.loading) {
            if (!info?.ok) {
              refreshPlan.progress.fail(refreshPlan.repositories.get(directory).root, info?.error || t('Git-Status nicht verfügbar: {error}', { error: directory }));
              planned.pending.delete(directory); continue;
            }
            const job = refreshPlan.repositories.get(directory);
            if (job.total) refreshPlan.progress.confirmRange(job.active, job.total);
            if (job.active) confirmRefreshStep(job.active);
            refreshPlan.progress.closePlanning(job.root);
            confirmRefreshStep(job.describe); confirmRefreshStep(job.inspect); confirmRefreshStep(job.publication); confirmRefreshStep(job.root);
            planned.pending.delete(directory);
          }
        }
      }
      if (displayChanged) refreshGitDisplay(); else updateDirectoryActivity();
      return;
    }
    if (host && event.data?.type === 'column-settings') { hostColumnSettings = event.data.settings || {}; render(); return; }
    if (host && event.data?.type === 'favorite-settings') { favoriteSettings = event.data.settings || {}; closeFavorites(false); return; }
    if (host && event.data?.type === 'icons' && event.data.icons && typeof event.data.icons === 'object') {
      for (const [key, value] of Object.entries(event.data.icons)) {
        if (requestedIcons.has(key) && typeof value === 'string' && value.length <= 131072 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) nativeIcons.set(key, value);
      }
      refreshVisibleIcons();
      return;
    }
    if (host && event.data?.type === 'restore') {
      clipboardPasteGeneration = null; clipboardPasteRequestId = null;
      rememberScroll();
      navigationRequests.clear(); navigationByTab.clear(); directoryListings.clear();
      if (!event.data.preserveUnchanged) { directoryCache.clear(); gitPending.clear(); }
      const retained = event.data.preserveUnchanged && { panes: clone(state.panes), active: state.active, folders: JSON.parse(confirmedFolders || '{}') };
      if (!retained) { gitBindings.clear(); gitDirectories.clear(); }
      gitMenuSelection = null; pendingGitDiff = null;
      fileSearch.dispose();
      if (event.data.resetViews) lister.dispose();
      refreshingFilesystem = false; refreshRequestId = null; refreshStages.clear(); refreshPlan = null;
      if (!retained) { cancelFolderSizes(); folderSizes.clear(); }
      transferCheckpoint?.cancel(); transferCheckpoint = null;
      transferJob?.controller?.abort();
      statusTasks.clear(); refreshMeasurements.clear(); statusPlans.clear();
      filesystemTaskId = null;
      transferJob = null; transferStatusPlan = null; transferProgress(); statusbar.reset(); clearTimeout(toast.timer); $('#toast').classList.remove('visible');
      transferCompletion = null; transferPreparationFailure = null; transferPending = false; filesystemResume = null;
      $('#panes').inert = false; $('#functionbar').inert = false;
      if ($('#modal').open) $('#modal').close();
      state = event.data.state?.version === 1 ? event.data.state : initial();
      if (retained) {
        state.active = retained.active;
        retained.panes.forEach((pane, index) => {
          if (!pane.tabs.every(path => Object.hasOwn(state.folders, path))) return;
          const valid = new Set(files(pane).map(file => file.id));
          pane.selected = pane.selected.filter(id => valid.has(id)); if (!valid.has(pane.cursor)) pane.cursor = null;
          state.panes[index] = pane;
        });
        invalidateChangedDirectories(retained.folders, event.data.refreshGitDirectories || []);
      }
      confirmedFolders = JSON.stringify(state.folders); filesystemPending = false;
      cacheDirectories();
      nextId = Math.max(Date.now(), ...Object.values(state.folders).flat().map(item => Number(item.id) + 1).filter(Number.isFinite));
      render(true); return;
    }
    if (host && event.data?.type === 'action' && typeof event.data.action === 'string') {
      if ($('#modal').open && conflictAction?.(event.data.action)) return;
      if ($('#modal').open) { toast(t('Zuerst den geöffneten Dialog schließen.')); return; }
      if (event.data.action === 'inspect-folder-locks' && event.data.contextSelection) { requestShellMenu(true, true, event.data.contextSelection); return; }
      const contextSelection = event.data.contextSelection;
      if (contextSelection && ['clipboard-copy', 'clipboard-cut', 'clipboard-paste'].includes(event.data.action)) {
        const side = state.panes.findIndex(p => currentPath(p) === contextSelection.directory);
        if (contextSelection.snapshotId !== state.snapshotId || side < 0 || !Array.isArray(contextSelection.ids) || contextSelection.ids.some(id => !files(state.panes[side]).some(file => file.id === id))) return;
        state.active = side; closeContextMenu();
        document.querySelectorAll('[data-pane]')[side]?.querySelector('.list')?.focus({ preventScroll: true });
      }
      run(event.data.action, event.data.reverseDirectories === true, contextSelection);
    }
  });
  let contextPopup = null;
  function closeContextMenu(restoreFocus = false) {
    if (!contextPopup) return;
    const { root, origin } = contextPopup;
    contextPopup = null; root.remove();
    if (restoreFocus && origin?.isConnected) origin.focus({ preventScroll: true });
  }
  function showContextMenu(event, section, kind, selection) {
    closeContextMenu();
    window.dispatchEvent(new CustomEvent('commander-menu-open', { detail: 'context' }));
    const side = Number(section.dataset.pane), p = state.panes[side];
    const directory = currentPath(p), snapshotId = state.snapshotId, tabId = p.tabStates[p.tab].id;
    const clickedTab = event.target.closest('[data-tab]');
    const clickedTabId = clickedTab ? p.tabStates[Number(clickedTab.dataset.tab)].id : tabId;
    const contextDirectory = clickedTab ? p.tabs[Number(clickedTab.dataset.tab)] : directory;
    const origin = event.target.closest('button, .list') || section.querySelector('.list');
    const definitions = kind === 'tabs' ? [['copy-path', 'Pfad kopieren', []], ['close-tab', 'Ordner-Tab schließen', ['ctrl+w']]]
      : kind === 'columns' ? [['configure-columns', 'Spalten konfigurieren', []]]
        : [...(selection.ids.length ? [['clipboard-copy', 'Kopieren', ['ctrl+c']], ['clipboard-cut', 'Ausschneiden', ['ctrl+x']]] : []), ['clipboard-paste', 'Einfügen', ['ctrl+v']]];
    if (kind === 'files' && selection.ids.length === 1) {
      const file = files(p).find(file => file.id === selection.ids[0]);
      if (file?.type === 'folder' && nativeDesktopSupported && !directory.startsWith('zip:')) definitions.push(['inspect-folder-locks', 'Ordnersperren untersuchen', []]);
      if (selection.gitFile) definitions.push(['git', 'Git', [], [['git-diff', 'Git-Diff', []]]]);
    }
    const root = document.createElement('div'); root.className = 'main-menu context-menu'; root.dataset.contextMenu = '';
    function describe([action, label, keys, children]) {
      const paste = action === 'clipboard-paste';
      return { id: action, label: t(label), keys: shortcutRuntime.keysFor(action, keys),
        attrs: { 'data-context-action': action, ...(paste ? { 'data-context-directory': directory } : {}) },
        disabled: paste && (!clipboardAvailable || directory.startsWith('zip:') || Boolean(state.archiveLocations?.[directory])),
        ...(children ? { children: children.map(describe) } : {}) };
    }
    const popup = menus.create({ items: definitions.map(describe), label: t('Kontextmenü'), decorateKeys: decorateShortcut,
      onClose: restore => closeContextMenu(restore), onAction: entry => {
        const action = entry.id;
        closeContextMenu(true);
        if ($('#modal').open || state.panes[side] !== p || state.snapshotId !== snapshotId || currentPath(p) !== directory || p.tabStates[p.tab].id !== tabId) return;
        if (selection && selection.ids.some(id => !files(p).some(file => file.id === id))) return;
        if (!p.tabStates.some(tab => tab.id === clickedTabId)) return;
        state.active = side;
        if (action === 'copy-path') { selectionIO('copy', displayArchivePath(contextDirectory)); return; }
        if (action === 'configure-columns') { host?.postMessage({ type: 'configure-columns' }); return; }
        if (action === 'inspect-folder-locks') { requestShellMenu(true, true, selection); return; }
        run(action, false, action === 'close-tab' ? { tabId: clickedTabId } : selection);
      }
    });
    root.append(popup); document.body.append(root); contextPopup = { root, origin };
    menus.place(popup, { anchor: origin, ...(event.button === 2 ? { x: event.clientX, y: event.clientY } : {}) });
    (popup.querySelector('button:not(:disabled)') || popup).focus();
    event.preventDefault(); event.stopPropagation();
  }
  document.addEventListener('pointerdown', event => { if (contextPopup && !contextPopup.root.contains(event.target)) closeContextMenu(); }, true);
  document.addEventListener('click', event => { if (contextPopup && !contextPopup.root.contains(event.target)) closeContextMenu(); }, true);
  document.addEventListener('contextmenu', () => closeContextMenu(), true);
  document.addEventListener('scroll', event => { if (contextPopup && !contextPopup.root.contains(event.target)) closeContextMenu(); }, true);
  window.addEventListener('blur', () => closeContextMenu());
  window.addEventListener('resize', () => closeContextMenu());
  window.addEventListener('commander-menu-open', event => { if (event.detail !== 'context') closeContextMenu(); });
  $('#panes').addEventListener('contextmenu', event => {
    if (event.target.closest('input,textarea,[contenteditable="true"]')) return;
    if (event.target.closest('[data-lister]')) return;
    const section = event.target.closest('[data-pane]');
    if (!section) return;
    state.active = Number(section.dataset.pane);
    if (event.target.closest('.pathbar, .tabs')) {
      if (event.target.closest('[data-tab]')) showContextMenu(event, section, 'tabs');
      else { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (event.target.closest('thead')) { showContextMenu(event, section, 'columns'); return; }
    const row = event.target.closest('tr[data-id]');
    if (row && !pane().selected.includes(row.dataset.id)) { pane().selected = [row.dataset.id]; pane().cursor = row.dataset.id; }
    refreshSelection();
    if (host && state.realFilesystem) {
      if (fileSettings.useSystemContextMenu !== true || ['linux', 'darwin'].includes(document.body.dataset.platform) && row) {
        const list = section.querySelector('.list');
        gitMenuSelection = captureGitDiff(JSON.parse((row || list).dataset.vscodeContext));
        if (!row && event.button === 2) list.dataset.vscodeContext = JSON.stringify({ webviewSection: 'fileBackground', fileMenu: true, preventDefaultContextMenuItems: true, directory: currentPath(pane()), ids: [], snapshotId: state.snapshotId });
        list.focus();
        showContextMenu(event, section, 'files', JSON.parse((row || list).dataset.vscodeContext)); return;
      }
      event.preventDefault(); event.stopPropagation();
      if (!row) { toast(t('Das Systemmenü für den Ordnerhintergrund ist noch nicht verfügbar.')); return; }
      requestShellMenu(false); return;
    }
    if (!host) { event.preventDefault(); browserMenu(); }
  });
  const themeObserver = new MutationObserver(() => {
    refreshHighlight(); refreshVisibleIcons(); refreshFileColors();
    document.querySelectorAll('.pane').forEach((section, index) => sizePaneColumns(section, state.panes[index]));
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id'] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  function shortcutFocus() {
    const focused = document.activeElement;
    const viewing = Boolean(focused?.closest('.lister')) && !$('#modal').open;
    const searching = Boolean(focused?.closest('[data-file-search]'));
    const editing = searching || $('#modal').open || !viewing && Boolean(focused?.matches('input,textarea,select,[contenteditable="true"]'));
    return { tabFocus: !editing && !viewing && !focused?.closest('.operation-error') && Boolean(focused?.closest('[data-pane]')), searchFocus: searching, searchResultsFocus: Boolean(searching && focused?.matches('[data-search-results]')), searchResults: Boolean(resultView(pane())), listerFocus: Boolean(viewing && focused?.matches('textarea')), textInput: editing, listFocus: !editing && Boolean(focused?.closest('.list')), conflictDialog: Boolean(conflictAction && $('#modal').open), inlineRenameInput: Boolean(focused?.matches('.inline-rename')), fileDialog: Boolean(searching || $('#modal').open || focused?.matches('.inline-rename') || focused?.closest('.operation-error')), transferNameInput: Boolean($('#modal').open && focused?.matches('#value[data-transfer-name]')) };
  }
  function reportFocus() {
    for (const item of document.querySelectorAll('[data-context-action="clipboard-paste"]')) {
      const directory = item.dataset.contextDirectory;
      item.disabled = !clipboardAvailable || directory.startsWith('zip:') || Boolean(state.archiveLocations?.[directory]);
    }
    if (!host) return;
    const value = shortcutFocus();
    host.postMessage({ type: 'inputFocus', tabs: value.tabFocus, search: value.searchFocus, searchResults: value.searchResultsFocus, resultTab: value.searchResults, lister: value.listerFocus, value: value.textInput, list: value.listFocus, conflict: value.conflictDialog, inlineRename: value.inlineRenameInput, dialog: value.fileDialog, transferName: value.transferNameInput, paste: clipboardAvailable && !state.archiveLocations?.[currentPath(pane())] && !currentPath(pane()).startsWith('zip:') });
  }
  window.CommanderStartupResource?.step('controls');
  const shortcutRuntime = window.installCommanderShortcuts({ host, focus: shortcutFocus, enabled: () => startupReady, decorate: decorateShortcut });
  document.addEventListener('focusin', event => {
    reportFocus();
    if (startupReady && event.target.closest('.list') && !event.relatedTarget?.closest('.list')) refreshClipboardAvailability();
  });
  document.addEventListener('focusin', event => {
    if (event.target.classList?.contains('path-input')) event.target.closest('.path-address').classList.add('is-editing');
  });
  document.addEventListener('focusout', event => {
    if (event.target.classList?.contains('path-input')) {
      const input = event.target, section = input.closest('[data-pane]');
      input.value = displayArchivePath(currentPath(state.panes[Number(section.dataset.pane)]));
      input.closest('.path-address').classList.remove('is-editing');
    }
    queueMicrotask(reportFocus);
  });
  $('#modal').addEventListener('close', reportFocus);
  window.CommanderStartupResource?.step('rendering');
  render(true);
  window.dispatchEvent(new Event('commander-started'));
  if (host) host.postMessage({ type: 'app-ready' });
  startupReady = true;
  if (host) { reportFocus(); refreshClipboardAvailability(); requestedIcons.clear(); requestIcons(); requestGitStatus(); }
  flushFocusRefresh();
})();


