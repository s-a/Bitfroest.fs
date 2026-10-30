(function (root, factory) {
  const transfer = typeof module === 'object' && module.exports ? require('./commander-transfer') : root.CommanderTransfer;
  const api = factory(transfer);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderSearchDuplicates = api;
})(typeof globalThis === 'object' ? globalThis : this, function (transfer) {
  'use strict';
  function selectDuplicates(rows, settings = {}) {
    const grouped = new Map();
    for (const row of rows) { if (!grouped.has(row.group)) grouped.set(row.group, []); grouped.get(row.group).push(row); }
    const selected = new Set();
    const pattern = (row, value, ids) => !value ? true : value.startsWith('>') ? (ids || []).includes(row.id) : value.startsWith('<') ? new RegExp(value.slice(1), 'iu').test(row.name) : transfer.matches(row.name, value);
    const relative = (row, group, mode, property) => {
      if (!mode || mode === 'none') return true;
      const value = row[property] || 0, values = group.map(row => row[property] || 0), min = Math.min(...values), max = Math.max(...values);
      return ({ older: value < max, newer: value > min, oldest: value === min, newest: value === max, smaller: value < max, larger: value > min, smallest: value === min, largest: value === max })[mode] ?? false;
    };
    for (const group of grouped.values()) {
      for (const row of group) {
        if (!pattern(row, settings.include || '*', settings.includeIds) || settings.exclude && pattern(row, settings.exclude, settings.excludeIds)) continue;
        if (!relative(row, group, settings.date, 'mtimeMs') || !relative(row, group, settings.size, 'size')) continue;
        const directory = row.fsSource.slice(0, row.fsSource.lastIndexOf('/'));
        if (settings.folders && !settings.folders.some(folder => directory === folder || settings.includeChildren && directory.startsWith(folder + '/'))) continue;
        if (settings.folderPattern) { const name = settings.directParent ? directory.split('/').at(-1) : directory; if (!transfer.matches(name, settings.folderPattern)) continue; }
        selected.add(row.id);
      }
      if (settings.keepOne && group.every(row => selected.has(row.id))) {
        let preserved = group;
        for (const rule of settings.keep || ['newest', 'largest', 'first']) {
          if (rule === 'first') preserved = [preserved[0]];
          else if (rule === 'last') preserved = [preserved.at(-1)];
          else { const property = ['newest', 'oldest'].includes(rule) ? 'mtimeMs' : 'size', values = preserved.map(row => row[property] || 0); const target = ['newest', 'largest'].includes(rule) ? Math.max(...values) : Math.min(...values); preserved = preserved.filter(row => (row[property] || 0) === target); }
          if (preserved.length <= 1) break;
        }
        for (const row of preserved) selected.delete(row.id);
      }
    }
    return rows.filter(row => selected.has(row.id)).map(row => row.id);
  }
  return { selectDuplicates };
});
