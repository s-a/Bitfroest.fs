ObjC.import('Foundation');
ObjC.import('AppKit');

function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (Number(data.length) > 1048576) throw new Error('Clipboard request exceeds limit.');
  const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
  const clipboard = $.NSPasteboard.generalPasteboard;
  function selection() {
    const before = Number(clipboard.changeCount);
    const objects = clipboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $.NSDictionary.dictionary);
    const paths = [];
    if (objects) for (let index = 0; index < Number(objects.count); index++) {
      const url = objects.objectAtIndex(index);
      if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
      if (paths.length > 1024) throw new Error('Too many clipboard files.');
    }
    if (before !== Number(clipboard.changeCount)) throw new Error('Clipboard changed while being read.');
    return { paths, mode: 'copy', token: String(before) };
  }
  if (request.action === 'read') return JSON.stringify(selection());
  if (request.action === 'write') {
    if (request.mode !== 'copy' || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > 1024) throw new Error('Unsupported clipboard selection.');
    const objects = $.NSMutableArray.array;
    for (const path of request.paths) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.length > 4096) throw new Error('Invalid clipboard path.');
      objects.addObject($.NSURL.fileURLWithPath(path));
    }
    clipboard.clearContents;
    if (!clipboard.writeObjects(objects)) throw new Error('File clipboard write failed.');
    return JSON.stringify(selection());
  }
  if (request.action === 'ack') return JSON.stringify({ matched: selection().token === request.token });
  throw new Error('Unsupported clipboard action.');
}
