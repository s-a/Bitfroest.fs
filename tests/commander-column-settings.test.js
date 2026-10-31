const assert = require('node:assert/strict');
const test = require('node:test');
const settings = require('../media/commander-column-settings');

test('public column defaults and examples use neutral file property names', () => {
  assert.equal(settings.evaluateColumnTemplate({ name: 'report.txt', size: 1536 }, '[=file.name] [=file.size.auto]').text, 'report 1.5 KB');
  assert.ok(settings.catalog.every(column => !column.field.includes('tc.')));
  for (const name of ['package.json', 'package.nls.json', 'package.nls.de.json']) {
    const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', name), 'utf8');
    assert.doesNotMatch(text, /\btc\./);
  }
});
test('timestamp strings retain their timezone when displayed as local metadata dates', () => {
  const timestamp = '2026-10-30T02:03:04+11:00';
  assert.equal(settings.evaluateColumnTemplate({ writedate: timestamp }, '[=tc.writedate] [=tc.writetime]').text,
    settings.evaluateColumnTemplate({ writedate: new Date(timestamp) }, '[=tc.writedate] [=tc.writetime]').text);
});
const file = { name: 'report.final.md', type: 'text', size: 1536, date: '29.10.2026 13:04:05', attributes: '-a--', fsSource: 'C:/tmp/report.final.md' };

