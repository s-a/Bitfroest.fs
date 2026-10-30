const zip = require('@zip.js/zip.js');
const zlib = require('node:zlib');
const { Duplex } = require('node:stream');

if (typeof zlib.createZstdDecompress === 'function') {
  class ZstandardDecompressionStream {
    constructor() { return Duplex.toWeb(zlib.createZstdDecompress()); }
  }
  for (const compressionMethod of [93, 20]) zip.registerCodec({ compressionMethod, format: 'zstd', DecompressionStream: ZstandardDecompressionStream, versionNeeded: 63 });
}
const readableMethod = method => zip.getSupportedCompressionMethods().some(codec => codec.compressionMethod === method && codec.decompression);
module.exports = { readableMethod };
