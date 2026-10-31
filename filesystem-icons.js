const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { loadNativeApi } = require('./native-api');

const MAX_REQUESTS = 128;
const MAX_CACHE = 512;
const MAX_ICON_BYTES = 131072;
const cache = new Map();
const linuxCache = new Map();

async function boundedFile(filePath, limit, io = fs) {
  const stat = await io.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return null;
  return io.readFile(filePath);
}

async function linuxIcon(request, services = {}) {
  const read = (filePath, limit) => boundedFile(filePath, limit, services.fs || fs);
  const environment = services.env || process.env;
  try {
    let reference = '';
    if (request.type === 'folder' && path.posix.isAbsolute(request.path)) {
      const metadata = await read(path.posix.join(request.path, '.directory'), 65536).catch(() => null);
      if (metadata) {
        let section = '';
        for (const line of metadata.toString('utf8').split(/\r?\n/)) {
          if (/^\[.*\]$/.test(line.trim())) section = line.trim();
          else if (section === '[Desktop Entry]' && /^Icon\s*=/.test(line)) reference = line.slice(line.indexOf('=') + 1).trim();
        }
      }
    }
    if (path.posix.isAbsolute(reference)) return pngData(await read(reference, 65536).catch(() => null));
    if (reference && !/^[\w.+-]+$/.test(reference)) reference = '';
    const suffix = path.posix.extname(request.name).slice(1).toLowerCase();
    const cacheKey = JSON.stringify([reference, request.type, suffix]);
    const cached = linuxCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    function remember(value) {
      linuxCache.set(cacheKey, { value, expires: Date.now() + (value ? 60000 : 10000) });
      while (linuxCache.size > MAX_CACHE) linuxCache.delete(linuxCache.keys().next().value);
      return value;
    }
    const typeNames = { ps1: 'text-x-script', sh: 'application-x-shellscript', exe: 'application-x-executable', dll: 'application-x-sharedlib', md: 'text-markdown', json: 'application-json', png: 'image-x-generic', jpg: 'image-x-generic', zip: 'application-x-archive', txt: 'text-x-generic' };
    const names = [...new Set([reference, request.type === 'folder' ? 'folder' : typeNames[suffix], request.type === 'folder' ? 'folder' : 'text-x-generic'].filter(Boolean))];
    const home = services.home || os.homedir();
    const configRoot = environment.XDG_CONFIG_HOME || path.posix.join(home, '.config');
    const config = await read(path.posix.join(configRoot, 'gtk-3.0/settings.ini'), 65536).catch(() => null);
    const configuredTheme = config?.toString('utf8').match(/^gtk-icon-theme-name\s*=\s*"?([\w.+-]+)"?\s*$/m)?.[1];
    const dataRoots = [environment.XDG_DATA_HOME || path.posix.join(home, '.local/share'), ...(environment.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
    const roots = [...new Set([path.posix.join(home, '.icons'), ...dataRoots.filter(root => path.posix.isAbsolute(root)).map(root => path.posix.join(root, 'icons'))])];
    const themes = [...new Set([configuredTheme, 'hicolor', 'Adwaita'].filter(Boolean))];
    for (const name of names) {
      for (const root of roots) for (const theme of themes) for (const dimension of ['16x16', '24x24', '32x32', '48x48']) for (const category of ['places', 'mimetypes', 'apps']) {
        const bytes = await read(path.posix.join(root, theme, dimension, category, `${name}.png`), 65536).catch(() => null);
        const icon = pngData(bytes);
        if (icon) return remember(icon);
      }
      const icon = pngData(await read(`/usr/share/pixmaps/${name}.png`, 65536).catch(() => null));
      if (icon) return remember(icon);
    }
    return remember(null);
  } catch { return null; }
}

function pngData(bytes) {
  return bytes?.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? `data:image/png;base64,${bytes.toString('base64')}` : null;
}

function normalizeRequests(requests) {
  if (!Array.isArray(requests)) return [];
  return requests.slice(0, MAX_REQUESTS).filter(request => request && typeof request.key === 'string' && request.key.length <= 300).map(request => ({
    key: request.key,
    path: typeof request.path === 'string' && request.path.length <= 4096 && !request.path.includes('\0') ? request.path : '',
    name: typeof request.name === 'string' && request.name.length <= 300 ? path.basename(request.name.replace(/\\/g, '/')) : '',
    type: request.type === 'folder' ? 'folder' : 'file',
    iconResource: typeof request.iconResource === 'string' && request.iconResource.length <= 4096 && !request.iconResource.includes('\0') ? request.iconResource : ''
  }));
}

async function getFilesystemIcons(requests, options = {}) {
  const normalized = normalizeRequests(requests);
  const platform = options.platform || process.platform;
  const result = Object.create(null);
  const pending = [];
  for (const request of normalized) {
    const identity = JSON.stringify([platform, request.path, request.name, request.type, request.iconResource]);
    const saved = cache.get(identity);
    if (saved && saved.expires > Date.now()) result[request.key] = saved.value;
    else { result[request.key] = null; pending.push({ ...request, identity }); }
  }
  if (!pending.length) return result;
  if (platform === 'linux') {
    for (const request of pending) {
      const value = await linuxIcon(request, options.linux);
      result[request.key] = value;
      cache.set(request.identity, { value, expires: Date.now() + (value ? 60000 : 10000) });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    }
    return result;
  }
  if (platform === 'win32' && (!options.testLookup || options.nativeApi)) {
    for (let offset = 0; offset < pending.length; offset += 24) {
      const batch = pending.slice(offset, offset + 24);
      let session, timer;
      try {
        const api = options.nativeApi || loadNativeApi();
        session = api.openSession();
        const response = await Promise.race([
          session.invoke('icons.resolve', { requests: batch.map(({ identity: _identity, ...request }) => request) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Icon lookup timed out.')), options.timeout || 8000); })
        ]);
        const rows = Array.isArray(response?.icons) ? response.icons : [];
        const byKey = new Map(rows.filter(row => row && typeof row.key === 'string').map(row => [row.key, row]));
        for (const request of batch) {
          const png = byKey.get(request.key)?.png;
          const value = Buffer.isBuffer(png) && png.length <= 65536 ? pngData(png) : null;
          result[request.key] = value && value.length <= MAX_ICON_BYTES ? value : null;
          cache.set(request.identity, { value: result[request.key], expires: Date.now() + (result[request.key] ? 60000 : 10000) });
          while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
        }
      } catch {
        for (const request of batch) cache.set(request.identity, { value: null, expires: Date.now() + 5000 });
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      } finally {
        clearTimeout(timer);
        try { session?.close(); } catch { /* Session cleanup must not replace the lookup result. */ }
      }
    }
    return result;
  }
  if (platform === 'darwin' || platform !== 'win32' || typeof options.testLookup !== 'function') return result;
  // An injected lookup service is available for isolated adapter tests.
  const runner = options.testLookup;
  for (let offset = 0; offset < pending.length; offset += 24) {
    const batch = pending.slice(offset, offset + 24);
    try {
      const rows = JSON.parse(await runner(null, [], batch.map(({ identity: _identity, ...request }) => request)));
      if (!Array.isArray(rows)) continue;
      for (const request of batch) {
        const row = rows.find(item => item?.key === request.key);
        const value = typeof row?.icon === 'string' && row.icon.length <= MAX_ICON_BYTES && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(row.icon) ? row.icon : null;
        result[request.key] = value;
        cache.set(request.identity, { value, expires: Date.now() + (value ? 60000 : 10000) });
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
    } catch {
      for (const request of batch) cache.set(request.identity, { value: null, expires: Date.now() + 5000 });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    }
  }
  return result;
}

function clearFilesystemIconCache() { cache.clear(); linuxCache.clear(); }

module.exports = { getFilesystemIcons, clearFilesystemIconCache };
