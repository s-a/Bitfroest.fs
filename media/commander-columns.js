(function (root, factory) {
  const settings = typeof module === 'object' && module.exports ? require('./commander-column-settings') : root.CommanderColumnSettings;
  const api = factory(settings);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderColumns = api;
})(typeof globalThis === 'object' ? globalThis : this, function (settings) {
  'use strict';

  const definitions = [
    { key: 'name', label: 'Name', width: 260, minWidth: 80, maxWidth: 1600 },
    { key: 'type', label: 'Ext.', width: 88, minWidth: 48, maxWidth: 400 },
    { key: 'size', label: 'Größe', width: 96, minWidth: 48, maxWidth: 400 },
    { key: 'date', label: 'Datum', width: 154, minWidth: 80, maxWidth: 600 },
    { key: 'attributes', label: 'Attr.', width: 72, minWidth: 48, maxWidth: 400 }
  ];
  const byKey = new Map(definitions.map(column => [column.key, column]));
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

  function defaults() {
    return definitions.map(column => ({ ...column }));
  }

  function normalize(columns) {
    const result = [], seen = new Set();
    if (Array.isArray(columns) && columns.some(column => typeof column?.field === 'string')) {
      for (const saved of columns) {
        if (!saved || typeof saved !== 'object') continue;
        const key = saved.key ?? saved.id;
        if (typeof key !== 'string' || !key || seen.has(key)) continue;
        const width = numericWidth(saved.width), definition = { minWidth: 32, maxWidth: 1600 };
        result.push({ key, label: settings.columnTitle(saved), field: String(saved.field ?? ''), align: ['left', 'right', 'center'].includes(saved.align) ? saved.align : 'left', visible: saved.visible !== false, width: Number.isFinite(width) ? clamp(width, definition) : 120, ...definition });
        seen.add(key);
      }
      return result;
    }
    for (const saved of Array.isArray(columns) ? columns : []) {
      const key = typeof saved === 'string' ? saved : saved?.key;
      const definition = byKey.get(key);
      if (!definition || seen.has(key)) continue;
      const width = numericWidth(saved?.width);
      result.push({ ...definition, width: Number.isFinite(width) ? clamp(width, definition) : definition.width });
      seen.add(key);
    }
    for (const definition of definitions) if (!seen.has(definition.key)) result.push({ ...definition });
    return result;
  }

  function clamp(width, column) {
    return Math.round(Math.min(column.maxWidth, Math.max(column.minWidth, width)));
  }

  function numericWidth(value) {
    return typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  }

  function moveColumn(columns, key, target) {
    const result = normalize(columns);
    const sourceIndex = result.findIndex(column => column.key === key);
    const targetIndex = typeof target === 'number' ? Math.trunc(target) : result.findIndex(column => column.key === target);
    if (sourceIndex < 0 || !Number.isFinite(targetIndex) || targetIndex < 0) return result;
    const [column] = result.splice(sourceIndex, 1);
    result.splice(Math.max(0, Math.min(result.length, targetIndex)), 0, column);
    return result;
  }

  function resizeColumn(columns, key, width) {
    const result = normalize(columns);
    const column = result.find(item => item.key === key);
    const numeric = numericWidth(width);
    if (column && Number.isFinite(numeric)) column.width = clamp(numeric, column);
    return result;
  }

  function isFolder(file) {
    return file?.type === 'folder' || file?.isDirectory === true;
  }

  function splitName(file) {
    const full = String(file?.name ?? '');
    if (isFolder(file)) return { name: full, extension: '' };
    const dot = full.lastIndexOf('.');
    if (dot <= 0 || dot === full.length - 1) return { name: full, extension: '' };
    return { name: full.slice(0, dot), extension: full.slice(dot + 1) };
  }

  function attributes(file) {
    const supplied = file?.attributes ?? file?.attr;
    return supplied === undefined || supplied === null ? (isFolder(file) ? 'd---' : '-a--') : String(supplied);
  }

  function formatSize(value) {
    const numeric = Math.max(0, Number(value) || 0);
    if (numeric >= 1048576) return `${(numeric / 1048576).toFixed(1)} MB`;
    if (numeric >= 1024) return `${(numeric / 1024).toFixed(1)} KB`;
    return `${numeric} B`;
  }

  function displayValue(file, key) {
    if (key && typeof key === 'object') return settings.evaluateColumnTemplate(file, key.field).text;
    const parts = splitName(file);
    switch (key) {
      case 'name': return parts.name;
      case 'type': return parts.extension;
      case 'size': return isFolder(file) ? Number.isFinite(file.folderSize) ? formatSize(file.folderSize) : '<DIR>' : formatSize(file?.size);
      case 'date': return String(file?.date ?? '');
      case 'attributes': return attributes(file);
      default: return '';
    }
  }

  function dateValue(file) {
    const value = file?.date;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : -Infinity;
    if (typeof value === 'number') return Number.isFinite(value) ? value : -Infinity;
    const text = String(value ?? '').trim();
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (match) {
      const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
      const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
      const date = new Date(time);
      return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day)
        && date.getUTCHours() === Number(hour) && date.getUTCMinutes() === Number(minute) && date.getUTCSeconds() === Number(second)
        ? time : -Infinity;
    }
    const time = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) ? Date.parse(text) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
  }

  function compareValue(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function compare(a, b, key = 'name', descending = false) {
    const folderOrder = Number(isFolder(b)) - Number(isFolder(a));
    if (folderOrder) return folderOrder;
    let result;
    if (key && typeof key === 'object') {
      const match = /^\[=(?:file|tc)\.(size|writedate|writetime|creationdate|creationtime|accessdate|accesstime)(?:\.[^\]]+)?\]$/.exec(key.field);
      if (match?.[1] === 'size') result = compareValue(Number(a?.size) || 0, Number(b?.size) || 0);
      else if (match) {
        const field = match[1], format = field.endsWith('time') ? 'h:m:s' : 'Y-M-D';
        const timestamp = file => {
          const value = settings.evaluateColumnTemplate(file, `[=file.${field}.${format}]`);
          return value.missingFields.length ? '' : value.text;
        };
        result = compareValue(timestamp(a), timestamp(b));
      } else result = collator.compare(displayValue(a, key), displayValue(b, key));
    }
    else if (key === 'size') result = compareValue(Number(a?.size) || 0, Number(b?.size) || 0);
    else if (key === 'date') result = compareValue(dateValue(a), dateValue(b));
    else result = collator.compare(displayValue(a, byKey.has(key) ? key : 'name'), displayValue(b, byKey.has(key) ? key : 'name'));
    if (!result) result = collator.compare(String(a?.name ?? ''), String(b?.name ?? ''));
    if (!result) result = String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'de', { sensitivity: 'variant' });
    return result * (descending ? -1 : 1);
  }

  function sort(items, key = 'name', descending = false) {
    return (Array.isArray(items) ? items : []).map((file, index) => ({ file, index }))
      .sort((a, b) => compare(a.file, b.file, key, descending) || a.index - b.index)
      .map(item => item.file);
  }

  function autoSize(columns, key, items, measure) {
    const result = normalize(columns);
    const column = result.find(item => item.key === key);
    if (!column || typeof measure !== 'function') return result;
    const padding = key === 'name' ? 32 : 16;
    const widths = [column.label, ...(Array.isArray(items) ? items : []).map(file => displayValue(file, typeof column.field === 'string' ? column : key))]
      .map(text => numericWidth(measure(text, key)))
      .filter(Number.isFinite);
    if (widths.length) column.width = clamp(Math.ceil(widths.reduce((largest, width) => Math.max(largest, width), 0) + padding), column);
    return result;
  }

  return { defaults, normalize, moveColumn, resizeColumn, autoSize, displayValue, splitName, attributes, dateValue, compare, sort };
});
