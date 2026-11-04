const fs = require('node:fs');
const path = require('node:path');

const begin = '<!-- showcase-gallery:start -->', end = '<!-- showcase-gallery:end -->';
const mediaDirectory = 'media/marketplace/showcases';
function mediaName(value) {
  if (!/^\d{4}-windows-en-dark-[a-z0-9-]+\.(png|gif)$/.test(value)) throw new Error('Invalid showcase media filename.');
  return value;
}
function renderGallery(manifest) {
  const lines = [begin, '## Feature walkthrough', '',
    'Windows examples with sample project files. Animations include a pointer highlight and keystroke hints. Drag-and-drop demonstrations stop at the confirmation dialog.', ''];
  for (const section of manifest.sections.filter(item => item.status === 'rendered' && item.id !== 'main')) {
    if (!section.images.length) continue;
    const number = mediaName(section.images[0].file).slice(0, 4);
    lines.push(`<details>`, `<summary>${number} · ${section.title}</summary>`, '', section.description, '');
    for (const image of section.images) lines.push(`![${image.alt}](${mediaDirectory}/${mediaName(image.file)})`, '');
    lines.push('</details>', '');
  }
  lines.push(end); return lines.join('\n');
}
function updateReadme(text, manifest) {
  const gallery = renderGallery(manifest), start = text.indexOf(begin), finish = text.indexOf(end);
  if ((start < 0) !== (finish < 0)) throw new Error('The README gallery markers are incomplete.');
  if (start >= 0) text = text.slice(0, start) + gallery + text.slice(finish + end.length);
  else {
    const at = text.indexOf('## Configuration');
    if (at < 0) throw new Error('The README configuration section was not found.');
    text = text.slice(0, at) + gallery + '\n\n' + text.slice(at);
  }
  const overview = manifest.sections.find(section => section.id === 'main' && section.status === 'rendered')?.images[0];
  if (overview) text = text.replace(/!\[[^\]]*\]\(media\/marketplace\/(?:product-overview\.png|showcases\/\d{4}-windows-en-dark-main-overview\.png)\)/,
    `![Bitfroest.fs with two folders, native Windows icons and file colors](${mediaDirectory}/${mediaName(overview.file)})`);
  if (!text.includes('| Ctrl+L |')) text = text.replace('| Ctrl+T / Ctrl+W |', '| Ctrl+L | Edit the active folder path |\n| Ctrl+T / Ctrl+W |');
  return text;
}
function publish(root = path.resolve(__dirname, '../..')) {
  const input = path.join(root, '.tmp/showcases'), output = path.join(root, mediaDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'showcases.json'), 'utf8'));
  const images = manifest.sections.filter(section => section.status === 'rendered').flatMap(section => section.images);
  if (!images.length) throw new Error('No recorded media are available to publish.');
  for (const image of images) {
    const bytes = fs.readFileSync(path.join(input, mediaName(image.file)));
    if (image.file.endsWith('.gif') ? bytes.toString('ascii', 0, 3) !== 'GIF' : bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`Invalid media: ${image.file}`);
  }
  const readmePath = path.join(root, 'README.md');
  const readme = updateReadme(fs.readFileSync(readmePath, 'utf8'), manifest);
  fs.mkdirSync(output, { recursive: true });
  for (const image of images) fs.copyFileSync(path.join(input, image.file), path.join(output, image.file));
  fs.writeFileSync(readmePath, readme);
  console.log(`Updated README with ${images.length} recorded images and animations in ${mediaDirectory}.`);
}

module.exports = { mediaName, renderGallery, updateReadme, publish };
if (require.main === module) { try { publish(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
