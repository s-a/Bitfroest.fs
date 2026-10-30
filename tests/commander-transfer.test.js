const test = require('node:test');
const assert = require('node:assert/strict');
const transfer = require('../media/commander-transfer');

function file(id, name, content = id, extra = {}) { return { id, name, type: 'text', content, size: content.length, date: '29.10.2026 14:32', ...extra }; }
function setup(extra = {}) {
  return { folders: { '/source': [file('s', 'same.txt', 'new')], '/target': [file('t', 'same.txt', 'old')], ...extra }, sourcePath: '/source', targetPath: '/target', ids: ['s'], mode: 'copy' };
}

test('default conflicts require an explicit decision and cancel without altering target', async () => {
  const options = setup(); let conflict;
  const result = await transfer.execute({ ...options, onConflict: value => { conflict = value; return { action: 'cancel' }; } });
  assert.equal(conflict.source.name, 'same.txt');
  assert.equal(result.cancelled, true);
  assert.equal(options.folders['/target'][0].content, 'old');
  assert.equal(options.folders['/source'][0].content, 'new');
});

test('copying and moving without conflicts use independent entries', async () => {
  for (const mode of ['copy', 'move']) {
    const options = setup({ '/target': [] });
    const result = await transfer.execute({ ...options, mode });
    assert.equal(result.completed, 1);
    assert.equal(options.folders['/target'][0].content, 'new');
    assert.notEqual(options.folders['/target'][0].id, 's');
    assert.equal(options.folders['/source'].length, mode === 'move' ? 0 : 1);
  }
});

test('overwrite, skip and cancel decisions do not act on unselected entries', async () => {
  for (const action of ['overwrite', 'skip', 'cancel']) {
    const options = setup(); options.folders['/source'].push(file('keep', 'keep.txt'));
    const result = await transfer.execute({ ...options, mode: 'move', onConflict: () => ({ action }) });
    assert.equal(options.folders['/target'][0].content, action === 'overwrite' ? 'new' : 'old');
    assert.ok(options.folders['/source'].some(item => item.id === 'keep'));
    assert.equal(result.cancelled, action === 'cancel');
  }
});

test('overwrite-all and skip-all are explicit policies for remaining conflicts', async () => {
  for (const action of ['overwrite-all', 'skip-all']) {
    const options = setup(); options.ids.push('s2'); options.folders['/source'].push(file('s2', 'two.txt', 'new-two')); options.folders['/target'].push(file('t2', 'two.txt', 'old-two'));
    let prompts = 0;
    const result = await transfer.execute({ ...options, onConflict: () => { prompts++; return { action }; } });
    assert.equal(prompts, 1);
    assert.equal(result.completed, action === 'overwrite-all' ? 2 : 0);
    assert.equal(options.folders['/target'][1].content, action === 'overwrite-all' ? 'new-two' : 'old-two');
  }
});

test('single-file destination can rename the copied file within its own directory', async () => {
  const options = setup();
  const result = await transfer.execute({ ...options, targetPath: '/source/renamed.txt' });
  assert.equal(result.completed, 1);
  assert.deepEqual(options.folders['/source'].map(item => item.name), ['same.txt', 'renamed.txt']);
});

test('automatic and explicit source renames preserve the preexisting target', async () => {
  for (const choice of [{ action: 'autorename-source' }, { action: 'rename-source', name: 'chosen.txt' }]) {
    const options = setup(); await transfer.execute({ ...options, onConflict: () => choice });
    assert.equal(options.folders['/target'][0].content, 'old');
    assert.equal(options.folders['/target'][1].name, choice.name || 'same (2).txt');
  }
});

test('renaming an existing target preserves its contents before the source is copied', async () => {
  for (const choice of [{ action: 'autorename-target' }, { action: 'rename-target', name: 'old-version.txt' }]) {
    const options = setup(); await transfer.execute({ ...options, onConflict: () => choice });
    assert.equal(options.folders['/target'].find(item => item.name === (choice.name || 'same (2).txt')).content, 'old');
    assert.equal(options.folders['/target'].find(item => item.name === 'same.txt').content, 'new');
  }
});

test('append requires an explicit choice and combines text in target then removes moved source', async () => {
  const options = setup(); await transfer.execute({ ...options, mode: 'move', onConflict: () => ({ action: 'append' }) });
  assert.equal(options.folders['/target'][0].content, 'oldnew');
  assert.equal(options.folders['/source'].length, 0);
});

