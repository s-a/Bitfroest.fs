const assert = require('node:assert/strict');
const test = require('node:test');
const columns = require('../media/commander-columns');

test('normalization preserves order and widths while restoring missing columns', () => {
  const source = [{ key: 'date', width: 205 }, { key: 'name', width: 5 }, { key: 'date', width: 300 }, { key: 'unknown', width: 100 }];
  const result = columns.normalize(source);
  assert.deepEqual(result.map(item => item.key), ['date', 'name', 'type', 'size', 'attributes']);
  assert.equal(result[0].width, 205);
  assert.equal(result[1].width, 80);
  assert.equal(source[1].width, 5);
});


test('name and extension are separate without splitting folders and dotfiles', () => {
  assert.deepEqual(columns.splitName({ name: 'report.final.md', type: 'markdown' }), { name: 'report.final', extension: 'md' });
  assert.deepEqual(columns.splitName({ name: 'folder.with.dot', type: 'folder' }), { name: 'folder.with.dot', extension: '' });
  assert.deepEqual(columns.splitName({ name: '.gitignore', type: 'text' }), { name: '.gitignore', extension: '' });
  assert.deepEqual(columns.splitName({ name: '.config.json', type: 'code' }), { name: '.config', extension: 'json' });
  assert.equal(columns.displayValue({ name: 'docs', type: 'folder' }, 'size'), '');
});

test('folders remain first while both groups follow descending numeric name sorting', () => {
  const items = [
    { name: 'file2.txt', type: 'text' }, { name: 'folder2', type: 'folder' },
    { name: 'file10.txt', type: 'text' }, { name: 'folder10', type: 'folder' }
  ];
  assert.deepEqual(columns.sort(items, 'name', true).map(file => file.name), ['folder10', 'folder2', 'file10.txt', 'file2.txt']);
  assert.equal(items[0].name, 'file2.txt');
});

test('date ordering is chronological across month and year boundaries', () => {
  const items = [
    { name: 'January', date: '01.01.2027 00:00' },
    { name: 'October', date: '29.10.2026 14:32' },
    { name: 'November', date: '02.11.2026 08:05' }
  ];
  assert.deepEqual(columns.sort(items, 'date').map(file => file.name), ['October', 'November', 'January']);
  assert.equal(columns.dateValue({ date: '31.02.2026 12:00' }), -Infinity);
});

test('size and attribute sorting use a name tie-break and preserve equal record order', () => {
  const a = { name: 'same', size: 5 }, b = { name: 'same', size: 5 };
  assert.deepEqual(columns.sort([{ name: 'b', size: 4 }, { name: 'a', size: 4 }], 'size').map(file => file.name), ['a', 'b']);
  const stable = columns.sort([a, b], 'size');
  assert.strictEqual(stable[0], a);
  assert.strictEqual(stable[1], b);
  assert.equal(columns.attributes({ type: 'folder' }), 'd---');
  assert.equal(columns.attributes({ type: 'text' }), '-a--');
  assert.equal(columns.attributes({ attr: 'r-h-' }), 'r-h-');
});

test('the configured standard date column sorts folders chronologically in both directions', () => {
  const settings = require('../media/commander-column-settings');
  const column = settings.catalog.find(column => column.id === 'date');
  const items = [
    { name: 'August', type: 'folder', date: '31.08.2026 19:09:55' },
    { name: 'October', type: 'folder', date: '30.10.2026 16:33:26' },
    { name: 'November early', type: 'folder', date: '02.11.2026 16:15:00' },
    { name: 'November late', type: 'folder', date: '02.11.2026 16:15:40' },
    { name: 'January', type: 'folder', date: '01.01.2027 00:00:00' },
    { name: 'File', type: 'text', date: '02.01.2027 00:00:00' }
  ];
  assert.deepEqual(columns.sort(items, column, true).map(item => item.name), ['January', 'November late', 'November early', 'October', 'August', 'File']);
  assert.deepEqual(columns.sort(items, column).map(item => item.name), ['August', 'October', 'November early', 'November late', 'January', 'File']);
});

