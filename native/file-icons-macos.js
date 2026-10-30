ObjC.import('Foundation');
ObjC.import('AppKit');

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (Number(input.length) > 524288) throw new Error('Icon request exceeds limit');
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding));
  const requests = JSON.parse(text);
  if (!Array.isArray(requests) || requests.length > 24) throw new Error('Too many icon requests');
  const workspace = $.NSWorkspace.sharedWorkspace;
  const manager = $.NSFileManager.defaultManager;
  const result = requests.map(request => {
    let icon = null;
    try {
      if (typeof request.key !== 'string' || request.key.length > 300) return { key: '', icon: null };
      const filePath = typeof request.path === 'string' && request.path.startsWith('/') && !request.path.includes('\0') ? request.path : '';
      let image;
      if (filePath && manager.fileExistsAtPath(filePath)) image = workspace.iconForFile(filePath);
      else if (request.type === 'folder') image = workspace.iconForFileType('public.folder');
      else {
        const name = typeof request.name === 'string' ? request.name : '';
        const suffix = name.includes('.') ? name.split('.').pop() : '';
        image = workspace.iconForFileType(suffix || 'public.data');
      }
      const representation = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
      const png = representation.representationUsingTypeProperties($.NSPNGFileType, $.NSDictionary.dictionary);
      if (Number(png.length) <= 65536) icon = 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    } catch (_) { icon = null; }
    return { key: request.key, icon };
  });
  return JSON.stringify(result);
}
