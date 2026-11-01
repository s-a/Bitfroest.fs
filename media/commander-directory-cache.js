(function (root) {
  'use strict';
  function create(limit = 2 * 1024 * 1024) {
    const entries = new Map(), encoder = new TextEncoder();
    let bytes = 0;
    const remove = key => { const entry = entries.get(key); if (entry) { bytes -= entry.bytes; entries.delete(key); } };
    const read = key => { const entry = entries.get(key); if (!entry) return; entries.delete(key); entries.set(key, entry); return entry; };
    const write = (key, rows, git = entries.get(key)?.git, columns = entries.get(key)?.columns) => {
      remove(key);
      const serialized = JSON.stringify(columns !== undefined ? [key, rows, git, columns] : git === undefined ? [key, rows] : [key, rows, git]), size = encoder.encode(serialized).length;
      if (size > limit) return;
      while (bytes + size > limit && entries.size) remove(entries.keys().next().value);
      const value = JSON.parse(serialized);
      entries.set(key, { rows: value[1], git: git === undefined ? undefined : value[2], columns: value[3], bytes: size }); bytes += size;
    };
    return {
      get bytes() { return bytes; },
      get(key) { return read(key)?.rows; },
      set: write,
      getColumns(key) { return read(key)?.columns; },
      setColumns(key, columns) { const entry = entries.get(key); if (entry) write(key, entry.rows, entry.git, columns); },
      getGit(key) { return read(key)?.git; },
      setGit(key, git) { const entry = entries.get(key); if (entry) write(key, entry.rows, git); },
      clearGit(key) { for (const value of key === undefined ? [...entries.keys()] : [key]) { const entry = entries.get(value); if (entry) { delete entry.git; write(value, entry.rows); } } },
      delete: remove,
      clear() { entries.clear(); bytes = 0; }
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.CommanderDirectoryCache = { create };
})(typeof window === 'object' ? window : globalThis);
