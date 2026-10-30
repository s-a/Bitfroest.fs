const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const files = {
  '/commander-lister.js': ['commander-lister.js', 'text/javascript; charset=utf-8'],
  '/lister-view.js': ['lister-view.js', 'text/javascript; charset=utf-8'],
  '/workbench-vendor.js': ['workbench-vendor.js', 'text/javascript; charset=utf-8'],
  '/workbench-vendor.css': ['workbench-vendor.css', 'text/css; charset=utf-8'],
  '/workbench-icons.js': ['workbench-icons.js', 'text/javascript; charset=utf-8'],
  '/commander-statusbar.js': ['commander-statusbar.js', 'text/javascript; charset=utf-8'],
  '/webview-bootstrap.js': ['webview-bootstrap.js', 'text/javascript; charset=utf-8'],
  '/commander-clipboard.js': ['commander-clipboard.js', 'text/javascript; charset=utf-8'],
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/commander-file-names.js': ['commander-file-names.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/commander-i18n.js': ['commander-i18n.js', 'text/javascript; charset=utf-8'],
  '/commander-column-settings.js': ['commander-column-settings.js', 'text/javascript; charset=utf-8'],
  '/commander-tabs.js': ['commander-tabs.js', 'text/javascript; charset=utf-8'],
  '/commander-columns.js': ['commander-columns.js', 'text/javascript; charset=utf-8'],
  '/commander-search.js': ['commander-search.js', 'text/javascript; charset=utf-8'],
  '/commander-contrast.js': ['commander-contrast.js', 'text/javascript; charset=utf-8'],
  '/commander-transfer.js': ['commander-transfer.js', 'text/javascript; charset=utf-8']
};
const port = Number(process.env.PROTOTYPE_PORT || 4173);
http.createServer((request, response) => {
  const file = files[new URL(request.url, 'http://127.0.0.1').pathname];
  if (!file) { response.writeHead(404); response.end(); return; }
  fs.readFile(path.join(__dirname, '..', 'media', file[0]), (error, content) => {
    if (error) { response.writeHead(500); response.end(); return; }
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    response.end(file[0] === 'index.html' ? content.toString().replace('<body>', `<body data-extension-version="${require('../package.json').version}">`) : content);
  });
}).listen(port, '127.0.0.1', () => process.stdout.write(`Preview: http://127.0.0.1:${port}\n`));