test('newer/larger/smaller policies compare source metadata rather than blindly overwriting', async () => {
  for (const [policy, sourceExtra, expected] of [['overwrite-older', { date: '30.10.2026 01:00' }, 'new'], ['overwrite-older', { date: '28.10.2026 01:00' }, 'old'], ['larger', { size: 100 }, 'new'], ['larger', { size: 1 }, 'old'], ['smaller', { size: 1 }, 'new'], ['smaller', { size: 100 }, 'old']]) {
    const options = setup(); Object.assign(options.folders['/source'][0], sourceExtra);
    await transfer.execute({ ...options, policy });
    assert.equal(options.folders['/target'][0].content, expected);
  }
});

test('directory merges preserve unrelated target children and resolve nested file collisions', async () => {
  const options = setup({ '/source': [file('folder', 'docs', '', { type: 'folder' })], '/target': [file('target-folder', 'docs', '', { type: 'folder' })], '/source/docs': [file('child', 'same.txt', 'new')], '/target/docs': [file('old-child', 'same.txt', 'old'), file('unrelated', 'keep.txt')] });
  options.ids = ['folder'];
  await transfer.execute({ ...options, onConflict: () => ({ action: 'overwrite' }) });
  assert.equal(options.folders['/target/docs'].find(item => item.name === 'same.txt').content, 'new');
  assert.ok(options.folders['/target/docs'].some(item => item.name === 'keep.txt'));
});

test('partial directory moves keep skipped children and remove only completed source entries', async () => {
  const options = setup({ '/source': [file('folder', 'docs', '', { type: 'folder' })], '/target': [file('target-folder', 'docs', '', { type: 'folder' })], '/source/docs': [file('one', 'same.txt'), file('two', 'other.txt')], '/target/docs': [file('old', 'same.txt')] });
  options.ids = ['folder'];
  await transfer.execute({ ...options, mode: 'move', onConflict: () => ({ action: 'skip' }) });
  assert.deepEqual(options.folders['/source/docs'].map(item => item.name), ['same.txt']);
  assert.ok(options.folders['/source'].some(item => item.name === 'docs'));
  assert.ok(options.folders['/target/docs'].some(item => item.name === 'other.txt'));
});

test('copying folders into their own descendant and invalid renames leave data unchanged', async () => {
  const options = setup({ '/source': [file('folder', 'docs', '', { type: 'folder' })], '/source/docs': [] }); options.ids = ['folder'];
  const before = JSON.stringify(options.folders);
  const result = await transfer.execute({ ...options, targetPath: '/source/docs' });
  assert.ok(result.errors.length);
  assert.equal(JSON.stringify(options.folders), before);
  const conflict = setup();
  const invalid = await transfer.execute({ ...conflict, onConflict: () => ({ action: 'rename-source', name: '../escape' }) });
  assert.ok(invalid.errors.length);
  assert.equal(conflict.folders['/target'].length, 1);
});

test('wildcard filters apply to files without pruning selected directories', async () => {
  const options = setup({ '/source': [file('folder', 'docs', '', { type: 'folder' })], '/source/docs': [file('a', 'first.txt'), file('b', 'second.md'), file('c', 'secret.txt')], '/target': [] }); options.ids = ['folder'];
  await transfer.execute({ ...options, filter: '*.txt | secret*' });
  assert.deepEqual(options.folders['/target/docs'].map(item => item.name), ['first.txt']);
});

test('archive children follow renamed files and overwrite cleans only the exact replaced tree', async () => {
  const options = setup({ '/source': [file('archive', 'pack.zip', '', { type: 'archive' })], '/source/pack.zip!': [file('inner', 'inside.txt')], '/target': [file('previous', 'pack.zip', '', { type: 'archive' })], '/target/pack.zip!': [file('old', 'old.txt')], '/target/pack.zip!backup': [file('kept', 'keep.txt')] }); options.ids = ['archive'];
  await transfer.execute({ ...options, policy: 'overwrite-all' });
  assert.equal(options.folders['/target/pack.zip!'][0].name, 'inside.txt');
  assert.ok(options.folders['/target/pack.zip!backup']);
});

test('Windows drive destinations preserve their absolute drive rather than becoming relative paths', async () => {
  const folders = { 'C:/tmp': [file('source', 'readme.txt')], 'C:/temp': [] };
  const result = await transfer.execute({ folders, sourcePath: 'C:/tmp', targetPath: 'C:\\temp', ids: ['source'] });
  assert.equal(result.completed, 1);
  assert.equal(folders['C:/temp'][0].name, 'readme.txt');
});

