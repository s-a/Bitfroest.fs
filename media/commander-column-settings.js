(function (root, factory) {
  const paths = typeof module === 'object' && module.exports ? require('./commander-paths') : root.CommanderPaths;
  const api = factory(paths);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderColumnSettings = api;
})(typeof globalThis === 'object' ? globalThis : this, function (paths) {
  'use strict';
  const units = { bytes: 1, kbytes: 1024, mbytes: 1048576, gbytes: 1073741824, tbytes: 1099511627776 };
  const fields = new Set(['name','ext','fullname','size','writedate','writetime','creationdate','creationtime','accessdate','accesstime','attributes','path','fullpath']);
  const dateFields = /^(write|creation|access)(date|time)$/;
  const catalog = [
    ['name', 'Name', '[=file.name]', 260, 'left'],
    ['type', 'Erweiterung', '[=file.ext]', 88, 'left'],
    ['size', 'Größe', '[=file.size.auto]', 96, 'right'],
    ['date', 'Datum', '[=file.writedate] [=file.writetime]', 154, 'left'],
    ['attributes', 'Attribute', '[=file.attributes]', 72, 'left'],
    ['fullName', 'Vollständiger Dateiname', '[=file.fullname]', 260, 'left'],
    ['path', 'Pfad', '[=file.path]', 320, 'left'],
    ['fullPath', 'Vollständiger Pfad', '[=file.fullpath]', 400, 'left'],
    ['writeTime', 'Änderungszeit', '[=file.writetime]', 120, 'left'],
    ['creationDate', 'Erstellungsdatum', '[=file.creationdate]', 154, 'left'],
    ['creationTime', 'Erstellungszeit', '[=file.creationtime]', 120, 'left'],
    ['accessDate', 'Zugriffsdatum', '[=file.accessdate]', 154, 'left'],
    ['accessTime', 'Zugriffszeit', '[=file.accesstime]', 120, 'left']
  ].map(([id, title, field, width, align], index) => Object.freeze({ id, title, field, width, align, visible: index < 5, position: index + 1 }));

  function columnSetFromPreferences(preferences = {}, translate = value => value) {
    const columns = catalog.map(column => ({
      ...column,
      title: typeof preferences[`title.${column.id}`] === 'string' && preferences[`title.${column.id}`].trim() ? preferences[`title.${column.id}`] : translate(column.title),
      width: preferences[`width.${column.id}`] ?? column.width,
      align: preferences[`alignment.${column.id}`] ?? column.align,
      visible: preferences[`visible.${column.id}`] ?? column.visible,
      position: preferences[`position.${column.id}`] ?? column.position
    }));
    columns.sort((left, right) => left.position - right.position);
    return normalizeColumnSets([{ id: 'standard', name: 'Standard', columns }])[0];
  }
  function automaticSize(value) {
    let amount = Math.max(0, value), unit = 0;
    const labels = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    while (amount >= 1024 && unit < labels.length - 1) { amount /= 1024; unit++; }
    return `${unit ? amount.toFixed(1) : amount} ${labels[unit]}`;
  }
  function splitName(file) {
    const full = String(file.name ?? ''), dot = full.lastIndexOf('.');
    return file.type === 'folder' || file.isDirectory || dot <= 0 || dot === full.length - 1 ? [full,''] : [full.slice(0,dot),full.slice(dot+1)];
  }
  function parseDate(value, allowTime) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : [value.getFullYear(),value.getMonth()+1,value.getDate(),value.getHours(),value.getMinutes(),value.getSeconds()];
    const text = String(value ?? '');
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return parseDate(new Date(text), allowTime);
    const time = allowTime && /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (time) return +time[1] < 24 && +time[2] < 60 && +(time[3] || 0) < 60 ? [2000,1,1,+time[1],+time[2],+(time[3] || 0)] : null;
    const local = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
    const parts = local ? [+local[3],+local[2],+local[1],+(local[4]||0),+(local[5]||0),+(local[6]||0)] : iso ? iso.slice(1,7).map(value => +(value || 0)) : null;
    if (!parts) return null;
    const [year,month,day,hour,minute,second] = parts;
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year,month,0)).getUTCDate() && hour < 24 && minute < 60 && second < 60 ? parts : null;
  }
  function evaluateColumnTemplate(file, template) {
    file = file && typeof file === 'object' ? file : {};
    const unsupportedFields = [], missingFields = [], unavailableFields = [];
    const mark = (list, value) => { if (!list.includes(value)) list.push(value); };
    const text = String(template ?? '').replace(/\[=([^\]]*)\]|\[=([^\]]*)$/g, (expression, complete, incomplete) => {
      const raw = complete ?? incomplete, conditional = raw.startsWith('"') ? /^"([^"]*)"([^"]+)"([^"]*)"$/.exec(raw) : null;
      const key = conditional ? conditional[2] : raw;
      const substring = /:(\d+)-(\d+)$/.exec(key);
      const fieldKey = substring ? key.slice(0, substring.index) : key;
      const parts = fieldKey.split('.'), provider = parts.shift(), field = parts.shift(), format = parts.join('.');
      const isDate = dateFields.test(field || '');
      const validFormat = !format || field === 'size' && (format === 'auto' || Object.hasOwn(units,format)) || isDate && /^[YyMDhmsaPp\-/:. ]+$/.test(format);
      if (incomplete !== undefined || raw.startsWith('"') && !conditional || !['file', 'tc'].includes(provider) || !fields.has(field) || !validFormat || substring && (+substring[1] < 1 || +substring[2] < +substring[1])) { mark(unsupportedFields,key); mark(unavailableFields,key); return conditional ? '' : expression; }
      let value;
      if (field === 'name') value = splitName(file)[0];
      else if (field === 'ext') value = splitName(file)[1];
      else if (field === 'fullname') value = file.name;
      else if (field === 'size') {
        if (file.type === 'folder' || file.isDirectory) value = Number.isFinite(file.folderSize) ? format === 'auto' ? automaticSize(file.folderSize) : String(file.folderSize / (units[format] || 1)) : '<DIR>';
        else if (file.size !== undefined && Number.isFinite(Number(file.size))) value = format === 'auto' ? automaticSize(Number(file.size)) : String(Number(file.size) / (units[format] || 1));
      } else if (field === 'attributes') value = file.attributes ?? file.attr;
      else if (field === 'path' || field === 'fullpath') {
        const full = file.fsSource ?? file.fullpath;
        if (field === 'path') value = file.path ?? (typeof full === 'string' ? paths.parentPath(full) : undefined);
        else value = full;
        if (value !== undefined && value !== null) value = paths.displayPath(value);
      } else if (isDate) {
        const family = dateFields.exec(field)[1], time = field.endsWith('time');
        const raw = file[field] ?? file[`${family}date`] ?? (family === 'write' ? file.date ?? file.mtime : undefined);
        const date = parseDate(raw, time);
        if (date) {
          const tokens = {Y:String(date[0]),y:String(date[0]).slice(-2),M:String(date[1]).padStart(2,'0'),D:String(date[2]).padStart(2,'0'),h:String(date[3]).padStart(2,'0'),m:String(date[4]).padStart(2,'0'),s:String(date[5]).padStart(2,'0'),a:String(date[3] % 12 || 12).padStart(2,'0'),P:date[3] < 12 ? 'am' : 'pm',p:date[3] < 12 ? 'a' : 'p'};
          value = (format || (time ? 'h:m:s' : 'D.M.Y')).replace(/[YyMDhmsaPp]/g,token=>tokens[token]);
        }
      }
      if (value === undefined || value === null) { mark(missingFields,key); if (!conditional) mark(unavailableFields,key); return conditional ? '' : '—'; }
      const output = substring ? String(value).slice(+substring[1] - 1, +substring[2]) : String(value);
      return conditional ? output ? conditional[1] + output + conditional[3] : '' : output;
    });
    return { text, supported: unsupportedFields.length === 0, unsupportedFields, missingFields, unavailableFields };
  }
  function defaults() {
    return [{id:'standard',name:'Standard',columns:[
      {id:'name',title:'Name',field:'[=file.name]',width:260,align:'left',visible:true},
      {id:'type',title:'Erweiterung',field:'[=file.ext]',width:88,align:'left',visible:true},
      {id:'size',title:'Größe',field:'[=file.size.auto]',width:96,align:'right',visible:true},
      {id:'date',title:'Datum',field:'[=file.writedate] [=file.writetime]',width:154,align:'left',visible:true},
      {id:'attributes',title:'Attribute',field:'[=file.attributes]',width:72,align:'left',visible:true}
    ],unsupportedFields:[]}];
  }
  function normalizeColumnSets(input) {
    const result = [], seen = new Set();
    let customCount = 0;
    for (const saved of Array.isArray(input) ? input : []) {
      if (!saved || typeof saved !== 'object' || typeof saved.id !== 'string' || !saved.id.trim() || seen.has(saved.id) || !Array.isArray(saved.columns)) continue;
      const columns = [], ids = new Set(), unsupportedFields = [];
      for (const column of saved.columns) {
        if (!column || typeof column !== 'object') continue;
        const id = typeof column.id === 'string' && column.id.trim() ? column.id : `column-${columns.length+1}`;
        if (ids.has(id)) continue;
        const field = typeof column.field === 'string' ? column.field : '';
        const numeric = typeof column.width === 'number' || typeof column.width === 'string' && column.width.trim() ? Number(column.width) : NaN;
        const width = Number.isFinite(numeric) ? Math.max(32,Math.min(1600,Math.round(numeric))) : 120;
        columns.push({id,title:typeof column.title === 'string' ? column.title : id,field,width,align:['left','right','center'].includes(column.align) ? column.align : 'left',visible:column.visible !== false});
        for (const unknown of evaluateColumnTemplate({},field).unsupportedFields) if (!unsupportedFields.includes(unknown)) unsupportedFields.push(unknown);
        ids.add(id);
      }
      if (!columns.length) continue;
      if (saved.id !== 'standard' && customCount >= 29) continue;
      result.push({id:saved.id,name:typeof saved.name === 'string' && saved.name.trim() ? saved.name : saved.id,columns,unsupportedFields}); seen.add(saved.id);
      if (saved.id !== 'standard') customCount++;
    }
    return result.length ? result : defaults();
  }
  function columnSetsFromTables(tables = {}, translate = value => value) {
    const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const names = record(tables.names), fields = record(tables.fields);
    const keys = Object.keys(fields).filter(key => /^[\w-]+\.[\w-]+$/.test(key) && typeof fields[key] === 'string');
    const order = [...new Set([...(Array.isArray(tables.order) ? tables.order.filter(key => keys.includes(key)) : []), ...keys])];
    const sets = Object.entries(names).filter(([id, name]) => /^[\w-]+$/.test(id) && typeof name === 'string' && name.trim()).map(([id, name]) => ({
      id, name, columns: order.filter(key => key.startsWith(`${id}.`)).map(key => ({
        id: key.slice(id.length + 1), field: fields[key],
        title: record(tables.titles)[key] ?? key.slice(id.length + 1),
        width: record(tables.widths)[key], align: record(tables.alignments)[key],
        visible: record(tables.visibility)[key]
      }))
    }));
    const result = normalizeColumnSets(sets);
    if (!sets.some(set => set.columns.length)) {
      for (const column of result[0].columns) column.title = translate(column.title);
    }
    return result;
  }
  return { normalizeColumnSets, evaluateColumnTemplate, columnSetsFromTables, catalog: Object.freeze(catalog), columnSetFromPreferences };
});
