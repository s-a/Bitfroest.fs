(() => {
  'use strict';
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
  document.documentElement.lang = language;
  document.querySelector('#modal-close').setAttribute('aria-label', t('Dialog schließen'));
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
      item.firstChild.textContent = `${t(item.firstChild.textContent.trim())} `;
    });
    popup.querySelector('[role="status"]').textContent = t('Mit „Mock“ gekennzeichnete Menüeinträge sind Platzhalter.');
    let items = [];
    let openTrigger = null;
    function closeMenu(returnFocus = false) {
      popup.hidden = true;
      openTrigger?.setAttribute('aria-expanded', 'false');
      if (returnFocus) openTrigger?.focus();
      openTrigger = null;
    }
    function showMenu(trigger) {
      openTrigger?.setAttribute('aria-expanded', 'false');
      openTrigger = trigger;
      trigger.setAttribute('aria-expanded', 'true');
      popup.setAttribute('aria-label', trigger.dataset.menuGroup === 'Hilfe' ? trigger.textContent.trim() : `${trigger.textContent.trim()} (Mock)`);
      popup.style.left = `${trigger.offsetLeft}px`;
      popup.querySelectorAll('[data-group]').forEach(item => { item.hidden = item.dataset.group !== trigger.dataset.menuGroup; });
      items = [...popup.querySelectorAll('[role="menuitem"]:not([hidden])')];
      popup.hidden = false;
      items[0]?.focus();
    }
    triggers.forEach(trigger => trigger.addEventListener('click', () => {
      if (openTrigger === trigger && !popup.hidden) closeMenu(); else showMenu(trigger);
    }));
    popup.addEventListener('click', event => {
      const item = event.target.closest('[data-group]');
      if (!item) return;
      event.preventDefault();
      if (item.hidden || item.getAttribute('aria-disabled') === 'true' || item.dataset.menuAction !== 'licenses') return;
      closeMenu(true); run('licenses');
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
  let fileSettings = {};
  try { fileSettings = JSON.parse(decodeURIComponent(document.body.dataset.fileSettings || '%7B%7D')); } catch { fileSettings = {}; }
  const activeRow = id => [...document.querySelectorAll('.pane.active tr[data-id]')].find(row => row.dataset.id === id);
  const tabs = window.CommanderTabs;
  const columns = window.CommanderColumns;
  const columnModel = window.CommanderColumnSettings;
  let hostColumnSettings;
  try { hostColumnSettings = JSON.parse(decodeURIComponent(document.body.dataset.columnSettings || '%7B%7D')); } catch { hostColumnSettings = {}; }
  let favoriteSettings;
  try { favoriteSettings = JSON.parse(decodeURIComponent(document.body.dataset.favoriteSettings || '%7B%7D')); } catch { favoriteSettings = {}; }
  let favoriteTrigger = null;
  const favoritePath = value => { const normalized = value.replace(/\\/g, '/'); return /^[a-z]:\/+$/i.test(normalized) ? normalized.slice(0, 3) : normalized.replace(/\/+$/, '') || '/'; };
  const favoriteIdentity = value => favoriteSettings.caseSensitive === false ? favoritePath(value).toLowerCase() : favoritePath(value);
  function closeFavorites(restore = true) {
    document.querySelector('[data-favorite-menu]')?.remove();
    const trigger = favoriteTrigger; favoriteTrigger = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (restore && trigger?.isConnected) trigger.focus();
  }
  function openFavorite(name, side) {
    if (filesystemPending || transferPending || transferJob) return;
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
      if (host && state.realFilesystem) requestFilesystem({ type: 'filesystem-navigate', path: target, side: index }, finish);
      else finish();
    };
    navigate(destination, side, () => { if (typeof opposite === 'string' && opposite.trim()) navigate(opposite, 1 - side); });
  }
  function showFavorites(trigger) {
    if (filesystemPending || transferPending || transferJob || $('#modal').open) return;
    const wasOpen = trigger === favoriteTrigger;
    closeFavorites(false); if (wasOpen) return;
    favoriteTrigger = trigger; trigger.setAttribute('aria-expanded', 'true');
    const side = Number(trigger.closest('[data-pane]').dataset.pane);
    const popup = document.createElement('div'); popup.dataset.favoriteMenu = ''; popup.setAttribute('role', 'menu'); popup.setAttribute('aria-label', t('Favoriten'));
    trigger.parentElement.append(popup);
    const entries = favoriteSettings.entries || {}, groups = favoriteSettings.groups || {};
    const names = [...new Set([...(Array.isArray(favoriteSettings.order) ? favoriteSettings.order : []), ...Object.keys(entries)])].filter(name => Object.hasOwn(entries, name) && typeof entries[name] === 'string');
    function button(label, attribute, onClick) {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.setAttribute(attribute, ''); item.textContent = label; item.onclick = onClick; popup.append(item); return item;
    }
    function rootActions() {
      const exists = names.some(name => favoriteIdentity(entries[name]) === favoriteIdentity(currentPath(state.panes[side])));
      button(t(exists ? 'Aktuelles Verzeichnis entfernen' : 'Aktuelles Verzeichnis hinzufügen…'), 'data-favorite-toggle', () => { closeFavorites(); host?.postMessage({ type: 'favorite-toggle', path: currentPath(state.panes[side]) }); });
      button(t('Favoriten konfigurieren…'), 'data-favorite-configure', () => { closeFavorites(false); host?.postMessage({ type: 'configure-favorites' }); });
    }
    function populate(group = '') {
      popup.replaceChildren();
      if (Array.isArray(favoriteSettings.items)) {
        const items = favoriteSettings.items;
        if (group) button(t('Zurück'), 'data-favorite-back', () => { populate(items.find(item => item.id === group)?.parent || ''); popup.querySelector('button')?.focus(); });
        for (const item of items.filter(item => item.parent === (group || null))) {
          if (item.type === 'group') {
            const child = button(item.name, 'data-favorite-group', () => { populate(item.id); popup.querySelector('button')?.focus(); }); child.setAttribute('aria-haspopup', 'menu');
          } else button(item.name, 'data-favorite-entry', () => openFavorite(item.id, side));
        }
        if (!group) rootActions();
        return;
      }
      if (group) button(t('Zurück'), 'data-favorite-back', () => { populate(group.includes('/') ? group.slice(0, group.lastIndexOf('/')) : ''); popup.querySelector('button')?.focus(); });
      const added = new Set();
      for (const name of names) {
        const location = typeof groups[name] === 'string' ? groups[name].split('/').map(part => part.trim()).filter(Boolean).join('/') : '';
        if (location === group) button(typeof favoriteSettings.labels?.[name] === 'string' ? favoriteSettings.labels[name] : name, 'data-favorite-entry', () => openFavorite(name, side));
        else if ((!group || location.startsWith(`${group}/`)) && location) {
          const next = location.slice(group ? group.length + 1 : 0).split('/')[0];
          if (added.has(next)) continue; added.add(next);
          const child = button(next, 'data-favorite-group', () => { populate(group ? `${group}/${next}` : next); popup.querySelector('button')?.focus(); });
          child.setAttribute('aria-haspopup', 'menu');
        }
      }
      if (!group) rootActions();
    }
    populate(); popup.querySelector('button')?.focus();
    popup.addEventListener('keydown', event => {
      const items = [...popup.querySelectorAll('button')], current = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFavorites(); }
      else if (event.key === 'Tab') closeFavorites(false);
    });
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('[data-favorite-menu],[data-favorites]')) closeFavorites(false); });
  window.addEventListener('blur', () => closeFavorites(false));
  function prepareColumns(p) {
    if (Array.isArray(hostColumnSettings?.sets) && hostColumnSettings.sets.length) {
      const sets = columnModel.normalizeColumnSets(hostColumnSettings.sets);
      const set = sets.find(item => item.id === hostColumnSettings.activeSet) || sets[0];
      const signature = JSON.stringify(set);
      if (p.columnSetSignature !== signature) { p.columns = columns.normalize(set.columns); p.columnSetSignature = signature; }
      else p.columns = columns.normalize(p.columns);
    } else { p.columns = columns.normalize(p.columns); }
  }
  const search = window.CommanderSearch;
  let clipboardSelection = null, nativeClipboardUnavailable = false, clipboardSequence = 0;
  let clipboardGeneration = 0;
  function refreshCutMarkers() {
    const identity = value => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
    const paths = new Set(clipboardSelection?.mode === 'move' ? clipboardSelection.paths.map(identity) : []);
    document.querySelectorAll('.pane').forEach((section, index) => {
      const directory = currentPath(state.panes[index]);
      const byId = new Map(files(state.panes[index]).map(file => [file.id, file]));
      section.querySelectorAll('tr[data-id]').forEach(row => {
        const file = byId.get(row.dataset.id);
        const cut = file && paths.has(identity(join(directory, file.name)));
        row.classList.toggle('is-cut', Boolean(cut));
        row.querySelector('.cut-marker')?.remove();
        if (cut) {
          row.setAttribute('aria-label', `${file.name} · ${t('Zum Verschieben vorgemerkt')}`);
          const marker = document.createElement('span'); marker.className = 'cut-marker'; marker.textContent = '↪'; marker.setAttribute('aria-hidden', 'true');
          row.querySelector('.fileicon')?.after(marker);
        } else row.removeAttribute('aria-label');
      });
    });
  }
  function setClipboardSelection(selection) { clipboardSelection = selection; refreshCutMarkers(); }
  const clipboardRequests = new Map();
  function clipboardRequest(message, complete) {
    const requestId = `clipboard-${++clipboardSequence}`;
    clipboardRequests.set(requestId, complete);
    host.postMessage({ ...message, requestId });
  }
  function copyClipboard(mode) {
    if (selected().some(row => row.archive)) { toast(t('Dateioperationen innerhalb von Archiven sind nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.')); return; }
    let captured;
    try { captured = window.CommanderClipboard.capture(state, mode); }
    catch (error) { toast(t(error.message)); return; }
    if (!captured) return;
    const generation = ++clipboardGeneration;
    setClipboardSelection({ ...captured, source: 'internal' });
    if (!host || !state.realFilesystem) { toast(t(mode === 'move' ? 'Dateiauswahl intern zum Verschieben vorgemerkt.' : 'Dateiauswahl intern in die Zwischenablage übernommen.')); return; }
    clipboardRequest({ type: 'clipboard-write', ...captured }, response => {
      if (generation !== clipboardGeneration) return;
      if (response.ok) { setClipboardSelection(response.selection); nativeClipboardUnavailable = false; toast(t(mode === 'move' ? 'Dateiauswahl zum Verschieben in die System-Zwischenablage übernommen.' : 'Dateiauswahl in die System-Zwischenablage übernommen.')); }
      else if (response.unavailable) { nativeClipboardUnavailable = true; toast(t('System-Datei-Zwischenablage nicht verfügbar; Auswahl nur intern übernommen.')); }
      else { setClipboardSelection(null); toast(t(response.error)); }
    });
  }
  function pasteClipboard() {
    const targetPath = currentPath(pane()), targetSide = state.active;
    const start = selection => {
      setClipboardSelection(selection);
      if (!selection) { toast(t('Die Zwischenablage enthält keine Dateien.')); return; }
      let plan;
      try { plan = window.CommanderClipboard.inspectPaste(state, selection, targetPath); }
      catch (error) { toast(t(error.message)); return; }
      if (!plan.ready) { requestFilesystem({ type: 'filesystem-prepare', paths: plan.directories, action: 'clipboard-paste', recursive: false }, () => start(selection)); return; }
      const completions = [];
      const finish = () => {
        const remainingPaths = window.CommanderClipboard.remaining(selection, completions);
        setClipboardSelection(remainingPaths.length ? { ...selection, paths: remainingPaths } : null);
        if (selection.source === 'system' && selection.mode === 'move' && completions.some(({ result }) => result.confirmed && result.completedIds?.length)) {
          clipboardRequest({ type: 'clipboard-ack', token: selection.token, paths: selection.paths, mode: selection.mode, remainingPaths }, response => {
            if (!response.ok) toast(t(response.error));
            else if (!response.matched) { setClipboardSelection(null); toast(t('Dateien übertragen; inzwischen geänderte Zwischenablage bleibt unverändert.')); }
          });
        }
      };
      const next = index => {
        if (index >= plan.groups.length) { finish(); return; }
        const group = plan.groups[index];
        const sourceSide = state.panes.findIndex(p => currentPath(p) === group.sourcePath);
        runTransfer({ ...group, sourceSide: sourceSide < 0 ? targetSide : sourceSide, onComplete: result => {
          completions.push({ group, result });
          if (result.confirmed !== true || result.cancelled || result.errors?.length) finish();
          else next(index + 1);
        } });
      };
      next(0);
    };
    if (!host || !state.realFilesystem || nativeClipboardUnavailable) { start(clipboardSelection); return; }
    clipboardRequest({ type: 'clipboard-read' }, response => {
      if (response.ok) start(response.selection);
      else if (response.unavailable) { nativeClipboardUnavailable = true; start(clipboardSelection); }
      else toast(t(response.error));
    });
  }
  const nativeIcons = new Map();
  const requestedIcons = new Set();
  let iconTheme = {};
  try { iconTheme = JSON.parse(decodeURIComponent(document.body.dataset.iconTheme || '%7B%7D')); } catch { iconTheme = {}; }
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const join = (base, name) => `${base === '/' ? '' : base}/${name}`;
  const parent = path => path.includes('!/') ? path.slice(0, path.lastIndexOf('/')) || '/' : path.slice(0, path.lastIndexOf('/')) || '/';
  const base = path => path.split('/').filter(Boolean).pop() || '/';
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
  let saved;
  try { const injected = JSON.parse(document.body.dataset.initialState || 'null'); saved = host ? injected?.realFilesystem ? injected : host.getState() || injected : JSON.parse(sessionStorage.getItem('bitfroest-demo')); } catch { saved = null; }
  let state = saved?.version === 1 && saved.folders && saved.panes?.length === 2 ? saved : initial();
  nextId = Math.max(Date.now(), ...Object.values(state.folders).flat().map(item => Number(item.id) + 1).filter(Number.isFinite));
  let confirmedFolders = JSON.stringify(state.folders);
  let filesystemPending = false;
  let refreshingFilesystem = false;
  const folderSizes = new Map(), folderSizeRequests = new Map();
  let folderSizeSequence = 0;
  function cancelFolderSizes() {
    for (const operationId of folderSizeRequests.keys()) host?.postMessage({ type: 'filesystem-cancel', operationId });
    folderSizeRequests.clear();
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
      const operationId = `folder-size-${++folderSizeSequence}`;
      const request = { type: 'folder-size', operationId, snapshotId: state.snapshotId, path };
      folderSizeRequests.set(operationId, request);
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
  }
  let filesystemResume = null;
  let creationFailure = null;
  let renameFailure = null;
  let transferCompletion = null;
  let transferCheckpoint = null;
  let transferJob = null, transferSequence = 0;
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
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !transferJob) return;
    if (event.target?.closest?.('[data-shell-menu]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); cancelTransfer();
  }, true);
  $('#modal').addEventListener('cancel', event => {
    if (!transferJob || transferJob.hostActive === false) return;
    event.preventDefault(); cancelTransfer();
  });
  function transferProgress(progress = {}) {
    let element = document.querySelector('.transfer-progress');
    if (!transferJob) { element?.remove(); return; }
    if (!element) {
      element = document.createElement('section'); element.className = 'transfer-progress'; element.setAttribute('role', 'region'); element.setAttribute('aria-labelledby', 'transfer-progress-title');
      const title = document.createElement('strong'); title.id = 'transfer-progress-title'; title.dataset.progressTitle = ''; title.textContent = t(transferJob.context.mode === 'move' ? 'Verschieben läuft…' : 'Kopieren läuft…');
      const paths = document.createElement('dl');
      for (const [key, label, value] of [['source', 'Quelle', transferJob.context.sources.join('\n')], ['target', 'Ziel', transferJob.context.target]]) {
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
      button.type = 'button'; button.dataset.cancelTransfer = ''; button.textContent = t('Abbrechen');
      button.onclick = cancelTransfer;
      actions.append(label, button); element.append(title, paths, meters, actions); (transferJob.modalPreparation ? $('#modal-body') : document.body).append(element);
    }
    const progressContainer = transferJob.modalPreparation ? $('#modal-body') : document.body;
    if (element.parentElement !== progressContainer) progressContainer.append(element);
    if (progress.phase) transferJob.phase = progress.phase;
    const progressPath = progress.sourcePath || progress.path;
    if (progressPath && progressPath !== transferJob.currentPath) { transferJob.currentPath = progressPath; transferJob.currentTransferred = 0; transferJob.currentTotal = progress.total; }
    if (progress.filesScanned !== undefined) element.querySelector('[data-progress-count]').textContent = t('{count} Einträge geprüft', { count: progress.filesScanned });
    else if (progress.totalBytes !== undefined) element.querySelector('[data-progress-count]').textContent = size(progress.completedBytes || 0) + ' / ' + size(progress.totalBytes);
    else if (!element.querySelector('[data-progress-count]').textContent) element.querySelector('[data-progress-count]').textContent = t('Dateioperation läuft…');
    if (progress.totalBytes !== undefined) { transferJob.totalBytes = progress.totalBytes; transferJob.completedBytes = progress.completedBytes || 0; }
    element.querySelector('[data-overall-count]').textContent = Number.isFinite(transferJob.totalBytes) && transferJob.totalBytes > 0 ? size(transferJob.completedBytes || 0) + ' / ' + size(transferJob.totalBytes) : t('Dateioperation läuft…');
    if (progress.transferred !== undefined) transferJob.currentTransferred = Math.max(transferJob.currentTransferred || 0, progress.transferred);
    if (progress.total !== undefined) transferJob.currentTotal = progress.total;
    if (progress.phase === 'published' && Number.isFinite(transferJob.currentTotal)) transferJob.currentTransferred = transferJob.currentTotal;
    if (transferJob.currentPath) element.querySelector('[data-current-file-path]').textContent = transferJob.currentPath;
    element.querySelector('[data-current-file-count]').textContent = Number.isFinite(transferJob.currentTotal) && transferJob.currentTotal > 0 ? size(transferJob.currentTransferred || 0) + ' / ' + size(transferJob.currentTotal) : t('Dateioperation läuft…');
    const operationLabel = transferJob.phase === 'preparing' ? 'Vorbereiten' : transferJob.phase === 'validating' ? 'Prüfen' : transferJob.context.mode === 'move' ? 'Verschieben' : 'Kopieren';
    const fileName = transferJob.currentPath?.split(/[\\/]/).filter(Boolean).at(-1);
    const title = transferJob.cancelRequested ? t('Abbruch wird ausgeführt…') : fileName ? t(`${operationLabel}: {file}`, { file: fileName }) : t(operationLabel === 'Vorbereiten' ? 'Dateien werden vorbereitet…' : operationLabel === 'Prüfen' ? 'Dateien werden geprüft…' : operationLabel === 'Verschieben' ? 'Verschieben läuft…' : 'Kopieren läuft…');
    element.querySelector('[data-progress-title]').textContent = title;
    const overallValueText = Number.isFinite(transferJob.totalBytes) && transferJob.totalBytes > 0 ? `${size(transferJob.completedBytes || 0)} / ${size(transferJob.totalBytes)}` : t('Gesamtfortschritt unbekannt');
    const fileValueText = Number.isFinite(transferJob.currentTotal) && transferJob.currentTotal > 0 ? `${size(transferJob.currentTransferred || 0)} / ${size(transferJob.currentTotal)}` : t('Fortschritt der aktuellen Datei unbekannt');
    const cancelButton = element.querySelector('[data-cancel-transfer]');
    cancelButton.hidden = false;
    cancelButton.disabled = Boolean(transferJob.cancelRequested);
    statusbar.setProgress({ id: transferJob.id, title, statusPath: transferJob.currentPath, overallValueText, fileValueText, total: transferJob.totalBytes, completed: transferJob.completedBytes, fileTotal: transferJob.currentTotal, fileCompleted: transferJob.currentTransferred, element, modal: transferJob.modalPreparation, cancelRequested: transferJob.cancelRequested, cancelAvailable: true });
  }
  let transferPreparationFailure = null;
  let startupReady = false;
  let focusRefreshRequested = false;
  let transferPending = false;
  let rightDropChoice = null, rightDropSequence = 0;
  let shellMenuPending = null, shellMenuSequence = 0;
  let conflictAction = null;
  function flushFocusRefresh() {
    if (!startupReady || !focusRefreshRequested || filesystemPending || transferPending || rightDropChoice || shellMenuPending || $('#modal').open) return;
    focusRefreshRequested = false;
    if (lister.has(state.active)) return;
    run('refresh');
  }
  window.addEventListener('focus', () => {
    if (!host || !state.realFilesystem) return;
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
    if (!result) return state.folders[currentPath(p)] || [];
    const archived = new Map((result.archiveRows || []).map(row => [row.fsSource, row])), directories = new Map();
    return result.paths.map(path => {
      if (archived.has(path)) return archived.get(path);
      const directory = parent(path);
      if (!directories.has(directory)) directories.set(directory, new Map((state.folders[directory] || []).map(row => [join(directory, row.name), row])));
      return directories.get(directory).get(path);
    }).filter(Boolean);
  };
  function requestFilesystem(message, resume) {
    if (filesystemPending) return true;
    refreshingFilesystem = message.type === 'filesystem-refresh';
    rememberScroll();
    filesystemResume = resume;
    if (message.type === 'filesystem-prepare' && ['copy', 'move'].includes(message.action)) {
      transferJob = { id: `prepare-${Date.now()}-${++transferSequence}`, phase: 'preparing', hostActive: true, context: Object.freeze({ mode: message.action, sources: Object.freeze([...message.paths]), target: currentPath(state.panes[1 - state.active]) }) };
      transferJob.modalPreparation = $('#modal').open;
      if (transferJob.modalPreparation) { if ($('#value')) $('#value').disabled = true; $('#modal-confirm').disabled = true; }
      message.operationId = transferJob.id; transferProgress();
    }
    filesystemPending = true; $('#panes').inert = !transferJob; $('#functionbar').inert = true;
    if (message.type === 'filesystem-delete') toast(t('Löschen wird ausgeführt'));
    host.postMessage({ ...message, state });
    return true;
  }
  function prepareFolders(paths, action, resume, recursive = true) {
    if (!host || !state.realFilesystem) return false;
    const directories = [...new Set(paths)].filter(path => (state.unloadedFolders || []).some(unloaded => unloaded === path || recursive && unloaded.startsWith(`${path}/`)));
    return directories.length ? requestFilesystem({ type: 'filesystem-prepare', paths: directories, action, recursive }, resume) : false;
  }
  const selected = () => selectedFor(pane());
  const size = value => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
  function persist() {
    if (transferPending && !transferCompletion) return;
    state.panes.forEach(p => tabs.remember(p));
    if (host) {
      host.setState(state);
      const proposedState = transferCompletion?.proposedState || state;
      if (state.realFilesystem && JSON.stringify(proposedState.folders) !== confirmedFolders) {
        if (!filesystemPending) { filesystemPending = true; $('#panes').inert = !transferJob; $('#functionbar').inert = true; if (!transferJob) toast(t('Dateioperation läuft…')); host.postMessage({ type: 'filesystem-apply', state: proposedState, ...(transferJob ? { operationId: transferJob.id, transfer: transferJob.transfer } : {}) }); }
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
  let gitSequence = 0, gitSignature = '', gitRequest;
  function requestGitStatus() {
    if (!host || !startupReady || !state.realFilesystem) return;
    const directories = [...new Set(state.panes.filter(p => !resultView(p)).map(currentPath).filter(path => !path.includes('!') && !path.startsWith('zip:')))];
    const signature = JSON.stringify([state.snapshotId, directories]);
    if (gitSignature === signature) return;
    gitSignature = signature;
    gitRequest = { type: 'git-status', requestId: `git-${++gitSequence}`, snapshotId: state.snapshotId, directories };
    host.postMessage(gitRequest);
  }
  function branchMarkup(p) {
    const info = gitDirectories.get(currentPath(p));
    if (!info?.ok || !info.repository) return '';
    const branch = info.detached ? `${t('Detached HEAD')} ${String(info.head || '').slice(0, 8)}` : info.branch;
    return branch ? `<button type="button" data-git-branch title="${escape(t('Lokale Branches anzeigen'))}" aria-label="${escape(t('Lokale Branches anzeigen'))}: ${escape(branch)}">(${escape(branch)})</button>` : '';
  }
  function icon(file, directory) {
    const original = baseIcon(file, directory);
    const info = gitDirectories.get(directory);
    const status = info?.ok && info.statuses?.[file.name];
    const labels = { clean: 'Unverändert', modified: 'Geändert', added: 'Hinzugefügt', deleted: 'Gelöscht', untracked: 'Unversioniert', ignored: 'Ignoriert', conflict: 'Konflikt' };
    const symbols = { clean: '✓', modified: '●', added: '+', deleted: '−', untracked: '?', ignored: '◌', conflict: '!' };
    if (!labels[status]) return original;
    return `<span class="git-icon">${original}<span data-git-status="${status}" role="img" aria-label="${escape(t(labels[status]))}" title="${escape(t(labels[status]))}">${symbols[status]}</span></span>`;
  }
  function refreshGitDisplay() {
    refreshVisibleIcons();
    document.querySelectorAll('.pane').forEach((section, index) => {
      const location = section.querySelector('[data-git-location]');
      if (!location) return;
      const info = gitDirectories.get(currentPath(state.panes[index]));
      section.querySelector('.path-input').title = info?.error ? t('Git-Status nicht verfügbar: {error}', { error: info.error }) : '';
      const html = branchMarkup(state.panes[index]);
      const template = document.createElement('template'); template.innerHTML = html;
      if (location.innerHTML !== template.innerHTML) {
        const focused = location.contains(document.activeElement);
        location.innerHTML = html;
        if (focused) (location.querySelector('button') || section.querySelector('.path-input')).focus({ preventScroll: true });
      }
    });
  }
  function baseIcon(file, directory) {
    const key = file.iconKey || join(directory || '', file.name);
    if (nativeIcons.get(key)) return `<img class="fileicon native-icon" src="${nativeIcons.get(key)}" alt="">`;
    if (file.type === 'folder') return '<span aria-hidden="true" class="fileicon folder"></span>';
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
    return themed ? `<span aria-hidden="true" class="fileicon themed ${escape(themed)}"></span>` : `<span aria-hidden="true" class="fileicon ${file.type}">${({ folder: '', archive: 'ZIP', markdown: 'M↓', code: '{}', text: '≡' })[file.type] || '≡'}</span>`;
  }
  function requestIcons() {
    if (!host) return;
    const requests = new Map();
    state.panes.forEach(p => {
      p.tabs.forEach(path => requests.set(path, { key: path, path, name: base(path), type: 'folder' }));
      files(p).forEach(file => {
        const key = entryPath(p, file);
        requests.set(key, { key, path: key, name: file.name, type: file.type === 'folder' ? 'folder' : 'file' });
      });
    });
    const pending = [...requests.values()].filter(item => !requestedIcons.has(item.key)).slice(0, 128);
    if (!pending.length) return;
    pending.forEach(item => requestedIcons.add(item.key));
    host.postMessage({ type: 'icons', requests: pending });
  }
  function refreshVisibleIcons() {
    document.querySelectorAll('.pane').forEach((section, index) => {
      const p = state.panes[index];
      const byId = new Map(files(p).map(file => [file.id, file]));
      const replace = (element, html) => { if (!element) return; const temp = document.createElement('template'); temp.innerHTML = html; const fresh = temp.content.firstElementChild; if (element.outerHTML !== fresh.outerHTML) element.replaceWith(fresh); };
      section.querySelectorAll('tr[data-id]').forEach(row => {
        const file = byId.get(row.dataset.id);
        if (file) replace(row.querySelector('.git-icon') || row.querySelector('.fileicon'), icon(file, currentPath(p)));
      });
      section.querySelectorAll('[data-tab]').forEach(button => {
        const path = p.tabs[Number(button.dataset.tab)];
        replace(button.querySelector('.git-icon') || button.querySelector('.fileicon'), icon({ name: base(path), type: 'folder', iconKey: path }, parent(path)));
      });
    });
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
  function startRename(proposal) {
    if (filesystemPending) return;
    clearTimeout(renameTimer);
    const p = pane(), file = files(p).find(item => item.id === p.cursor) || selected()[0];
    if (!file) return;
    const source = resultView(p) ? parent(file.fsSource) : currentPath(p);
    if (file.archive && !state.archiveLocations?.[source]) return toast(t('Dateioperationen innerhalb von Archiven sind nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.'));
    if (file.type === 'folder' && prepareFolders([join(source, file.name)], 'rename-one', startRename)) return;
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
      finished = true;
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
  function renderFileCell(original, column, p) {
      const file = displayFile(original, p);
      const result = column.field === undefined ? null : columnModel.evaluateColumnTemplate(file, column.field);
      const unavailable = result?.unavailableFields;
      const text = unavailable?.length ? t('Nicht verfügbar: {field}', { field: unavailable.join(', ') }) : columns.displayValue(file, column.field === undefined ? column.key : column);
      const isName = column.field === undefined ? column.key === 'name' : /\[=(?:file|tc)\.(?:name|fullname)\]/.test(column.field);
      const content = isName ? `<span class="filename">${icon(file, currentPath(p))}<span data-filename>${highlight(text, p.filter)}</span>${resultView(p) ? `<span data-result-source class="result-source" title="${escape(file.fsSource)}">${escape(parent(file.fsSource))}</span>` : ''}</span>` : highlight(text, column.key === 'type' && p.filter.startsWith('.') ? p.filter.slice(1) : p.filter);
      return `<td data-cell="${escape(column.key)}" title="${escape(file.name)}" class="column-align-${column.align || 'left'}">${content}</td>`;
  }
  function renderPane(p, index) {
    tabs.ensure(p);
    prepareColumns(p);
    const displayColumns = p.columns.filter(column => column.visible !== false);
    const list = visible(p), marked = selectedFor(p), selectedIds = new Set(p.selected);
    const cell = (file, column) => renderFileCell(file, column, p);
    return ui`<section class="pane ${state.active === index ? 'active' : ''}" data-pane="${index}" data-tab-key="${p.tabStates[p.tab].id}" aria-label="${index === 0 ? t('Linke') : t('Rechte')} Dateiliste">
      <div class="pane-label"><span>${index === 0 ? t('LINKE') : t('RECHTE')} DATEILISTE</span><span>${state.active === index ? t('AKTIV') : t('GEGENSEITE')}</span></div>
      <div class="tabs" role="tablist" aria-label="Ordner-Tabs ${index === 0 ? t('links') : t('rechts')}">${p.tabs.map((path, tab) => ui`<div class="tab-wrap ${p.tab === tab ? 'selected' : ''}" draggable="true" data-tab-drag="${tab}"><button class="tab" role="tab" aria-selected="${p.tab === tab}" data-tab="${tab}" title="${escape(path)} · Doppelklick schließt">${icon({ name: base(path), type: 'folder', iconKey: path }, parent(path))}<span>${escape(p.tabStates[tab].searchResult?.label || base(path))}</span></button></div>`).join('')}<button class="add-tab" data-new-tab title="Ordner-Tab hinzufügen" aria-label="Ordner-Tab hinzufügen">+</button></div>
      <div class="pathbar"><button data-favorites title="Favoriten" aria-label="Favoriten" aria-haspopup="menu" aria-expanded="false">☆</button><div class="path"><span>${currentPath(p).includes('!') ? '▣' : '⌂'}</span><input class="path-input" aria-label="Pfad ${index === 0 ? t('links') : t('rechts')}" value="${escape(displayArchivePath(currentPath(p)))}" spellcheck="false"><span data-git-location>${branchMarkup(p)}</span></div><button data-refresh title="Liste aktualisieren" aria-label="Liste aktualisieren">⟳</button></div>
      <div class="list" tabindex="0" aria-label="Dateien ${index === 0 ? t('links') : t('rechts')}"><table class="file-table" aria-label="Dateien und Ordner ${index === 0 ? t('links') : t('rechts')}"><colgroup>${displayColumns.map(column => `<col data-col="${escape(column.key)}" width="${column.width}">`).join('')}</colgroup><thead data-vscode-context='{"webviewSection":"columns","preventDefaultContextMenuItems":true}'><tr>${displayColumns.map(column => ui`<th data-column="${escape(column.key)}" class="column-align-${column.align || 'left'}" draggable="true"><button data-sort="${escape(column.key)}">${escape(column.field === undefined ? t(column.label) : column.label)}${p.sort === column.key ? p.descending ? ' ↓' : ' ↑' : ''}</button><span class="column-resize" data-resize="${escape(column.key)}" role="separator" aria-label="Breite ${escape(column.field === undefined ? t(column.label) : column.label)}" title="Ziehen: Breite ändern · Doppelklick: an Inhalt anpassen"></span></th>`).join('')}</tr></thead><tbody><tr class="parent-row" data-parent>${displayColumns.map(column => `<td data-cell="${escape(column.key)}">${column.key === 'name' ? '<span class="filename"><span class="fileicon folder"></span><span>..</span></span>' : ''}</td>`).join('')}</tr>${list.map((file, rowIndex) => `<tr data-id="${escape(file.id)}" draggable="${!resultView(p)}" aria-selected="${selectedIds.has(file.id)}" class="${resultView(p)?.groups && rowIndex > 0 && resultView(p).groups[file.fsSource] !== resultView(p).groups[list[rowIndex - 1].fsSource] ? 'search-group-start' : ''} ${selectedIds.has(file.id) ? 'selected' : ''} ${p.cursor === file.id ? 'focused' : ''}">${displayColumns.map(column => cell(file, column)).join('')}</tr>`).join('')}</tbody></table>${!displayColumns.length ? `<div class="empty">${t('Keine sichtbaren Spalten')}</div>` : list.length ? '' : ui(['<div class="empty">Keine Einträge</div>'])}</div>
      <div class="pane-status"><span><strong>${marked.length ? ui`${marked.length} markiert` : count('file', files(p).filter(f => f.type !== 'folder').length)}</strong> · ${count('folder', files(p).filter(f => f.type === 'folder').length)}</span><span>${size((marked.length ? marked : files(p)).reduce((sum, f) => sum + displayBytes(f, p), 0))}</span></div></section>`;
  }
  function selectedFor(p) { const ids = new Set(p.selected); return files(p).filter(file => ids.has(file.id)); }
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
      const p = state.panes[index], active = state.active === index, selectedIds = new Set(p.selected);
      section.classList.toggle('active', active);
      section.querySelector('.pane-label span:last-child').innerHTML = active ? ui(['<i></i> AKTIV']) : t('GEGENSEITE');
      if (lister.has(index)) return;
      section.querySelectorAll('[data-id]').forEach(row => {
        row.classList.toggle('selected', selectedIds.has(row.dataset.id));
        row.classList.toggle('focused', p.cursor === row.dataset.id);
        row.setAttribute('aria-selected', String(selectedIds.has(row.dataset.id)));
      });
      const marked = selectedFor(p);
      section.querySelector('.pane-status').innerHTML = ui`<span><strong>${marked.length ? ui`${marked.length} markiert` : count('file', files(p).filter(f => f.type !== 'folder').length)}</strong> · ${count('folder', files(p).filter(f => f.type === 'folder').length)}</span><span>${size((marked.length ? marked : files(p)).reduce((sum, f) => sum + displayBytes(f, p), 0))}</span>`;
    });
    lister.updateMenu();
    persist();
  }
  const actions = [['F3', t('Anzeigen'), 'view'], ['F4', t('Bearbeiten'), 'edit'], ['F5', t('Kopieren'), 'copy'], ['F6', t('Verschieben'), 'move'], ['F7', t('Neuer Ordner'), 'mkdir'], ['F8', t('Löschen'), 'delete']];
  const lister = window.CommanderListerView.create({ host, state: () => state, t, escape, modal, restore: render, edit: file => preview(file, true), notify: toast, remember: rememberScroll });
  const fileSearch = window.CommanderFileSearch.create({ host, t, escape,
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
      if (section.dataset.tabKey === p.tabStates[p.tab].id && section.querySelector('.list')) p.scrollTop = section.querySelector('.list').scrollTop;
    });
  }
  function render(focusList = false) {
    closeFavorites(false);
    rememberScroll();
    refreshHighlight();
    $('#panes').innerHTML = state.panes.map(renderPane).join('');
    document.querySelectorAll('.list').forEach((list, index) => {
      list.scrollTop = state.panes[index].scrollTop || 0;
      list.querySelector('table').style.width = `${state.panes[index].columns.filter(column => column.visible !== false).reduce((sum, column) => sum + column.width, 0)}px`;
    });
    lister.mount();
    if (focusList) { if (lister.has(state.active)) lister.focus(); else document.querySelector('.pane.active .list')?.focus({ preventScroll: true }); }
    refreshCutMarkers();
    persist();
    requestIcons();
    requestGitStatus();
  }
  function toast(text) { const message = t(text); statusbar.setStatus(message); $('#toast').classList.remove('visible'); $('#toast').textContent = ''; }
  function go(path) {
    path = Object.keys(state.archiveLocations || {}).find(value => displayArchivePath(value) === path) || path;
    if (!Object.hasOwn(state.folders, path)) return toast(t('Dieser Pfad ist in den Beispieldaten nicht vorhanden.'));
    if (host && state.realFilesystem && state.unloadedFolders?.includes(path)) {
      const side = state.active;
      requestFilesystem({ type: 'filesystem-navigate', path, side }, () => { state.active = side; go(path); }); return;
    }
    rememberScroll(); delete pane().tabStates[pane().tab].searchResult; tabs.navigate(pane(), path); render(true);
  }
  function displayArchivePath(value) {
    const archive = state.archiveLocations?.[value]?.archive;
    return archive ? archive + value.slice(value.indexOf('!')) : value;
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
    if ($('#modal').open || document.querySelector('.inline-rename') || filesystemPending || transferPending) return;
    const input = document.querySelectorAll('.path-input')[state.active];
    input.focus(); input.select();
    const generation = ++pathRequestGeneration, side = state.active, activePane = pane(), originalPath = currentPath(activePane);
    if (!fromClipboard || !host) return;
    clipboardRequest({ type: 'clipboard-path-read' }, response => {
      if (generation !== pathRequestGeneration || document.activeElement !== input || state.active !== side || pane() !== activePane || currentPath(activePane) !== originalPath || $('#modal').open || filesystemPending || transferPending) return;
      if (!response.ok) { toast(response.error); return; }
      input.value = response.path; input.select();
      if (state.realFilesystem) {
        const navigation = { generation, input, side, valid: false };
        pendingPathNavigation = navigation;
        requestFilesystem({ type: 'filesystem-navigate', path: response.path, side }, () => {
          if (!navigation.valid) return;
          const identity = value => /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
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
    else if (host && state.realFilesystem) host.postMessage({ type: 'open', path: file.fsSource });
    else preview(file, false);
  }
  let confirmAction = null;
  let operationFailure = null, operationErrorDialog = false, operationFailureInline = false, failureFocus = null;
  function mountOperationFailure() {
    document.querySelector('.operation-error')?.remove();
    if (!operationFailure) return;
    const area = document.createElement('section'); area.className = 'operation-error'; area.setAttribute('role', 'alert');
    area.innerHTML = `<p>${t('Die Fehlerdetails bleiben bis zur Bestätigung verfügbar.')}</p><label for="operation-error-text">${t('Fehlerdetails und Wiederherstellungspfade')}</label><textarea id="operation-error-text" class="operation-error-text" readonly rows="4"></textarea><div class="operation-error-actions"><button type="button" data-select-error>${t('Details auswählen')}</button>${operationErrorDialog ? '' : `<button type="button" data-dismiss-error>${t('Fehler bestätigen')}</button>`}</div>`;
    area.querySelector('textarea').value = operationFailure;
    if (operationFailureInline) { area.classList.add('operation-error-inline'); $('#functionbar').before(area); }
    else $('#modal-body').prepend(area);
  }
  function showOperationFailure(message, { inline = false } = {}) {
    statusbar.error(message);
    statusbar.setStatus(message);
    clearTimeout(toast.timer); $('#toast').classList.remove('visible');
    operationFailure = message;
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
    $('#modal-confirm').textContent = label; $('#modal-confirm').hidden = !label; $('#modal-cancel').textContent = label ? t('Abbrechen') : t('Schließen');
    const description = $('#modal-body').querySelector('#modal-description');
    if (description) $('#modal').setAttribute('aria-describedby', 'modal-description');
    else $('#modal').removeAttribute('aria-describedby');
    confirmAction = callback; $('#modal').showModal();
    const input = $('#modal-body').querySelector('input:not([type="checkbox"]):not([type="radio"]), textarea');
    if (input) { input.focus(); input.select(); }
    if (operationFailure) mountOperationFailure();
  }
  function field(label, value, id = 'value') { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${escape(value)}" required autocomplete="off"></div>`; }
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
      host.postMessage({ type: edit ? 'edit' : 'preview', content: file.content || '', language: file.type === 'markdown' ? 'markdown' : 'plaintext', ...(state.realFilesystem ? { path: file.fsSource } : {}) });
      return;
    }
    let body;
    if (edit) body = ui`<p>Editor-Vorschau mit Beispieldaten.</p><textarea class="editor" aria-label="Dateiinhalt">${escape(file.content)}</textarea>`;
    else if (file.type === 'markdown') {
      const lines = (file.content || '').split('\n');
      body = `<article class="markdown-preview">${lines.map(line => line.startsWith('## ') ? `<h2>${escape(line.slice(3))}</h2>` : line.startsWith('# ') ? `<h1>${escape(line.slice(2))}</h1>` : line.startsWith('- ') ? `<ul><li>${escape(line.slice(2))}</li></ul>` : `<p>${escape(line)}</p>`).join('')}</article>`;
    } else body = `<pre class="preview-text">${escape(file.content || t('Keine Textvorschau verfügbar.'))}</pre>`;
    modal(file.name, body, edit ? t('Mockup speichern') : null, () => { file.content = $('.editor').value; file.size = new TextEncoder().encode(file.content).length; render(); toast(t('Beispieldatei aktualisiert')); return true; }, edit ? t('BEARBEITEN · F4') : t('VORSCHAU · F3'));
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
      const fileCard = (file, role, path) => `<section class="file-comparison" data-conflict-file="${role}" aria-label="${t(role === 'source' ? 'Quelle' : 'Ziel')}"><h3>${t(role === 'source' ? 'Quelle' : 'Ziel')}</h3><div class="comparison-name">${escape(file.name)}</div><div class="comparison-path">${escape(path)}</div><div class="comparison-meta"><span class="comparison-meta-label">${t('Größe / Datum')}</span><span>${escape(text(file))}</span></div></section>`;
      modal(t('Datei bereits vorhanden'), `<p id="modal-description" class="dialog-description">${t('Eine Datei mit diesem Namen ist bereits im Ziel vorhanden.')}</p><div class="file-comparison-grid">${fileCard(conflict.source, 'source', conflict.sourcePath)}${fileCard(conflict.target, 'target', conflict.targetPath)}</div>${conflict.samePath ? `<p class="dialog-notice">${t('Quelle und Ziel sind identisch. Zum Kopieren einen neuen Namen wählen.')}</p>` : ''}${field(t('Neuer Name für Kopie oder Ziel'), window.CommanderTransfer.uniqueName([conflict.source, conflict.target], conflict.source.name), 'conflict-name')}<fieldset class="conflict-single"><legend>${t('Für diese Datei')}</legend><div class="conflict-actions">${['overwrite', 'skip', 'rename-source', 'rename-target', 'append'].map(button).join('')}</div></fieldset><details class="dialog-options"><summary>${t('Weitere Konfliktentscheidungen')}</summary><div class="conflict-actions">${['overwrite-all', 'skip-all', 'autorename-source', 'autorename-target', 'overwrite-older', 'overwrite-older-equal', 'rename-older-target', 'larger', 'smaller'].map(button).join('')}</div></details><p id="conflict-limitations" class="dialog-hint">${conflict.samePath ? t('Identische Dateien können nicht überschrieben werden.') : t('Entscheidungen für alle Dateien gelten für weitere Konflikte dieses Auftrags.')}</p><button type="button" id="conflict-compare" class="dialog-link" ${typeof conflict.source.content !== 'string' || typeof conflict.target.content !== 'string' || ['folder', 'archive'].includes(conflict.source.type) || ['folder', 'archive'].includes(conflict.target.type) ? `disabled title="${t('Keine vollständigen Textdaten für einen Vergleich vorhanden')}"` : ''}>${t('Inhalt vergleichen')}</button><pre id="conflict-comparison" class="preview-text" hidden></pre>`, null, () => false, t('KOPIER-/VERSCHIEBEKONFLIKT'));
      $('#modal-cancel').textContent = t('Abbrechen');
      $('#modal-cancel').dataset.conflictAction = 'cancel';
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
    if (options.validateSelection && !options.validateSelection()) throw new Error(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.'));
    const plan = window.CommanderTransfer.planTarget({ ...options, folders: state.folders });
    const targetDirectory = plan.directory;
    const progressSources = new Map((state.folders[options.sourcePath] || []).filter(file => options.ids.includes(file.id)).map(file => [file.id, join(options.sourcePath, file.name)]));
    if (!transferJob) {
      transferJob = { id: `transfer-ui-${Date.now()}-${++transferSequence}`, hostActive: false, phase: 'copying', context: Object.freeze({ mode: options.mode, sources: Object.freeze(options.ids.map(id => progressSources.get(id)).filter(Boolean)), target: targetDirectory }) };
      transferProgress();
    } else if (transferJob.hostActive === false && transferJob.phase === 'preparing') {
      transferJob.phase = 'copying'; transferJob.currentPath = null; transferJob.currentTransferred = 0; transferJob.currentTotal = undefined; transferProgress();
    }
    const resume = () => executeTransfer(options).catch(error => failTransferExecution(error, options.onComplete));
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
      filesystemPending = true;
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
          filesystemPending = false; planningJob.hostActive = false;
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
    const result = await window.CommanderTransfer.execute({ ...options, policy: options.policyState?.value || options.policy, signal: planningJob.controller.signal, folders: state.folders, createId: () => String(nextId++),
      onBeforeDecision: flushCompleted, onConflict: async (...args) => { const decision = await transferConflict(...args); if (options.policyState && window.CommanderTransfer.policies.includes(decision?.action) && decision.action !== 'ask') options.policyState.value = decision.action; return decision; }, onRename: transferIndividualName });
    if (transferJob !== planningJob) return;
    if (planningJob.cancelRequested) {
      state.folders = originalFolders;
      Object.assign(result, committedResult, { cancelled: true });
      transferPending = false;
      render(true); finishTransfer({ result, options }, true); return result;
    }
    const sourcePane = state.panes[options.sourceSide];
    const remaining = new Set((state.folders[options.sourcePath] || []).map(file => file.id));
    if (currentPath(sourcePane) === options.sourcePath) {
      sourcePane.selected = sourcePane.selected.filter(id => remaining.has(id) && !result.completedIds.includes(id));
      if (!remaining.has(sourcePane.cursor)) sourcePane.cursor = null;
    }
    const completion = { result, options, committedResult };
    const needsCommit = host && state.realFilesystem && JSON.stringify(state.folders) !== confirmedFolders;
    if (needsCommit) { transferCompletion = completion; document.querySelector('.transfer-progress')?.remove(); transferJob = { id: `transfer-${Date.now()}-${++transferSequence}`, hostActive: true, context: Object.freeze({ mode: options.mode, sources: Object.freeze(result.completedIds.map(id => progressSources.get(id))), target: plan.name || plan.mask ? join(targetDirectory, plan.name || plan.mask) : targetDirectory }), transfer: pendingTransfer() }; transferProgress(); }
    if (needsCommit) { completion.proposedState = clone(state); state.folders = confirmedView.folders; state.panes = confirmedView.panes; }
    transferPending = false;
    render(true);
    if (!needsCommit) finishTransfer(completion, true);
    return result;
    } catch (error) {
      if (transferJob === planningJob) state.folders = originalFolders;
      if (committedResult.completed || committedResult.completedIds.length) error.confirmedTransfer = committedResult;
      throw error;
    } finally { if (transferJob === planningJob || !transferJob || transferJob.hostActive) transferPending = false; flushFocusRefresh(); }
  }
  function transferSummary(completion) {
    const { result, options } = completion;
    return result.errors[0] || ui`${count('file', result.completed)} ${options.mode === 'move' ? t('verschoben') : t('kopiert')}, ${result.skipped} übersprungen${result.cancelled ? ui([' · Abgebrochen']) : ''}`;
  }
  function failTransferExecution(error, onComplete) {
    statusbar.finishProgress({ message: error.message, severity: window.CommanderWorkbench.Severity.Error });
    if (transferJob?.hostActive === false) { transferJob = null; transferProgress(); }
    if (state.realFilesystem) { render(true); showOperationFailure(error.message); } else toast(error.message);
    onComplete?.({ completed: 0, completedIds: [], ...error.confirmedTransfer, confirmed: Boolean(error.confirmedTransfer), errors: [error.message], cancelled: false });
  }
  function finishTransfer(completion, confirmed, error) {
    const { result, options } = completion;
    if (!error) {
      const message = transferSummary(completion);
      statusbar.finishProgress({ message }); statusbar.setStatus(message);
      if (transferJob?.hostActive === false) { transferJob = null; transferProgress(); }
    }
    const accepted = confirmed || completion.actualOutcome;
    const stable = accepted ? result : { completed: 0, completedIds: [], ...completion.committedResult };
    options.onComplete?.({ ...result, ...stable, confirmed: Boolean(accepted || stable.completed || stable.completedIds.length), ...(confirmed ? {} : { errors: [error, ...result.errors].filter(Boolean) }) });
  }
  function runZipCopy(sourceSide, sourcePath, picked, targetPath) {
    if (!picked.length) return;
    modal(t('Archiv entpacken'), `<p>${count('selectedEntry', picked.length)}</p>${zipUnpackFields(targetPath || currentPath(state.panes[1 - sourceSide]))}`, t('Entpacken'), () => {
      const target = $('#value').value.trim();
      if (state.archiveLocations?.[target]) { toast(t('Ein Zielordner ist erforderlich.')); return false; }
      const operationId = `zip-${Date.now()}-${++transferSequence}`;
      transferJob = { id: operationId, phase: 'copying', hostActive: true, context: Object.freeze({ mode: 'copy', sources: Object.freeze(picked.map(row => row.name)), target }) };
      transferProgress(); requestFilesystem({ type: 'zip-copy', operationId, path: sourcePath, ids: picked.map(row => row.id), target, ...zipUnpackOptions() });
      return true;
    });
    $('#value').required = false;
  }
  function zipUnpackFields(target, all = false) { return field(t('Zielordner'), target) + (all ? field(t('Zu entpackende Dateien'), '*.*', 'zip-filter') : '') + `<label><input id="zip-paths" type="checkbox" checked> ${t('Pfade mit entpacken')}</label><label><input id="zip-overwrite" type="checkbox"> ${t('Bestehende Dateien überschreiben')}</label>` + (all ? `<label><input id="zip-separate" type="checkbox"> ${t('Jedes Archiv in separates Verzeichnis entpacken')}</label>` : ''); }
  function zipUnpackOptions() { return { paths: $('#zip-paths').checked, overwrite: $('#zip-overwrite').checked, ...($('#zip-filter') ? { filter: $('#zip-filter').value, separate: $('#zip-separate').checked } : {}) }; }
  function sendZipWrite(request, completed) {
    if (filesystemPending) return;
    const operationId = `zip-write-${Date.now()}-${++transferSequence}`;
    const { messageType = 'zip-write', ...payload } = request;
    transferJob = { id: operationId, phase: 'preparing', hostActive: true, context: Object.freeze({ mode: 'copy', sources: Object.freeze([]), target: request.archive || request.target || displayArchivePath(request.path) || '' }) };
    transferProgress(); requestFilesystem({ type: messageType, operationId, ...payload }, completed);
  }
  function zipPack(picked, sourcePath, targetPath, move = false) {
    if (!picked.length) return;
    const targetLocation = state.archiveLocations?.[targetPath];
    const archive = targetLocation?.archive || join(targetPath, base(sourcePath) + '.zip');
    modal(t('Auswahl packen'), `<p>${count('selectedEntry', picked.length)}</p>${field(t('Archivname'), archive)}<label>${t('Kompressionsrate')}<input id="zip-level" type="number" min="0" max="9" value="6"></label><label>${t('Verschlüsselung')}<select id="zip-encryption"><option value="none">${t('Keine')}</option><option value="zipcrypto">ZIP2.0</option><option value="aes128">AES-128</option><option value="aes192">AES-192</option><option value="aes256">AES-256</option></select></label><label><input id="zip-paths" type="checkbox" checked> ${t('Pfade speichern')}</label><label><input id="zip-recursive" type="checkbox" checked> ${t('Unterverzeichnisse rekursiv speichern')}</label><label><input id="zip-move" type="checkbox" ${move ? 'checked' : ''}> ${t('Nach dem Packen Quellen entfernen')}</label>`, t('Packen'), () => {
      const destination = $('#value').value.trim();
      if (!destination) return false;
      sendZipWrite({ action: 'pack', archive: destination, ...(targetLocation && destination === archive ? { path: targetPath } : {}), sourcePath, ids: picked.map(row => row.id), level: Number($('#zip-level').value), encryption: $('#zip-encryption').value, paths: $('#zip-paths').checked, recursive: $('#zip-recursive').checked, move: $('#zip-move').checked }); return true;
    });
    $('#zip-level').value = String(fileSettings.zip?.level ?? 6);
    $('#zip-paths').checked = fileSettings.zip?.paths !== false;
    $('#zip-recursive').checked = fileSettings.zip?.recursive !== false;
  }
  function runTransfer({ sourceSide = state.active, sourcePath: providedSourcePath, ids, targetPath, mode = 'copy', onComplete, validateSelection, sourceGroups }) {
    if (filesystemPending || transferPending) return;
    if (validateSelection && !validateSelection()) return toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.'));
    const sourcePane = state.panes[sourceSide];
    const sourcePath = providedSourcePath || currentPath(sourcePane);
    if (state.archiveLocations?.[sourcePath]) {
      if (mode !== 'copy') return toast(t('Änderungen innerhalb von ZIP-Archiven sind im Pilot nicht verfügbar.'));
      const chosen = ids || (sourcePane.selected.length ? sourcePane.selected : [sourcePane.cursor]);
      const target = targetPath || currentPath(state.panes[1 - sourceSide]);
      if (state.archiveLocations?.[target]) return zipPack((state.folders[sourcePath] || []).filter(row => chosen.includes(row.id)), sourcePath, target);
      return runZipCopy(sourceSide, sourcePath, (state.folders[sourcePath] || []).filter(row => chosen.includes(row.id)), targetPath);
    }
    if (state.archiveLocations?.[targetPath || currentPath(state.panes[1 - sourceSide])]) {
      const selected = ids || (sourcePane.selected.length ? sourcePane.selected : [sourcePane.cursor]);
      return zipPack((state.folders[sourcePath] || []).filter(row => selected.includes(row.id)), sourcePath, targetPath || currentPath(state.panes[1 - sourceSide]), mode === 'move');
    }
    const pickedIds = ids || (sourcePane.selected.length ? sourcePane.selected : sourcePane.cursor ? [sourcePane.cursor] : []);
    const picked = (state.folders[sourcePath] || []).filter(file => pickedIds.includes(file.id));
    if (!picked.length) { toast(t('Zuerst eine Datei oder einen Ordner auswählen.')); onComplete?.({ confirmed: false, completed: 0, completedIds: [], errors: [], cancelled: true }); return; }
    const policies = [['ask', t('Bei Konflikten nachfragen')], ['overwrite-all', t('Alle überschreiben')], ['skip-all', t('Alle vorhandenen überspringen')], ['overwrite-older', t('Alle älteren überschreiben')], ['overwrite-older-equal', t('Alle älteren und gleich alten überschreiben')], ['rename-older-target', t('Ältere Ziele umbenennen, neuere überspringen')], ['autorename-source', t('Kopien automatisch umbenennen')], ['autorename-target', t('Vorhandene Ziele automatisch umbenennen')], ['larger', t('Nur größere Dateien kopieren')], ['smaller', t('Nur kleinere Dateien kopieren')]];
    const cancelled = () => { if ($('#modal').open) return; $('#modal').removeEventListener('close', cancelled); onComplete?.({ confirmed: false, completed: 0, completedIds: [], errors: [], cancelled: true }); };
    modal(mode === 'move' ? t('Verschieben') : t('Kopieren'), `<p id="modal-description" class="dialog-description">${count('selectedEntry', picked.length)}</p><div class="transfer-source"><span>${t('Quelle')}</span><div data-transfer-source>${escape(sourcePath)}</div></div>${field(mode === 'move' ? t('Verschieben nach') : t('Kopieren nach'), targetPath || currentPath(state.panes[1 - sourceSide]))}${field(t('Nur Dateien dieses Typs'), '*.*', 'transfer-filter')}<label><input type="checkbox" id="transfer-individual"> ${t('Jede Datei einzeln umbenennen')}</label><details class="dialog-options"><summary>${t('Optionen')}</summary><div class="field"><label for="transfer-policy">${t('Bei vorhandenen Zieldateien')}</label><select id="transfer-policy">${policies.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div><p class="dialog-hint">${t('Bei einer einzelnen Datei kann das Ziel auch einen neuen Dateinamen enthalten. Filter unterstützen * und ? sowie Ausschlüsse hinter |.')}</p></details>`, mode === 'move' ? t('Verschieben') : t('Kopieren'), () => {
      let destination = $('#value').value;
      if (sourceGroups?.length && sourceGroups.reduce((sum, group) => sum + group.ids.length, 0) > 1 && destination.trim() && !/[\\/]$/.test(destination)) destination += '/';
      if (validateSelection && !validateSelection()) { toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.')); return false; }
      try { for (const group of sourceGroups || [{ sourcePath, ids: picked.map(file => file.id) }]) window.CommanderTransfer.planTarget({ folders: state.folders, sourcePath: group.sourcePath, ids: group.ids, targetPath: destination }); }
      catch (error) { toast(error.message); return false; }
      const options = { sourceSide, sourcePath, ids: picked.map(file => file.id), targetPath: destination, mode, individualNames: $('#transfer-individual').checked, filter: $('#transfer-filter').value, policy: $('#transfer-policy').value, onComplete, validateSelection };
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
    if (sourceGroups?.length) { $('#modal-description').textContent = count('selectedEntry', sourceGroups.reduce((sum, group) => sum + group.ids.length, 0)); document.querySelector('[data-transfer-source]').textContent = sourceGroups.map(group => group.sourcePath).join('\n'); }
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
    if (filesystemPending || transferPending) return;
    if (frozen && !validDraggedFiles(frozen)) return toast(t('Die gezogene Auswahl wurde geändert. Bitte erneut ziehen.'));
    if (state.realFilesystem && kind === 'reset') return toast(t('Diese Aktion ist für das reale Dateisystem noch nicht verfügbar.'));
    const p = frozen ? state.panes[frozen.side] : pane(), source = currentPath(p), marked = selected(), picked = frozen ? files(p).filter(file => frozen.ids.includes(file.id)) : marked.length ? marked : files(p).filter(file => file.id === p.cursor);
    if (state.realFilesystem && ['pack', 'pack-move'].includes(kind)) return zipPack(picked, source, currentPath(state.panes[1 - state.active]), kind === 'pack-move');
    if (state.realFilesystem && kind === 'test-archives') return sendZipWrite({ messageType: 'zip-test', path: source, sourcePath: source, ids: picked.map(row => row.id) });
    if (state.realFilesystem && kind === 'unpack') {
      if (!picked.length || picked.some(row => !/\.zip$/i.test(row.name))) return toast(t('Zum Entpacken zuerst ein ZIP-Archiv markieren.'));
      modal(t('Archiv entpacken'), zipUnpackFields(currentPath(state.panes[1 - state.active]), true), t('Entpacken'), () => { sendZipWrite({ messageType: 'zip-unpack', sourcePath: source, ids: picked.map(row => row.id), target: $('#value').value.trim(), ...zipUnpackOptions() }); return true; }); $('#value').required = false; return;
    }
    if (state.archiveLocations?.[source] && ['delete', 'delete-alternate', 'delete-permanently'].includes(kind)) {
      if (!picked.length) return;
      return modal(t('Auswahl löschen'), `<p>${count('selectedEntry', picked.length)}</p>`, t('Löschen'), () => { sendZipWrite({ action: 'remove', path: source, ids: picked.map(row => row.id) }); return true; });
    }
    if (state.archiveLocations?.[source] && !['copy', 'swap', 'mkdir', 'new-file', 'view', 'edit'].includes(kind)) return toast(t('Diese Aktion ist innerhalb eines ZIP-Archivs nicht verfügbar.'));
    if (state.archiveLocations?.[source] && kind === 'copy') return state.archiveLocations?.[currentPath(state.panes[1 - state.active])] ? zipPack(picked, source, currentPath(state.panes[1 - state.active])) : runZipCopy(frozen?.side ?? state.active, source, picked);
    if (state.archiveLocations?.[source] && ['mkdir', 'new-file'].includes(kind)) return modal(t(kind === 'mkdir' ? 'Neuer Ordner' : 'Neue Textdatei'), field(t('Name'), ''), t('Erstellen'), () => {
      const name = $('#value').value; if (!validName(name)) return false;
      sendZipWrite({ action: kind, path: source, name }, kind === 'new-file' ? () => { const file = state.folders[source]?.find(row => row.name === name); if (file) host.postMessage({ type: 'edit', path: file.fsSource }); } : undefined); return true;
    });
    if (kind === 'reset') { state = initial(); render(true); toast(t('Beispieldaten zurückgesetzt')); return; }
    if (kind === 'swap') { state.panes.reverse(); state.active = 1 - state.active; render(true); return; }
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
          if (file && plan.openEditor) {
            const path = plan.paths[0], created = state.folders[parent(path)].find(item => item.name === base(path));
            preview(created, true);
          }
          if ((!file || !plan.openEditor) && (!state.realFilesystem || changed)) toast(t(file ? plan.paths.length === 1 ? 'Datei erstellt' : 'Dateien erstellt' : plan.paths.length === 1 ? 'Ordner erstellt' : 'Mehrere Ordner erstellt'));
        };
        const changed = JSON.stringify(state.folders) !== confirmedFolders;
        if (state.realFilesystem && changed) { filesystemResume = afterCreation; creationFailure = () => show(entered); }
        $('#modal').close(); render(true);
        if (!state.realFilesystem || !changed) afterCreation();
        return false;
      };
      const show = value => modal(t(file ? 'Neue Textdatei' : 'Neuer Ordner'), ui`<p>Erstellen in <strong>${escape(targetPath)}</strong></p>${field(t(file ? 'Dateiname' : 'Ordnername'), value)}`, t(file ? 'Datei erstellen' : 'Ordner erstellen'), create);
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
        if (state.realFilesystem) { $('#modal').close(); requestFilesystem({ type: 'filesystem-delete', paths: picked.map(file => resultView(p) ? file.fsSource : join(source, file.name)), useTrash }); return false; }
        picked.forEach(file => removeTree(join(source, file.name), file.type === 'archive'));
        state.folders[source] = files(p).filter(file => !picked.some(item => item.id === file.id)); p.selected = []; p.cursor = null; render(true); toast(state.realFilesystem ? t('Löschen wird ausgeführt') : t('Auswahl aus Beispieldaten gelöscht')); return true;
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
        files(p).push(entry(name, 'archive', Math.round(picked.reduce((sum, f) => sum + f.size, 0) * .7))); render(); toast(t('Beispielarchiv erstellt · keine echte Kompression')); return true;
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
        render(); toast(t('Beispielarchiv entpackt')); return true;
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
      const completed = () => toast(`${count('entry', picked.length)} ${t('umbenannt')}${state.realFilesystem ? '' : ui([' · Beispieldaten'])}`);
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
    if (filesystemPending || transferPending || transferJob || rightDropChoice || shellMenuPending || clipboardRequests.size || $('#modal').open || fileSearch.isOpen || document.querySelector('.inline-rename')) {
      languageReloadTimer = setTimeout(requestLanguageReload, 100);
      return;
    }
    rememberScroll();
    persist();
    document.body.inert = true;
    host.postMessage({ type: 'language-reload', state });
  }
  const statusbar = window.CommanderStatusbar.create({ t, onLanguage: () => { if (host) host.postMessage({ type: 'choose-language' }); }, version: decodeURIComponent(document.body.dataset.extensionVersion || ''), actions, onCancel: cancelTransfer, focusList: () => document.querySelectorAll('.list')[state.active]?.focus({ preventScroll: true }) });
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
    modal(t('Doppelte Dateien markieren'), `<div class="field-row">${field(t('Markieren nach Name/Erweiterung'), '*', 'duplicate-name')}${field(t('Markierung entfernen nach Name/Erweiterung'), '', 'duplicate-remove')}</div><div class="field-row">${select('duplicate-date', 'Markieren nach Datum/Zeit', dateOptions)}${select('duplicate-size', 'Markieren nach Dateigröße', sizeOptions)}</div><details class="dialog-options"><summary>${t('Markieren nach Ordner')}</summary><label><input id="duplicate-use-folders" type="checkbox"> ${t('Nur in gewählten Ordnern markieren')}</label><select id="duplicate-folders" multiple size="5" aria-label="${t('Ordner')}">${folders.map(folder => `<option value="${escape(folder)}" selected>${escape(folder)}</option>`).join('')}</select><div>${['all', 'none', 'invert'].map((key, index) => `<button type="button" data-duplicate-folders="${key}">${t(['Alle', 'Keine', 'Umkehren'][index])}</button>`).join('')}</div><label><input id="duplicate-subfolders" type="checkbox"> ${t('Auch alle Unterordner markieren')}</label>${field(t('Ordner mit Muster markieren'), '', 'duplicate-pattern')}<label><input id="duplicate-parent" type="checkbox"> ${t('Dieses Muster nur auf das direkte Vaterverzeichnis anwenden')}</label></details><label><input id="duplicate-keep-one" type="checkbox"> ${t('Mindestens eine Datei pro Gruppe nicht markieren')}</label><div class="field-row">${[1, 2, 3].map(i => select(`duplicate-keep-${i}`, `${t('Priorität')} ${i}`, keep)).join('')}</div><p class="dialog-hint">${t('Masken, reguläre Ausdrücke mit < und gespeicherte Suchen mit > werden unterstützt.')}</p><button type="button" data-duplicate-apply>${t('Anwenden')}</button>`, t('OK'), () => { applySelection(true); return false; });
    for (const id of ['duplicate-name', 'duplicate-remove', 'duplicate-pattern']) $('#' + id).required = false;
    $('#duplicate-keep-2').value = 'largest'; $('#duplicate-keep-3').value = 'first';
    $('[data-duplicate-apply]').onclick = () => applySelection(false);
    for (const button of document.querySelectorAll('[data-duplicate-folders]')) button.onclick = () => {
      for (const option of $('#duplicate-folders').options) option.selected = button.dataset.duplicateFolders === 'all' || button.dataset.duplicateFolders === 'invert' && !option.selected;
    };
  }
  function run(command) {
    if (typeof command !== 'string') return;
    if (command === 'git-branches') { if (gitDirectories.get(currentPath(pane()))?.repository) host?.postMessage({ type: 'git-branches', path: currentPath(pane()), snapshotId: state.snapshotId }); return; }
    if (command === 'licenses') { host?.postMessage({ type: 'show-licenses' }); return; }
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
    if (filesystemPending && (!transferJob || !['toggle-selection-next', 'select-all', 'clear', 'invert', 'filter', 'path', 'new-tab', 'background-tab', 'close-tab', 'next-tab', 'previous-tab'].includes(command))) return;
    if (filesystemPending && ['next-tab', 'previous-tab'].includes(command)) {
      const p = pane(), next = (p.tab + (command === 'next-tab' ? 1 : -1) + p.tabs.length) % p.tabs.length;
      if (state.unloadedFolders?.includes(p.tabs[next])) return;
    }
    if (command === 'open-trash') { if (host) host.postMessage({ type: 'open-trash' }); else toast(t('Die Papierkorbansicht ist auf diesem System nicht verfügbar.')); return; }
    if (command === 'toggle-selection-next') {
      if (!document.activeElement?.closest('.list') || document.activeElement.matches('input,textarea,select,[contenteditable="true"]') || $('#modal').open) return;
      const p = pane(), list = visible(p), index = list.findIndex(file => file.id === p.cursor);
      if (index < 0) return;
      p.selected = p.selected.includes(p.cursor) ? p.selected.filter(id => id !== p.cursor) : [...p.selected, p.cursor];
      p.cursor = list[Math.min(index + 1, list.length - 1)].id;
      rememberSelectionAnchor(p); render(true); activeRow(p.cursor)?.scrollIntoView({ block: 'nearest' }); return;
    }
    if (command === 'clipboard-copy' || command === 'clipboard-cut') { copyClipboard(command === 'clipboard-cut' ? 'move' : 'copy'); return; }
    if (command === 'clipboard-paste') { pasteClipboard(); return; }
    if (command === 'copy-same') {
      const picked = selected().length ? selected() : files(pane()).filter(item => item.id === pane().cursor);
      if (resultView(pane())) { transferResultSelection(picked, 'copy', picked.length === 1 ? picked[0].fsSource : currentPath(pane())); return; }
      runTransfer({ sourceSide: state.active, ids: picked.map(file => file.id), targetPath: picked.length === 1 ? join(currentPath(pane()), picked[0].name) : currentPath(pane()), mode: 'copy' }); return;
    }
    if (command === 'swap-paths') {
      rememberScroll(); const left = currentPath(state.panes[0]), right = currentPath(state.panes[1]);
      tabs.navigate(state.panes[0], right); tabs.navigate(state.panes[1], left); render(true); return;
    }
    if (['new-tab', 'background-tab', 'close-tab', 'next-tab', 'previous-tab', 'open-dir-tab', 'open-dir-other-tab', 'back', 'forward'].includes(command)) {
      rememberScroll(); const p = pane();
      if (command === 'new-tab' || command === 'background-tab') tabs.duplicate(p, { background: command === 'background-tab' });
      if (command === 'close-tab' && !tabs.close(p)) return toast(t('Der letzte Ordner-Tab bleibt geöffnet.'));
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
      if (host && state.realFilesystem && state.unloadedFolders?.includes(currentPath(p))) {
        requestFilesystem({ type: 'filesystem-navigate', path: currentPath(p), side: state.active }, () => render(true)); return;
      }
      render(true); return;
    }
    if (command === 'rename-one') { startRename(); return; }
    if (command === 'search-next' || command === 'search-previous') { applySearch(pane().filter, command === 'search-next' ? 1 : -1); return; }
    if (command === 'refresh') { requestedIcons.clear(); nativeIcons.clear(); if (state.realFilesystem && host) { refreshingFilesystem = true; filesystemPending = true; $('#panes').inert = true; $('#functionbar').inert = true; host.postMessage({ type: 'filesystem-refresh', state }); } else render(true); return; }
    if (command === 'path' || command === 'path-clipboard') { focusPath(command === 'path-clipboard'); return; }
    if (command === 'filter') { document.querySelectorAll('.list')[state.active].focus(); return; }
    if (command === 'select-all' || command === 'clear' || command === 'invert') {
      pane().selected = command === 'clear' ? [] : visible(pane()).filter(file => command !== 'invert' || !pane().selected.includes(file.id)).map(file => file.id); render(true);
    } else if (command === 'help') modal(t('Tastatur & Prototyp'), ui(['<p>Tab wechselt die Dateiliste. Pfeiltasten navigieren. Enter öffnet Ordner und Archive. Rücktaste geht eine Ebene nach oben. Leertaste markiert; Strg-Klick und Umschalt-Klick erweitern die Auswahl.</p><p>F3–F8 bedienen die Dateiaktionen. Strg+M öffnet das Mehrfach-Umbenennen. Alt+F5 packt, Alt+F9 entpackt.</p><p>Alle Dateiaktionen verändern ausschließlich Beispieldaten. Im VS-Code-Host öffnet F4 ein ungespeichertes Dokument. Aufruf der Erweiterung: Strg+Alt+Umschalt+F12.</p>']), null, null, t('BEDIENUNG'));
    else action(command);
  }
  document.addEventListener('click', event => {
    const target = event.target;
    if (target.closest('[data-resize]') || target.closest('.inline-rename')) return;
    clearTimeout(renameTimer);
    const section = target.closest('[data-pane]');
    if (section) {
      state.active = Number(section.dataset.pane);
      const p = pane();
      if (target.closest('[data-tab]')) {
        if (filesystemPending && state.unloadedFolders?.includes(p.tabs[Number(target.closest('[data-tab]').dataset.tab)])) return;
        rememberScroll(); tabs.activate(p, Number(target.closest('[data-tab]').dataset.tab));
        document.querySelectorAll('.pane').forEach((element, side) => {
          element.classList.toggle('active', side === state.active);
          element.querySelectorAll('.tab-wrap').forEach((tab, index) => { tab.classList.toggle('selected', index === state.panes[side].tab); tab.querySelector('[role="tab"]').setAttribute('aria-selected', String(index === state.panes[side].tab)); });
        });
        const template = document.createElement('template'); template.innerHTML = renderPane(p, state.active);
        const fresh = template.content.firstElementChild;
        for (const selector of ['.pane-label', '.pathbar', '.list', '.pane-status']) section.querySelector(selector).replaceWith(fresh.querySelector(selector));
        section.dataset.tabKey = p.tabStates[p.tab].id;
        const list = section.querySelector('.list'); list.scrollTop = p.scrollTop || 0;
        list.querySelector('table').style.width = `${p.columns.filter(column => column.visible !== false).reduce((sum, column) => sum + column.width, 0)}px`;
        list.focus({ preventScroll: true }); persist(); requestIcons(); requestGitStatus(); return;
      }
      if (target.closest('[data-new-tab]')) { run('new-tab'); return; }
      if (target.closest('[data-git-branch]')) { host?.postMessage({ type: 'git-branches', path: currentPath(p), snapshotId: state.snapshotId }); return; }
      if (target.closest('[data-favorites]')) { showFavorites(target.closest('[data-favorites]')); return; }
      if (target.closest('[data-refresh]')) { run('refresh'); return; }
      if (target.closest('[data-sort]')) { const sort = target.closest('[data-sort]').dataset.sort; p.descending = p.sort === sort ? !p.descending : false; p.sort = sort; render(true); return; }
      const row = target.closest('tr[data-id]');
      if (row) {
        const id = row.dataset.id;
        const renameClick = p.cursor === id && p.selected.includes(id) && Date.now() - lastNameClick > 500 && event.detail === 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey && target.closest('[data-filename]');
        if (event.shiftKey && p.cursor) extendSelection(p, id, event.ctrlKey || event.metaKey);
        else if (event.ctrlKey || event.metaKey) p.selected = p.selected.includes(id) ? p.selected.filter(value => value !== id) : [...p.selected, id];
        else p.selected = [id];
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
      const context = document.createElement('canvas').getContext('2d');
      context.font = getComputedStyle(section.querySelector('td')).font;
      pane().columns = columns.autoSize(pane().columns, resize.dataset.resize, files(pane()), text => context.measureText(text).width);
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
    if (filesystemPending || transferPending || rightDropChoice || $('#modal').open) return;
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
    if (!row || event.target.closest('input,textarea,select,[contenteditable="true"]') || filesystemPending || transferPending || rightDropChoice || $('#modal').open) return;
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
  document.addEventListener('contextmenu', event => { if (suppressRightContext) { suppressRightContext = false; if (event.target.closest('thead') || event.button !== 2) return; event.preventDefault(); event.stopPropagation(); } }, true);
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
  $('#functionbar').addEventListener('contextmenu', event => {
    if (!event.target.closest('[data-action="delete"]')) return;
    event.preventDefault(); event.stopPropagation();
    if (!filesystemPending && !$('#modal').open) run('open-trash');
  });
  $('#panes').addEventListener('drop', event => {
    if (!dragged) return;
    const section = event.target.closest('[data-pane]'); if (!section) return;
    event.preventDefault(); rememberScroll(); const side = Number(section.dataset.pane);
    if (dragged.kind === 'files') {
      const destination = fileDropTarget(event.target), source = dragged;
      dragged = null; clearDropTarget();
      const mode = window.CommanderTransfer.dropMode(event);
      if (mode === 'link') { toast(t('Verknüpfungen sind für diese Dateiaktion noch nicht verfügbar.')); return; }
      if (validFileDropTarget(source, destination)) runTransfer({ sourceSide: source.side, ids: source.ids, targetPath: destination.path, mode });
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
    const key = handle.dataset.resize, start = event.clientX, width = p.columns.find(column => column.key === key).width;
    handle.setPointerCapture?.(event.pointerId);
    const move = event => {
      p.columns = columns.resizeColumn(p.columns, key, width + event.clientX - start);
      [...section.querySelectorAll('[data-col]')].find(column => column.dataset.col === key).width = p.columns.find(column => column.key === key).width;
      section.querySelector('table').style.width = `${p.columns.reduce((sum, column) => sum + column.width, 0)}px`;
    };
    const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); persist(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  });
  $('#panes').addEventListener('focusin', event => { const section = event.target.closest('[data-pane]'); if (section) { state.active = Number(section.dataset.pane); refreshSelection(); lister.updateMenu(); } });
  document.addEventListener('keydown', event => {
    if (event.target.closest('[data-lister]') && !$('#modal').open) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd' && event.target.closest('.list') && !$('#modal').open) {
      event.preventDefault(); showFavorites(document.querySelectorAll('[data-favorites]')[state.active]); return;
    }
    if (event.target.closest('[data-file-search]')) return;
    if (event.key === 'F7' && event.altKey && !event.ctrlKey && !event.metaKey && event.target.closest('.list') && !$('#modal').open) { event.preventDefault(); run(event.shiftKey ? 'search-separate' : 'search'); return; }
    if (event.key === 'F2' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && resultView(pane()) && event.target.closest('.list')) { event.preventDefault(); run('search-normal'); return; }
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
      if (event.key === 'Enter' && event.target.classList.contains('path-input')) { event.preventDefault(); go(event.target.value.replace(/\/$/, '') || '/'); }
      if (event.key === 'Escape') render(true);
      return;
    }
    if (!event.target.closest('.list')) return;
    if (event.key === 'Escape' && folderSizeRequests.size) { event.preventDefault(); cancelFolderSizes(); return; }
    if (event.key === 'Enter' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!filesystemPending && !transferPending) { for (const file of visible(pane())) if (file.type === 'folder') calculateFolder(file, pane()); render(true); }
      return;
    }
    if (event.key === 'ContextMenu' && !event.ctrlKey && !event.metaKey && !event.altKey || event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); requestShellMenu(true); return; }
    if (event.key === 'Insert' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); run('toggle-selection-next'); return; }
    if (/^F\d+$/.test(event.key)) {
      const unsupported = event.ctrlKey || event.metaKey || event.altKey && (event.shiftKey || !['F3', 'F5', 'F6', 'F9'].includes(event.key)) || event.shiftKey && !event.altKey && !['F3', 'F4', 'F5', 'F6', 'F7', 'F8'].includes(event.key);
      if (unsupported) { event.preventDefault(); return; }
    }
    if ((event.ctrlKey || event.metaKey) && event.target.closest('.list')) {
      if (event.altKey) return;
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
    const keyboard = { F2: 'refresh', F3: 'view', F4: event.shiftKey ? 'new-file' : 'edit', F5: event.altKey ? 'pack' : event.shiftKey ? 'copy-same' : 'copy', F6: event.altKey ? 'unpack' : 'move', F7: event.shiftKey ? 'mkdir-other' : 'mkdir', F8: event.shiftKey ? 'delete-alternate' : 'delete', Delete: event.shiftKey ? 'delete-alternate' : 'delete', F9: event.altKey ? 'unpack' : null };
    if (keyboard[event.key]) { event.preventDefault(); run(keyboard[event.key]); return; }
    if (event.target.closest('.list') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === 'Escape' && pane().filter) { event.preventDefault(); applySearch(''); return; }
      if (event.key === 'Backspace' && pane().filter) { event.preventDefault(); applySearch(pane().filter.slice(0, -1)); return; }
      if (event.key.length === 1 && event.key !== ' ') {
        event.preventDefault(); const now = Date.now();
        const query = now - (run.lastTyped || 0) > 1600 ? event.key : pane().filter + event.key;
        run.lastTyped = now; applySearch(query); return;
      }
    }
    if (event.key === 'Tab' && event.target.closest('.list')) { event.preventDefault(); state.active = 1 - state.active; render(true); return; }
    if (event.key === 'Backspace' && event.target.closest('.list')) { event.preventDefault(); goUp(); return; }
    if (event.key === 'Enter' && event.target.closest('.list')) { event.preventDefault(); openFile(files(pane()).find(file => file.id === pane().cursor) || selected()[0]); return; }
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.target.closest('.list')) {
      event.preventDefault();
      if (filesystemPending || transferPending) return;
      const p = pane(), file = files(p).find(file => file.id === p.cursor);
      if (file) {
        const marked = p.selected.includes(file.id);
        p.selected = marked ? p.selected.filter(value => value !== file.id) : [...p.selected, file.id];
        if (!marked && file.type === 'folder' && fileSettings.countFolderSizeOnSpace !== false) calculateFolder(file, p);
      }
      render(true); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target.closest('.list')) {
      event.preventDefault(); const p = pane(), list = visible(p); if (!list.length) return;
      const old = list.findIndex(file => file.id === p.cursor);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, old + (event.key === 'ArrowDown' ? 1 : -1)));
      if (event.shiftKey) extendSelection(p, list[index].id, event.ctrlKey || event.metaKey);
      p.cursor = list[index].id;
      if (!event.shiftKey) { p.selected = [p.cursor]; rememberSelectionAnchor(p); }
      render(true); activeRow(p.cursor)?.scrollIntoView({ block: 'nearest' });
    }
  });
  $('#modal-form').addEventListener('submit', event => { event.preventDefault(); if (transferJob?.modalPreparation && filesystemPending) return; if (!confirmAction || confirmAction() !== false) $('#modal').close(); });
  $('#modal-close').onclick = $('#modal-cancel').onclick = () => { if (transferJob?.modalPreparation) { cancelTransfer(); return; } $('#modal').close(); render(!$('#modal').open); };
  $('#modal').addEventListener('cancel', event => { if (transferJob?.modalPreparation) { event.preventDefault(); cancelTransfer(); } });
  $('#modal').addEventListener('close', () => {
    if ($('#modal').open) return;
    if (operationFailureInline && document.querySelector('.inline-rename')) return;
    if (operationErrorDialog) { operationFailure = null; operationErrorDialog = false; $('#modal-body').querySelector('.operation-error')?.remove(); }
    else if (operationFailure) showOperationFailure(operationFailure);
  });
  document.body.classList.toggle('browser-preview', !host);
  function browserMenu() { modal(t('Dateimanager-Befehle'), '<div class="browser-command-list">' + [[t('Seiten tauschen'), 'swap'], [t('Packen'), 'pack'], [t('Entpacken'), 'unpack'], [t('Mehrfach-Umbenennen'), 'rename'], [t('Alle markieren'), 'select-all'], [t('Auswahl umkehren'), 'invert'], [t('Auswahl aufheben'), 'clear'], [t('Beispieldaten zurücksetzen'), 'reset'], [t('Hilfe'), 'help']].map(([label, command]) => `<button type="button" data-browser-action="${command}">${label}</button>`).join('') + '</div>', null, null); }
  function requestShellMenu(keyboard, inspectLocks = false) {
    if (!host || !state.realFilesystem || shellMenuPending || $('#modal').open) return;
    if (filesystemPending || transferPending) { toast(t('Während einer Dateioperation ist das Systemmenü nicht verfügbar.')); return; }
    const p = pane(), ids = p.selected.length ? [...p.selected] : p.cursor ? [p.cursor] : [];
    if (!ids.length) { toast(t('Für das Systemmenü zuerst eine Datei oder einen Ordner auswählen.')); return; }
    const requestId = `shell-menu-${++shellMenuSequence}`;
    shellMenuPending = { requestId };
    host.postMessage({ type: 'shell-context-menu', requestId, directory: currentPath(p), ids, snapshotId: state.snapshotId, keyboard: Boolean(keyboard), ...(inspectLocks ? { inspectLocks: true } : {}) });
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-select-error]')) { const text = $('#operation-error-text'); text.focus(); text.select(); return; }
    if (event.target.closest('[data-dismiss-error]')) { operationFailure = null; document.querySelector('.operation-error')?.remove(); if (failureFocus?.isConnected) failureFocus.focus(); return; }
    const button = event.target.closest('[data-browser-action]');
    if (button) { $('#modal').close(); run(button.dataset.browserAction); }
  });
  window.addEventListener('message', event => {
    if (host && event.data?.type === 'auxiliary-compact-check' && typeof event.data.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(event.data.requestId)) {
      auxiliaryCompactRequest = event.data.requestId; auxiliaryCompactReported = false; reportAuxiliaryCompactReady(); return;
    }
    if (host && event.data?.type === 'shell-context-menu-result') {
      if (shellMenuPending?.requestId !== event.data.requestId) return;
      shellMenuPending = null;
      if (event.data.clipboardInvalidated) { clipboardGeneration++; setClipboardSelection(null); }
      if (event.data.refreshed) focusRefreshRequested = false;
      if (!event.data.ok) showOperationFailure(event.data.error || t('Das native Systemmenü konnte nicht geöffnet werden.'));
      flushFocusRefresh(); return;
    }
    if (host && event.data?.type === 'drop-action-result') { if (rightDropChoice?.requestId !== event.data.requestId) return; if (event.data.error) { rightDropChoice = null; showOperationFailure(event.data.error); } else finishRightDrop(event.data.action, event.data.requestId); return; }
    if (host && event.data?.type === 'clipboard-result') {
      const complete = clipboardRequests.get(event.data.requestId);
      if (complete) { clipboardRequests.delete(event.data.requestId); complete(event.data); }
      return;
    }
    if (host && event.data?.type === 'action' && event.data.action === 'transfer-name-parts') { selectTransferName(event.data.key); return; }
    if (host && event.data?.type === 'action' && event.data.action === 'transfer-name-start') { startTransferName(); return; }
    if (host && event.data?.type === 'language-changed') { document.body.inert = false; requestLanguageReload(); return; }
    if (host && event.data?.type === 'language-picker-closed') { document.querySelector('#language-toggle').focus(); return; }
    if (host && event.data?.type === 'file-settings') { fileSettings = event.data.settings || {}; return; }
    if (host && event.data?.type === 'open-trash-result') { if (!event.data.ok) showOperationFailure(event.data.error || t('Der Papierkorb konnte nicht geöffnet werden.'), { inline: Boolean(document.querySelector('.inline-rename')) }); return; }
    if (host && event.data?.type === 'filesystem-progress') { if (transferJob?.id === event.data.operationId) transferProgress(event.data.progress); return; }
    if (host && event.data?.type === 'folder-size-result') {
      const result = event.data, request = folderSizeRequests.get(result.operationId);
      if (!request) return;
      folderSizeRequests.delete(result.operationId);
      if (request.snapshotId !== state.snapshotId || result.snapshotId !== request.snapshotId || result.path !== request.path) return;
      if (result.ok && Number.isSafeInteger(result.size) && result.size >= 0) { folderSizes.set(result.path, result.size); refreshFolderSizeDisplay(result.path); }
      else if (!result.cancelled) {
        const message = result.error || t('Die Ordnergröße konnte nicht ermittelt werden.');
        statusbar.error(message); statusbar.setStatus(message);
      }
      return;
    }
    if (host && event.data?.type === 'filesystem-result') {
      if (transferCheckpoint) {
        if (event.data.operationId !== transferCheckpoint.id) return;
        const checkpoint = transferCheckpoint; transferCheckpoint = null;
        checkpoint.complete(event.data); return;
      }
      if (event.data.operationId && event.data.operationId !== transferJob?.id) return;
      const pathNavigation = pendingPathNavigation; pendingPathNavigation = null;
      if (pathNavigation) pathNavigation.valid = pathNavigation.generation === pathRequestGeneration && document.activeElement === pathNavigation.input && state.active === pathNavigation.side;
      cancelFolderSizes(); folderSizes.clear();
      const readingView = (transferJob || refreshingFilesystem) && { panes: clone(state.panes), active: state.active };
      refreshingFilesystem = false;
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
      if (readingView) {
        state.active = readingView.active;
        readingView.panes.forEach((p, index) => {
          if (!p.tabs.every(path => Object.hasOwn(state.folders, path))) return;
          const valid = new Set(files(p).map(file => file.id));
          p.selected = p.selected.filter(id => valid.has(id)); if (!valid.has(p.cursor)) p.cursor = null;
          state.panes[index] = p;
        });
      }
      render(!$('#modal').open && (!pathNavigation || pathNavigation.valid));
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
      if (completedTransferJob && !continuePreparation) statusbar.finishProgress({ message: event.data.ok ? event.data.notice || (event.data.cancelled || event.data.operationOutcome?.cancelled ? t('Dateiübertragung abgebrochen.') : completion ? transferSummary(completion) : t('Dateioperation beendet')) : error, severity: event.data.ok ? undefined : window.CommanderWorkbench.Severity.Error });
      if (completion) finishTransfer(completion, Boolean(event.data.ok), event.data.ok ? undefined : error);
      else if (event.data.ok) statusbar.setStatus(event.data.notice || t('Dateisystem aktualisiert'));
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
      if (!event.data.ok) showOperationFailure(error, { inline: Boolean(failedRename && restoreRename(failedRename)) });
      flushFocusRefresh(); return;
    }
    if (host && event.data?.type === 'git-settings-changed') {
      gitSignature = ''; gitDirectories.clear(); refreshGitDisplay(); requestGitStatus(); return;
    }
    if (host && event.data?.type === 'git-status-result') {
      if (!gitRequest || event.data.requestId !== gitRequest.requestId || event.data.snapshotId !== state.snapshotId || !event.data.directories || typeof event.data.directories !== 'object') return;
      for (const directory of gitRequest.directories) {
        const info = event.data.directories[directory];
        if (info) gitDirectories.set(directory, info); else gitDirectories.delete(directory);
      }
      refreshGitDisplay(); return;
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
      gitSignature = ''; gitRequest = undefined; gitDirectories.clear();
      fileSearch.dispose();
      if (event.data.resetViews) lister.dispose();
      refreshingFilesystem = false;
      cancelFolderSizes(); folderSizes.clear();
      transferCheckpoint?.cancel(); transferCheckpoint = null;
      transferJob?.controller?.abort();
      transferJob = null; transferProgress(); statusbar.reset(); clearTimeout(toast.timer); $('#toast').classList.remove('visible');
      transferCompletion = null; transferPreparationFailure = null; transferPending = false; filesystemResume = null;
      $('#panes').inert = false; $('#functionbar').inert = false;
      if ($('#modal').open) $('#modal').close();
      state = event.data.state?.version === 1 ? event.data.state : initial();
      confirmedFolders = JSON.stringify(state.folders); filesystemPending = false;
      nextId = Math.max(Date.now(), ...Object.values(state.folders).flat().map(item => Number(item.id) + 1).filter(Number.isFinite));
      render(true); return;
    }
    if (host && event.data?.type === 'action' && typeof event.data.action === 'string') {
      if ($('#modal').open && conflictAction?.(event.data.action)) return;
      if ($('#modal').open) { toast(t('Zuerst den geöffneten Dialog schließen.')); return; }
      run(event.data.action);
    }
  });
  $('#panes').addEventListener('contextmenu', event => {
    if (event.target.closest('[data-lister]')) return;
    const section = event.target.closest('[data-pane]');
    if (!section) return;
    state.active = Number(section.dataset.pane);
    if (event.target.closest('thead')) return;
    const row = event.target.closest('tr[data-id]');
    if (row && !pane().selected.includes(row.dataset.id)) { pane().selected = [row.dataset.id]; pane().cursor = row.dataset.id; }
    refreshSelection();
    if (host && state.realFilesystem) {
      event.preventDefault(); event.stopPropagation();
      if (!row) { toast(t('Das Systemmenü für den Ordnerhintergrund ist noch nicht verfügbar.')); return; }
      requestShellMenu(false); return;
    }
    if (!host) { event.preventDefault(); browserMenu(); }
  });
  const themeObserver = new MutationObserver(() => { refreshHighlight(); refreshVisibleIcons(); });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id'] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  function reportFocus() {
    if (!host) return;
    const focused = document.activeElement;
    const viewing = Boolean(focused?.closest('.lister')) && !$('#modal').open;
    const searching = Boolean(focused?.closest('[data-file-search]'));
    const editing = searching || $('#modal').open || !viewing && Boolean(focused?.matches('input,textarea,select,[contenteditable="true"]'));
    host.postMessage({ type: 'inputFocus', search: searching, searchResults: Boolean(searching && focused?.matches('[data-search-results]')), resultTab: Boolean(resultView(pane())), lister: viewing && focused?.matches('textarea'), value: editing, list: !editing && Boolean(focused?.closest('.list')), conflict: Boolean(conflictAction && $('#modal').open), inlineRename: Boolean(focused?.matches('.inline-rename')), dialog: Boolean(searching || $('#modal').open || focused?.matches('.inline-rename') || focused?.closest('.operation-error')), transferName: Boolean($('#modal').open && focused?.matches('#value[data-transfer-name]')) });
  }
  document.addEventListener('focusin', reportFocus);
  document.addEventListener('focusout', () => queueMicrotask(reportFocus));
  $('#modal').addEventListener('close', reportFocus);
  render(true);
  window.dispatchEvent(new Event('commander-started'));
  if (host) host.postMessage({ type: 'app-ready' });
  startupReady = true;
  if (host) { reportFocus(); requestedIcons.clear(); requestIcons(); requestGitStatus(); }
  flushFocusRefresh();
})();