test('invalid sources, empty selections and missing targets fail before any mutation', async () => {
  for (const overrides of [{ folders: null }, { sourcePath: '/missing' }, { ids: [] }, { ids: null }, { targetPath: undefined }, { targetPath: '/missing/deep/file.txt' }]) {
    const options = setup(); const before = JSON.stringify(options.folders);
    const result = await transfer.execute({ ...options, ...overrides });
    assert.ok(result.errors.length);
    assert.equal(JSON.stringify(options.folders), before);
  }
});

test('relative and quoted paths normalize without losing root and filters match literals safely', () => {
  assert.equal(transfer.normalizePath('"../target/./folder"', '/source/inner'), '/source/target/folder');
  assert.equal(transfer.normalizePath('../../..', '/source'), '/');
  assert.equal(transfer.normalizePath('', '/source'), '/source');
  assert.equal(transfer.matches('notes.txt', ' | secret*'), true);
  assert.equal(transfer.matches('secret.txt', ' | secret*'), false);
  assert.equal(transfer.matches('[file].txt', '[file].txt'), true);
  assert.equal(transfer.matches('other.txt', '*.md;*.txt'), true);
  assert.equal(transfer.matches('book.txt', 'b??k.txt'), true);
});

test('same-path overwrite cannot destroy the source while explicit source rename remains available', async () => {
  const options = setup();
  const result = await transfer.execute({ ...options, targetPath: '/source', policy: 'overwrite-all' });
  assert.equal(result.completed, 0);
  assert.match(result.errors[0], /identisch/);
  assert.equal(options.folders['/source'][0].content, 'new');
  await transfer.execute({ ...options, targetPath: '/source', onConflict: () => ({ action: 'autorename-source' }) });
  assert.deepEqual(options.folders['/source'].map(item => item.name), ['same.txt', 'same (2).txt']);
});

test('invalid target renames, binary appends and unknown choices leave conflicts intact', async () => {
  for (const decision of [{ action: 'rename-target', name: '../escape' }, { action: 'rename-target', name: 'same.txt' }, { action: 'unknown' }]) {
    const options = setup();
    const result = await transfer.execute({ ...options, onConflict: () => decision });
    assert.ok(result.errors.length);
    assert.equal(options.folders['/target'][0].content, 'old');
  }
  const binary = setup(); binary.folders['/source'][0].type = 'archive';
  const result = await transfer.execute({ ...binary, onConflict: () => ({ action: 'append' }) });
  assert.ok(result.errors.length);
  assert.equal(binary.folders['/target'][0].content, 'old');
});

test('string decisions and absent resolvers produce deterministic overwrite or cancel behavior', async () => {
  const overwrite = setup();
  await transfer.execute({ ...overwrite, onConflict: () => 'overwrite' });
  assert.equal(overwrite.folders['/target'][0].content, 'new');
  const cancelled = setup();
  const result = await transfer.execute({ ...cancelled, policy: 'unrecognized' });
  assert.equal(result.cancelled, true);
});

test('cancel midway through a directory move preserves all remaining source contents', async () => {
  const options = setup({ '/source': [file('folder', 'docs', '', { type: 'folder' })], '/source/docs': [file('a', 'first.txt'), file('b', 'same.txt'), file('c', 'last.txt')], '/target': [file('d', 'docs', '', { type: 'folder' })], '/target/docs': [file('old', 'same.txt')] }); options.ids = ['folder'];
  const result = await transfer.execute({ ...options, mode: 'move', onConflict: () => ({ action: 'cancel' }) });
  assert.equal(result.cancelled, true);
  assert.deepEqual(options.folders['/source/docs'].map(item => item.name), ['same.txt', 'last.txt']);
  assert.ok(options.folders['/target/docs'].some(item => item.name === 'first.txt'));
});

test('fully moved directories are removed and replacing incompatible target kinds is explicit', async () => {
  const options = setup({ '/source': [file('folder', 'docs', '', { type: 'folder' })], '/source/docs': [file('a', 'inside.txt')], '/target': [file('old', 'docs', 'file-not-directory')] }); options.ids = ['folder'];
  await transfer.execute({ ...options, mode: 'move', onConflict: () => ({ action: 'overwrite' }) });
  assert.deepEqual(options.folders['/source'], []);
  assert.equal(options.folders['/source/docs'], undefined);
  assert.equal(options.folders['/target'][0].type, 'folder');
  assert.equal(options.folders['/target/docs'][0].name, 'inside.txt');
});

