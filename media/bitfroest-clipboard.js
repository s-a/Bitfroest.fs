(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BitfroestClipboard = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const identity = (value, platform) => platform === 'win32' && /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  function normalize(value, platform) {
    if (typeof value !== 'string' || value.includes('\0') || value.length > 4096) throw new Error('Ungültiger Zwischenablage-Pfad.');
    const absolute = platform === 'linux' ? value.startsWith('/') : /^(?:[a-z]:[\\/]|\/)/i.test(value);
    const segments = platform === 'linux' ? value.split('/') : value.split(/[\\/]/);
    if (!absolute || segments.includes('..')) throw new Error('Ungültiger Zwischenablage-Pfad.');
    return (platform === 'win32' ? value.replace(/\\/g, '/') : value).replace(/\/$/, '');
  }
  function validate(selection, platform) {
    if (!selection || !['copy', 'move'].includes(selection.mode) || !Array.isArray(selection.paths) || !selection.paths.length || selection.paths.length > 1024) throw new Error('Ungültige Datei-Zwischenablage.');
    return [...new Map(selection.paths.map(value => normalize(value, platform)).map(value => [identity(value, platform), value])).values()];
  }
  function capture(state, mode, platform = 'win32') {
    const p = state.panes[state.active], directory = p.tabs[p.tab];
    const selected = p.selected.length ? p.selected : p.cursor ? [p.cursor] : [];
    const result = p.tabStates?.[p.tab]?.searchResult;
    const entries = result ? Object.values(state.folders).flat().filter(row => result.paths.includes(row.fsSource)) : state.folders[directory] || [];
    const paths = [...(!state.archiveLocations?.[directory] && selected.includes('\u0000parent') ? [directory] : []), ...entries.filter(file => selected.includes(file.id)).map(file => result ? file.fsSource : `${directory}/${file.name}`)];
    return paths.length ? { paths: validate({ paths, mode }, platform), mode } : null;
  }
  function inspectPaste(state, selection, targetPath, platform = 'win32') {
    const paths = validate(selection, platform), directories = [], groups = [];
    const target = normalize(targetPath, platform);
    for (const filePath of paths) {
      const directory = filePath.slice(0, filePath.lastIndexOf('/')) || '/';
      const actualDirectory = Object.keys(state.folders).find(key => identity(key, platform) === identity(directory, platform));
      if (!actualDirectory || (state.unloadedFolders || []).includes(actualDirectory)) { directories.push(directory); continue; }
      const file = state.folders[actualDirectory].find(row => identity(`${actualDirectory}/${row.name}`, platform) === identity(filePath, platform));
      if (!file) throw new Error('Eine Datei aus der Zwischenablage ist nicht mehr vorhanden.');
      let group = groups.find(item => item.sourcePath === actualDirectory);
      if (!group) { group = { sourcePath: actualDirectory, ids: [], paths: [], targetPath: target, mode: selection.mode }; groups.push(group); }
      group.ids.push(file.id); group.paths.push(`${actualDirectory}/${file.name}`);
    }
    return { ready: !directories.length, directories: [...new Set(directories)], groups: directories.length ? [] : groups };
  }
  function remaining(selection, completions, platform = 'win32') {
    const paths = validate(selection, platform);
    if (selection.mode !== 'move') return paths;
    const completed = new Set();
    for (const { group, result } of completions) {
      if (result?.confirmed !== true) continue;
      group.ids.forEach((id, index) => { if ((result.completedIds || []).includes(id)) completed.add(identity(group.paths[index], platform)); });
    }
    return paths.filter(item => !completed.has(identity(item, platform)));
  }
  return { capture, inspectPaste, remaining };
});
