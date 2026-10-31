const { catalog, columnSetFromPreferences, normalizeColumnSets, columnSetsFromTables } = require('./media/commander-column-settings');
const { favoritesFromTables, validateFavorites, validateColumns } = require('./media/configuration-model');
const { catalog: shortcutCatalog } = require('./shortcut-settings');
const { validate: validateShortcuts } = require('./media/commander-shortcuts');

function createConfigurationSettings(vscode, options) {
  let saving = false;
  const configuration = () => vscode.workspace.getConfiguration('bitfroest');
  function readFavorites(scope) {
    const settings = configuration(), scopeKey = scope === 'workspace' ? 'workspaceValue' : 'globalValue';
    const value = key => settings.inspect(key)?.[scopeKey], items = value('favorites.items');
    return Array.isArray(items) ? items.map(item => ({ ...item })) : favoritesFromTables(Object.fromEntries(['entries', 'labels', 'groups', 'targets', 'order'].map(key => [key, value(`favorites.${key}`)])));
  }
  function read(scope) {
    const settings = configuration(), scopeKey = scope === 'workspace' ? 'workspaceValue' : 'globalValue';
    const value = key => settings.inspect(key)?.[scopeKey];
    const shortcuts = value('shortcuts.bindings') || {};
    const favorites = readFavorites(scope);
    const layout = value('columns.layout');
    if (Array.isArray(layout)) return { favorites, columns: validateColumns(layout), shortcuts };
    const preferences = Object.fromEntries(catalog.flatMap(column => ['visible', 'title', 'width', 'alignment', 'position'].map(kind => [`${kind}.${column.id}`, value(`columns.${kind}.${column.id}`)])));
    const fixed = Object.values(preferences).some(item => item !== undefined);
    const tableKeys = ['names', 'fields', 'titles', 'widths', 'alignments', 'visibility', 'order'];
    const hasTables = tableKeys.some(key => value(`columns.${key}`) !== undefined);
    const defaults = Object.assign({}, ...require('./package.json').contributes.configuration.map(category => category.properties));
    const tables = Object.fromEntries(tableKeys.map(key => {
      const own = value(`columns.${key}`), fallback = defaults[`bitfroest.columns.${key}`].default;
      return [key, key === 'order' ? own ?? fallback : { ...fallback, ...own }];
    }));
    const defaultTitles = Object.fromEntries(catalog.slice(0, 5).map(column => [`standard.${column.id}`, options.t(column.title)]));
    tables.titles = { ...defaultTitles, ...value('columns.titles') };
    const oldSets = value('columns.sets');
    const legacy = !fixed && (hasTables ? columnSetsFromTables(tables, options.t) : Array.isArray(oldSets) ? normalizeColumnSets(oldSets) : null);
    const source = legacy ? (legacy.find(item => item.id === value('columns.activeSet')) || legacy[0]).columns : columnSetFromPreferences(preferences, options.t).columns;
    const columns = catalog.map(column => {
      const found = source.find(item => item.id === column.id || item.field === column.field);
      return { id: column.id, title: found?.title ?? options.t(column.title), width: found?.width ?? column.width, align: found?.align ?? column.align, visible: found ? found.visible !== false : false };
    });
    const position = id => { const index = source.findIndex(item => item.id === id || item.field === catalog.find(column => column.id === id).field); return index < 0 ? source.length + catalog.findIndex(item => item.id === id) : index; };
    columns.sort((left, right) => position(left.id) - position(right.id));
    return { favorites, columns, shortcuts };
  }
  async function write(data, scope) {
    if (saving) throw new Error(options.t('Die Konfiguration wird gerade gespeichert. Bitte erneut versuchen.'));
    if (!['user', 'workspace'].includes(scope) || scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error(options.t('Kein Arbeitsbereich geöffnet.'));
    const next = { favorites: validateFavorites(data.favorites), columns: validateColumns(data.columns) };
    next.shortcuts = validateShortcuts(shortcutCatalog, data.shortcuts || {}, process.platform);
    const inherited = scope === 'workspace' ? configuration().inspect('shortcuts.bindings')?.globalValue || {} : {};
    validateShortcuts(shortcutCatalog, { ...inherited, ...next.shortcuts }, process.platform);
    const before = read(scope), settings = configuration(), target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const scopeKey = scope === 'workspace' ? 'workspaceValue' : 'globalValue', changes = [];
    for (const [part, key] of [['favorites', 'favorites.items'], ['columns', 'columns.layout'], ['shortcuts', 'shortcuts.bindings']]) if (JSON.stringify(before[part]) !== JSON.stringify(next[part])) changes.push({ key, value: next[part], previous: settings.inspect(key)?.[scopeKey] });
    saving = true;
    const completed = [];
    try {
      for (const change of changes) { await settings.update(change.key, change.value, target); completed.push(change); }
    } catch (error) {
      for (const change of completed.reverse()) {
        try { await settings.update(change.key, change.previous, target); } catch (rollback) { throw new Error(`${error.message}\n${options.t('Der vorherige Stand konnte nicht vollständig wiederhergestellt werden.')}: ${rollback.message}`, { cause: rollback }); }
      }
      throw error;
    } finally { saving = false; }
    await options.saved();
  }
  return { read, readFavorites, write, get saving() { return saving; } };
}
module.exports = { createConfigurationSettings };