test('automatic size units are readable while explicit byte and fixed-unit columns keep their meaning', () => {
  for (const [size, expected] of [[0,'0 B'],[1023,'1023 B'],[1024,'1.0 KB'],[1536,'1.5 KB'],[1048576,'1.0 MB'],[1073741824,'1.0 GB'],[1099511627776,'1.0 TB'],[1125899906842624,'1.0 PB']]) {
    const result = settings.evaluateColumnTemplate({ ...file, size }, '[=tc.size.auto]');
    assert.equal(result.text, expected); assert.deepEqual(result.unsupportedFields, []);
  }
  assert.equal(settings.evaluateColumnTemplate(file, '[=tc.size]').text, '1536');
  assert.equal(settings.evaluateColumnTemplate(file, '[=tc.size.bytes]').text, '1536');
  assert.equal(settings.evaluateColumnTemplate(file, '[=tc.size.kbytes]').text, '1.5');
  assert.equal(settings.evaluateColumnTemplate({ type: 'folder' }, '[=tc.size.auto]').text, '<DIR>');
  assert.equal(settings.normalizeColumnSets([])[0].columns.find(column => column.id === 'size').field, '[=file.size.auto]');
  const manifest = require('../package.json');
  assert.equal(Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties))['bitfroest.columns.sets'].default[0].columns.find(column => column.id === 'size').field, '[=file.size.auto]');
});
test('normalizes sets and columns without mutating input or losing order and visibility', () => {
  const source = [{ id: 'reports', name: 'Berichte', columns: [{ id: 'title', title: 'Datei', field: '[=tc.fullname]', width: 240, align: 'left', visible: true }, { id: 'bytes', title: 'Bytes', field: '[=tc.size]', width: 99, align: 'right', visible: false }] }];
  const result = settings.normalizeColumnSets(source);
  assert.deepEqual(result[0].columns.map(c => [c.id,c.title,c.field,c.width,c.align,c.visible]), [['title','Datei','[=tc.fullname]',240,'left',true],['bytes','Bytes','[=tc.size]',99,'right',false]]);
  result[0].columns[0].title = 'Changed'; assert.equal(source[0].columns[0].title, 'Datei');
});
test('rejects duplicate identities, clamps widths, repairs alignment and flags plugin fields', () => {
  const result = settings.normalizeColumnSets([{id:'custom',columns:[{id:'a',field:'[=media.duration]',width:1,align:'center'},{id:'a',field:'[=tc.size]'},{id:'b',field:'[=tc.unknown]',width:9000,align:'bogus'}]},{id:'custom',columns:[]}]);
  assert.equal(result.length, 1); assert.equal(result[0].columns.length,2);
  assert.equal(result[0].columns[0].width,32); assert.equal(result[0].columns[0].align,'center');
  assert.equal(result[0].columns[1].width,1600); assert.equal(result[0].columns[1].align,'left');
  assert.deepEqual(result[0].unsupportedFields,['media.duration','tc.unknown']);
});
test('defaults invalid configuration to standard columns', () => {
  for (const input of [null,{},[],[null], [{columns:[]}]] ) {
    const result = settings.normalizeColumnSets(input); assert.equal(result[0].id,'standard'); assert.equal(result[0].columns.length,5);
  }
});
test('evaluates literal text and file name fields with folder and dotfile handling', () => {
  assert.equal(settings.evaluateColumnTemplate(file,'[=tc.name] ([=tc.ext]) [=tc.fullname]').text,'report.final (md) report.final.md');
  assert.equal(settings.evaluateColumnTemplate({name:'.config',type:'file'},'[=tc.name]|[=tc.ext]').text,'.config|');
  assert.equal(settings.evaluateColumnTemplate({name:'dir.ext',type:'folder'},'[=tc.name]|[=tc.ext]').text,'dir.ext|');
});
test('formats byte units deterministically and preserves raw byte precision', () => {
  assert.equal(settings.evaluateColumnTemplate(file,'[=tc.size] / [=tc.size.kbytes] / [=tc.size.mbytes]').text,'1536 / 1.5 / 0.00146484375');
  assert.equal(settings.evaluateColumnTemplate({size:1073741824},'[=tc.size.gbytes]').text,'1');
  assert.equal(settings.evaluateColumnTemplate({type:'folder'},'[=tc.size]').text,'<DIR>');
});
test('formats write dates and times without guessing unavailable creation or access data', () => {
  const result = settings.evaluateColumnTemplate(file,'[=tc.writedate.Y-M-D] [=tc.writetime.h:m:s]');
  assert.equal(result.text,'2026-10-29 13:04:05'); assert.equal(result.supported,true);
  const missing = settings.evaluateColumnTemplate(file,'[=tc.creationdate] [=tc.accessdate]');
  assert.deepEqual(missing.missingFields,['tc.creationdate','tc.accessdate']); assert.equal(missing.supported,true);
  assert.equal(settings.evaluateColumnTemplate({creationdate:'2025-01-02T03:04:05Z'},'[=tc.creationdate.D.M.Y]').text,'02.01.2025');
});
test('evaluates paths and attributes only from real supplied metadata', () => {
  assert.equal(settings.evaluateColumnTemplate(file,'[=tc.path]|[=tc.fullpath]|[=tc.attributes]').text,'C:\\tmp|C:\\tmp\\report.final.md|-a--');
  assert.deepEqual(settings.evaluateColumnTemplate({name:'x'},'[=tc.path] [=tc.attributes]').missingFields,['tc.path','tc.attributes']);
});
test('reports unsupported fields and malformed expressions visibly rather than silently succeeding', () => {
  const result = settings.evaluateColumnTemplate(file,'[=media.duration] / [=tc.size.invalid] / [=tc.unknown]');
  assert.equal(result.supported,false); assert.deepEqual(result.unsupportedFields,['media.duration','tc.size.invalid','tc.unknown']);
  assert.equal(result.text,'[=media.duration] / [=tc.size.invalid] / [=tc.unknown]');
  assert.equal(settings.evaluateColumnTemplate(file,'[=tc.name').supported,false);
  assert.equal(settings.evaluateColumnTemplate(file,'unchanged').text,'unchanged');
});
test('time-only metadata is usable and impossible calendar dates remain missing', () => {
  assert.equal(settings.evaluateColumnTemplate({writetime:'09:08:07'},'[=tc.writetime]').text,'09:08:07');
  for (const date of ['31.02.2026 10:20', '2026-13-04', '2026-01-02 26:00:00']) {
    assert.deepEqual(settings.evaluateColumnTemplate({date},'[=tc.writedate]').missingFields,['tc.writedate']);
  }
});
test('metadata aliases and primitive input failures are handled without fabrication', () => {
  assert.equal(settings.evaluateColumnTemplate({name:'a.',attr:'rh',path:'/src',fullpath:'/src/a.'},'[=tc.name]|[=tc.ext]|[=tc.attributes]|[=tc.path]|[=tc.fullpath]').text,'a.||rh|/src|/src/a.');
  assert.equal(settings.evaluateColumnTemplate({name:'.a.json',isDirectory:true},'[=tc.name]|[=tc.ext]|[=tc.size]').text,'.a.json||<DIR>');
  assert.deepEqual(settings.evaluateColumnTemplate(null,'[=tc.fullname]').missingFields,['tc.fullname']);
  assert.equal(settings.evaluateColumnTemplate(null,null).text,'');
  assert.equal(settings.evaluateColumnTemplate({date:new Date(2026,0,2,3,4,5)},'[=tc.writedate] [=tc.writetime]').text,'02.01.2026 03:04:05');
  assert.deepEqual(settings.evaluateColumnTemplate({date:new Date(NaN)},'[=tc.writetime]').missingFields,['tc.writetime']);
  assert.equal(settings.evaluateColumnTemplate({size:1099511627776},'[=tc.size.tbytes]').text,'1');
});
test('normalization handles anonymous columns and invalid options deterministically', () => {
  const result = settings.normalizeColumnSets([null,{id:'',columns:[]},{id:'a',columns:[null,{field:'literal',width:'128.6'}, {id:'b',width:'',visible:false},{id:'c',width:'NaN',align:'right'}]}]);
  assert.equal(result[0].name,'a'); assert.equal(result[0].columns[0].id,'column-1');
  assert.equal(result[0].columns[0].width,129); assert.equal(result[0].columns[0].title,'column-1');
  assert.equal(result[0].columns[1].width,120); assert.equal(result[0].columns[1].visible,false);
  assert.equal(result[0].columns[2].width,120);
});

