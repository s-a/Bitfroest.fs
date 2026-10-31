(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderPaths = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const opaque = value => /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:/i.test(value);
  const isWindowsPath = value => /^[a-z]:/i.test(String(value)) || /^(?:\\\\|\/\/)/.test(String(value));
  const isAbsolutePath = value => /^[a-z]:[\\/]/i.test(String(value)) || String(value).startsWith('/') || String(value).startsWith('\\\\');

  function collapse(value) {
    let root = '', rest = value;
    const drive = /^([a-z]:)\//i.exec(value), unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(value);
    if (drive) { root = drive[1] + '/'; rest = value.slice(3); }
    else if (unc) { root = `//${unc[1]}/${unc[2]}`; rest = value.slice(unc[0].length); }
    else if (value.startsWith('/')) { root = '/'; rest = value.slice(1); }
    const parts = [];
    for (const part of rest.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !root) parts.push(part);
    }
    return root + (root && !root.endsWith('/') && parts.length ? '/' : '') + parts.join('/');
  }

  function normalizePath(value, options = {}) {
    let text = String(value ?? ''), base = String(options.base ?? '');
    if (options.input) text = text.trim().replace(/^"(.*)"$/, '$1');
    if (opaque(text)) return text;
    const windows = options.platform === 'win32' || isWindowsPath(text) || isWindowsPath(base);
    if (windows) { text = text.replaceAll('\\', '/'); base = base.replaceAll('\\', '/'); }
    if (base && !isAbsolutePath(text) && !/^[a-z]:/i.test(text)) text = base.replace(/\/$/, '') + '/' + text;
    else if (base && /^[a-z]:\//i.test(base) && text.startsWith('/') && !text.startsWith('//')) text = base.slice(0, 2) + text;
    if (opaque(text)) return text;
    const boundary = text.search(/!(?:\/|$)/);
    if (boundary >= 0) {
      const outer = collapse(text.slice(0, boundary));
      const inner = collapse('/' + text.slice(boundary + 1).replace(/^\//, ''));
      return outer + '!' + (inner === '/' ? '' : inner);
    }
    return collapse(text);
  }

  function displayPath(value, options = {}) {
    const normalized = normalizePath(value, options);
    return isWindowsPath(normalized) && !opaque(normalized) ? normalized.replace(/^[a-z]:/i, drive => drive.toUpperCase()).replaceAll('/', '\\') : normalized;
  }
  function parentPath(value, options = {}) {
    const normalized = normalizePath(value, options);
    if (opaque(normalized)) return normalized;
    if (normalized.endsWith('!')) return parentPath(normalized.slice(0, -1), options);
    const boundary = normalized.search(/!(?:\/|$)/);
    if (boundary >= 0) {
      const inner = normalized.slice(boundary + 1), at = inner.lastIndexOf('/');
      return normalized.slice(0, boundary + 1) + (at > 0 ? inner.slice(0, at) : '');
    }
    if (/^[a-z]:\/$/i.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized) || normalized === '/') return normalized;
    const index = normalized.lastIndexOf('/');
    return index < 0 ? '' : normalizePath(normalized.slice(0, index + (/^[a-z]:\//i.test(normalized) && index === 2 ? 1 : 0)) || '/');
  }
  const baseName = value => { const normalized = normalizePath(value); return normalized.slice(normalized.lastIndexOf('/') + 1); };
  const joinPath = (base, ...parts) => parts.reduce((value, part) => normalizePath(part, { base: value }), normalizePath(base));
  const identity = (value, options = {}) => { const normalized = normalizePath(value, options); return options.platform === 'win32' || isWindowsPath(normalized) ? normalized.toLowerCase() : normalized; };

  return Object.freeze({ normalizePath, displayPath, isWindowsPath, isAbsolutePath, parentPath, baseName, joinPath, identity });
});
