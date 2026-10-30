const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, getFileVersion } = require('../pe-file-version');

function image(version = [2, 12, 345, 6], plus = false) {
  const bytes = Buffer.alloc(0x600), nt=0x80, optional=nt+24, optionalSize=plus?240:224, section=optional+optionalSize;
  bytes.write('MZ');bytes.writeUInt32LE(nt,0x3c);bytes.write('PE\0\0',nt);bytes.writeUInt16LE(1,nt+6);bytes.writeUInt16LE(optionalSize,nt+20);
  bytes.writeUInt16LE(plus?0x20b:0x10b,optional);bytes.writeUInt32LE(16,optional+(plus?108:92));
  const directory=optional+(plus?112:96)+16;bytes.writeUInt32LE(0x1000,directory);bytes.writeUInt32LE(0x300,directory+4);
  bytes.write('.rsrc',section);bytes.writeUInt32LE(0x300,section+8);bytes.writeUInt32LE(0x1000,section+12);bytes.writeUInt32LE(0x400,section+16);bytes.writeUInt32LE(0x200,section+20);
  const root=0x200;
  bytes.writeUInt16LE(1,root+14);bytes.writeUInt32LE(16,root+16);bytes.writeUInt32LE(0x80000020,root+20);
  bytes.writeUInt16LE(1,root+0x20+14);bytes.writeUInt32LE(1,root+0x20+16);bytes.writeUInt32LE(0x80000040,root+0x20+20);
  bytes.writeUInt16LE(1,root+0x40+14);bytes.writeUInt32LE(1033,root+0x40+16);bytes.writeUInt32LE(0x60,root+0x40+20);
  bytes.writeUInt32LE(0x1100,root+0x60);bytes.writeUInt32LE(92,root+0x64);
  const value=root+0x100;bytes.writeUInt16LE(92,value);bytes.writeUInt16LE(52,value+2);bytes.writeUInt16LE(0,value+4);bytes.write('VS_VERSION_INFO\0',value+6,'utf16le');
  const fixed=value+40;bytes.writeUInt32LE(0xFEEF04BD,fixed);bytes.writeUInt32LE(0x00010000,fixed+4);bytes.writeUInt32LE(version[0]*65536+version[1],fixed+8);bytes.writeUInt32LE(version[2]*65536+version[3],fixed+12);
  return bytes;
}
function fakeFile(bytes, overrides = {}) {
  const calls=[], handle={async read(target,offset,length,position){calls.push({length,position});const count=Math.max(0,Math.min(length,bytes.length-position));bytes.copy(target,offset,position,position+count);return {bytesRead:count};},async stat(){return {size:bytes.length,isFile:()=>true};},async close(){calls.push({close:true});}};
  return {calls,fs:{async open(){return {...handle,...overrides};}}};
}
test('extracts the fixed file version from real RT_VERSION trees in PE32 and PE32+ images',()=>{
 for(const plus of [false,true])assert.deepEqual(parseVersion(image([2,12,345,6],plus)),[2,12,345,6]);
 assert.deepEqual(parseVersion(image([0,0,0,0])),[0,0,0,0]);
});
test('rejects arbitrary signature bytes, malformed resource kinds and truncated version values',()=>{
 assert.equal(parseVersion(Buffer.from('FEEF04BD VS_VERSION_INFO')),null);
 const wrong=image();wrong.writeUInt32LE(10,0x210);assert.equal(parseVersion(wrong),null);
 const truncated=image().subarray(0,0x320);assert.equal(parseVersion(truncated),null);
 const bad=image();bad.writeUInt16LE(80,0x300);assert.equal(parseVersion(bad),null);
});
test('bounded file reads obtain only headers and the declared resource and always close the handle',async()=>{
 const file=fakeFile(image());assert.deepEqual(await getFileVersion('C:/tmp/sample.EXE',{fs:file.fs}),[2,12,345,6]);
 assert.ok(file.calls.filter(call=>call.length).reduce((sum,call)=>sum+call.length,0)<2048);assert.equal(file.calls.at(-1).close,true);
});
test('non-PE file types and unavailable files do not invent versions or start processes',async()=>{
 let opened=false;assert.equal(await getFileVersion('example.txt',{fs:{open(){opened=true;throw new Error('unavailable');}}}),null);assert.equal(opened,false);
 assert.equal(await getFileVersion('example.dll',{fs:{open(){throw new Error('unavailable');}}}),null);
});
module.exports={image,fakeFile};

test('filesystem snapshots include versions for executable files without inventing them for unrelated files',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'commander-versions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'sample.dll'),image([4,3,2,1]));await fs.writeFile(path.join(root,'plain.txt'),'ordinary');
 const {createProvider}=require('../filesystem-provider');const state=await createProvider({roots:[root]}).load();
 const files=state.folders[root.replace(/\\/g,'/')];assert.deepEqual(files.find(file=>file.name==='sample.dll').fileVersion,[4,3,2,1]);assert.equal(files.find(file=>file.name==='plain.txt').fileVersion,undefined);
});

