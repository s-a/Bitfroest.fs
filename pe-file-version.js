const fs = require('node:fs/promises');
const MAX_RESOURCE_BYTES = 1048576;
const MAX_HEADER_OFFSET = 16777216;

function range(buffer, offset, size) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset + size <= buffer.length;
}
function headerLocation(dos, fileSize) {
  if (!Buffer.isBuffer(dos) || !range(dos,0,64) || dos.toString('ascii',0,2) !== 'MZ') return null;
  const offset = dos.readUInt32LE(0x3c);
  return offset >= 64 && offset <= MAX_HEADER_OFFSET && offset + 24 <= fileSize ? offset : null;
}
function headerLength(header) {
  if (!range(header,0,24) || header.readUInt32LE(0) !== 0x4550) return null;
  const sections=header.readUInt16LE(6), optionalSize=header.readUInt16LE(20);
  return sections >= 1 && sections <= 96 && optionalSize >= 120 && optionalSize <= 4096 ? 24 + optionalSize + sections*40 : null;
}
function resourceLocation(header, fileSize) {
  const length=headerLength(header);
  if (!length || !range(header,0,length)) return null;
  const optionalSize=header.readUInt16LE(20), magic=header.readUInt16LE(24), optional=24;
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const directories=magic===0x20b?112:96, count=directories-4;
  if (optionalSize < directories+24 || header.readUInt32LE(optional+count)<3) return null;
  const rva=header.readUInt32LE(optional+directories+16), size=header.readUInt32LE(optional+directories+20);
  if (!rva || size < 16 || size > MAX_RESOURCE_BYTES) return null;
  for(let i=0;i<header.readUInt16LE(6);i++) {
    const offset=24+optionalSize+i*40, start=header.readUInt32LE(offset+12), rawSize=header.readUInt32LE(offset+16), raw=header.readUInt32LE(offset+20);
    if(rva>=start && rva-start+size<=rawSize && raw+rva-start+size<=fileSize) return {offset:raw+rva-start,size,rva};
  }
  return null;
}
function resourceVersion(resource, baseRva) {
  function block(offset, limit) {
    if (!range(resource, offset, 6)) return null;
    const end = offset + resource.readUInt16LE(offset), type = resource.readUInt16LE(offset + 4);
    if (end > limit || end <= offset + 6 || type > 1) return null;
    let keyEnd = offset + 6;
    while (keyEnd + 2 <= end && resource.readUInt16LE(keyEnd)) keyEnd += 2;
    if (keyEnd + 2 > end) return null;
    const key = resource.toString('utf16le', offset + 6, keyEnd), start = (keyEnd + 5) & ~3;
    const valueEnd = start + resource.readUInt16LE(offset + 2) * (type ? 2 : 1);
    if (valueEnd > end) return null;
    return { key, type, start, valueEnd, end, children: (valueEnd + 3) & ~3 };
  }
  function children(parent) {
    const result = [];
    for (let offset = parent.children; offset + 6 <= parent.end;) {
      const child = block(offset, parent.end);
      if (!child) break;
      result.push(child); offset = (child.end + 3) & ~3;
    }
    return result;
  }
  function versionString(start, end) {
    const root = block(start, end);
    if (!root) return undefined;
    const parts = children(root), tables = parts.filter(part => part.key === 'StringFileInfo').flatMap(children);
    const translations = parts.filter(part => part.key === 'VarFileInfo').flatMap(children).find(part => part.key === 'Translation');
    const preferred = [];
    if (translations) for (let i = translations.start; i + 4 <= translations.valueEnd; i += 4) preferred.push(resource.readUInt16LE(i).toString(16).padStart(4, '0') + resource.readUInt16LE(i + 2).toString(16).padStart(4, '0'));
    const byName = new Map(tables.map(table => [table.key.toLowerCase(), table]));
    const ordered = [...new Set([...preferred.map(key => byName.get(key)).filter(Boolean), ...tables])];
    for (const table of ordered) {
      const entry = children(table).find(item => item.key === 'FileVersion' && item.type === 1);
      if (!entry) continue;
      const text = resource.toString('utf16le', entry.start, entry.valueEnd).replace(/\0.*$/s, '');
      if (text) return text;
    }
    return undefined;
  }
  function entries(offset) {
    if(!range(resource,offset,16)) return [];
    const count=resource.readUInt16LE(offset+12)+resource.readUInt16LE(offset+14);
    if(count>4096 || !range(resource,offset+16,count*8)) return [];
    return Array.from({length:count},(_,i)=>({name:resource.readUInt32LE(offset+16+i*8),target:resource.readUInt32LE(offset+20+i*8)}));
  }
  function value(offset) {
    if(!range(resource,offset,16)) return null;
    const rva=resource.readUInt32LE(offset), length=resource.readUInt32LE(offset+4), start=rva-baseRva;
    if(!range(resource,start,length) || length<92) return null;
    const end=start+resource.readUInt16LE(start), valueLength=resource.readUInt16LE(start+2), type=resource.readUInt16LE(start+4);
    if(end>start+length || end<start+92 || valueLength!==52 || type!==0 || resource.toString('utf16le',start+6,start+38)!=='VS_VERSION_INFO\0') return null;
    const fixed=start+40;
    if(resource.readUInt32LE(fixed)!==0xFEEF04BD || resource.readUInt32LE(fixed+4)!==0x00010000) return null;
    const ms=resource.readUInt32LE(fixed+8),ls=resource.readUInt32LE(fixed+12);
    const result = { version: [ms>>>16,ms&65535,ls>>>16,ls&65535] };
    const text = versionString(start, end);
    if (text !== undefined) result.versionString = text;
    return result;
  }
  for(const type of entries(0)) {
    if(type.name!==16 || !(type.target&0x80000000)) continue;
    for(const name of entries(type.target&0x7fffffff)) {
      if(!(name.target&0x80000000)) continue;
      for(const language of entries(name.target&0x7fffffff)) {
        if(language.target&0x80000000) continue;
        const version=value(language.target);
        if(version) return version;
      }
    }
  }
  return null;
}
function parseVersionInfo(buffer) {
  if(!Buffer.isBuffer(buffer)) return null;
  const offset=headerLocation(buffer,buffer.length);
  if(offset===null) return null;
  const location=resourceLocation(buffer.subarray(offset),buffer.length);
  return location ? resourceVersion(buffer.subarray(location.offset,location.offset+location.size),location.rva) : null;
}
async function getFileVersionInfo(filePath, options={}) {
  if(typeof filePath!=='string' || !/\.(exe|dll)$/i.test(filePath)) return null;
  let handle;
  try {
    handle=await (options.fs||fs).open(filePath,'r');
    const stat=await handle.stat();
    if(!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size<64) return null;
    async function read(offset,size) {
      if(offset<0 || offset+size>stat.size) return null;
      const buffer=Buffer.alloc(size);
      let done=0;
      while(done<size) {
        const {bytesRead}=await handle.read(buffer,done,size-done,offset+done);
        if(!Number.isInteger(bytesRead) || bytesRead<=0 || bytesRead>size-done) return null;
        done+=bytesRead;
      }
      return buffer;
    }
    const dos=await read(0,64), offset=headerLocation(dos,stat.size);
    if(offset===null) return null;
    const initial=await read(offset,24), length=initial&&headerLength(initial);
    if(!length || offset+length>stat.size) return null;
    const header=await read(offset,length);
    if(!header) return null;
    const location=resourceLocation(header,stat.size);
    if(!location) return null;
    const resource=await read(location.offset,location.size);
    return resource ? resourceVersion(resource,location.rva) : null;
  } catch { return null; }
  finally { if(handle) { try { await handle.close(); } catch { /* The unavailable version remains nonfatal. */ } } }
}
function parseVersion(buffer) { return parseVersionInfo(buffer)?.version ?? null; }
async function getFileVersion(filePath, options = {}) { return (await getFileVersionInfo(filePath, options))?.version ?? null; }
module.exports={parseVersion,getFileVersion,parseVersionInfo,getFileVersionInfo};
