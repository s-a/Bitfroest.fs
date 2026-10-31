(function (root, factory) {
  const paths = typeof module === 'object' && module.exports ? require('./commander-paths') : root.CommanderPaths;
  const api = factory(paths);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderFileNames = api;
})(typeof globalThis === 'object' ? globalThis : this, function (pathTools) {
  const parent = pathTools.parentPath;
  const basename = pathTools.baseName;
  const equal = (a, b) => pathTools.identity(a) === pathTools.identity(b);
  const fail = () => { throw new Error('Ungültiger Name, Namenskonflikt oder Ziel außerhalb der bekannten Ordner.'); };
  function valid(segment) {
    return segment && !['.', '..'].includes(segment) && !/[<>:"|?*\\/]/.test(segment) && ![...segment].some(c => c.charCodeAt(0) < 32) && !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment);
  }
  function expand(input, options) {
    if (!input.startsWith('<')) {
      if (input.startsWith('"')) {
        if (input.endsWith('|')) fail();
        const results = [], expression = /"([^"]+)"(?:\s*\|\s*|\s+|$)/gy;
        let match, end = 0;
        while ((match = expression.exec(input))) { results.push(match[1]); end = expression.lastIndex; }
        if (end !== input.length) fail();
        return { names: results, batch: results.length > 1 };
      }
      return { names: input.split('|'), batch: input.includes('|') };
    }
    if (input.includes('|')) fail();
    const range = /^<(\d+)-(\d+)>/.exec(input);
    const start = range ? Number(range[1]) : 1, end = range ? Number(range[2]) : 1;
    if (end < start || end - start >= 1000 || !Number.isSafeInteger(end)) fail();
    const mask = input.slice(range ? range[0].length : 1), now = options.now || new Date();
    const current = String(options.currentName || ''), dot = options.currentType === 'folder' ? -1 : current.lastIndexOf('.');
    const two = value => String(value).padStart(2, '0');
    const values = { Y: String(now.getFullYear()), M: two(now.getMonth() + 1), D: two(now.getDate()), h: two(now.getHours()), m: two(now.getMinutes()), s: two(now.getSeconds()), N: dot > 0 ? current.slice(0, dot) : current, E: dot > 0 ? current.slice(dot + 1) : '' };
    const names = [];
    for (let counter = start; counter <= end; counter++) names.push(mask.replace(/\[([^\]]+)\]/g, (_, key) => {
      if (Object.hasOwn(values, key)) return values[key];
      const count = /^C(?::([1-9]))?$/.exec(key);
      if (!count) fail();
      return String(counter).padStart(Number(count[1] || 1), '0');
    }));
    return { names, batch: Boolean(range) };
  }
  function plan(input, options) {
    if (typeof input !== 'string' || !input.trim()) fail();
    const expanded = expand(input.trim(), options), paths = [], directories = [], known = new Set(Object.keys(options.folders));
    const existing = directory => Object.keys(options.folders).find(path => equal(path, directory));
    for (const raw of expanded.names) {
      const value = pathTools.isWindowsPath(raw) || pathTools.isWindowsPath(options.base) ? raw.replace(/\\/g, '/') : raw;
      if (!value || value.endsWith('/')) fail();
      const segments = value.replace(/^[a-z]:\//i, '').split('/').filter(Boolean);
      if (!segments.every(valid)) fail();
      let path = pathTools.normalizePath(value, { base: options.base });
      if (!pathTools.isAbsolutePath(path)) fail();
      const missing = [];
      let ancestor = options.kind === 'folder' ? path : parent(path);
      while (!existing(ancestor) && !known.has(ancestor)) {
        if (parent(ancestor) === ancestor || !ancestor.includes('/')) fail();
        missing.unshift(ancestor); ancestor = parent(ancestor);
      }
      const resolved = existing(ancestor);
      if (resolved && resolved !== ancestor) {
        path = resolved + path.slice(ancestor.length);
        for (let index = 0; index < missing.length; index++) missing[index] = resolved + missing[index].slice(ancestor.length);
      }
      if (paths.some(previous => equal(previous, path))) fail();
      if (options.kind === 'file' && paths.some(previous =>
        path.length > previous.length && path[previous.length] === '/' && equal(path.slice(0, previous.length), previous) ||
        previous.length > path.length && previous[path.length] === '/' && equal(previous.slice(0, path.length), path))) fail();
      const targetParent = parent(path), targetName = basename(path);
      const present = (options.folders[existing(targetParent)] || []).find(row => equal(`${targetParent}/${row.name}`, path));
      if (present && !(options.allowExisting && options.kind === 'folder' && present.type === 'folder')) fail();
      for (const directory of missing) {
        const listing = options.folders[existing(parent(directory))] || [];
        if (listing.some(row => row.name.toLowerCase() === basename(directory).toLowerCase() && row.type !== 'folder')) fail();
        if (!known.has(directory)) { directories.push(directory); known.add(directory); }
      }
      if (!valid(targetName)) fail();
      paths.push(path);
    }
    return { paths, directories, openEditor: options.kind === 'file' && paths.length === 1 && !expanded.batch };
  }
  function ensureDirectories(folders, paths, createEntry) {
    for (const path of paths) {
      if (Object.hasOwn(folders, path)) continue;
      const directory = parent(path);
      if (!Object.hasOwn(folders, directory)) fail();
      folders[directory].push(createEntry(basename(path))); folders[path] = [];
    }
  }
  return { plan, ensureDirectories };
});
