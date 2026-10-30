const assert=require('node:assert/strict');
const test=require('node:test');
const {createReadonlyResources}=require('../readonly-files');
function setup(options={}){
 const registrations=[],mutations=[],stats={size:3,mtimeMs:10,ctimeMs:10,dev:1,ino:2,isFile:()=>true,isSymbolicLink:()=>false};let version=0;
 const uri=path=>({scheme:'bitfroest-conflict',path,toString(){return `${this.scheme}:${this.path}`;}});
 const vscode={Uri:{from:definition=>uri(definition.path)},FileType:{File:1},FilePermission:{Readonly:1},FileSystemError:Object.fromEntries(['NoPermissions','FileNotFound','FileNotADirectory','Unavailable'].map(name=>[name,message=>Object.assign(new Error(message||name),{code:name})])),workspace:{registerFileSystemProvider(scheme,provider,configuration){registrations.push({scheme,provider,configuration});return{dispose(){registrations[0].disposed=true;}};}}};
 const fs={async lstat(){version++;return{...stats,...(options.stat?options.stat(version):{})};},async readFile(){if(options.forbidReadFile)throw new Error('Unbounded read not allowed');return options.bytes||Buffer.from('abc');},async open(){const data=options.bytes||Buffer.from('abc');return {async stat(){return {...stats,...(options.handleChanged?{ino:999}:{})};},async read(buffer,offset,length,position){const bytesRead=Math.min(length,Math.max(0,data.length-position));data.copy(buffer,offset,position,position+bytesRead);return {bytesRead};},async close(){mutations.push('closed');}};},async writeFile(){mutations.push('write');},async rename(){mutations.push('rename');},async unlink(){mutations.push('unlink');}};
 const adapter=createReadonlyResources(vscode,{fs:options.nativeFs||fs,validate:path=>path===(options.original||'C:/tmp/file.bin'),maxBytes:options.maxBytes??1024,maxResources:options.maxResources});
 return{adapter,registrations,mutations,uri};
}
test('conflict resources register a native read-only filesystem with opaque paths',async()=>{
 const h=setup(),resource=await h.adapter.createUri('C:/tmp/file.bin');assert.equal(h.registrations[0].scheme,'bitfroest-conflict');assert.equal(h.registrations[0].configuration.isReadonly,true);assert.doesNotMatch(resource.path,/C:|tmp/);
 const stat=await h.registrations[0].provider.stat(resource);assert.equal(stat.permissions,1);assert.equal(stat.size,3);assert.deepEqual(await h.registrations[0].provider.readFile(resource),Buffer.from('abc'));
});
test('all mutation methods fail before any original filesystem write',async()=>{
 const h=setup(),resource=await h.adapter.createUri('C:/tmp/file.bin'),p=h.registrations[0].provider;
 for(const method of ['writeFile','rename','delete','createDirectory'])await assert.rejects(async()=>p[method](resource,resource),{code:'NoPermissions'});
 assert.deepEqual(h.mutations,[]);p.watch(resource).dispose();
});
test('unregistered and out-of-bounds resources are rejected',async()=>{
 const h=setup();await assert.rejects(h.adapter.createUri('C:/outside/file.bin'));await assert.rejects(async()=>h.registrations[0].provider.readFile(h.uri('/unknown')));await assert.rejects(async()=>h.registrations[0].provider.readDirectory(h.uri('/unknown')));
});
test('oversized and changed originals fail explicitly instead of returning partial comparison text',async()=>{
 const large=setup({maxBytes:2});await assert.rejects(large.adapter.createUri('C:/tmp/file.bin'),{code:'Unavailable'});
 const changed=setup({stat:count=>count>1?{mtimeMs:11}: {}}),resource=await changed.adapter.createUri('C:/tmp/file.bin');await assert.rejects(changed.registrations[0].provider.readFile(resource),{code:'Unavailable'});
 const short=setup({bytes:Buffer.from('ab')}),shortResource=await short.adapter.createUri('C:/tmp/file.bin');await assert.rejects(short.registrations[0].provider.readFile(shortResource),{code:'Unavailable'});
});
test('symlinks and non-files never become comparison resources',async()=>{
 for(const stat of [{isSymbolicLink:()=>true},{isFile:()=>false}]){const h=setup({stat:()=>stat});await assert.rejects(h.adapter.createUri('C:/tmp/file.bin'));}
});
test('disposal frees registered resources and invalidates stale editor requests',async()=>{
 const h=setup(),resource=await h.adapter.createUri('C:/tmp/file.bin');h.adapter.dispose();assert.equal(h.registrations[0].disposed,true);await assert.rejects(async()=>h.registrations[0].provider.readFile(resource));
});

test('complete bytes are obtained through bounded handle reads instead of unbounded readFile',async()=>{
 const h=setup({forbidReadFile:true}),resource=await h.adapter.createUri('C:/tmp/file.bin');assert.deepEqual(await h.registrations[0].provider.readFile(resource),Buffer.from('abc'));
});

test('read-only watchers emit no synthetic changes and old resources expire at the reference bound',async()=>{
 const h=setup({maxResources:1}),p=h.registrations[0].provider;let changes=0;const subscription=p.onDidChangeFile(()=>{changes++;});const first=await h.adapter.createUri('C:/tmp/file.bin');const second=await h.adapter.createUri('C:/tmp/file.bin');await assert.rejects(p.readFile(first),{code:'FileNotFound'});assert.deepEqual(await p.readFile(second),Buffer.from('abc'));subscription.dispose();assert.equal(changes,0);
});
test('changes to an opened handle are rejected and handles are closed on failure',async()=>{
 const h=setup({handleChanged:true}),resource=await h.adapter.createUri('C:/tmp/file.bin');await assert.rejects(h.registrations[0].provider.readFile(resource),{code:'Unavailable'});assert.equal(h.mutations.includes('closed'),true);
});

test('native temporary binary files remain unchanged after read-only resource access and denied mutations',async t=>{
 const native=require('node:fs/promises'),path=require('node:path'),os=require('node:os');const directory=await native.mkdtemp(path.join(os.tmpdir(),'bitfroest-readonly-'));const original=path.join(directory,'file.bin');const bytes=Buffer.from([0,255,1,128]);await native.writeFile(original,bytes);t.after(async()=>{await native.unlink(original);await native.rmdir(directory);});
 const h=setup({nativeFs:native,original}),resource=await h.adapter.createUri(original),p=h.registrations[0].provider;assert.deepEqual(await p.readFile(resource),bytes);for(const method of ['writeFile','rename','delete'])await assert.rejects(async()=>p[method](resource,resource),{code:'NoPermissions'});assert.deepEqual(await native.readFile(original),bytes);h.adapter.dispose();
});

test('trusted snapshot size and modification time are checked before exposing a conflict resource',async()=>{
 const h=setup();await assert.rejects(h.adapter.createUri('C:/tmp/file.bin',{size:4,mtimeMs:10}),{code:'Unavailable'});await assert.rejects(h.adapter.createUri('C:/tmp/file.bin',{size:3,mtimeMs:9}),{code:'Unavailable'});assert.ok(await h.adapter.createUri('C:/tmp/file.bin',{size:3,mtimeMs:10}));
});