test('renaming existing archives relocates their virtual children before replacement', async () => {
  const options = setup({ '/source': [file('new', 'pack.zip', '', { type: 'archive' })], '/source/pack.zip!': [file('n', 'new.txt')], '/target': [file('old', 'pack.zip', '', { type: 'archive' })], '/target/pack.zip!': [file('o', 'old.txt')] }); options.ids = ['new'];
  await transfer.execute({ ...options, policy: 'autorename-target' });
  assert.equal(options.folders['/target/pack (2).zip!'][0].name, 'old.txt');
  assert.equal(options.folders['/target/pack.zip!'][0].name, 'new.txt');
});

test('overwrite-older uses precise filesystem timestamps including epoch zero', async () => {
  const options = setup(); options.policy = 'overwrite-older';
  options.folders['/source'][0].mtimeMs = 2001; options.folders['/target'][0].mtimeMs = 2000;
  const result = await transfer.execute(options); assert.equal(result.completed,1); assert.equal(options.folders['/target'][0].content,'new');
  const equal = setup(); equal.policy = 'overwrite-older'; equal.folders['/source'][0].mtimeMs = 0; equal.folders['/target'][0].mtimeMs = 0;
  equal.folders['/source'][0].date = '30.10.2026';
  assert.equal((await transfer.execute(equal)).completed,0);
});

test('automatic older overwrite protects newer valid versions before comparing timestamps',async()=>{
 for(const [sourceVersion,targetVersion,sourceTime,targetTime,completed] of [[[2,0,0,0],[1,9,9,9],1,100,1],[[1,0,0,0],[2,0,0,0],100,1,0],[[1,0,0,0],[1,0,0,0],2,1,1],[[1,0,0,0],null,2,1,1],[[1,-1,0,0],[2,0,0,0],2,1,1]]){
 const options=setup();Object.assign(options.folders['/source'][0],{fileVersion:sourceVersion,mtimeMs:sourceTime});Object.assign(options.folders['/target'][0],{fileVersion:targetVersion,mtimeMs:targetTime});
 assert.equal((await transfer.execute({...options,policy:'overwrite-older'})).completed,completed);
 }
});
test('older-or-equal policy includes identical version and timestamp but skips newer targets',async()=>{
 for(const [sourceTime,targetTime,completed]of[[1,1,1],[0,1,0],[2,1,1]]){const options=setup();options.folders['/source'][0].mtimeMs=sourceTime;options.folders['/target'][0].mtimeMs=targetTime;
 assert.equal((await transfer.execute({...options,policy:'overwrite-older-equal'})).completed,completed);}
});
test('renaming older targets preserves their contents and skips newer or equally old targets',async()=>{
 for(const [sourceTime,targetTime,completed]of[[2,1,1],[1,2,0],[1,1,0]]){const options=setup();options.folders['/source'][0].mtimeMs=sourceTime;options.folders['/target'][0].mtimeMs=targetTime;
 const result=await transfer.execute({...options,policy:'rename-older-target'});assert.equal(result.completed,completed);
 if(completed){assert.equal(options.folders['/target'].find(file=>file.name==='same (2).txt').content,'old');assert.equal(options.folders['/target'].find(file=>file.name==='same.txt').content,'new');}else assert.equal(options.folders['/target'].length,1);
 }
});
test('automatic collision names use the reference default counter starting at two',()=>{
 assert.equal(transfer.uniqueName([{name:'file.txt'},{name:'file (2).txt'}],'file.txt'),'file (3).txt');
 assert.equal(transfer.uniqueName([{name:'README'}],'README'),'README (2)');
});

