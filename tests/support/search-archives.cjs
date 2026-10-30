const zlib = require('node:zlib');
function zip(files, options = {}) {
  const chunks = [], entries = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text), encoded = options.encodedNames?.[name] || Buffer.from(name), packed = options.pack ? options.pack(bytes) : zlib.deflateRawSync(bytes), crc = zlib.crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(2048, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(encoded.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(2048, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
    if (options.legacy) { header.writeUInt16LE(0, 6); central.writeUInt16LE(0, 8); }
    if (options.compressionMethod !== undefined) { header.writeUInt16LE(options.compressionMethod, 8); central.writeUInt16LE(options.compressionMethod, 10); header.writeUInt16LE(63, 4); central.writeUInt16LE(63, 6); }
    chunks.push(header, encoded, packed); entries.push(central, encoded); offset += header.length + encoded.length + packed.length;
  }
  const directory = Buffer.concat(entries), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length / 2, 8); end.writeUInt16LE(entries.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
function tar(entries) {
  const chunks = [];
  for (const item of entries) {
    const bytes = Buffer.from(item.text || ''), header = Buffer.alloc(512); header.write(item.name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write((item.headerSize ?? bytes.length).toString(8).padStart(11, '0') + '\0', 124); header.write('00000000001\0', 136); header.fill(32, 148, 156); header[156] = (item.type || '0').charCodeAt(0); header.write('ustar\0', 257); header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function pax(values) {
  return Object.entries(values).map(([key, value]) => { const content = `${key}=${value}\n`; let size = Buffer.byteLength(content) + 2; while (size !== Buffer.byteLength(content) + String(size).length + 1) size = Buffer.byteLength(content) + String(size).length + 1; return `${size} ${content}`; }).join('');
}
module.exports = { zip, tar, pax };