test('combined date and time fields sort by their family independently of display formats', () => {
  for (const family of ['write', 'creation', 'access']) for (const provider of ['file', 'tc']) {
    const items = [
      { name: 'older', [`${family}date`]: '2026-08-31T17:09:55Z' },
      { name: 'newer', [`${family}date`]: '2026-11-02T15:15:40Z' },
      { name: 'unknown' }
    ];
    const column = { field: `[=${provider}.${family}date.D/M/y] [=${provider}.${family}time.h:m:s]` };
    assert.deepEqual(columns.sort(items, column, true).map(item => item.name), ['newer', 'older', 'unknown']);
  }
});


test('malformed persisted widths use defaults instead of coercing null and boolean values', () => {
  const result = columns.normalize([
    { key: 'name', width: null }, { key: 'type', width: false }, { key: 'date', width: '' }
  ]);
  assert.equal(result.find(item => item.key === 'name').width, 260);
  assert.equal(result.find(item => item.key === 'type').width, 88);
  assert.equal(result.find(item => item.key === 'date').width, 154);
});


test('normalization accepts saved keys and numeric strings and clamps finite widths', () => {
  assert.equal(columns.normalize(undefined).length, 5);
  const result = columns.normalize([null, 'size', { key: 'name', width: '310.6' }, { key: 'type', width: Infinity }, { key: 'date', width: -5 }]);
  assert.deepEqual(result.map(item => item.key), ['size', 'name', 'type', 'date', 'attributes']);
  assert.equal(result[1].width, 311);
  assert.equal(result[2].width, 88);
  assert.equal(result[3].width, 80);
});


test('display values cover unnamed entries, empty attributes and size units', () => {
  assert.deepEqual(columns.splitName(undefined), { name: '', extension: '' });
  assert.deepEqual(columns.splitName({ name: 'trailing.' }), { name: 'trailing.', extension: '' });
  assert.equal(columns.attributes({ attributes: '' }), '');
  assert.equal(columns.attributes({ attributes: null, type: 'folder' }), 'd---');
  assert.equal(columns.displayValue({ name: 'report.txt' }, 'name'), 'report');
  assert.equal(columns.displayValue({ name: 'report.txt' }, 'type'), 'txt');
  assert.equal(columns.displayValue({ name: 'report.txt' }, 'attributes'), '-a--');
  assert.equal(columns.displayValue({}, 'date'), '');
  assert.equal(columns.displayValue({}, 'unknown'), '');
  assert.equal(columns.displayValue({ size: 82 }, 'size'), '82 B');
  assert.equal(columns.displayValue({ size: 1536 }, 'size'), '1.5 KB');
  assert.equal(columns.displayValue({ size: 1572864 }, 'size'), '1.5 MB');
  assert.equal(columns.displayValue({ size: -8 }, 'size'), '0 B');
});

test('date parser accepts supported sources and rejects invalid dates and times', () => {
  const epoch = Date.UTC(2026, 9, 29, 14, 32);
  assert.equal(columns.dateValue({ date: new Date(epoch) }), epoch);
  assert.equal(columns.dateValue({ date: epoch }), epoch);
  assert.equal(columns.dateValue({ date: '2026-10-29T14:32:00Z' }), epoch);
  assert.equal(columns.dateValue({ date: '29.10.2026' }), Date.UTC(2026, 9, 29));
  assert.equal(columns.dateValue({ date: '29.10.2026 14:32:05' }), epoch + 5000);
  for (const value of [NaN, new Date(NaN), 'invalid', '31.02.2026', '29.13.2026', '29.10.2026 25:00', '29.10.2026 14:70', '2026-20-29']) {
    assert.equal(columns.dateValue({ date: value }), -Infinity);
  }
  assert.equal(columns.dateValue(undefined), -Infinity);
});

