const vscode = require('vscode');
const extensionVersion = require('./package.json').version;
const { createSelectionIO } = require('./selection-io');
const { selectStartupRoots, existingDirectories } = require('./startup-paths');
const { resolveUncPaths } = require('./network-paths');
const defaultFileColors = Object.fromEntries(require('./file-type-colors.json').flatMap(group => group.patterns.map(pattern => [pattern, group.color])));
const { createGitStatusProvider } = require('./git-status-provider');
const { allowedGitPath } = require('./git-status-paths');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePath, displayPath, identity: pathIdentity } = require('./media/commander-paths');
const crypto = require('node:crypto');
const { loadIconTheme } = require('./icon-theme');
const { getFilesystemIcons } = require('./filesystem-icons');
const { createProvider } = require('./filesystem-provider');
const { createZipFilesystem } = require('./zip-filesystem');
const { createZipEditor } = require('./zip-editor');
const { createReadonlyResources } = require('./readonly-files');
const { createClipboardProvider } = require('./clipboard-provider');
const { create } = require('./media/commander-i18n');
const { columnSetsFromTables, columnSetFromPreferences, catalog } = require('./media/commander-column-settings');
const { renderOperationError } = require('./operation-errors');
const { openTrash } = require('./open-trash');
const { openTerminal } = require('./open-terminal');
const { openAssociatedFile } = require('./open-file');
const { maximizeWindow } = require('./native-window');
const { createListerProvider } = require('./lister-provider');
const { createSearchProvider } = require('./search-provider');
const { validateSettings: validateSearchSettings } = require('./file-search');
const { createConfigurationEditor } = require('./configuration-editor');
const { createConfigurationSettings } = require('./configuration-settings');

function operationDiagnostic(error, request, state) {
  const fields = ['path', 'paths', 'target', 'archive', 'side', 'action', 'recursive', 'operationId', 'snapshotId'];
  const requestContext = { type: request.type };
  for (const key of fields) if (request[key] !== undefined) requestContext[key] = request[key];
  if (request.transfer && typeof request.transfer === 'object') {
    const transfer = {};
    for (const key of ['mode', 'sourcePath', 'sourceSide', 'targetPath']) if (request.transfer[key] !== undefined) transfer[key] = request.transfer[key];
    requestContext.transfer = transfer;
  }
  const serialize = (failure, depth = 0) => {
    if (!failure || depth > 6) return undefined;
    const result = {};
    for (const key of ['name', 'message', 'code', 'path', 'scanPhase']) {
      const value = failure[key];
      if (typeof value === 'string' || typeof value === 'number') result[key] = String(value).slice(0, 4000);
    }
    if (typeof failure.stack === 'string') result.stack = failure.stack.slice(0, 12000);
    if (failure.cause) result.cause = serialize(failure.cause, depth + 1);
    return result;
  };
  const panelPaths = (state?.panes || []).slice(0, 2).map(pane => {
    const index = Number.isInteger(pane?.tab) ? pane.tab : 0;
    return Array.isArray(pane?.tabs) && typeof pane.tabs[index] === 'string' ? pane.tabs[index].slice(0, 4096) : undefined;
  }).filter(Boolean);
  return { request: requestContext, panelPaths, timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch, osRelease: os.release(), extensionVersion, vscodeVersion: vscode.version, runtimeVersion: process.version, failure: serialize(error) };
}
const { catalog: shortcutCatalog, localizedCatalog, effectiveBindings } = require('./shortcut-settings');
const { resolve: resolveShortcut } = require('./media/commander-shortcuts');
const { favoritesToTables, validateColumns } = require('./media/configuration-model');
const { archiveEntries } = require('./search-archives');
const { createShellMenuProvider } = require('./native-shell-menu');
const { createLockInspector } = require('./lock-inspector');
const { createLicenseInformation } = require('./license-information');
const os = require('node:os');

