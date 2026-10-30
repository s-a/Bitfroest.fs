(function (root, factory) {
  const columns = typeof module === 'object' && module.exports ? require('./commander-column-settings') : root.CommanderColumnSettings;
  const api = factory(columns);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ConfigurationModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function (columns) {
  'use strict';
  const absolute = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value) && !value.split(/[\\/]/).includes('..');
  function validateHierarchy(nodes) {
    const ids = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      const seen = new Set([node.id]); let parent = node.parent;
      while (parent) {
        if (seen.has(parent)) throw new Error('Eine Gruppe darf nicht in ihre eigene Untergruppe verschoben werden.');
        const ancestor = ids.get(parent);
        if (ancestor?.type !== 'group') throw new Error('Die übergeordnete Gruppe ist ungültig.');
        seen.add(parent); parent = ancestor.parent;
      }
    }
  }
  function validateFavorites(input) {
    if (!Array.isArray(input)) throw new Error('Ungültige Favoritenliste.');
    const ids = new Map();
    const nodes = input.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !['favorite', 'group'].includes(item.type) || typeof item.name !== 'string' || !item.name.trim() || item.name.includes('\0')) throw new Error('Jeder Eintrag benötigt einen eindeutigen Namen.');
      if (item.type === 'group' && item.name.includes('/')) throw new Error('Gruppennamen dürfen keinen Schrägstrich enthalten.');
      if (item.type === 'favorite' && (!absolute(item.path) || item.target && !absolute(item.target))) throw new Error('Ein gültiger absoluter Verzeichnispfad ist erforderlich.');
      const result = { id: item.id, type: item.type, name: item.name.trim(), parent: item.parent || null };
      if (item.type === 'favorite') Object.assign(result, { path: item.path, target: item.target || '' });
      ids.set(result.id, result); return result;
    });
    validateHierarchy(nodes);
    return nodes;
  }
  function favoritesFromTables(tables = {}) {
    const nodes = [], groups = new Map(), entries = tables.entries || {};
    let sequence = 0;
    const names = [...new Set([...(tables.order || []), ...Object.keys(entries)])].filter(key => Object.hasOwn(entries, key));
    for (const key of names) {
      let parent = null, location = '';
      for (const name of String(tables.groups?.[key] || '').split('/').filter(Boolean)) {
        location += `/${name}`;
        if (!groups.has(location)) { const id = `group-${++sequence}`; groups.set(location, id); nodes.push({ id, name, type: 'group', parent }); }
        parent = groups.get(location);
      }
      nodes.push({ id: `favorite-${++sequence}`, type: 'favorite', name: tables.labels?.[key] || key, parent, path: entries[key], target: tables.targets?.[key] || '' });
    }
    return nodes;
  }
  function favoritesToTables(input) {
    const nodes = validateFavorites(input), byId = new Map(nodes.map(item => [item.id, item]));
    const result = { entries: {}, labels: {}, groups: {}, targets: {}, order: [], groupPaths: [] };
    const groupPath = node => { const names = []; let parent = node.parent; while (parent) { const group = byId.get(parent); names.unshift(group.name); parent = group.parent; } return names.join('/'); };
    for (const node of nodes) {
      if (node.type === 'group') { result.groupPaths.push([groupPath(node), node.name].filter(Boolean).join('/')); continue; }
      result.entries[node.id] = node.path; result.labels[node.id] = node.name; result.order.push(node.id);
      const group = groupPath(node); if (group) result.groups[node.id] = group;
      if (node.target) result.targets[node.id] = node.target;
    }
    return result;
  }
  function moveFavorite(input, id, parent, before) {
    const nodes = input.map(item => ({ ...item })), index = nodes.findIndex(item => item.id === id);
    if (index < 0) return nodes;
    const [node] = nodes.splice(index, 1); node.parent = parent || null;
    const position = before ? nodes.findIndex(item => item.id === before) : -1;
    nodes.splice(position < 0 ? nodes.length : position, 0, node);
    validateHierarchy(nodes);
    return nodes;
  }
  function validateColumns(input) {
    if (!Array.isArray(input) || input.length !== columns.catalog.length || new Set(input.map(item => item?.id)).size !== columns.catalog.length) throw new Error('Der vollständige Spaltenkatalog ist erforderlich.');
    return input.map(item => {
      if (!columns.catalog.some(column => column.id === item.id)) throw new Error('Unbekannte Spalte.');
      if (!Number.isInteger(item.width) || item.width < 32 || item.width > 1600) throw new Error('Die Breite muss zwischen 32 und 1600 Pixeln liegen.');
      if (!['left', 'right', 'center'].includes(item.align) || typeof item.visible !== 'boolean' || typeof item.title !== 'string') throw new Error('Ungültige Spaltendarstellung.');
      return { id: item.id, title: item.title, width: item.width, align: item.align, visible: item.visible };
    });
  }
  return { validateFavorites, favoritesFromTables, favoritesToTables, moveFavorite, validateColumns };
});