test('copy and move create explicitly addressed missing target directories after complete validation',async()=>{
 for(const mode of ['copy','move']){const options=setup();options.targetPath='/target/new/deep/';const result=await transfer.execute({...options,mode});assert.equal(result.completed,1);assert.equal(options.folders['/target/new/deep'][0].content,'new');assert.equal(options.folders['/source'].length,mode==='move'?0:1);}
 const invalid=setup();invalid.folders['/target'].push(file('blocked','blocked'));const before=JSON.stringify(invalid.folders);const result=await transfer.execute({...invalid,targetPath:'/target/blocked/new/'});assert.ok(result.errors.length);assert.equal(JSON.stringify(invalid.folders),before);
});
test('documented destination masks rename files and use one-based original character positions',async()=>{
 for(const [mask,expected]of[['H?.txt','He.txt'],['F*.txt','Fest.txt'],['F*Rest.*','FestRest.txt'],['start_**_rest.*','start_test_rest.txt'],['*.neu','test.neu']])assert.equal(transfer.applyNameMask('test.txt',mask),expected);
 assert.equal(transfer.applyNameMask('name.txt','start_*?do*_rest.*'),'start_dome_rest.txt');
 const options=setup();options.folders['/source'].push(file('s2','other.md'));options.ids.push('s2');const result=await transfer.execute({...options,targetPath:'/target/new/*.neu'});assert.equal(result.completed,2);assert.deepEqual(options.folders['/target/new'].map(file=>file.name),['same.neu','other.neu']);
});
test('self and descendant destinations reject before creating any new directories',async()=>{
 const options=setup({'/source':[file('dir','Folder','',{type:'folder'})],'/source/Folder':[file('child','child.txt')]});options.ids=['dir'];const before=JSON.stringify(options.folders);
 for(const targetPath of ['/source/Folder/new/','/source/Folder/']){const result=await transfer.execute({...options,targetPath});assert.ok(result.errors.length);assert.equal(JSON.stringify(options.folders),before);}
});
test('reference drop modifiers reserve Ctrl-Shift for links instead of silently moving',()=>{
 assert.equal(transfer.dropMode({}),'copy');assert.equal(transfer.dropMode({ctrlKey:true}),'copy');assert.equal(transfer.dropMode({shiftKey:true}),'move');assert.equal(transfer.dropMode({altKey:true}),'move');assert.equal(transfer.dropMode({ctrlKey:true,shiftKey:true}),'link');assert.equal(transfer.dropMode({ctrlKey:true,shiftKey:true,altKey:true}),'link');
});

test('completed top-level identifiers distinguish successful files from filtered, skipped and cancelled entries',async()=>{
 const options=setup({'/source':[file('done','done.txt'),file('s','same.txt'),file('filtered','excluded.bin')],'/target':[file('old','same.txt')]});options.ids=['done','s','filtered'];
 const result=await transfer.execute({...options,filter:'*.txt',onConflict:()=>({action:'skip'})});assert.deepEqual(result.completedIds,['done']);
 const cancel=setup({'/source':[file('done','done.txt'),file('s','same.txt'),file('later','later.txt')]});cancel.ids=['done','s','later'];const cancelled=await transfer.execute({...cancel,onConflict:()=>({action:'cancel'})});assert.deepEqual(cancelled.completedIds,['done']);assert.equal(cancelled.cancelled,true);
});

test('drive-rooted targets and differently cased known Windows folders keep one canonical destination',async()=>{
 const options={folders:{'C:/tmp':[file('s','file.txt')],'C:/temp':[]},sourcePath:'C:/tmp',targetPath:'\\temp\\new\\',ids:['s']};assert.equal(transfer.normalizePath('\\temp\\new\\','C:/tmp'),'C:/temp/new');assert.equal((await transfer.execute(options)).completed,1);assert.equal(options.folders['C:/temp/new'][0].name,'file.txt');
 const alias={folders:{'C:/tmp':[file('s','file.txt')],'C:/temp':[]},sourcePath:'C:/tmp',targetPath:'c:/TEMP/',ids:['s']};assert.equal((await transfer.execute(alias)).completed,1);assert.equal(alias.folders['C:/temp'].length,1);assert.equal(Object.hasOwn(alias.folders,'c:/TEMP'),false);
});
test('documented space-separated file filters match multiple extensions and retain exclusions',()=>{
 assert.equal(transfer.matches('report.txt','*.txt *.doc'),true);assert.equal(transfer.matches('report.doc','*.txt *.doc'),true);assert.equal(transfer.matches('report.old','*.* | *.bak *.old'),false);
});
test('an obsolete selection cannot create a target tree without copying anything',async()=>{
 const options=setup(),before=JSON.stringify(options.folders);const result=await transfer.execute({...options,ids:['missing'],targetPath:'/target/new/deep/'});assert.ok(result.errors.length);assert.equal(JSON.stringify(options.folders),before);
});