test('malformed DOS and PE headers cannot redirect resource reads outside the image',()=>{
 assert.equal(parseVersion(null),null);assert.equal(parseVersion(Buffer.alloc(12)),null);
 const cases=[
  ['DOS signature',bytes=>bytes.write('ZZ')],['low header offset',bytes=>bytes.writeUInt32LE(32,0x3c)],['header offset limit',bytes=>bytes.writeUInt32LE(16777217,0x3c)],['header beyond file',bytes=>bytes.writeUInt32LE(0x5ff,0x3c)],
  ['PE signature',bytes=>bytes.writeUInt32LE(0,0x80)],['zero sections',bytes=>bytes.writeUInt16LE(0,0x86)],['section limit',bytes=>bytes.writeUInt16LE(97,0x86)],['short optional header',bytes=>bytes.writeUInt16LE(20,0x94)],['optional header limit',bytes=>bytes.writeUInt16LE(4097,0x94)],
  ['optional magic',bytes=>bytes.writeUInt16LE(0x999,0x98)],['resource directory absent',bytes=>bytes.writeUInt32LE(2,0x98+92)],['resource RVA absent',bytes=>bytes.writeUInt32LE(0,0x98+112)],['tiny resource',bytes=>bytes.writeUInt32LE(15,0x98+116)],['resource limit',bytes=>bytes.writeUInt32LE(1048577,0x98+116)],
  ['unmapped resource',bytes=>bytes.writeUInt32LE(0x2000,0x98+112)],['resource outside raw section',bytes=>bytes.writeUInt32LE(0x100,0x178+16)],['raw pointer outside file',bytes=>bytes.writeUInt32LE(0xfffffff0,0x178+20)]
 ];
 for(const [description,mutate] of cases){const bytes=image();mutate(bytes);assert.equal(parseVersion(bytes),null,description);}
});
test('resource tree offsets, excessive entry counts and cycles are rejected without following arbitrary signatures',()=>{
 const cases=[
  ['root entry count limit',bytes=>bytes.writeUInt16LE(4097,0x20e)],['root entries beyond section',bytes=>bytes.writeUInt16LE(300,0x20e)],['type is data instead of directory',bytes=>bytes.writeUInt32LE(0x20,0x214)],['directory offset outside resource',bytes=>bytes.writeUInt32LE(0x80000300,0x214)],
  ['name is data',bytes=>bytes.writeUInt32LE(0x40,0x234)],['language loops to directory',bytes=>bytes.writeUInt32LE(0x80000000,0x254)],['data record outside resource',bytes=>bytes.writeUInt32LE(0x2ff,0x254)],['data RVA before resource',bytes=>bytes.writeUInt32LE(1,0x260)],['data extends outside resource',bytes=>bytes.writeUInt32LE(0x1200,0x264)],['short version data',bytes=>bytes.writeUInt32LE(91,0x264)],
  ['invalid root length',bytes=>bytes.writeUInt16LE(500,0x300)],['wrong value length',bytes=>bytes.writeUInt16LE(1,0x302)],['text type',bytes=>bytes.writeUInt16LE(1,0x304)],['wrong root key',bytes=>bytes.write('X',0x306,'utf16le')],['wrong fixed signature',bytes=>bytes.writeUInt32LE(0,0x328)],['unsupported fixed structure',bytes=>bytes.writeUInt32LE(0,0x32c)]
 ];
 for(const [description,mutate] of cases){const bytes=image();mutate(bytes);assert.equal(parseVersion(bytes),null,description);}
});
test('resource enumeration skips unrelated types and malformed alternatives while retaining a valid language',()=>{
 const bytes=image();bytes.writeUInt16LE(2,0x20e);bytes.writeUInt32LE(10,0x210);bytes.writeUInt32LE(16,0x218);bytes.writeUInt32LE(0x80000020,0x21c);
 bytes.writeUInt16LE(2,0x22e);bytes.writeUInt32LE(0x40,0x234);bytes.writeUInt32LE(2,0x238);bytes.writeUInt32LE(0x80000040,0x23c);
 bytes.writeUInt16LE(2,0x24e);bytes.writeUInt32LE(0x80000000,0x254);bytes.writeUInt32LE(1031,0x258);bytes.writeUInt32LE(0x60,0x25c);
 assert.deepEqual(parseVersion(bytes),[2,12,345,6]);
 bytes.writeUInt32LE(0x70,0x254);bytes.writeUInt32LE(1,0x270);bytes.writeUInt32LE(92,0x274);assert.deepEqual(parseVersion(bytes),[2,12,345,6]);
});
test('reader handles partial reads and closes malformed, nonregular and failed-read handles',async()=>{
 const bytes=image(), partial=fakeFile(bytes,{async read(target,offset,length,position){const count=Math.min(length,7,bytes.length-position);bytes.copy(target,offset,position,position+count);return {bytesRead:count};}});
 assert.deepEqual(await getFileVersion('partial.dll',{fs:partial.fs}),[2,12,345,6]);assert.equal(partial.calls.at(-1).close,true);
 for(const overrides of [{async read(){return {bytesRead:0};}},{async read(){return {bytesRead:NaN};}},{async read(){throw new Error('read failed');}},{async stat(){return {size:12,isFile:()=>true};}},{async stat(){return {size:bytes.length,isFile:()=>false};}}]){
  const file=fakeFile(bytes,overrides);assert.equal(await getFileVersion('bad.dll',{fs:file.fs}),null);assert.equal(file.calls.at(-1).close,true);
 }
 const closeError=fakeFile(bytes,{async close(){throw new Error('close failed');}});assert.deepEqual(await getFileVersion('valid.dll',{fs:closeError.fs}),[2,12,345,6]);
});
test('reader rejects invalid image layouts before requesting an oversized allocation',async()=>{
 for(const mutate of [bytes=>bytes.write('ZZ'),bytes=>bytes.writeUInt32LE(0,0x80),bytes=>bytes.writeUInt16LE(90,0x86),bytes=>bytes.writeUInt32LE(1048577,0x98+116)]){
  const bytes=image();mutate(bytes);const file=fakeFile(bytes);assert.equal(await getFileVersion('bad.exe',{fs:file.fs}),null);assert.equal(file.calls.at(-1).close,true);assert.ok(file.calls.every(call=>!call.length||call.length<2000));
 }
});
