const fs = require('node:fs/promises');
const path = require('node:path');
const espree = require('espree');
const esbuild = require('esbuild');
const options = {
  entryPoints: [path.join(__dirname, 'xray-editor.mjs')], outfile: path.join(__dirname, '../media/xray-editor.js'), bundle: true, minify: true, format: 'iife', legalComments: 'external', loader: { '.ttf': 'file' }, assetNames: 'xray-[name]',
  plugins: [{ name: 'webview-style-nonce', setup(build) {
    build.onLoad({ filter: /domStylesheets\.js$/ }, async args => ({ contents: (await fs.readFile(args.path, 'utf8')).replace("const style = document.createElement('style');", "const style = document.createElement('style'); style.nonce = document.querySelector('meta[name=webview-nonce]')?.content || '';"), loader: 'js' }));
    build.onLoad({ filter: /basic-languages[\\/](?:typescript|python|xml|yaml)[\\/][a-z]+\.js$/ }, async args => ({
      contents: (await fs.readFile(args.path, 'utf8'))
        .replace(/^import '\.\.\/\.\.\/editor\/[^']+';\r?\n/gm, '')
        .replace("import { languages } from '../../editor/editor.api2.js';", "import { IndentAction } from '../../editor/common/standalone/standaloneEnums.js'; const languages = { IndentAction };"),
      loader: 'js'
    }));
  } }]
};
async function main() {
  const preview = await esbuild.build({ ...options, write: false, metafile: true });
  const sources = Object.keys(preview.metafile.inputs).filter(file => /\.[cm]?js$/.test(file));
  const references = (await Promise.all(sources.map(async file => {
    let source = await fs.readFile(file, 'utf8');
    const tree = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', comment: true, range: true });
    for (const comment of tree.comments.reverse()) source = source.slice(0, comment.range[0]) + source.slice(comment.range[1]);
    if (file.endsWith('/codiconsLibrary.js')) return source.split('\n').filter(line => !/^\s+\w+: register\(/.test(line)).join('\n');
    if (file.endsWith('/base/common/network.js')) return source.split('\n').filter(line => !/^\s+Schemas\.\w+ =/.test(line)).join('\n');
    return source;
  }))).join('\n');
  await esbuild.build({ ...options, plugins: [...options.plugins, { name: 'referenced-editor-glyphs', setup(build) {
    build.onLoad({ filter: /base[\\/]common[\\/]network\.js$/ }, async args => ({
      contents: (await fs.readFile(args.path, 'utf8')).split('\n').filter(line => {
        const entry = /^\s+Schemas\.(\w+) = '([^']+)'/.exec(line);
        return !entry || new RegExp('\\b' + entry[1] + '\\b').test(references) || references.includes(entry[2]);
      }).join('\n'), loader: 'js'
    }));
    build.onLoad({ filter: /codiconsLibrary\.js$/ }, async args => ({
      contents: (await fs.readFile(args.path, 'utf8')).split('\n').filter(line => {
        const entry = /^\s+(\w+): register\('([^']+)'/.exec(line);
        return !entry || new RegExp('\\b' + entry[1] + '\\b').test(references) || references.includes(entry[2]);
      }).join('\n'), loader: 'js'
    }));
  } }] });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
