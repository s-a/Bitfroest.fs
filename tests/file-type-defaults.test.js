const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../file-type-colors.json');
const colors = require('../media/commander-file-colors');
const manifest = require('../package.json');
const defaults = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties))['bitfroest.colors.rules'].default;

test('default groups cover related Office variants and development file families', () => {
  const families = [
    ['report.docx', 'report.docm', 'template.dotm', 'text.odt', 'text.sxw', 'text.sdw'],
    ['budget.xlsx', 'budget.xlsm', 'budget.xlsb', 'template.xltm', 'sheet.ods', 'sheet.sxc', 'sheet.sdc', 'table.csv'],
    ['talk.pptx', 'talk.pptm', 'show.ppsm', 'template.potm', 'slides.odp', 'slides.sxi', 'slides.sdd'],
    ['drawing.vsdx', 'drawing.vstm', 'drawing.vssm', 'drawing.odg', 'drawing.drawio'],
    ['data.accdb', 'data.accdt', 'data.sqlite3', 'data.odb'],
    ['message.msg', 'archive.pst', 'template.oft', 'event.ics', 'contacts.vcf'],
    ['main.rs', 'main.go', 'main.py', 'main.cs', 'main.ts', 'types.d.ts', 'component.tsx', 'main.lua', 'main.zig'],
    ['package.json', 'Cargo.toml', 'pom.xml', 'project.csproj', 'Makefile', 'Dockerfile', 'CMakeLists.txt'],
    ['README', 'README.md', 'LICENSE', 'CHANGELOG.md'],
    ['archive.zip', 'archive.tar.gz', 'archive.tar.xz', 'archive.7z'],
    ['image.png', 'image.jpeg', 'image.webp'],
    ['key.pem', 'id_rsa', 'id_ed25519', 'known_hosts']
  ];
  for (const names of families) {
    const expected = colors.match(names[0], defaults);
    assert.ok(expected, `missing ${names[0]}`);
    for (const name of names) assert.equal(colors.match(name, defaults), expected, name);
  }
  assert.notEqual(colors.match('report.docx', defaults), colors.match('budget.xlsx', defaults));
  assert.notEqual(colors.match('budget.xlsx', defaults), colors.match('talk.pptx', defaults));
});

test('common media and everyday formats have consistent family colors', () => {
  const families = [
    ['song.mp3', 'song.wav', 'song.flac', 'song.aac', 'song.m4a', 'song.ogg', 'song.opus', 'song.wma', 'song.aiff', 'song.mid'],
    ['clip.mp4', 'clip.mkv', 'clip.mov', 'clip.avi', 'clip.webm', 'clip.m4v', 'clip.wmv', 'clip.mpeg', 'clip.mpg', 'clip.m2ts'],
    ['captions.srt', 'captions.vtt', 'captions.ass', 'captions.ssa', 'captions.sub'],
    ['playlist.m3u', 'playlist.m3u8', 'playlist.wpl', 'playlist.xspf'],
    ['book.epub', 'book.mobi', 'book.azw3', 'book.fb2', 'book.cbz', 'book.cbr'],
    ['photo.jpg', 'photo.heif', 'photo.jxl', 'photo.dng', 'photo.cr2', 'photo.nef', 'photo.arw', 'image.psd', 'image.xcf'],
    ['disk.iso', 'disk.img', 'disk.dmg', 'disk.vhdx', 'disk.vmdk', 'disk.qcow2'],
    ['archive.zip', 'archive.cab', 'archive.lz', 'archive.lzma', 'archive.br']
  ];
  for (const names of families) {
    const expected = colors.match(names[0], defaults);
    assert.ok(expected, names[0]);
    for (const name of names) {
      assert.equal(colors.match(name.toUpperCase(), defaults), expected, name);
    }
  }
  assert.equal(new Set(families.slice(0, 5).map(names => colors.match(names[0], defaults))).size, 5);
  assert.equal(colors.match('circuit.vhd', defaults), colors.match('circuit.vhdl', defaults));
  assert.equal(colors.match('module.mts', defaults), colors.match('module.ts', defaults));
  assert.equal(colors.match('package.pls', defaults), colors.match('package.sql', defaults));
});

test('grouped source and native settings default agree without duplicate or path rules', () => {
  assert.ok(groups.length >= 15);
  const flat = {}, seen = new Set();
  for (const group of groups) {
    assert.match(group.color, /^#[\da-f]{6}$/i);
    for (const pattern of group.patterns) {
      assert.equal(pattern.includes('/'), false, pattern);
      assert.equal(seen.has(pattern.toLowerCase()), false, pattern);
      seen.add(pattern.toLowerCase()); flat[pattern] = group.color;
    }
  }
  assert.deepEqual(defaults, flat);
  for (const name of ['unknown.extension', 'arbitrary.dat', 'arbitrary.bin', 'arbitrary.lock', 'arbitrary.config', 'arbitrary.tmp']) assert.equal(colors.match(name, defaults), null, name);
  assert.notEqual(colors.match('package.json', defaults), colors.match('data.json', defaults));
});

test('all group colors meet existing contrast requirements on light, dark and hover backgrounds', () => {
  assert.ok(groups.length);
  for (const group of groups) for (const background of ['#ffffff', '#181818', '#2a2d2e', '#789abc']) {
    assert.ok(colors.ratio(colors.readable(group.color, background), background) >= 4.5, group.id + background);
  }
});

test('compiled catalog matcher retains snapshots, custom overrides and compound pattern priority', () => {
  const rules = { ...defaults, '*.d.ts': '#112233' }, match = colors.compile(rules);
  assert.equal(match('MODEL.D.TS'), '#112233');
  assert.equal(match('budget.XLSX'), colors.match('budget.xlsx', defaults));
  rules['*.d.ts'] = '#445566';
  assert.equal(match('model.d.ts'), '#112233');
  assert.equal(colors.compile(rules)('model.d.ts'), '#445566');
});

test('catalog extension and named-file fixtures are covered apart from generic dump files', () => {
  const match = colors.compile(defaults);
  let checked = 0;
  for (const candidate of require('./fixtures/file-type-candidates.json')) {
    let name = candidate;
    if (name.startsWith('.') && !name.includes('*') && !Object.hasOwn(defaults, name)) name = 'example' + name;
    name = name.replaceAll('*', 'example').replaceAll('?', 'x');
    assert.ok(match(name), candidate); checked++;
  }
  assert.ok(checked > 300);
});