function activate(context) {
  const displayLanguage = () => {
    const configured = vscode.workspace.getConfiguration('bitfroest').get('language', 'auto');
    return ['de', 'en'].includes(configured) ? configured : vscode.env.language;
  };
  let language = displayLanguage();
  let translator = create(language), translatedLocale = language;
  const t = (key, parameters) => {
    const locale = displayLanguage();
    if (locale !== translatedLocale) { translator = create(locale); translatedLocale = locale; }
    return translator.t(key, parameters);
  };
  async function askZipPassword({ name, attempt, signal }) {
    const token = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null;
    const cancel = () => token?.cancel(); signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) return undefined;
      return await vscode.window.showInputBox({ title: t(attempt ? 'Passwort erneut eingeben' : 'ZIP-Passwort'), prompt: name, password: true, ignoreFocusOut: true }, token?.token);
    } finally { signal?.removeEventListener('abort', cancel); token?.dispose(); }
  }
  const licenseInformation = createLicenseInformation(vscode, { extensionPath: context.extensionPath, language: displayLanguage });
  context.subscriptions.push(licenseInformation);
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.licenses', () => licenseInformation.open().catch(error => {
    vscode.window.showErrorMessage(t('Lizenzhinweise konnten nicht geöffnet werden: {error}', { error: error.message }));
  })));
  const columnSettings = () => {
    const settings = vscode.workspace.getConfiguration('bitfroest');
    const layout = settings.get('columns.layout');
    if (Array.isArray(layout) && layout.length) {
      try {
        const columns = validateColumns(layout).map(column => ({ ...catalog.find(item => item.id === column.id), ...column, title: column.title.trim() || t(catalog.find(item => item.id === column.id).title) }));
        return { sets: [{ id: 'standard', name: 'Standard', columns }], activeSet: 'standard' };
      } catch { /* Earlier settings remain available when a layout is invalid. */ }
    }
    const names = ['names', 'fields', 'titles', 'widths', 'alignments', 'visibility', 'order'];
    const configured = key => {
      if (!settings.inspect) return settings.get(key) !== undefined;
      const value = settings.inspect(key);
      return value && ['globalValue', 'workspaceValue', 'workspaceFolderValue'].some(scope => value[scope] !== undefined);
    };
    const preferenceKeys = catalog.flatMap(column => ['visible', 'width', 'alignment', 'position', 'title'].map(kind => `${kind}.${column.id}`));
    const hasFixed = preferenceKeys.some(key => configured(`columns.${key}`));
    if (hasFixed || !['sets', ...names].some(name => configured(`columns.${name}`))) {
      const preferences = Object.fromEntries(preferenceKeys.map(key => [key, settings.get(`columns.${key}`)]));
      return { sets: [columnSetFromPreferences(preferences, t)], activeSet: 'standard' };
    }
    const legacy = configured('columns.sets') && !names.some(name => configured(`columns.${name}`));
    if (legacy) return { sets: settings.get('columns.sets'), activeSet: settings.get('columns.activeSet') };
    const properties = Object.assign({}, ...require('./package.json').contributes.configuration.map(category => category.properties));
    const tables = Object.fromEntries(names.map(name => [name, settings.get(`columns.${name}`) ?? properties[`bitfroest.columns.${name}`].default]));
    if (!configured('columns.titles')) tables.titles = Object.fromEntries(['Name', 'Erweiterung', 'Größe', 'Datum', 'Attribute'].map((title, index) => [`standard.${['name', 'type', 'size', 'date', 'attributes'][index]}`, t(title)]));
    return { sets: columnSetsFromTables(tables, t), activeSet: settings.get('columns.activeSet') };
  };
  const favoriteSettings = () => {
    const settings = vscode.workspace.getConfiguration('bitfroest');
    const savedItems = settings.inspect('favorites.items');
    if (savedItems && ['globalValue', 'workspaceValue'].some(scope => savedItems[scope] !== undefined)) {
      try {
        const items = configurationData.readFavorites('user');
        const used = new Set(items.map(item => item.id));
        const workspaceItems = configurationData.readFavorites('workspace');
        const ids = new Map(workspaceItems.map(item => { let id = item.id; while (used.has(id)) id = `workspace-${id}`; used.add(id); return [item.id, id]; }));
        items.push(...workspaceItems.map(item => ({ ...item, id: ids.get(item.id), parent: item.parent ? ids.get(item.parent) : null })));
        return { ...favoritesToTables(items), items, caseSensitive: process.platform !== 'win32' };
      } catch { /* Earlier favorites remain available when the tree is invalid. */ }
    }
    const record = key => {
      const value = settings.get(`favorites.${key}`, {});
      return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([name, path]) => name.trim() && typeof path === 'string' && path.trim() && !path.includes('\0'))) : {};
    };
    const order = settings.get('favorites.order', []);
    return { caseSensitive: process.platform !== 'win32', entries: record('entries'), groups: record('groups'), labels: record('labels'), targets: record('targets'), order: Array.isArray(order) ? order.filter(name => typeof name === 'string') : [] };
  };
  let favoriteQueue = Promise.resolve();
  function toggleFavorite(directory) {
    favoriteQueue = favoriteQueue.then(async () => {
      if (typeof directory !== 'string' || !directory.trim() || directory.length > 4096 || directory.includes('\0')) return;
      const favorites = favoriteSettings();
      const identity = value => pathIdentity(value, { platform: process.platform });
      const exists = Object.values(favorites.entries).some(value => identity(value) === identity(directory));
      if (exists) {
        for (const scope of ['user', 'workspace']) {
          const data = configurationData.read(scope);
          const remaining = data.favorites.filter(item => item.type !== 'favorite' || identity(item.path) !== identity(directory));
          if (remaining.length !== data.favorites.length) await configurationData.write({ ...data, favorites: remaining }, scope);
        }
      } else {
        const settings = vscode.workspace.getConfiguration('bitfroest');
        const scope = settings.get('favorites.storage', 'user') === 'workspace' ? 'workspace' : 'user';
        let data = configurationData.read(scope);
        const duplicate = name => data.favorites.some(item => !item.parent && item.name === name.trim());
        const name = await vscode.window.showInputBox({ title: t('Favorit hinzufügen'), prompt: t('Name des Favoriten'), value: path.basename(normalizePath(directory)) || displayPath(directory),
          validateInput: value => !value.trim() ? t('Ein Name ist erforderlich.') : duplicate(value) ? t('Dieser Name ist bereits vergeben.') : undefined });
        data = configurationData.read(scope);
        if (!name?.trim() || duplicate(name)) return;
        data.favorites.push({ id: crypto.randomUUID(), type: 'favorite', name: name.trim(), path: directory, target: '', parent: null });
        await configurationData.write(data, scope);
      }
      if (panel) await panel.webview.postMessage({ type: 'favorite-settings', settings: favoriteSettings() });
    }).catch(error => { vscode.window.showErrorMessage(renderOperationError(error, t)); });
    return favoriteQueue;
  }
  const fileSettings = () => {
    const settings = vscode.workspace.getConfiguration('bitfroest');
    return { deleteToTrash: settings.get('files.deleteToTrash', true) !== false, countFolderSizeOnSpace: settings.get('files.countFolderSizeOnSpace', true) !== false, selectDirectories: settings.get('files.selectDirectories', true) !== false,
      colors: { enabled: settings.get('colors.fileTypes', true), git: settings.get('colors.gitStatus', true), rules: settings.get('colors.rules', defaultFileColors) },
      gitStatus: { iconSizePercent: settings.get('gitStatus.iconSizePercent', 66) },
      zip: { level: settings.get('zip.compressionLevel', 6), paths: settings.get('zip.storePaths', true), recursive: settings.get('zip.recursive', true), verify: settings.get('zip.verifyAfterWrite', true) } };
  };
  let panel, resetListerViews = async () => {}, resetSearchViews = () => {};
  let shortcutBindings = {}, shortcutContext = {}, shortcutSync = Promise.resolve(), shortcutsDisposed = false;
  function shortcutState() { return { catalog: localizedCatalog(displayLanguage()), bindings: shortcutBindings }; }
  function syncShortcuts() {
    shortcutSync = shortcutSync.then(async () => {
    if (shortcutsDisposed) return;
    try {
      const next = effectiveBindings(vscode.workspace.getConfiguration('bitfroest'));
      for (const id of new Set([...Object.keys(shortcutBindings), ...Object.keys(next)])) {
        if (shortcutsDisposed) return;
        if (Object.hasOwn(shortcutBindings, id) !== Object.hasOwn(next, id)) await vscode.commands.executeCommand('setContext', `bitfroest.shortcutOverride.${id}`, Object.hasOwn(next, id));
      }
      shortcutBindings = next;
      if (panel) await panel.webview.postMessage({ type: 'shortcut-settings', ...shortcutState() });
    } catch (error) { vscode.window.showErrorMessage(t(error.message)); }
    });
    return shortcutSync;
  }
  const configurationData = createConfigurationSettings(vscode, { t, saved: async () => {
    if (panel) {
      await panel.webview.postMessage({ type: 'favorite-settings', settings: favoriteSettings() });
      await panel.webview.postMessage({ type: 'column-settings', settings: columnSettings() });
    }
    await syncShortcuts();
  } });
  const configurationOptions = {
    t, read: configurationData.read, write: configurationData.write, language: displayLanguage,
    workspace: () => Boolean(vscode.workspace.workspaceFolders?.length),
    shortcutBase: requestedScope => requestedScope === 'workspace' ? vscode.workspace.getConfiguration('bitfroest').inspect('shortcuts.bindings')?.globalValue || {} : {},
    settings: () => {
      const labels = /^de/.test(displayLanguage()) ? require('./package.nls.de.json') : require('./package.nls.json');
      const label = value => typeof value === 'string' && value.startsWith('%') ? labels[value.slice(1, -1)] || value : value || '';
      return require('./package.json').contributes.configuration.flatMap(group => Object.entries(group.properties).map(([key, property]) => ({ key, title: `${label(group.title)} · ${key.replace(/^bitfroest\./, '')}`, description: label(property.markdownDescription || property.description) })));
    },
    openSetting: key => { if (require('./package.json').contributes.configuration.some(group => Object.hasOwn(group.properties, key))) return vscode.commands.executeCommand('workbench.action.openSettings', key); },
    browse: async () => { const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: t('Verzeichnis auswählen') }); return chosen?.[0]?.fsPath; }
  };
  const configurationEditor = createConfigurationEditor(vscode, context, configurationOptions);
  const initialShortcutsReady = syncShortcuts();
  context.subscriptions.push({ dispose() { shortcutsDisposed = true; for (const entry of shortcutCatalog.filter(item => item.source === 'manifest' && item.editable)) vscode.commands.executeCommand('setContext', `bitfroest.shortcutOverride.${entry.id}`, false); } });
  let searchPresetQueue = Promise.resolve();
  let panelReady = false, panelFailed = false;
  function setReady(value) {
    panelReady = value;
    vscode.commands.executeCommand('setContext', 'bitfroest.ready', value);
    if (!value) for (const key of ['textInput', 'listFocus', 'listerFocus', 'searchFocus', 'searchResultsFocus', 'searchResults', 'conflictDialog', 'transferNameInput', 'fileDialog', 'inlineRenameInput']) vscode.commands.executeCommand('setContext', `bitfroest.${key}`, false);
  }
  let opening = false, pendingOpen = Promise.resolve();
  let scope = context.workspaceState.get('tabScope', vscode.workspace.workspaceFolders?.length ? 'workspace' : 'global');
  const storage = () => scope === 'global' ? context.globalState : context.workspaceState;
  let savedState = storage().get('fileManagerState');
  const fileRoots = selectStartupRoots(process.platform === 'win32' ? ['C:/tmp', 'C:/temp'] : [path.join(os.homedir(), 'tmp'), path.join(os.homedir(), 'temp')], os.homedir());
  const favoriteRoots = () => { const settings = favoriteSettings(); return [...Object.values(settings.entries), ...Object.values(settings.targets)]; };
  const minimizeRoots = values => {
    const normalized = [...new Set(values.filter(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && !value.split(/[\\/]/).includes('..')).map(value => normalizePath(path.resolve(value), { platform: process.platform })))];
    const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalized.filter((value, index) => !normalized.some((other, otherIndex) => otherIndex !== index && (identity(value) === identity(other) ? otherIndex < index : identity(value).startsWith(`${identity(other).replace(/\/$/, '')}/`))));
  };
  const provider = createZipFilesystem(createProvider({ roots: fileRoots, additionalRoots: favoriteRoots, allowNavigationOutsideRoots: true, deletePath: (target, options) => vscode.workspace.fs.delete(vscode.Uri.file(target), options) }));
  context.subscriptions.push(provider);
  const fileClipboard = createClipboardProvider({ contains: provider.contains });
  context.subscriptions.push({ dispose: () => fileClipboard.dispose() });
  let clipboardTicket = null, filesystemRevision = 0;
  let clipboardQueue = Promise.resolve();
  const clipboardIdentity = value => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  function clipboardSourceExists(value) {
    return Object.entries(filesystemState?.folders || {}).some(([directory, rows]) => rows.some(row => clipboardIdentity(`${directory}/${row.name}`) === clipboardIdentity(value)));
  }
  let filesystemState;
  let filesystemQueue = Promise.resolve();
  let filesystemRequests = 0;
  const transferJobs = new Map();
  const searchCatalog = new Map();
  const extractedSearchFiles = new Set();
  context.subscriptions.push({ dispose() { for (const job of transferJobs.values()) job.controller.abort(); transferJobs.clear(); } });
  function knownFilePath(value) {
    return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && filesystemState && (extractedSearchFiles.has(value) || provider.contains(value) && (searchCatalog.has(value) || Object.values(filesystemState.folders).flat().some(file => file.type !== 'folder' && file.fsSource === value)));
  }
  const readonlyResources = createReadonlyResources(vscode, { validate: knownFilePath, t });
  context.subscriptions.push(readonlyResources);
  const fileSnapshot = target => Object.values(filesystemState?.folders || {}).flat().find(file => file.fsSource === target) || searchCatalog.get(target);
  const zipEditor = createZipEditor({
    read: provider.readArchiveEntry,
    confirm: async reference => (await vscode.window.showQuickPick([{ label: t('Zurückpacken'), value: 'repack' }, { label: t('Arbeitskopie behalten'), value: 'keep' }], { title: t('Geänderte Datei ins ZIP zurückpacken?'), placeHolder: reference.archiveEntry }))?.value === 'repack',
    write(reference, data, settings) {
      filesystemRequests++;
      const operation = filesystemQueue.catch(() => {}).then(async () => {
        const result = await provider.replaceArchiveEntry(reference, data, settings);
        try {
          const view = filesystemState;
          filesystemState = retainView(await loadView(view), view); await saveState(filesystemState);
          if (panel) await panel.webview.postMessage({ type: 'filesystem-result', ok: true, state: filesystemState });
        } catch (error) { error.committedResult = result; throw error; }
        return result;
      }).finally(() => { filesystemRequests--; });
      filesystemQueue = operation.catch(() => {}); return operation;
    },
    retain: target => { vscode.window.showInformationMessage(t('Bearbeitete Arbeitskopie bleibt erhalten: {path}', { path: target })); }
  });
  context.subscriptions.push({ dispose: () => { zipEditor.dispose().catch(error => vscode.window.showErrorMessage(t(error.message))); } });
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => zipEditor.saved(document.uri.fsPath).catch(error => { vscode.window.showErrorMessage(t(error.committedResult ? 'ZIP wurde gespeichert; die Nachprüfung wurde nicht abgeschlossen: {error}' : 'ZIP konnte nicht aktualisiert werden: {error}', { error: t(error.message) })); })));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => zipEditor.close(document.uri.fsPath).catch(error => { vscode.window.showErrorMessage(t(error.message)); })));
  async function openArchiveDocument(reference, currentPanel, associated = false) {
    let target;
    try {
      target = await zipEditor.open(reference, { onPassword: askZipPassword });
      if (panel !== currentPanel) { await zipEditor.close(target); return { ok: false, cancelled: true }; }
      if (associated && !(await openAssociatedFile(target)).editor) return { ok: true };
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      return { ok: true };
    } catch (error) { if (target) await zipEditor.close(target); if (error.name !== 'AbortError') vscode.window.showErrorMessage(t(error.message)); return { ok: false, cancelled: error.name === 'AbortError', error: t(error.message) }; }
  }
  function loadView(view) {
    const directories = existingDirectories([...new Set((view?.panes || []).flatMap(pane => pane.tabs || []).filter(target => typeof target === 'string' && provider.canNavigate(target)))]);
    const resultDirectories = (view?.panes || []).flatMap(p => (p.tabStates || []).flatMap(tab => tab.searchResult?.paths || [])).filter(target => typeof target === 'string' && provider.contains(target)).map(target => normalizePath(path.dirname(target)));
    directories.push(...resultDirectories.filter(target => !directories.includes(target) && fs.existsSync(target)));
    return provider.load({ directories });
  }
  function retainView(fresh, view) {
    if (!fresh || !view?.realFilesystem) return fresh;
    fresh.panes = view.panes.map((p, index) => {
      const activePath = p.tabs[p.tab];
      const pane = { ...p, tabs: p.tabs.filter(target => Object.hasOwn(fresh.folders, target)) };
      if (!pane.tabs.length) return fresh.panes[index];
      const retainedIndex = pane.tabs.indexOf(activePath);
      pane.tab = retainedIndex >= 0 ? retainedIndex : Math.min(pane.tab, pane.tabs.length - 1);
      if (pane.tabStates) pane.tabStates = pane.tabStates.filter(tab => pane.tabs.includes(tab.path));
      return pane;
    });
    fresh.active = view.active;
    return fresh;
  }
  let saveQueue = Promise.resolve();
  function saveState(state) {
    savedState = state;
    const target = storage();
    const persisted = state?.realFilesystem ? { version: 1, realFilesystem: true, active: state.active, panes: state.panes } : state;
    saveQueue = saveQueue.then(() => target.update('fileManagerState', persisted)).catch(error => vscode.window.showErrorMessage(t('Ordner-Tabs konnten nicht gespeichert werden: {error}', { error: t(error.message) })));
    return saveQueue;
  }
  const title = () => `Bitfroest.fs · ${t(scope === 'global' ? 'Global' : 'Arbeitsbereich')}`;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  status.text = '$(folder)';
  status.tooltip = t('Bitfroest.fs ein-/ausblenden (Strg+Alt+Umschalt+F12)');
  status.command = 'bitfroest.openPrototype';
  status.name = 'Bitfroest.fs';
  status.show();
  context.subscriptions.push(status);
  function updateStatus() {
    status.text = panel?.visible ? '$(folder-opened)' : '$(folder)';
  }
  function open(restoredPanel) {
    if (opening) return restoredPanel ? pendingOpen.then(() => open(restoredPanel)) : undefined;
    pendingOpen = openPanel(restoredPanel);
    return pendingOpen;
  }
  async function openPanel(restoredPanel) {
    if (panel?.visible && !restoredPanel) { panel.dispose(); return; }
    if (panel) { if (restoredPanel) restoredPanel.dispose(); else panel.reveal(); return; }
    opening = true;
    let restoredDisposed = false;
    const restoringSubscription = restoredPanel?.onDidDispose(() => { restoredDisposed = true; });
    try {
    await initialShortcutsReady;
    try {
      await filesystemQueue;
      const fresh = await loadView(savedState);
      if (fresh) { filesystemState = retainView(fresh, savedState); savedState = filesystemState; }
    } catch (error) {
      if (restoredPanel && !restoredDisposed) restoredPanel.dispose();
      vscode.window.showErrorMessage(t('Testverzeichnisse konnten nicht geladen werden: {error}', { error: t(error.message) }));
      return;
    }
    if (restoredDisposed) return;
    const icons = await loadIconTheme(vscode);
    if (restoredDisposed) return;
    if (panel) { panel.reveal(); return; }
    const webviewOptions = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), ...icons.roots]
    };
    panel = restoredPanel || vscode.window.createWebviewPanel('bitfroestPrototype', title(), vscode.ViewColumn.Active, {
      ...webviewOptions, retainContextWhenHidden: true
    });
    if (restoredPanel) panel.webview.options = webviewOptions;
    const nonce = crypto.randomBytes(18).toString('base64');
    const shellMenu = createShellMenuProvider({ get roots() { return minimizeRoots([...fileRoots, ...Object.keys(filesystemState?.folders || {}).filter(directory => !filesystemState.unloadedFolders?.includes(directory))]); } });
    const lockInspector = createLockInspector(vscode, context, {
      language: displayLanguage,
      get roots() { return minimizeRoots([...fileRoots, ...Object.keys(filesystemState?.folders || {}).filter(directory => !filesystemState.unloadedFolders?.includes(directory))]); },
      changed() { if (panel === messagePanel) messagePanel.webview.postMessage({ type: 'action', action: 'refresh' }); }
    });
    panel.onDidDispose(() => lockInspector.dispose());
    context.subscriptions.push(shellMenu);
    let shellMenuBusy = false;
    let auxiliaryMoveCompleted = Boolean(restoredPanel), auxiliaryReady = false, auxiliaryCheckSent = false, auxiliaryCompactApplied = false;
    let auxiliaryCheckId = crypto.randomUUID();
    const hasSingleEditor = () => {
      if (messagePanel.viewColumn === undefined) return false;
      const group = vscode.window.tabGroups.all.find(group => group.viewColumn === messagePanel.viewColumn);
      return group?.tabs.length === 1;
    };
    const requestAuxiliaryReady = () => {
      if (!auxiliaryMoveCompleted || !panelReady || auxiliaryCheckSent || panel !== messagePanel || !hasSingleEditor()) return;
      auxiliaryCheckSent = true;
      messagePanel.webview.postMessage({ type: 'auxiliary-compact-check', requestId: auxiliaryCheckId });
    };
    const applyCompactWhenReady = () => {
      if (!auxiliaryMoveCompleted || !panelReady || !auxiliaryReady || auxiliaryCompactApplied || panel !== messagePanel || !hasSingleEditor()) return;
      auxiliaryCompactApplied = true;
      Promise.resolve(vscode.commands.executeCommand('workbench.action.enableCompactAuxiliaryWindow')).catch(() => {});
    };
    panelFailed = false;
    setReady(false);
    const resource = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name)).toString();
    const template = fs.readFileSync(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
    const renderHtml = () => {
      language = displayLanguage();
      panel.title = title();
      status.tooltip = t('Bitfroest.fs ein-/ausblenden (Strg+Alt+Umschalt+F12)');
      panel.webview.html = template
        .replace('<!--POLICY-->', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} data:; font-src ${panel.webview.cspSource};"><style nonce="${nonce}">${icons.css(panel.webview)}</style>`)
        .replace('<body>', `<body data-shortcut-settings="${encodeURIComponent(JSON.stringify(shortcutState()))}" data-favorite-settings="${encodeURIComponent(JSON.stringify(favoriteSettings()))}" data-startup-error="${encodeURIComponent(t('Die Dateiverwaltung konnte nicht gestartet werden. Diesen Tab schließen und erneut öffnen.'))}" data-language="${encodeURIComponent(language)}" data-file-settings="${encodeURIComponent(JSON.stringify(fileSettings()))}" data-column-settings="${encodeURIComponent(JSON.stringify(columnSettings()))}" data-icon-theme="${encodeURIComponent(JSON.stringify(icons.associations))}">`)
        .replace('<body ', `<body data-platform="${process.platform}" data-extension-version="${encodeURIComponent(require('./package.json').version)}" data-initial-state="${JSON.stringify(savedState || null).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" `)
        .replace(/href="([a-z0-9-]+\.css)"/g, (_, name) => `href="${resource(name)}"`)
        .replace(/src="([a-z0-9-]+\.png)"/g, (_, name) => `src="${resource(name)}"`)
        .replace('Loading file manager…', () => t('Dateiverwaltung wird geladen…'))
        .replace(/src="([a-z0-9-]+\.js)"/g, (_, name) => `nonce="${nonce}" src="${resource(name)}"`);
    };
    renderHtml();
    panel.onDidDispose(() => { shellMenu.dispose(); for (const job of transferJobs.values()) job.controller.abort(); panel = undefined; setReady(false); vscode.commands.executeCommand('setContext', 'bitfroest.textInput', false); vscode.commands.executeCommand('setContext', 'bitfroest.listFocus', false); vscode.commands.executeCommand('setContext', 'bitfroest.conflictDialog', false); vscode.commands.executeCommand('setContext', 'bitfroest.transferNameInput', false); vscode.commands.executeCommand('setContext', 'bitfroest.fileDialog', false); vscode.commands.executeCommand('setContext', 'bitfroest.inlineRenameInput', false); updateStatus(); }, null, context.subscriptions);
    panel.onDidChangeViewState(() => { updateStatus(); updateAuxiliaryTabs(); if (panel === messagePanel && messagePanel.visible) publishGit().catch(() => {}); }, null, context.subscriptions);
    updateStatus();
    const messagePanel = panel;
    let singleEditor = hasSingleEditor();
    const updateAuxiliaryTabs = () => {
      if (panel !== messagePanel) return;
      const next = hasSingleEditor();
      if (next === singleEditor) return;
      singleEditor = next;
      auxiliaryCheckId = crypto.randomUUID();
      auxiliaryReady = false; auxiliaryCheckSent = false; auxiliaryCompactApplied = false;
      requestAuxiliaryReady();
    };
    const auxiliaryTabSubscriptions = [
      vscode.window.tabGroups.onDidChangeTabs(updateAuxiliaryTabs),
      vscode.window.tabGroups.onDidChangeTabGroups(updateAuxiliaryTabs)
    ];
    context.subscriptions.push(...auxiliaryTabSubscriptions);
    messagePanel.onDidDispose(() => auxiliaryTabSubscriptions.forEach(subscription => subscription.dispose()));
    let gitQuery, gitDisposed = false, gitUpdating = false, gitDirty = false;
    const gitSettings = () => {
      const settings = vscode.workspace.getConfiguration('bitfroest');
      return Object.fromEntries(Object.entries({ enabled: true, showClean: true, showUntracked: true, showIgnored: true, recursive: true, untrackedAsModified: false, allowNetwork: false, includePaths: [], excludePaths: [] }).map(([key, fallback]) => [key, settings.get(`gitStatus.${key}`, fallback) ?? fallback]));
    };
    const validGitPath = directory => typeof directory === 'string' && directory.length <= 4096 && !directory.includes('\0') && !directory.includes('!') && !directory.startsWith('zip:') && provider.contains(directory) && Object.hasOwn(filesystemState?.folders || {}, directory) && !filesystemState.unloadedFolders?.includes(directory);
    const gitService = createGitStatusProvider({ onChange: () => { if (messagePanel.visible) publishGit().catch(() => {}); } });
    const closeGit = () => { if (gitDisposed) return; gitDisposed = true; gitQuery = undefined; gitService.dispose(); };
    messagePanel.onDidDispose(closeGit); context.subscriptions.push({ dispose: closeGit });
    async function publishGit() {
      if (gitDisposed || !gitQuery) return;
      if (gitUpdating === gitQuery) { gitDirty = true; return; }
      gitUpdating = gitQuery;
      const query = gitQuery, settings = gitSettings();
      try {
        const allowed = query.directories.filter(directory => validGitPath(directory) && allowedGitPath(directory, settings) && (settings.allowNetwork || !/^(?:\\\\|\/\/)/.test(directory)));
        let directories = {};
        if (settings.enabled && allowed.length) directories = await gitService.inspect(allowed, settings, updates => {
          if (gitDisposed || panel !== messagePanel || gitQuery !== query || filesystemState?.snapshotId !== query.snapshotId) return;
          const filtered = Object.fromEntries(Object.entries(updates).filter(([directory]) => allowed.includes(directory)).map(([directory, info]) => [directory, { ...info, statuses: Object.fromEntries(Object.entries(info.statuses || {}).filter(([, status]) => (settings.showClean || status !== 'clean') && (settings.showUntracked || status !== 'untracked'))) }]));
          messagePanel.webview.postMessage({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, partial: true, directories: filtered }).then(undefined, () => {});
        });
        else gitService.suspend?.();
        for (const info of Object.values(directories)) if (info.statuses) {
          info.statuses = Object.fromEntries(Object.entries(info.statuses).filter(([, status]) => (settings.showClean || status !== 'clean') && (settings.showUntracked || status !== 'untracked')));
        }
        if (!gitDisposed && panel === messagePanel && gitQuery === query && filesystemState?.snapshotId === query.snapshotId) await messagePanel.webview.postMessage({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, directories });
      } catch (error) {
        if (!gitDisposed && panel === messagePanel && gitQuery === query && filesystemState?.snapshotId === query.snapshotId) await messagePanel.webview.postMessage({ type: 'git-status-result', requestId: query.requestId, snapshotId: query.snapshotId, directories: Object.fromEntries(query.directories.map(directory => [directory, { ok: false, error: error.message, statuses: {} }])) });
      } finally {
        if (gitUpdating === query) {
          gitUpdating = false;
          if (gitDirty) { gitDirty = false; publishGit().catch(() => {}); }
        }
      }
    }
    messagePanel.onDidDispose(() => provider.clear());
    const searchRoots = [...fileRoots];
    const searchService = createSearchProvider({ roots: searchRoots });
    let searchTemp, searchDisposed = false, searchGeneration = 0;
    function clearSearchTemp() { const temp = searchTemp; searchTemp = undefined; extractedSearchFiles.clear(); if (temp) Promise.resolve().then(resetListerViews).then(() => temp).then(directory => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })).catch(() => {}); }
    resetSearchViews = () => { searchGeneration++; searchService.clear(); searchCatalog.clear(); clearSearchTemp(); };
    const closeSearch = () => { searchDisposed = true; searchGeneration++; searchService.dispose(); searchCatalog.clear(); clearSearchTemp(); };
    messagePanel.onDidDispose(closeSearch); context.subscriptions.push({ dispose: closeSearch });
    async function materializeSearchEntry(value, settings = {}) {
      const generation = searchGeneration;
      const browsing = Object.values(filesystemState?.folders || {}).flat().find(row => row.archive && row.fsSource === value);
      const row = browsing || searchCatalog.get(value) || filesystemState?.panes.flatMap(p => (p.tabStates || []).flatMap(tab => tab.searchResult?.archiveRows || [])).find(row => row.fsSource === value);
      if (!row?.archive || !provider.contains(row.archive)) return value;
      if (browsing && settings.confirm !== false) {
        const choice = await vscode.window.showQuickPick([{ label: t('Anzeigen'), value: 'view' }, { label: t('Abbrechen'), value: 'cancel' }], { title: t('Datei aus ZIP anzeigen'), placeHolder: row.name });
        if (choice?.value !== 'view') throw new DOMException('Anzeigen abgebrochen.', 'AbortError');
      }
      searchTemp ||= fs.promises.mkdtemp(path.join(os.tmpdir(), 'bitfroest-search-'));
      const directory = await searchTemp;
      if (row.revision && row.archiveEntry) {
        const target = normalizePath(path.join(directory, crypto.randomUUID() + path.extname(row.name))), output = await fs.promises.open(target, 'wx', 0o600);
        try {
          for await (const chunk of provider.readArchiveEntry(row, { onPassword: async ({ name, attempt, signal }) => {
            if (searchDisposed || generation !== searchGeneration) throw new DOMException('Archivansicht wurde geschlossen.', 'AbortError');
            return askZipPassword({ name, attempt, signal });
          } })) {
            if (searchDisposed || generation !== searchGeneration) throw new Error('Die Archivansicht ist geschlossen.');
            await output.writeFile(chunk);
          }
        } catch (error) { await output.close(); await fs.promises.rm(target, { force: true }); throw error; }
        await output.close();
        if (searchDisposed || generation !== searchGeneration) { await fs.promises.rm(target, { force: true }); throw new Error('Die Archivansicht ist geschlossen.'); }
        extractedSearchFiles.add(target); searchCatalog.set(target, { ...row, fsSource: target, archive: undefined }); return target;
      }
      for await (const entry of archiveEntries(row.archive)) {
        if ((entry.archiveEntry || entry.entry) !== (row.archiveEntry || row.entry)) continue;
        if (row.revision && row.revision !== entry.revision) throw new Error('Das ZIP-Archiv wurde geändert.');
        const target = normalizePath(path.join(directory, crypto.randomUUID() + path.extname(row.name)));
        const output = await fs.promises.open(target, 'wx');
        try { try { for await (const chunk of entry.chunks()) { if (searchDisposed || generation !== searchGeneration) throw new Error('Die Dateisuche ist geschlossen.'); await output.writeFile(chunk); } } finally { await output.close(); } }
        catch (error) { await fs.promises.rm(target, { force: true }); throw error; }
        if (searchDisposed || generation !== searchGeneration) { await fs.promises.rm(target, { force: true }); throw new Error('Die Dateisuche ist geschlossen.'); }
        extractedSearchFiles.add(target); searchCatalog.set(target, { ...row, fsSource: target, archive: undefined }); return target;
      }
      throw new Error('Der Archivtreffer ist nicht mehr vorhanden.');
    }
    const lister = createListerProvider({ validate: target => provider.contains(target) || extractedSearchFiles.has(target) });
    const listerSides = new Map(), listerJobs = new Map(), listerVersions = [0, 0];
    async function closeLister(id) {
      let target; try { target = lister.path(id); } catch { /* The session may already be closed. */ }
      await lister.close(id);
      if (target && extractedSearchFiles.has(target) && ![...listerSides.values()].some(other => other !== id && lister.path(other) === target)) {
        await fs.promises.rm(target, { force: true }); extractedSearchFiles.delete(target); searchCatalog.delete(target);
      }
    }
    resetListerViews = async () => { listerVersions[0]++; listerVersions[1]++; for (const job of listerJobs.values()) job.abort(); listerJobs.clear(); const ids = [...listerSides.values()]; listerSides.clear(); await Promise.all(ids.map(closeLister)); };
    let listerDisposed = false;
    const closeListers = () => { listerDisposed = true; listerVersions[0]++; listerVersions[1]++; for (const job of listerJobs.values()) job.abort(); listerJobs.clear(); listerSides.clear(); return lister.dispose().catch(() => {}); };
    context.subscriptions.push({ dispose: closeListers });
    messagePanel.onDidDispose(closeListers);
    const selectionIO = createSelectionIO(vscode, t, () => panel === messagePanel && !listerDisposed, resolveUncPaths);
    const replyUiAction = (message, result) => {
      if (panel === messagePanel && !listerDisposed && typeof message.requestId === 'string' && /^ui-action-\d{1,15}$/.test(message.requestId)) return messagePanel.webview.postMessage({ type: 'ui-action-result', requestId: message.requestId, ...result });
    };
    panel.webview.onDidReceiveMessage(async message => {
      if (panel !== messagePanel) return;
      if (message?.type === 'selection-io') {
        if (typeof message.requestId !== 'string' || !/^selection-\d{1,15}$/.test(message.requestId)) return;
        let result;
        try { result = await selectionIO(message.action, message.text, message.pathRanges); }
        catch (error) { result = { ok: false, error: t(error.message) }; }
        if (panel === messagePanel && !listerDisposed) await messagePanel.webview.postMessage({ type: 'selection-io-result', requestId: message.requestId, ...result });
        return;
      }
      if (message?.type === 'app-startup-error') { panelFailed = true; setReady(false); return; }
      if (message?.type === 'app-ready') {
        if (!panelFailed) {
          setReady(true);
          requestAuxiliaryReady();
        }
        return;
      }
      if (message?.type === 'auxiliary-compact-ready') {
        if (message.requestId !== auxiliaryCheckId || !auxiliaryCheckSent || panel !== messagePanel) return;
        auxiliaryReady = true;
        applyCompactWhenReady();
        return;
      }
      if (!panelReady) return;
      if (message?.type === 'git-status') {
        if (typeof message.requestId !== 'string' || message.requestId.length > 100 || message.snapshotId !== filesystemState?.snapshotId || !Array.isArray(message.directories) || message.directories.length > 2 || message.directories.some(directory => !validGitPath(directory))) return;
        gitQuery = { requestId: message.requestId, snapshotId: message.snapshotId, directories: [...new Set(message.directories)] };
        await publishGit(); return;
      }
      if (message?.type === 'git-branches') {
        const settings = gitSettings();
        if (!settings.enabled || message.snapshotId !== filesystemState?.snapshotId || !validGitPath(message.path) || !allowedGitPath(message.path, settings) || !gitQuery?.directories.includes(message.path) || !settings.allowNetwork && /^(?:\\\\|\/\/)/.test(message.path)) return;
        const query = gitQuery;
        try {
          const result = await gitService.branches(message.path);
          if (!gitDisposed && panel === messagePanel && gitQuery === query && filesystemState?.snapshotId === message.snapshotId) {
            if (!result.ok) throw new Error(result.error);
            const names = [...new Set([...(result.branch ? [result.branch] : []), ...(result.names || [])])];
            const items = names.map(label => ({ label, description: t(label === result.branch ? 'Aktueller Branch' : 'Lokaler Branch') }));
            items.push(...(result.remoteNames || []).map(label => ({ label, description: t('Remote-Branch') })));
            if (result.detached) items.unshift({ label: `Detached HEAD ${String(result.head || '').slice(0, 8)}`, description: t('Aktueller Stand') });
            await vscode.window.showQuickPick(items, { title: t('Verfügbare Branches'), placeHolder: t('Branchliste (nur Anzeige)'), matchOnDescription: true });
          }
        } catch (error) { if (!gitDisposed && panel === messagePanel && gitQuery === query && filesystemState?.snapshotId === message.snapshotId) vscode.window.showWarningMessage(t('Git-Status nicht verfügbar: {error}', { error: error.message })); }
        return;
      }
      if (message?.type === 'configure-settings') { configurationEditor.open('settings'); return; }
      if (message?.type === 'shortcut-execute') {
        const entry = shortcutCatalog.find(item => item.id === message.id);
        const resolved = typeof message.key === 'string' && resolveShortcut(shortcutCatalog, shortcutBindings, message.key, shortcutContext, process.platform);
        if (panel === messagePanel && panelReady && messagePanel.active && entry?.editable && resolved?.entry?.id === entry.id && entry.source !== 'local') await vscode.commands.executeCommand(entry.command, entry.args);
        return;
      }
      if (['open-settings', 'show-licenses'].includes(message?.type)) {
        try {
          if (message.type === 'open-settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bitfroest.bitfroest-fs-prototype');
          else await licenseInformation.open();
          await replyUiAction(message, { ok: true });
        } catch (error) { await replyUiAction(message, { ok: false, error: t(error.message) }); vscode.window.showErrorMessage(t(error.message)); }
        return;
      }
      if (message?.type?.startsWith('search-')) {
        const id = message.searchId;
        const reply = data => { if (panel === messagePanel) return messagePanel.webview.postMessage({ ...data, ...(id ? { searchId: id } : {}) }); };
        try {
          if (['search-presets-load', 'search-preset-save', 'search-preset-delete', 'search-history-delete'].includes(message.type)) {
            searchPresetQueue = searchPresetQueue.catch(() => {}).then(async () => {
              const values = { ...context.globalState.get('searchPresets', {}) };
              if (message.type === 'search-history-delete') {
                if (!['name', 'searchIn', 'text'].includes(message.field) || typeof message.value !== 'string') return;
                const histories = { ...context.globalState.get('searchInputHistory', {}) };
                histories[message.field] = (histories[message.field] || []).filter(value => value !== message.value);
                await context.globalState.update('searchInputHistory', histories);
              } else if (message.type !== 'search-presets-load') {
              if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 120 || /[\r\n\0]/.test(message.name) || ['__proto__', 'constructor', 'prototype'].includes(message.name)) return;
              if (message.type === 'search-preset-save') { if (JSON.stringify(message.settings).length > 262144) return; values[message.name] = validateSearchSettings(message.settings); }
              else delete values[message.name];
              await context.globalState.update('searchPresets', values);
              }
              await reply({ type: 'search-presets', values, histories: context.globalState.get('searchInputHistory', {}) });
            });
            await searchPresetQueue; return;
          }
          if (['search-browse', 'search-drives'].includes(message.type)) {
            const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true, title: t('Suchorte wählen') });
            await reply({ type: 'search-browsed', dialogId: message.dialogId, paths: chosen?.map(uri => normalizePath(uri.fsPath, { platform: process.platform })) }); return;
          }
          if (message.type === 'search-release') { if (Array.isArray(message.ids)) for (const searchId of message.ids) searchService.release(searchId); return; }
          if (typeof id !== 'string' || !/^search-[a-f0-9]{16}-\d{1,15}$/.test(id)) return;
          if (message.type === 'search-start') {
            searchPresetQueue = searchPresetQueue.catch(() => {}).then(async () => {
              const histories = { ...context.globalState.get('searchInputHistory', {}) };
              for (const field of ['name', 'searchIn', 'text']) { const value = message.settings?.[field]; if (typeof value === 'string' && value) histories[field] = [value, ...(histories[field] || []).filter(item => item !== value)]; }
              await context.globalState.update('searchInputHistory', histories);
            });
            searchPresetQueue.catch(() => {});
            searchRoots.splice(0, searchRoots.length, ...minimizeRoots([...fileRoots, ...favoriteRoots()]));
            const result = await searchService.run(id, message.settings, { onProgress: value => reply({ type: 'search-progress', ...value }) });
            for (const row of result.results) searchCatalog.set(row.fsSource, row);
            await reply({ type: 'search-complete', ...result }); return;
          }
          if (message.type === 'search-cancel') { searchService.cancel(id); return; }
          if (message.type === 'search-skip') {
            if (typeof message.path !== 'string' || !provider.contains(message.path)) return;
            const target = fs.statSync(message.path).isDirectory() ? message.path : normalizePath(path.dirname(message.path));
            const yes = t('Überspringen');
            if (await vscode.window.showWarningMessage(t('Verzeichnis während der Suche überspringen: {path}', { path: target }), { modal: true }, yes) === yes) searchService.skip(id, target);
            return;
          }
          const results = searchService.results(id); if (!results) return;
          if (message.type === 'search-copy') { await vscode.env.clipboard.writeText(results.map(row => row.fsSource).join('\r\n')); return; }
          if (message.type === 'search-apply' || message.type === 'search-navigate') {
            const navigate = message.type === 'search-navigate';
            const selected = navigate ? results.filter(row => row.fsSource === message.path) : results;
            if (!selected.length || navigate && selected.length !== 1) return;
            const paths = [...new Set(selected.map(row => row.archive || row.fsSource))];
            if (paths.some(target => !provider.contains(target))) throw new Error('Ungültiger Suchergebnispfad.');
            const directories = [...new Set(paths.map(target => normalizePath(path.dirname(target))))];
            filesystemRequests++;
            filesystemQueue = filesystemQueue.catch(() => {}).then(async () => {
              const before = { ...filesystemState, panes: message.state?.panes || filesystemState.panes, active: message.state?.active === 1 ? 1 : 0 };
              const fresh = await provider.prepare(before, { directories, recursive: false });
              filesystemState = retainView(fresh, before); await saveState(filesystemState);
              const found = new Map(Object.values(fresh.folders).flat().map(row => [row.fsSource, row]));
              const archiveOnly = !navigate && selected.every(row => row.archive) && new Set(selected.map(row => row.archive)).size === 1;
              await reply({ type: navigate ? 'search-navigated' : 'search-applied', ok: true, state: filesystemState, results: archiveOnly ? selected : paths.map(target => found.get(target)).filter(Boolean).map(row => ({ ...row, group: selected.find(item => item.fsSource === row.fsSource)?.group })), ...(navigate ? { path: paths[0], newTab: Boolean(message.newTab) } : {}) });
            }).finally(() => { filesystemRequests--; });
            await filesystemQueue; return;
          }
        } catch (error) {
          await reply({ type: message.type === 'search-apply' ? 'search-applied' : message.type === 'search-navigate' ? 'search-navigated' : message.type === 'search-start' ? 'search-complete' : 'search-error', ok: false, error: t(error.message), results: [], errors: [] });
        }
        return;
      }
      if (message?.type === 'lister-codepage-save') {
        if (!Array.isArray(message.values) || message.values.length > 100) return;
        const values = {};
        for (const item of message.values) {
          if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80 || /[\r\n\0]/.test(item.label) || !/^\d{1,5}$/.test(item.encoding) || Number(item.encoding) > 65535) return;
          Object.defineProperty(values, item.label, { value: Number(item.encoding), enumerable: true });
        }
        try {
          for (const encoding of Object.values(values)) await lister.validateEncoding(encoding);
          await vscode.workspace.getConfiguration('bitfroest').update('lister.codepages', values, vscode.ConfigurationTarget.Global);
        } catch (error) { vscode.window.showErrorMessage(t(error.message)); }
        return;
      }
      if (message?.type === 'lister-demo-copy') {
        if (!filesystemState && typeof message.text === 'string' && message.text.length <= 100000) await vscode.env.clipboard.writeText(message.text);
        return;
      }
      if (message?.type === 'lister-cancel' || message?.type === 'lister-close') {
        if (![...listerSides.values()].includes(message.id)) return;
        listerJobs.get(message.id)?.abort(); listerJobs.delete(message.id);
        if (message.type === 'lister-close') {
          for (const [side, id] of listerSides) if (id === message.id) listerSides.delete(side);
          await closeLister(message.id);
        }
        return;
      }
      if (['lister-open', 'lister-read', 'lister-search', 'lister-copy', 'lister-link', 'lister-edit'].includes(message?.type)) {
        if (typeof message.requestId !== 'string' || !/^lister-(?:[a-f0-9]{16}-)?\d{1,15}$/.test(message.requestId)) return;
        const reply = result => { if (!listerDisposed && panel === messagePanel) return messagePanel.webview.postMessage({ type: 'lister-result', requestId: message.requestId, ...result }); };
        try {
          if (message.type === 'lister-open') {
            if (![0, 1].includes(message.side)) throw new Error('Ungültiger Lister-Pfad.');
            message.path = await materializeSearchEntry(message.path);
            if (![0, 1].includes(message.side) || !knownFilePath(message.path)) throw new Error('Ungültiger Lister-Pfad.');
            const side = message.side, version = ++listerVersions[side], previous = listerSides.get(side);
            if (previous) { listerJobs.get(previous)?.abort(); listerSides.delete(side); await closeLister(previous); }
            const result = await lister.open(message.path);
            if (listerDisposed || version !== listerVersions[side]) { await closeLister(result.id); return; }
            listerSides.set(side, result.id);
            const values = vscode.workspace.getConfiguration('bitfroest').get('lister.codepages', {});
            const codepages = Object.entries(values || {}).filter(([label, encoding]) => label.length <= 80 && Number.isInteger(encoding) && encoding >= 0 && encoding <= 65535).map(([label, encoding]) => ({ label, encoding: String(encoding) }));
            await reply({ ok: true, ...result, codepages });
          } else {
            if (![...listerSides.values()].includes(message.id)) throw new Error('Die Lister-Ansicht ist geschlossen.');
            if (message.type === 'lister-edit') {
              if (extractedSearchFiles.has(lister.path(message.id))) throw new Error('Bearbeiten von Archivtreffern ist nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.');
              await lister.validate(message.id);
              const document = await vscode.workspace.openTextDocument(vscode.Uri.file(lister.path(message.id)));
              await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
              await reply({ ok: true }); return;
            }
            if (message.type === 'lister-link') {
              if (typeof message.href !== 'string' || message.href.length > 4096 || /[\r\n\0]/.test(message.href)) throw new Error('Ungültiger Lister-Pfad.');
              if (/^https?:\/\//i.test(message.href)) { await vscode.env.openExternal(vscode.Uri.parse(message.href)); await reply({ ok: true }); }
              else {
                if (/^[a-z][a-z0-9+.-]*:/i.test(message.href) || message.href.startsWith('//') || message.href.startsWith('\\\\')) throw new Error('Ungültiger Lister-Pfad.');
                const target = normalizePath(path.resolve(path.dirname(lister.path(message.id)), decodeURIComponent(message.href)), { platform: process.platform });
                if (!provider.contains(target)) throw new Error('Ungültiger Lister-Pfad.');
                const side = [...listerSides].find(([, id]) => id === message.id)?.[0];
                const version = ++listerVersions[side];
                listerJobs.get(message.id)?.abort();
                const result = await lister.open(target);
                if (listerDisposed || side === undefined || version !== listerVersions[side] || listerSides.get(side) !== message.id) { await closeLister(result.id); await reply({ ok: false, error: t('Die Lister-Ansicht ist geschlossen.') }); return; }
                listerSides.set(side, result.id); await closeLister(message.id); await reply({ ok: true, ...result, path: target });
              }
              return;
            }
            const settings = message.settings;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Ungültige Lister-Anfrage.');
            for (const key of ['position', 'start', 'end']) if (settings[key] !== undefined && (!Number.isSafeInteger(settings[key]) || settings[key] < 0)) throw new Error('Ungültige Lister-Position.');
            if (settings.encoding !== undefined && (typeof settings.encoding !== 'string' || !/^(?:font|utf-8|utf-16le|utf-16be|\d{1,5})$/.test(settings.encoding))) throw new Error('Ungültige Codeseite.');
            if (message.type === 'lister-read') await reply({ ok: true, view: await lister.view(message.id, settings) });
            else {
              listerJobs.get(message.id)?.abort();
              const controller = new AbortController(); listerJobs.set(message.id, controller);
              try {
                if (message.type === 'lister-search') await reply({ ok: true, match: await lister.search(message.id, settings, controller.signal) });
                else {
                  const text = await lister.copy(message.id, settings, controller.signal);
                  if (controller.signal.aborted || listerDisposed) throw new Error('Suche abgebrochen.');
                  await vscode.env.clipboard.writeText(text); await reply({ ok: true });
                }
              } finally { if (listerJobs.get(message.id) === controller) listerJobs.delete(message.id); }
            }
          }
        } catch (error) { await reply({ ok: false, error: t(error.message) }); }
        return;
      }
      if (message?.type === 'clipboard-path-read') {
        if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.requestId)) return;
        const current = panel;
        let response;
        try {
          let target = (await vscode.env.clipboard.readText()).trim();
          if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
          if (!target || target.length > 4096 || /[\r\n\0]/.test(target) || !(process.platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(target) : path.isAbsolute(target))) throw new Error(t('Ungültiger Datei- oder Ordnername.'));
          target = normalizePath(target, { platform: process.platform });
          if (!provider.contains(target)) throw new Error(t('Der Pfad liegt außerhalb der erlaubten Root-Verzeichnisse.'));
          target = normalizePath(path.resolve(target), { platform: process.platform });
          if (!(await fs.promises.stat(target)).isDirectory()) throw new Error(t('Ungültiger Datei- oder Ordnername.'));
          response = { ok: true, path: target };
        } catch (error) { response = { ok: false, error: renderOperationError(error, t) }; }
        if (panel === current) await current.webview.postMessage({ type: 'clipboard-result', requestId: message.requestId, ...response });
        return;
      }
      if (message?.type === 'configure-favorites') { await vscode.commands.executeCommand('bitfroest.configureFavorites'); return; }
      if (message?.type === 'favorite-toggle') { await toggleFavorite(message.path); return; }
      if (message?.type === 'choose-language') { await chooseLanguage(); return; }
      if (message?.type === 'language-reload') {
        if (filesystemRequests || transferJobs.size || shellMenuBusy) { messagePanel.webview.postMessage({ type: 'language-changed' }); return; }
        setReady(false);
        if (message.state?.version === 1 && message.state.panes?.length === 2) await saveState(message.state);
        await saveQueue;
        for (const id of listerSides.values()) await closeLister(id);
        listerSides.clear(); listerVersions[0]++; listerVersions[1]++;
        if (panel === messagePanel) renderHtml();
        return;
      }
      if (message?.type === 'shell-context-menu') {
        if (!panel.visible || typeof message.requestId !== 'string' || message.requestId.length > 64 || !/^shell-menu-\d+$/.test(message.requestId)) return;
        const requestId = message.requestId;
        const keyboard = Boolean(message.keyboard);
        let attempted = false, invoked = false, refreshed = false, clipboardInvalidated = false, refreshAttempted = false;
        const reply = result => { if (panel === messagePanel) return messagePanel.webview.postMessage({ type: 'shell-context-menu-result', requestId, ...result }); };
        const refresh = async () => {
          refreshAttempted = true;
          const fresh = await loadView(savedState);
          if (panel !== messagePanel) return false;
          if (!fresh?.realFilesystem) throw new Error(t('Kein Dateisystem geladen.'));
          filesystemState = retainView(fresh, savedState);
          await saveState(filesystemState);
          if (panel === messagePanel) await messagePanel.webview.postMessage({ type: 'restore', state: filesystemState });
          return true;
        };
        if (shellMenuBusy || filesystemRequests || transferJobs.size) { await reply({ ok: false, error: t('Eine Dateisystemoperation läuft bereits.') }); return; }
        try {
          if (context.extensionUri.scheme !== 'file' || vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI) throw new Error(t('Das Systemmenü ist nur im lokalen Erweiterungshost verfügbar.'));
          const directory = message.directory;
          if (!filesystemState?.realFilesystem || message.snapshotId !== filesystemState.snapshotId || typeof directory !== 'string' || directory.length > 4096 || !provider.contains(directory) || !Object.hasOwn(filesystemState.folders, directory) || !savedState?.panes?.some(pane => pane.tabs[pane.tab] === directory) || !Array.isArray(message.ids) || !message.ids.length || message.ids.length > 256 || message.ids.some(id => typeof id !== 'string' || id.length > 1024) || new Set(message.ids).size !== message.ids.length) throw new Error(t('Ungültige Dateiauswahl für das Systemmenü.'));
          const rows = new Map(filesystemState.folders[directory].map(row => [row.id, row]));
          const paths = Object.freeze(message.ids.map(id => {
            const row = rows.get(id), target = row?.fsSource;
            if (!row || typeof target !== 'string' || !provider.contains(target) || clipboardIdentity(target) !== clipboardIdentity(`${directory}/${row.name}`)) throw new Error(t('Ungültige Dateiauswahl für das Systemmenü.'));
            return target;
          }));
          shellMenuBusy = true;
          try {
            await clipboardQueue;
            if (panel !== messagePanel) return;
            if (filesystemRequests || transferJobs.size) throw new Error(t('Eine Dateisystemoperation läuft bereits.'));
            attempted = true;
            const result = message.inspectLocks === true ? { action: 'inspect-locks' } : await shellMenu.show(paths, { keyboard, ownerTitle: messagePanel.title, lockInspectionLabel: t('Ordnersperren untersuchen') });
            if (panel !== messagePanel) return;
            if (result.action === 'inspect-locks') {
              if (paths.length !== 1 || rows.get(message.ids[0])?.type !== 'folder') throw new Error(t('Die Sperrenuntersuchung benötigt genau einen Ordner.'));
              lockInspector.open(paths[0]);
              await reply({ ok: true, invoked: false, cancelled: false, refreshed: false }); return;
            }
            invoked = result.invoked;
            if (invoked) {
              clipboardTicket = null; clipboardInvalidated = true;
              refreshed = await refresh();
            }
            await reply({ ok: true, invoked, cancelled: result.cancelled, refreshed, ...(clipboardInvalidated ? { clipboardInvalidated: true } : {}) });
          } finally { shellMenuBusy = false; }
        } catch (error) {
          if (attempted && panel === messagePanel && !['ENOTSUPPORTED', 'EINVAL', 'EACCESS', 'EBUSY', 'EDISPOSED'].includes(error.code)) {
            shellMenuBusy = true;
            clipboardTicket = null; clipboardInvalidated = true;
            try { if (!refreshAttempted) refreshed = await refresh(); } catch { /* Keep the last confirmed snapshot when rereading fails. */ }
            finally { shellMenuBusy = false; }
          }
          await reply({ ok: false, refreshed, ...(clipboardInvalidated ? { clipboardInvalidated: true } : {}), ...(invoked ? { invoked: true } : {}), error: invoked ? t('Das Systemmenü wurde ausgeführt, der Dateibestand konnte jedoch nicht aktualisiert werden: {error}', { error: t(error.message) }) : t(error.message) });
        }
        return;
      }
      if (message?.type === 'choose-drop-action') {
        if (panel !== messagePanel || !panel?.visible || typeof message.requestId !== 'string' || !/^right-drop-\d+$/.test(message.requestId)) return;
        try {
          const choice = await vscode.window.showQuickPick([{ label: t('Hier kopieren'), value: 'copy' }, { label: t('Hier verschieben'), value: 'move' }, { label: t('Abbrechen'), value: 'cancel' }], { title: t('Aktion für die gezogene Auswahl'), ignoreFocusOut: false });
          if (panel === messagePanel) messagePanel.webview.postMessage({ type: 'drop-action-result', requestId: message.requestId, action: choice?.value || 'cancel' });
        } catch (error) {
          if (panel === messagePanel) messagePanel.webview.postMessage({ type: 'drop-action-result', requestId: message.requestId, action: 'cancel', error: t(error.message) });
        }
        return;
      }
      if (message?.type === 'open-terminal') {
        if (!panel?.visible || !panelReady || typeof message.requestId !== 'string' || !/^ui-action-\d{1,15}$/.test(message.requestId)) return;
        try {
          const directory = message.path;
          if (typeof directory !== 'string' || directory.includes('\0') || directory.startsWith('zip:') || !provider.contains(directory) ||
              !Object.hasOwn(filesystemState?.folders || {}, directory) || filesystemState?.archiveLocations?.[directory] || filesystemState?.unloadedFolders?.includes(directory)) throw new Error('Ungültiger Ordnerpfad.');
          await openTerminal(directory, { window: vscode.window });
          await replyUiAction(message, { ok: true });
        } catch (error) {
          await replyUiAction(message, { ok: false, unsupported: error.code === 'ENOTSUPPORTED', error: t(error.code === 'NotFound' || error.code === 'ENOENT' ? 'Windows Terminal ist nicht verfügbar.' : error.message) });
        }
        return;
      }
      if (message?.type === 'open-trash') {
        if (panel !== messagePanel || !panel?.visible) return;
        try {
          await openTrash();
          if (message.requestId) await replyUiAction(message, { ok: true });
          else if (panel === messagePanel) messagePanel.webview.postMessage({ type: 'open-trash-result', ok: true });
        } catch (error) {
          if (panel !== messagePanel) return;
          const errorText = t(error.message);
          if (message.requestId) await replyUiAction(message, { ok: false, error: errorText });
          else messagePanel.webview.postMessage({ type: 'open-trash-result', ok: false, error: errorText });
          vscode.window.showErrorMessage(errorText);
        }
        return;
      }
      if (['clipboard-read', 'clipboard-write', 'clipboard-ack'].includes(message?.type)) {
        if (typeof message.requestId !== 'string' || !/^[\w-]{1,64}$/.test(message.requestId)) return;
        if (shellMenuBusy) { await messagePanel.webview.postMessage({ type: 'clipboard-result', requestId: message.requestId, ok: false, error: t('Eine Dateisystemoperation läuft bereits.') }); return; }
        const current = panel;
        clipboardQueue = clipboardQueue.then(async () => {
          await filesystemQueue;
          if (!current || panel !== current) return;
          try {
            if (!filesystemState) throw new Error(t('Kein Dateisystem geladen.'));
            let response;
            if (message.type === 'clipboard-ack') {
              const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => typeof item === 'string' && clipboardIdentity(item) === clipboardIdentity(b[index]));
              const remaining = clipboardTicket?.paths.filter(clipboardSourceExists);
              if (!clipboardTicket || clipboardTicket.mode !== 'move' || message.token !== clipboardTicket.token || message.mode !== clipboardTicket.mode || filesystemRevision <= clipboardTicket.issuedRevision || !same(message.paths, clipboardTicket.paths) || !same(message.remainingPaths, remaining)) throw new Error(t('Zwischenablage wurde nicht durch eine bestätigte Dateioperation übernommen.'));
              response = { matched: await fileClipboard.ack({ token: message.token, paths: message.paths, mode: message.mode, remainingPaths: message.remainingPaths }) };
              clipboardTicket = null;
            } else {
              if (message.type === 'clipboard-write' && (!Array.isArray(message.paths) || message.paths.length > 1024 || !message.paths.length || message.paths.some(value => typeof value !== 'string' || !clipboardSourceExists(value)))) throw new Error(t('Ungültige Datei-Zwischenablage.'));
              const selection = message.type === 'clipboard-read' ? await fileClipboard.read() : await fileClipboard.write({ paths: message.paths, mode: message.mode });
              clipboardTicket = selection ? { ...selection, issuedRevision: filesystemRevision } : null;
              response = { selection };
            }
            if (panel === current) await current.webview.postMessage({ type: 'clipboard-result', requestId: message.requestId, ok: true, ...response });
          } catch (error) {
            if (panel === current) await current.webview.postMessage({ type: 'clipboard-result', requestId: message.requestId, ok: false, unavailable: error.code === 'CLIPBOARD_UNAVAILABLE', error: t(error.message) });
          }
        });
        await clipboardQueue; return;
      }
      if (message?.type === 'filesystem-cancel') {
        const job = transferJobs.get(message.operationId); if (job?.panel === panel) job.controller.abort(); return;
      }
      if (['zip-open', 'zip-copy', 'zip-write', 'zip-unpack', 'zip-test'].includes(message?.type)) {
        const current = panel, copying = message.type !== 'zip-open', writing = message.type === 'zip-write';
        const operationId = copying && typeof message.operationId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(message.operationId) ? message.operationId : undefined;
        if (copying && (!operationId || transferJobs.has(operationId))) return;
        const job = copying ? { controller: new AbortController(), panel: current } : null;
        if (job) transferJobs.set(operationId, job);
        let pendingProgress;
        const flushProgress = () => {
          if (!pendingProgress || !job || transferJobs.get(operationId) !== job || panel !== current) return;
          const progress = pendingProgress; pendingProgress = undefined;
          job.progressAt = Date.now(); job.progressPhase = progress.phase;
          current.webview.postMessage({ type: 'filesystem-progress', operationId, progress });
        };
        filesystemRequests++;
        filesystemQueue = filesystemQueue.then(async () => {
          let ok = true, cancelled = false, error, navigation, archiveCommitted, notice;
          const view = message.state?.realFilesystem ? message.state : savedState;
          try {
            if (shellMenuBusy || !filesystemState) throw new Error('Eine Dateisystemoperation läuft bereits.');
            if (!copying) {
              if (![0, 1].includes(message.side) || !knownFilePath(message.path)) throw new Error('Dieses ZIP-Archiv ist nicht verfügbar.');
              const opened = await provider.openArchive(filesystemState, message.path);
              filesystemState = retainView(opened.state, view);
              navigation = { path: opened.path, side: message.side };
            } else {
              const settings = {
                signal: job.controller.signal,
                onPassword: async ({ name, attempt }) => {
                  const token = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null;
                  const cancel = () => token?.cancel(); job.controller.signal.addEventListener('abort', cancel, { once: true });
                  try {
                    if (job.controller.signal.aborted) return undefined;
                    return await vscode.window.showInputBox({ title: t(attempt ? 'Passwort erneut eingeben' : 'ZIP-Passwort'), prompt: name, password: true, ignoreFocusOut: true }, token?.token);
                  } finally { job.controller.signal.removeEventListener('abort', cancel); token?.dispose(); }
                },
                onProgress: progress => {
                  if (transferJobs.get(operationId) !== job || panel !== current) return;
                  pendingProgress = progress;
                  const final = progress.done || progress.totalBytes > 0 && progress.completedBytes === progress.totalBytes;
                  if (final || job.progressAt === undefined || progress.phase !== job.progressPhase || Date.now() - job.progressAt >= 50) flushProgress();
                },
                onArchiveExists: async target => {
                  const token = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null;
                  const cancel = () => token?.cancel(); job.controller.signal.addEventListener('abort', cancel, { once: true });
                  try {
                    if (job.controller.signal.aborted) return 'cancel';
                    const choice = await vscode.window.showQuickPick([{ label: t('Vorhandenes Archiv aktualisieren'), value: 'update' }, { label: t('Abbrechen'), value: 'cancel' }], { title: t('Archiv bereits vorhanden'), placeHolder: target, ignoreFocusOut: true }, token?.token);
                    return choice?.value || 'cancel';
                  } finally { job.controller.signal.removeEventListener('abort', cancel); token?.dispose(); }
                },
                onConflict: async target => {
                  const token = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null;
                  const cancel = () => token?.cancel(); job.controller.signal.addEventListener('abort', cancel, { once: true });
                  try {
                    if (job.controller.signal.aborted) return 'cancel';
                    const choice = await vscode.window.showQuickPick([{ label: t('Überschreiben'), value: 'overwrite' }, { label: t('Überspringen'), value: 'skip' }, { label: t('Abbrechen'), value: 'cancel' }], { title: t('Datei bereits vorhanden'), placeHolder: target, ignoreFocusOut: true }, token?.token);
                    return choice?.value || 'cancel';
                  } finally { job.controller.signal.removeEventListener('abort', cancel); token?.dispose(); }
                }
              };
              if (writing) {
                if (message.encryption && message.encryption !== 'none') {
                  settings.password = await settings.onPassword({ name: t('Passwort zum Verschlüsseln'), attempt: 0 });
                  if (settings.password === undefined) throw new DOMException('Passworteingabe abgebrochen.', 'AbortError');
                  const confirmation = await settings.onPassword({ name: t('Passwort bestätigen'), attempt: 0 });
                  if (confirmation === undefined) throw new DOMException('Passworteingabe abgebrochen.', 'AbortError');
                  if (confirmation !== settings.password) throw new Error('Die Passwörter stimmen nicht überein.');
                }
                const defaults = fileSettings().zip;
                await provider.writeArchive(filesystemState, { ...message, level: message.level ?? defaults.level, paths: message.paths ?? defaults.paths, recursive: message.recursive ?? defaults.recursive, verify: message.verify ?? defaults.verify }, settings);
              } else if (message.type === 'zip-unpack') await provider.unpackArchives(filesystemState, message, settings);
              else if (message.type === 'zip-test') await provider.testArchives(filesystemState, message, settings);
              else await provider.copyArchive(message, settings);
              filesystemRevision++;
            }
          } catch (failure) {
            if (failure.committedResult) { archiveCommitted = true; filesystemRevision++; notice = t('ZIP wurde gespeichert; Nachprüfung oder Quellentfernung wurde nicht abgeschlossen.'); }
            if (failure.name === 'AbortError') cancelled = true; else { ok = false; error = [notice, renderOperationError(failure, t)].filter(Boolean).join('\n'); }
          }
          finally {
            flushProgress();
            if (copying && panel === current) { try { filesystemState = retainView(await loadView(view), view); } catch (failure) { ok = false; error ||= renderOperationError(failure, t); } }
            if (job) transferJobs.delete(operationId);
          }
          if (panel === current) {
            await saveState(filesystemState);
            await current.webview.postMessage({ type: 'filesystem-result', ok, state: filesystemState, ...(operationId ? { operationId } : {}), ...(navigation && ok ? { resumeNavigation: navigation } : {}), ...(cancelled ? { cancelled: true } : {}), ...(archiveCommitted ? { archiveCommitted, notice } : {}), ...(error ? { error } : {}) });
          }
        }).finally(() => { filesystemRequests--; });
        await filesystemQueue; return;
      }
      if (message?.type === 'folder-size') {
        const current = panel, { operationId, snapshotId, path: directory } = message;
        if (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(operationId) || transferJobs.has(operationId)) return;
        const job = { controller: new AbortController(), panel: current };
        transferJobs.set(operationId, job);
        filesystemRequests++;
        filesystemQueue = filesystemQueue.then(async () => {
          let result;
          try {
            if (job.controller.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            if (shellMenuBusy || !filesystemState?.realFilesystem || snapshotId !== filesystemState.snapshotId || typeof directory !== 'string' || directory.length > 4096 || !provider.contains(directory)) throw new Error(t('Ungültiger Datei- oder Ordnername.'));
            const parent = directory.slice(0, directory.lastIndexOf('/')), name = directory.slice(directory.lastIndexOf('/') + 1);
            if (!filesystemState.folders[parent]?.some(row => row.type === 'folder' && row.name === name)) throw new Error(t('Ungültiger Datei- oder Ordnername.'));
            const size = await provider.measureFolder(filesystemState, directory, { signal: job.controller.signal });
            result = { ok: true, size };
          } catch (error) {
            result = error.name === 'AbortError' ? { ok: false, cancelled: true } : { ok: false, error: renderOperationError(error, t) };
          } finally { transferJobs.delete(operationId); }
          if (panel === current) await current.webview.postMessage({ type: 'folder-size-result', operationId, snapshotId, path: directory, ...result });
        }).finally(() => { filesystemRequests--; });
        await filesystemQueue;
        return;
      }
      if (['filesystem-apply', 'filesystem-refresh', 'filesystem-navigate', 'filesystem-prepare', 'filesystem-delete'].includes(message?.type)) {
        if (shellMenuBusy) { await messagePanel.webview.postMessage({ type: 'filesystem-result', ok: false, state: filesystemState, ...(message.operationId ? { operationId: message.operationId } : {}), error: t('Eine Dateisystemoperation läuft bereits.') }); return; }
        const current = panel;
        const operationId = (message.type === 'filesystem-apply' && message.transfer || message.type === 'filesystem-prepare') && typeof message.operationId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(message.operationId) ? message.operationId : undefined;
        if (operationId && transferJobs.has(operationId)) return;
        const job = operationId ? { controller: new AbortController(), panel: current } : null;
        if (job) transferJobs.set(operationId, job);
        const onProgress = progress => {
          if (!job || transferJobs.get(operationId) !== job || panel !== current) return;
          const now = Date.now(), phase = progress.phase === 'published' ? 'copying' : progress.phase;
          const final = progress.done || Number.isFinite(progress.totalBytes) && progress.completedBytes === progress.totalBytes;
          if (!final && job.progressAt !== undefined && phase === job.progressPhase && now - job.progressAt < 50) return;
          job.progressAt = now; job.progressPhase = phase;
          current.webview.postMessage({ type: 'filesystem-progress', operationId, progress });
        };
        filesystemRequests++;
        filesystemQueue = filesystemQueue.then(async () => {
          let ok = true;
          let cancelled = false;
          let operationError;
          let diagnostic;
          try {
            if (!filesystemState) throw new Error(t('Kein Dateisystem geladen.'));
            let fresh;
            if (message.type === 'filesystem-apply') fresh = await provider.apply(filesystemState, message.state, job ? { signal: job.controller.signal, transfer: message.transfer, onProgress } : {});
            else if (message.type === 'filesystem-delete') fresh = await provider.remove(filesystemState, { paths: message.paths, useTrash: message.useTrash });
            else if (message.type === 'filesystem-navigate' || message.type === 'filesystem-prepare') {
              const directories = message.type === 'filesystem-navigate' ? [message.path] : message.paths;
              if (!Array.isArray(directories) || directories.length > 128 || directories.some(target => typeof target !== 'string' || target.length > 4096 || !provider.canNavigate(target))) throw new Error(t('Ungültiger Datei- oder Ordnername.'));
              if (message.type === 'filesystem-navigate' && ![0, 1].includes(message.side)) throw new Error(t('Ungültiger Datei- oder Ordnername.'));
              fresh = await provider.prepare(filesystemState, { directories, recursive: message.type === 'filesystem-prepare' && message.recursive !== false, ...(job ? { signal: job.controller.signal, onProgress } : {}) });
            } else fresh = await loadView(message.state || savedState);
            filesystemState = retainView(fresh, message.state || savedState);
            if (message.type === 'filesystem-apply') filesystemRevision++;
            await saveState(filesystemState);
          } catch (error) {
            if (job && error.name === 'AbortError') cancelled = true;
            else {
            ok = false;
            diagnostic = operationDiagnostic(error, message, message.state || filesystemState);
            const detail = Number.isInteger(error.deletedCount) ? t('Löschen fehlgeschlagen nach {count} Einträgen: {error}', { count: error.deletedCount, error: renderOperationError(error.cause, t) }) : renderOperationError(error, t);
            operationError = detail;
            if (message.type !== 'filesystem-prepare') {
              try { filesystemState = retainView(await loadView(savedState), savedState); } catch { /* Preserve the last confirmed state. */ }
            }
            }
          }
          if (job) transferJobs.delete(operationId);
          if (current && panel === current) await current.webview.postMessage({ type: 'filesystem-result', ok, state: filesystemState, ...(cancelled ? { cancelled: true } : {}), ...(operationId ? { operationId, operationOutcome: filesystemState?.operationOutcome } : {}), ...(!ok ? { error: operationError, diagnostic } : {}), ...(ok && !cancelled && message.type === 'filesystem-navigate' ? { resumeNavigation: { path: message.path, side: message.side } } : {}), ...(ok && !cancelled && message.type === 'filesystem-prepare' ? { resumeAction: message.action } : {}) });
        }).finally(() => { filesystemRequests--; });
        await filesystemQueue;
        return;
      }
      if (message?.type === 'icons') {
        if (!Array.isArray(message.requests) || message.requests.length > 128) return;
        const current = panel;
        const roots = [
          ['/workspace/bitfroest', vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file' ? vscode.workspace.workspaceFolders[0].uri.fsPath : ''],
          ['/home/demo/Downloads', path.join(os.homedir(), 'Downloads')],
          ['/home/demo/Backups', path.join(os.homedir(), 'Backups')]
        ];
        const requests = message.requests.filter(item => item && ['key', 'path', 'name'].every(key => typeof item[key] === 'string' && item[key].length < (key === 'path' ? 4096 : 300) && !item[key].includes('\0')) && ['folder', 'file'].includes(item.type)).map(item => {
          let local = '';
          if (!item.path.includes('!') && !item.path.split('/').includes('..')) {
            const root = roots.find(([prefix, localRoot]) => localRoot && (item.path === prefix || item.path.startsWith(`${prefix}/`)));
            if (root) local = path.join(root[1], item.path.slice(root[0].length));
            else if (filesystemState && provider.contains(item.path)) local = item.path;
          }
          return { key: item.key, path: local, name: item.name, type: item.type };
        });
        let icons = {};
        try { icons = await getFilesystemIcons(requests); } catch { /* The view retains its fallback icons. */ }
        if (panel === current && current) await current.webview.postMessage({ type: 'icons', icons });
        return;
      }
      if (message?.type === 'inputFocus') {
        shortcutContext = { searchFocus: Boolean(message.search), searchResultsFocus: Boolean(message.searchResults && message.search), searchResults: Boolean(message.resultTab), listerFocus: Boolean(message.lister && !message.dialog), textInput: Boolean(message.value), listFocus: Boolean(message.list), conflictDialog: Boolean(message.conflict), transferNameInput: Boolean(message.transferName && message.value), fileDialog: Boolean(message.dialog), inlineRenameInput: Boolean(message.inlineRename && message.value) };
        await vscode.commands.executeCommand('setContext', 'bitfroest.searchFocus', Boolean(message.search));
        await vscode.commands.executeCommand('setContext', 'bitfroest.searchResultsFocus', Boolean(message.searchResults && message.search));
        await vscode.commands.executeCommand('setContext', 'bitfroest.searchResults', Boolean(message.resultTab));
        await vscode.commands.executeCommand('setContext', 'bitfroest.listerFocus', Boolean(message.lister && !message.dialog));
        await vscode.commands.executeCommand('setContext', 'bitfroest.textInput', Boolean(message.value));
        await vscode.commands.executeCommand('setContext', 'bitfroest.listFocus', Boolean(message.list));
        await vscode.commands.executeCommand('setContext', 'bitfroest.conflictDialog', Boolean(message.conflict));
        await vscode.commands.executeCommand('setContext', 'bitfroest.transferNameInput', Boolean(message.transferName && message.value));
        await vscode.commands.executeCommand('setContext', 'bitfroest.fileDialog', Boolean(message.dialog));
        await vscode.commands.executeCommand('setContext', 'bitfroest.inlineRenameInput', Boolean(message.inlineRename && message.value));
        return;
      }
      if (message?.type === 'state') { await saveState(message.state); return; }
      if (message?.type === 'zip-open-entry') {
        try {
          const row = fileSnapshot(message.path);
          if (!row?.archive || !provider.contains(row.archive)) return;
          await openArchiveDocument(row, messagePanel, true);
        } catch (error) { vscode.window.showErrorMessage(t(error.message)); }
        return;
      }
      if (message?.type === 'compare') {
        if (!knownFilePath(message.sourcePath) || !knownFilePath(message.targetPath)) return;
        try {
          const target = await readonlyResources.createUri(message.targetPath, fileSnapshot(message.targetPath)), source = await readonlyResources.createUri(message.sourcePath, fileSnapshot(message.sourcePath));
          await vscode.commands.executeCommand('vscode.diff', target, source, `${path.basename(message.targetPath)} (${t('Ziel')}) ↔ ${path.basename(message.sourcePath)} (${t('Quelle')})`, { viewColumn: panel?.viewColumn || vscode.ViewColumn.Active, preview: false });
        } catch (error) { await vscode.window.showErrorMessage(t('Dateivergleich fehlgeschlagen: {error}', { error: error.message })); }
        return;
      }
      if (message?.type === 'conflict-preview') {
        if (!knownFilePath(message.path)) return;
        try {
          const resource = await readonlyResources.createUri(message.path, fileSnapshot(message.path));
          const options = { viewColumn: panel?.viewColumn || vscode.ViewColumn.Active, preview: false };
          if (message.plain) await vscode.commands.executeCommand('vscode.openWith', resource, 'default', options);
          else await vscode.commands.executeCommand('vscode.open', resource, options);
          if (!message.plain && message.language === 'markdown') await vscode.commands.executeCommand('markdown.showPreview', resource);
        } catch (error) { await vscode.window.showErrorMessage(t('Dateivergleich fehlgeschlagen: {error}', { error: error.message })); }
        return;
      }
      if (message?.type === 'open') {
        if (!knownFilePath(message.path)) { await replyUiAction(message, { ok: false, error: t('Ungültiger Dateipfad.') }); return; }
        try {
          const result = await openAssociatedFile(message.path);
          if (!result.editor) { await replyUiAction(message, { ok: true }); return; }
          message = { ...message, type: 'edit' };
        } catch (error) {
          await replyUiAction(message, { ok: false, error: t(error.message) }); vscode.window.showErrorMessage(t('Datei konnte nicht geöffnet werden: {error}', { error: error.message }));
          return;
        }
      }
      if (!message || !['edit', 'preview'].includes(message.type)) return;
      const archiveReference = fileSnapshot(message.path);
      if (archiveReference?.archive && archiveReference.archiveEntry && archiveReference.revision && archiveReference.encryption && provider.contains(archiveReference.archive)) {
        await replyUiAction(message, await openArchiveDocument(archiveReference, messagePanel));
        return;
      }
      if (searchCatalog.get(message.path)?.archive || filesystemState?.panes.some(p => (p.tabStates || []).some(tab => tab.searchResult?.archiveRows?.some(row => row.fsSource === message.path)))) { const error = t('Bearbeiten von Archivtreffern ist nicht verfügbar. F3 zeigt den Inhalt schreibgeschützt an.'); await replyUiAction(message, { ok: false, error }); vscode.window.showErrorMessage(error); return; }
      const column = message.type === 'edit' ? vscode.ViewColumn.One : panel?.viewColumn || vscode.ViewColumn.Active;
      const localPath = knownFilePath(message.path) ? message.path : null;
      if (filesystemState && !localPath) { await replyUiAction(message, { ok: false, error: t('Ungültiger Dateipfad.') }); return; }
      if (!localPath && (typeof message.content !== 'string' || message.content.length > 100000)) { await replyUiAction(message, { ok: false, error: t('Ungültiger Dateipfad.') }); return; }
      try {
      const document = await vscode.workspace.openTextDocument(localPath ? vscode.Uri.file(localPath) : {
        content: message.content,
        language: message.language === 'markdown' ? 'markdown' : 'plaintext'
      });
      if (message.type === 'preview' && message.language === 'markdown') {
        await vscode.window.showTextDocument(document, { viewColumn: column, preview: false });
        await vscode.commands.executeCommand('markdown.showPreview', document.uri);
      } else {
        await vscode.window.showTextDocument(document, { viewColumn: column, preview: false });
      }
      await replyUiAction(message, { ok: true });
      } catch (error) { await replyUiAction(message, { ok: false, error: t(error.message) }); vscode.window.showErrorMessage(t(error.message)); }
    }, null, context.subscriptions);
    if (restoredPanel) return;
    const current = panel;
    const token = crypto.randomUUID();
    current.title = `${title()} [${token}]`;
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      auxiliaryMoveCompleted = true;
      requestAuxiliaryReady();
      if (process.platform === 'win32') {
        await maximizeWindow(token);
      }
    } catch (error) {
      vscode.window.showErrorMessage(t('Das Commander-Fenster konnte nicht vollständig eingerichtet werden: {error}', { error: t(error.message) }));
    } finally {
      if (panel === current) current.title = title();
    }
    } catch (error) {
      if (restoredPanel && !restoredDisposed) restoredPanel.dispose();
      throw error;
    } finally { restoringSubscription?.dispose(); opening = false; }
  }
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.openPrototype', () => open()));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.inspect-folder-locks', selection => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action: 'inspect-folder-locks', ...(selection?.webviewSection === 'folder' ? { contextSelection: { directory: selection.directory, ids: selection.ids, snapshotId: selection.snapshotId } } : {}) }); }));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('bitfroestPrototype', {
    deserializeWebviewPanel: restoredPanel => open(restoredPanel)
  }));
  for (const action of ['search', 'search-separate', 'search-normal', 'search-duplicates']) context.subscriptions.push(vscode.commands.registerCommand(`bitfroest.${action}`, () => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action }); }));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.search-key', key => { if (panel && panelReady && typeof key === 'string') panel.webview.postMessage({ type: 'action', action: `search-key:${key}` }); }));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.select-all-text', () => vscode.commands.executeCommand('editor.action.selectAll')));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.configureColumns', () => configurationEditor.open('columns')));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.configureSettings', () => configurationEditor.open('settings')));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.configureShortcuts', () => configurationEditor.open('shortcuts')));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.showLocalBranches', () => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action: 'git-branches' }); }));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.configureFavorites', () => configurationEditor.open('favorites')));
  for (const action of ['conflict-target', 'conflict-source', 'conflict-target-plain', 'conflict-source-plain', 'conflict-compare', 'conflict-compare-internal']) context.subscriptions.push(vscode.commands.registerCommand(`bitfroest.${action}`, () => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action }); }));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.transfer-name-parts', key => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action: 'transfer-name-parts', key }); }));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.transfer-name-start', () => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action: 'transfer-name-start' }); }));
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.ignore-dialog-function-key', () => undefined));
  for (const action of ['select-group', 'unselect-group', 'select-extension', 'unselect-extension', 'save-selection', 'restore-selection', 'save-selection-file', 'load-selection-file', 'copy-names', 'copy-full-names', 'copy-details', 'copy-full-details']) {
    context.subscriptions.push(vscode.commands.registerCommand(`bitfroest.${action}`, options => { if (panel && panelReady) panel.webview.postMessage({ type: 'action', action, reverseDirectories: options?.reverseDirectories === true }); }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.lister-action', action => { if (panel && panelReady && typeof action === 'string') panel.webview.postMessage({ type: 'action', action: `lister:${action}` }); }));
  for (const action of ['open-terminal', 'shell-context-menu', 'view', 'edit', 'clipboard-copy', 'clipboard-cut', 'clipboard-paste', 'copy', 'copy-same', 'move', 'mkdir', 'mkdir-other', 'new-file', 'delete', 'delete-alternate', 'delete-permanently', 'pack', 'pack-move', 'test-archives', 'unpack', 'rename', 'select-all', 'invert', 'clear', 'toggle-selection-next', 'open-trash', 'swap', 'reset', 'help', 'new-tab', 'close-tab', 'next-tab', 'previous-tab', 'refresh', 'filter', 'path', 'path-clipboard', 'background-tab', 'open-dir-tab', 'open-dir-other-tab', 'rename-one', 'back', 'forward', 'swap-paths']) {
    context.subscriptions.push(vscode.commands.registerCommand(`bitfroest.${action}`, options => {
      if (panel && panelReady) panel.webview.postMessage({ type: 'action', action, ...(options?.reverseDirectories === true ? { reverseDirectories: true } : {}) });
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.chooseTabMode', async () => {
    const chosen = await vscode.window.showQuickPick([
      { label: t('Arbeitsbereich'), description: scope === 'workspace' ? t('Aktiv') : '', detail: t('Eigene Ordner-Tabs für diesen Workspace.'), value: 'workspace' },
      { label: t('Global'), description: scope === 'global' ? t('Aktiv') : '', detail: t('Gemeinsame Ordner-Tabs für alle Workspaces auf diesem Rechner.'), value: 'global' }
    ], { title: t('Ordner-Tabs speichern'), placeHolder: t('Arbeitsbereich oder Global') });
    if (!chosen || chosen.value === scope) return;
    await saveQueue;
    scope = chosen.value;
    provider.clear();
    await context.workspaceState.update('tabScope', scope);
    const nextState = storage().get('fileManagerState', savedState);
    const restored = filesystemState ? retainView(await loadView(nextState), nextState) : nextState;
    if (filesystemState) filesystemState = restored;
    await saveState(restored);
    await resetListerViews();
    resetSearchViews();
    if (panel) { panel.title = title(); await panel.webview.postMessage({ type: 'restore', resetViews: true, state: restored }); }
  }));
  let languagePickerOpen = false;
  function notifyLanguageChange() {
    panel?.webview.postMessage({ type: create(language).language === create(displayLanguage()).language ? 'language-picker-closed' : 'language-changed' });
  }
  async function chooseLanguage() {
    if (languagePickerOpen) return;
    languagePickerOpen = true;
    try {
      const defaultLanguage = create(vscode.env.language).language;
      const current = create(displayLanguage()).language;
      const items = [['de', 'Deutsch'], ['en', 'English']].map(([value, name]) => ({
        value,
        label: `${value === defaultLanguage ? '$(star-full) ' : ''}${name}`,
        description: [value === defaultLanguage ? t('Standard · Visual Studio Code') : '', value === current ? t('Aktiv') : ''].filter(Boolean).join(' · ')
      }));
      const chosen = await vscode.window.showQuickPick(items, { title: t('Sprache wechseln'), placeHolder: t('Standardsprache mit Stern gekennzeichnet') });
      if (!chosen) { panel?.webview.postMessage({ type: 'language-picker-closed' }); return; }
      await vscode.workspace.getConfiguration('bitfroest').update('language', chosen.value === defaultLanguage ? 'auto' : chosen.value, vscode.ConfigurationTarget.Global);
      notifyLanguageChange();
    } catch (error) {
      panel?.webview.postMessage({ type: 'language-picker-closed' });
      vscode.window.showErrorMessage(t('Sprache konnte nicht gespeichert werden: {error}', { error: error.message }));
    } finally { languagePickerOpen = false; }
  }
  context.subscriptions.push(vscode.commands.registerCommand('bitfroest.chooseLanguage', chooseLanguage));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
    const gitBehaviorChanged = ['enabled', 'showClean', 'showUntracked', 'showIgnored', 'recursive', 'untrackedAsModified', 'allowNetwork', 'includePaths', 'excludePaths'].some(key => event.affectsConfiguration(`bitfroest.gitStatus.${key}`));
    if (event.affectsConfiguration('bitfroest.gitStatus') && (!event.affectsConfiguration('bitfroest.gitStatus.iconSizePercent') || gitBehaviorChanged) && panel) await panel.webview.postMessage({ type: 'git-settings-changed' });
    if (configurationData.saving && (event.affectsConfiguration('bitfroest.columns') || event.affectsConfiguration('bitfroest.favorites'))) return;
    if (event.affectsConfiguration('bitfroest.columns') || event.affectsConfiguration('bitfroest.favorites') || event.affectsConfiguration('bitfroest.shortcuts')) { configurationEditor.changed(); }
    if (event.affectsConfiguration('bitfroest.shortcuts')) await syncShortcuts();
    if (event.affectsConfiguration('bitfroest.language')) notifyLanguageChange();
    if ((event.affectsConfiguration('bitfroest.files') || event.affectsConfiguration('bitfroest.zip') || event.affectsConfiguration('bitfroest.colors') || event.affectsConfiguration('bitfroest.gitStatus.iconSizePercent')) && panel) await panel.webview.postMessage({ type: 'file-settings', settings: fileSettings() });
    if (event.affectsConfiguration('bitfroest.columns') && panel) await panel.webview.postMessage({ type: 'column-settings', settings: columnSettings() });
    if (event.affectsConfiguration('bitfroest.favorites') && panel) await panel.webview.postMessage({ type: 'favorite-settings', settings: favoriteSettings() });
    if (!event.affectsConfiguration('workbench.iconTheme') || !panel) return;
    await saveQueue;
    panel.dispose();
    await open();
  }));
}

module.exports = { activate };