test('malformed generated target names fail before mutation',async()=>{

 const options=setup(),original=JSON.stringify(options.folders);assert.ok((await transfer.execute({...options,targetPath:'/target/*bad:'})).errors.length);assert.equal(JSON.stringify(options.folders),original);
 assert.equal(transfer.applyNameMask('.gitignore','*.*'),'.gitignore');assert.equal(transfer.applyNameMask('README','*.txt'),'README.txt');assert.equal(transfer.applyNameMask('a.txt','renamed'),'renamed');assert.equal(transfer.planTarget({...options,targetPath:''}).directory,options.sourcePath);
});
test('case aliases cannot bypass the Windows descendant overlap guard',async()=>{
 const options={folders:{'C:/tmp':[file('dir','Folder','',{type:'folder'})],'C:/tmp/Folder':[],'C:/temp':[]},sourcePath:'C:/tmp',targetPath:'c:/TMP/folder/new/',ids:['dir']};const before=JSON.stringify(options.folders);const result=await transfer.execute(options);assert.ok(result.errors.length);assert.equal(JSON.stringify(options.folders),before);
});

test('individual copy names prompt every selected source and preserve partial cancellation', async () => {
  const options = setup({ '/source': [file('a', 'one.txt'), file('b', 'two.txt'), file('c', 'three.txt')], '/target': [] });
  const seen = [];
  const result = await transfer.execute({ ...options, ids: ['a', 'b', 'c'], individualNames: true, onRename: source => {
    seen.push(source.name);
    return source.id === 'a' ? { name: 'renamed.txt' } : { action: 'cancel' };
  } });
  assert.deepEqual(seen, ['one.txt', 'two.txt']);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.completedIds, ['a']);
  assert.deepEqual(options.folders['/target'].map(row => row.name), ['renamed.txt']);
});

test('individual names may skip an entry and validate Windows reserved destinations before mutation', async () => {
  const options = setup({ '/source': [file('a', 'one.txt'), file('b', 'two.txt')], 'C:/target': [] });
  const result = await transfer.execute({ ...options, targetPath: 'C:/target', ids: ['a', 'b'], individualNames: true, onRename: source => source.id === 'a' ? { action: 'skip' } : { name: 'CON.txt' } });
  assert.equal(result.completed, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(options.folders['C:/target'], []);
});

test('real append records original byte provenance without concatenating preview strings', async () => {
  const options = setup();
  Object.assign(options.folders['/source'][0], { fsSource: '/source/same.txt', size: 1000000, content: 'preview' });
  Object.assign(options.folders['/target'][0], { fsSource: '/target/same.txt', size: 3000000, content: 'old preview' });
  const result = await transfer.execute({ ...options, onConflict: () => 'append' });
  assert.equal(result.completed, 1);
  const target = options.folders['/target'][0];
  assert.deepEqual(target.fsAppend, { source: '/source/same.txt', target: '/target/same.txt' });
  assert.equal(target.size, 4000000);
  assert.equal(target.content, undefined);
});

test('folder masks rename only the selected roots and retain nested file names for copy and move', async () => {
  for (const mode of ['copy', 'move']) {
    const options = { folders: { '/source': [file('dir', 'docs.old', '', { type: 'folder' })], '/source/docs.old': [file('child', 'inside.txt')], '/target': [] }, sourcePath: '/source', targetPath: '/target/*.new', ids: ['dir'], mode };
    const result = await transfer.execute(options);
    assert.deepEqual(result.errors, []); assert.equal(result.completed, 1);
    assert.equal(options.folders['/target'][0].name, 'docs.new');
    assert.equal(options.folders['/target/docs.new'][0].name, 'inside.txt');
    assert.equal(Boolean(options.folders['/source/docs.old']), mode === 'copy');
  }
});

test('several original files append in selection order when destination masks converge', async () => {
  const options = setup({ '/source': [file('a', 'same.one', 'a', { fsSource: '/source/same.one' }), file('b', 'same.two', 'b', { fsSource: '/source/same.two' })], '/target': [file('t', 'same.txt', 't', { fsSource: '/target/same.txt' })] });
  const result = await transfer.execute({ ...options, ids: ['a', 'b'], targetPath: '/target/*.txt', onConflict: () => 'append' });
  assert.equal(result.completed, 2);
  assert.deepEqual(options.folders['/target'][0].fsAppend.sources, ['/source/same.one', '/source/same.two']);
  assert.equal(options.folders['/target'][0].size, 3);
});
