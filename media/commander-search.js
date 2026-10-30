(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderSearch = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const fold = value => String(value ?? '').toLocaleLowerCase('de');
  function range(name, query) {
    const start = fold(name).indexOf(fold(query));
    return query && start >= 0 ? { start, end: start + String(query).length } : null;
  }
  function matches(items, query) {
    return query ? items.filter(item => range(item.name, query)) : [];
  }
  function find(items, query, cursorId, direction = 0) {
    const found = matches(items, query);
    if (!found.length) return null;
    const index = found.findIndex(item => item.id === cursorId);
    if (!direction) return index >= 0 ? found[index] : found[0];
    return found[(index + found.length + (direction < 0 ? -1 : 1)) % found.length];
  }
  return Object.freeze({ range, matches, find });
});