test('reference date format tokens expand individually including 12-hour and meridiem variants',()=>{
 assert.equal(settings.evaluateColumnTemplate(file,'[=tc.writedate.YMD] [=tc.writetime.h:m:s] [=tc.writetime.a:m P p] [=tc.writedate.y]').text,'20261029 13:04:05 01:04 pm p 26');
 assert.equal(settings.evaluateColumnTemplate({writetime:'00:03:02'},'[=tc.writetime.a P p]').text,'12 am a');
});
test('field substring positions are one-based and inclusive within formatted values',()=>{
 assert.equal(settings.evaluateColumnTemplate(file,'[=tc.fullname:4-7]|[=tc.writedate.YMD:1-4]').text,'ort.|2026');
 assert.equal(settings.evaluateColumnTemplate(file,'[=tc.fullname:40-50]').text,'');
 assert.equal(settings.evaluateColumnTemplate(file,'[=tc.name:0-4]').supported,false);
});
test('conditional prefixes and suffixes appear only around valid nonempty field values',()=>{
 assert.equal(settings.evaluateColumnTemplate(file,'[="("tc.ext")"] [="Size: "tc.size.kbytes" KiB"]').text,'(md) Size: 1.5 KiB');
 assert.equal(settings.evaluateColumnTemplate({name:'README'},'[="("tc.ext")"]').text,'');
 const missing=settings.evaluateColumnTemplate(file,'[="Created "tc.creationdate.YMD"!"]');assert.equal(missing.text,'');assert.deepEqual(missing.missingFields,['tc.creationdate.YMD']);
 const unavailable=settings.evaluateColumnTemplate(file,'[="Duration "media.duration" seconds"]');assert.equal(unavailable.supported,false);assert.equal(unavailable.text,'');assert.deepEqual(unavailable.unsupportedFields,['media.duration']);
});
test('at most 29 custom views coexist with the standard view while array order remains unchanged',()=>{
 const source=Array.from({length:31},(_,index)=>({id:`view-${index}`,name:`View ${index}`,columns:[{id:'name',field:'[=tc.name]'}]}));
 assert.equal(settings.normalizeColumnSets(source).length,29);
 const standard={id:'standard',name:'Standard',columns:[{id:'name',field:'[=tc.name]'}]};
 const result=settings.normalizeColumnSets([standard,...source]);assert.equal(result.length,30);assert.equal(result.at(-1).id,'view-28');
});

test('native settings describe reference field syntax and bound custom view count',()=>{
 const manifest=require('../package.json');const schema=Object.assign({}, ...manifest.contributes.configuration.map(category => category.properties))['bitfroest.columns.sets'];
 assert.equal(schema.maxItems,30);
 for(const file of ['package.nls.json','package.nls.de.json']){
 const strings=require(`../${file}`);assert.match(strings['configuration.properties.bitfroest.columns.sets.description'],/29/);assert.match(strings['configuration.properties.bitfroest.columns.sets.items.properties.columns.items.properties.field.description'],/\[=file.writedate.YMD\]/);
 }
});

test('every custom column option documents its meaning in both contribution languages', () => {
  const schema = Object.assign({}, ...require('../package.json').contributes.configuration.map(category => category.properties))['bitfroest.columns.sets'];
  const options = [...Object.values(schema.items.properties), ...Object.values(schema.items.properties.columns.items.properties)];
  for (const option of options) {
    assert.match(option.description || '', /^%[^%]+%$/);
    for (const file of ['package.nls.json', 'package.nls.de.json']) {
      assert.ok(require(`../${file}`)[option.description.slice(1, -1)]);
    }
  }
  assert.equal(schema.items.properties.columns.items.properties.width.minimum, 32);
  const alignment = schema.items.properties.columns.items.properties.align;
  assert.equal(alignment.enumDescriptions.length, alignment.enum.length);
});

