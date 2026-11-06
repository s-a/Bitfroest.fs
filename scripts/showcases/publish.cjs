const fs = require('node:fs');
const path = require('node:path');

const begin = '<!-- showcase-gallery:start -->', end = '<!-- showcase-gallery:end -->';
const mediaDirectory = 'media/marketplace/showcases';
const defaultScenes = new Set(['new-folder', 'new-file', 'delete-confirmations']);
const galleryScenes = new Set([...defaultScenes, 'folder-locks']);
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function mediaName(value) {
  if (!/^\d{4}-windows-en-dark-[a-z0-9-]+\.(png|gif|webm)$/.test(value)) throw new Error('Invalid showcase media filename.');
  return value;
}
function galleryFile(image) {
  const file = mediaName(image.file.endsWith('.webm') ? image.fallback || '' : image.file);
  if (!/\.(png|gif)$/.test(file)) throw new Error('The gallery requires a PNG or GIF capture.');
  return file;
}
function renderGallery(manifest, catalog = []) {
  const lines = [begin, '## Feature walkthrough', '',
    'Windows examples with isolated sample files.', ''];
  const groups = new Map();
  for (const section of manifest.sections.filter(item => item.status === 'rendered' && galleryScenes.has(item.id) && item.images.length)) {
    const scene = catalog.find(item => item.id === section.id);
    const category = scene?.category || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push({ section, scene });
  }
  for (const [category, sections] of groups) {
    lines.push(`### ${escapeHtml(category)}`, '');
    for (const { section, scene } of sections) {
      const title = scene?.title || section.title;
      const shortcuts = Array.isArray(scene?.shortcuts) ? scene.shortcuts.map(key => `<kbd>${escapeHtml(key)}</kbd>`).join(' ') : '';
      lines.push(`<details>`, `<summary>${shortcuts ? `${shortcuts} ` : ''}${escapeHtml(title)}</summary>`, '');
      for (const image of section.images) {
        const alt = image.alt === section.title ? title : image.alt;
        lines.push(`![${alt}](${mediaDirectory}/${galleryFile(image)})`, '');
      }
      lines.push('</details>', '');
    }
  }
  lines.push(end); return lines.join('\n');
}
function updateReadme(text, manifest, catalog = []) {
  const gallery = renderGallery(manifest, catalog), start = text.indexOf(begin), finish = text.indexOf(end);
  if ((start < 0) !== (finish < 0)) throw new Error('The README gallery markers are incomplete.');
  if (start >= 0) text = text.slice(0, start) + gallery + text.slice(finish + end.length);
  else {
    const at = text.indexOf('## Configuration');
    if (at < 0) throw new Error('The README configuration section was not found.');
    text = text.slice(0, at) + gallery + '\n\n' + text.slice(at);
  }
  const overview = manifest.sections.find(section => section.id === 'new-file' && section.status === 'rendered')?.images[0];
  if (overview) {
    const image = `![Create and organize handover notes](${mediaDirectory}/${galleryFile(overview)})`;
    const pattern = /!\[[^\]]*\]\(media\/marketplace\/(?:product-overview\.png|showcases\/\d{4}-windows-en-dark-(?:main-overview|new-file-story)\.(?:png|gif))\)/;
    const galleryStart = text.indexOf(begin);
    let introduction = text.slice(0, galleryStart);
    if (pattern.test(introduction)) introduction = introduction.replace(pattern, image);
    else introduction = introduction.replace(/(\*\*A two-panel file manager[^\n]*\n)/, `$1\n${image}\n`);
    text = introduction + text.slice(galleryStart);
  }
  if (!text.includes('| Ctrl+L |')) text = text.replace('| Ctrl+T / Ctrl+W |', '| Ctrl+L | Edit the active folder path |\n| Ctrl+T / Ctrl+W |');
  return text;
}
function publish(root = path.resolve(__dirname, '../..')) {
  const input = path.join(root, '.tmp/showcases'), output = path.join(root, mediaDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'showcases.json'), 'utf8'));
  const images = manifest.sections.filter(section => section.status === 'rendered' && galleryScenes.has(section.id)).flatMap(section => section.images).map(image => ({ file: galleryFile(image) }));
  if (!images.length) throw new Error('No recorded media are available to publish.');
  for (const image of images) {
    const bytes = fs.readFileSync(path.join(input, mediaName(image.file)));
    if (image.file.endsWith('.gif') ? bytes.toString('ascii', 0, 3) !== 'GIF' : bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`Invalid media: ${image.file}`);
  }
  const readmePath = path.join(root, 'README.md');
  const catalogFile = path.join(root, 'scripts/showcases/catalog.json');
  const catalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : [];
  const before = fs.readFileSync(readmePath, 'utf8'), readme = updateReadme(before, manifest, catalog);
  const references = text => [...text.matchAll(/media\/marketplace\/showcases\/(\d{4}-windows-en-dark-[a-z0-9-]+\.(?:png|gif|webm))/g)].map(match => mediaName(match[1]));
  const retained = new Set([...images.map(image => image.file), ...references(readme)]);
  fs.mkdirSync(output, { recursive: true });
  for (const image of images) fs.copyFileSync(path.join(input, image.file), path.join(output, image.file));
  fs.writeFileSync(readmePath, readme);
  for (const file of new Set(references(before))) {
    const obsolete = path.join(output, file);
    if (!retained.has(file) && fs.existsSync(obsolete)) fs.unlinkSync(obsolete);
  }
  console.log(`Updated README with ${images.length} recorded images and animations in ${mediaDirectory}.`);
}

module.exports = { mediaName, renderGallery, updateReadme, publish, defaultScenes };
if (require.main === module) { try { publish(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
