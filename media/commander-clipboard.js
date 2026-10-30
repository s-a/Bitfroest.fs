(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderClipboard = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const identity = value => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  function normalize(value) {
    if (typeof value !== 'string' || !/^(?:[a-z]:[\\/]|\/)/i.test(value) || value.includes('\0') || value.length > 4096 || value.split(/[\\/]/).includes('..')) throw new Error('Ungültiger Zwischenablage-Pfad.');
    return value.replace(/\\/g, '/').replace(/\/$/, '');
  }
  function validate(selection) {
    if (!selection || !['copy', 'move'].includes(selection.mode) || !Array.isArray(selection.paths) || !selection.paths.length || selection.paths.length > 1024) throw new Error('Ungültige Datei-Zwischenablage.');
    return [...new Map(selection.paths.map(normalize).map(value => [identity(value), value])).values()];
  }
  function capture(state, mode) {
    const p = state.panes[state.active], directory = p.tabs[p.tab];
    const selected = p.selected.length ? p.selected : p.cursor ? [p.cursor] : [];
    const result = p.tabStates?.[p.tab]?.searchResult;
    const entries = result ? Object.values(state.folders).flat().filter(row => result.paths.includes(row.fsSource)) : state.folders[directory] || [];
    const paths = entries.filter(file => selected.includes(file.id)).map(file => result ? file.fsSource : `${directory}/${file.name}`);
    return paths.length ? { paths: validate({ paths, mode }), mode } : null;
  }
  function inspectPaste(state, selection, targetPath) {
    const paths = validate(selection), directories = [], groups = [];
    const target = normalize(targetPath);
    for (const filePath of paths) {
      const directory = filePath.slice(0, filePath.lastIndexOf('/')) || '/';
      const actualDirectory = Object.keys(state.folders).find(key => identity(key) === identity(directory));
      if (!actualDirectory || (state.unloadedFolders || []).includes(actualDirectory)) { directories.push(directory); continue; }
      const file = state.folders[actualDirectory].find(row => identity(`${actualDirectory}/${row.name}`) === identity(filePath));
      if (!file) throw new Error('Eine Datei aus der Zwischenablage ist nicht mehr vorhanden.');
      let group = groups.find(item => item.sourcePath === actualDirectory);
      if (!group) { group = { sourcePath: actualDirectory, ids: [], paths: [], targetPath: target, mode: selection.mode }; groups.push(group); }
      group.ids.push(file.id); group.paths.push(`${actualDirectory}/${file.name}`);
    }
    return { ready: !directories.length, directories: [...new Set(directories)], groups: directories.length ? [] : groups };
  }
  function remaining(selection, completions) {
    const paths = validate(selection);
    if (selection.mode !== 'move') return paths;
    const completed = new Set();
    for (const { group, result } of completions) {
      if (result?.confirmed !== true) continue;
      group.ids.forEach((id, index) => { if ((result.completedIds || []).includes(id)) completed.add(identity(group.paths[index])); });
    }
    return paths.filter(item => !completed.has(identity(item)));
  }
  return { capture, inspectPaste, remaining };
});