test('sorting covers extensions, attributes, defaults and both folder directions', () => {
  const items = [{ name: 'b.md', size: 9, attributes: 'r---' }, { name: 'a.txt', size: 2, attributes: '-a--' }, { name: 'folder', isDirectory: true, size: 4 }];
  assert.deepEqual(columns.sort(items, 'size', true).map(item => item.name), ['folder', 'b.md', 'a.txt']);
  assert.deepEqual(columns.sort(items, 'type').map(item => item.name), ['folder', 'b.md', 'a.txt']);
  assert.deepEqual(columns.sort(items, 'attributes').map(item => item.name), ['folder', 'a.txt', 'b.md']);
  assert.deepEqual(columns.sort(items, 'unknown').map(item => item.name), ['folder', 'a.txt', 'b.md']);
  assert.deepEqual(columns.sort(undefined), []);
  assert.equal(columns.compare(undefined, {}), 0);
  assert.equal(columns.compare({}, {}, 'size'), 0);
  assert.equal(columns.compare({}, {}, 'date'), 0);
  assert.equal(columns.compare({ name: 'a' }, { name: 'b' }), -1);
});



test('custom column normalization preserves only configured columns including hidden fields', () => {
  const input = [{id:'custom-size',title:'Kilobytes',field:'[=tc.size.kbytes]',width:200,align:'right',visible:true},{id:'custom-hidden',title:'Hidden',field:'[=plugin.info]',width:50,align:'center',visible:false}];
  const result = columns.normalize(input);
  assert.deepEqual(result.map(column=>[column.key,column.label,column.field,column.width,column.align,column.visible]),[['custom-size','Größe','[=tc.size.kbytes]',200,'right',true],['custom-hidden','[=plugin.info]','[=plugin.info]',50,'center',false]]);
  assert.equal(result[0].minWidth,32); assert.equal(result[0].maxWidth,1600);
  assert.deepEqual(columns.normalize(result),result);
});
test('custom template display uses supported fields and visibly retains unsupported plugin expressions', () => {
  assert.equal(columns.displayValue({name:'a.txt',size:2048},{field:'File [=tc.fullname]: [=tc.size.kbytes] KiB'}),'File a.txt: 2 KiB');
  assert.equal(columns.displayValue({name:'a.txt'},{field:'[=plugin.unknown]'}),'[=plugin.unknown]');
});
test('custom numeric and date sorts compare metadata semantically and keep folders first', () => {
  const files = [{name:'large',size:10240,date:'01.01.2026',creationdate:'2025-01-01'},{name:'small',size:2048,date:'31.12.2025',creationdate:'2026-01-01'},{name:'dir',type:'folder'}];
  assert.deepEqual(columns.sort(files,{field:'[=tc.size.kbytes]'}).map(file=>file.name),['dir','small','large']);
  assert.deepEqual(columns.sort(files,{field:'[=tc.writedate]'}).map(file=>file.name),['dir','small','large']);
  assert.deepEqual(columns.sort(files,{field:'[=tc.creationdate]'}).map(file=>file.name),['dir','large','small']);
  assert.deepEqual(columns.sort(files,{field:'[=tc.size]'},true).map(file=>file.name),['dir','large','small']);
});

test('custom date and time fields sort their own components and missing metadata safely', () => {
  const files = [{name:'early',date:'02.01.2026 01:00:00'},{name:'late',date:'01.01.2026 23:00:00'},{name:'middle',writetime:'12:30:00'},{name:'unknown'}];
  assert.deepEqual(columns.sort(files,{field:'[=tc.writetime]'}).map(file=>file.name),['unknown','early','middle','late']);
  assert.deepEqual(columns.sort(files.slice(0,2),{field:'[=tc.writedate]'}).map(file=>file.name),['late','early']);
});
test('custom normalization rejects malformed records and lexical sorts use template contents', () => {
  const result = columns.normalize([null,{id:'a',title:'Ext',field:'[=tc.ext]',width:null,align:'invalid'},{id:'a',field:'duplicate'},{field:'missing-id'}, {key:'b',label:'Other',field:'literal',width:9999}]);
  assert.deepEqual(result.map(column=>column.key),['a','b']); assert.equal(result[0].width,120); assert.equal(result[0].align,'left'); assert.equal(result[1].width,1600);
  assert.deepEqual(columns.sort([{name:'a.z'},{name:'z.a'}],result[0]).map(file=>file.name),['z.a','a.z']);
});