test('column tables group fields into named sets and apply order, presentation and visibility', () => {
  const tables = { names: { reports: 'Berichte' }, fields: { 'reports.name': '[=tc.fullname]', 'reports.bytes': '[=tc.size]', 'unused.x': 'ignored' }, titles: { 'reports.name': 'My title' }, widths: { 'reports.bytes': 199 }, alignments: { 'reports.bytes': 'right' }, visibility: { 'reports.bytes': false }, order: ['reports.bytes', 'reports.bytes', 'missing.x'] };
  const original = JSON.stringify(tables);
  const sets = settings.columnSetsFromTables(tables);
  assert.equal(sets[0].name, 'Berichte');
  assert.deepEqual(sets[0].columns.map(column => [column.id, column.title, column.width, column.align, column.visible]), [['bytes', 'bytes', 199, 'right', false], ['name', 'My title', 120, 'left', true]]);
  assert.equal(sets.length, 1);
  assert.equal(JSON.stringify(tables), original);
});

test('column tables reject malformed keys and values and identify unavailable fields', () => {
  const sets = settings.columnSetsFromTables({ names: { custom: 'Custom' }, fields: { 'custom.a': '[=plugin.unknown]', 'custom.b': '[=tc.name]', 'custom.bad.key': 'ignored', 'custom.c': null }, widths: { 'custom.a': 4 }, alignments: { 'custom.b': 'invalid' } });
  assert.equal(sets[0].columns.length, 2);
  assert.equal(sets[0].columns[0].width, 32);
  assert.equal(sets[0].columns[1].align, 'left');
  assert.deepEqual(sets[0].unsupportedFields, ['plugin.unknown']);
  assert.equal(settings.columnSetsFromTables({ fields: null })[0].id, 'standard');
  const { t } = require('../media/commander-i18n').create('en');
  assert.equal(settings.columnSetsFromTables({ fields: null }, t)[0].columns.find(column => column.id === 'size').title, 'Size');
});

test('all new column settings can be edited with native scalar, list or table controls', () => {
  const properties = Object.assign({}, ...require('../package.json').contributes.configuration.map(category => category.properties));
  const scalar = schema => ['string', 'number', 'integer', 'boolean'].includes(schema.type);
  for (const name of ['names', 'fields', 'titles', 'widths', 'alignments', 'visibility', 'order']) {
    const schema = properties[`bitfroest.columns.${name}`];
    assert.ok(schema, name);
    assert.ok(scalar(schema) || schema.type === 'array' && scalar(schema.items) || schema.type === 'object' && scalar(schema.additionalProperties), name);
    assert.equal(schema.scope, 'window');
    assert.ok(schema.tags.includes('columnSettings'));
    const pattern = schema.propertyNames?.pattern || schema.items.pattern;
    assert.ok(new RegExp(pattern).test(name === 'names' ? 'reports' : 'reports.file'));
    assert.equal(new RegExp(pattern).test('invalid.key.extra'), false);
    for (const file of ['package.nls.json', 'package.nls.de.json']) assert.ok(require(`../${file}`)[schema.markdownDescription.slice(1, -1)]);
  }
});

test('custom columns have a localized native settings category', () => {
  const categories = require('../package.json').contributes.configuration;
  assert.ok(Array.isArray(categories));
  const category = categories.find(item => item.properties['bitfroest.columns.fields']);
  for (const file of ['package.nls.json', 'package.nls.de.json']) assert.ok(require(`../${file}`)[category.title.slice(1, -1)]);
});

test('path columns use shared native formatting and preserve drive, UNC and POSIX roots', () => {
  const render = file => settings.evaluateColumnTemplate(file, '[=file.path]|[=file.fullpath]').text;
  assert.equal(render({ fsSource: 'c:/git/project/one.txt' }), 'C:\\git\\project|C:\\git\\project\\one.txt');
  assert.equal(render({ fsSource: 'c:/one.txt' }), 'C:\\|C:\\one.txt');
  assert.equal(render({ fsSource: '//server/share/one.txt' }), '\\\\server\\share|\\\\server\\share\\one.txt');
  assert.equal(render({ path: 'c:/explicit', fullpath: 'c:/other/one.txt' }), 'C:\\explicit|C:\\other\\one.txt');
  assert.equal(render({ fsSource: '/home/back\\slash/one.txt' }), '/home/back\\slash|/home/back\\slash/one.txt');
  assert.equal(settings.evaluateColumnTemplate({}, '[=file.path]|[=file.fullpath]').text, '—|—');
});
