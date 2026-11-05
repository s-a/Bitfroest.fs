const fs = require('node:fs');
const path = require('node:path');

const begin = '<!-- showcase-gallery:start -->', end = '<!-- showcase-gallery:end -->';
const mediaDirectory = 'media/marketplace/showcases';
const summaryExcerpts = {
  'path-copy': 'Copy the current folder path from the address bar.',
  'right-selection': 'Select several files with a right-button drag.',
  'right-drag': 'Drag selected files and review the destination before moving them.',
  'shortcut-ctrl-l': 'Jump to the folder path with Ctrl+L.',
  'main-menus': 'Find commands grouped by task.',
  'location-menu': 'Open saved project folders from the favorites menu.',
  'select-group': 'Select filenames with masks or regular expressions.',
  'unselect-group': 'Remove matching filenames from the current selection.',
  'rename-inline': 'Edit a filename directly in the file list.',
  'rename-multiple': 'Preview generated names before applying a batch rename.',
  'delete-trash': 'Review what will move to the recycle bin.',
  'delete-permanently': 'Review permanent deletion before confirming.',
  'file-search': 'Search by filename, contents, or saved presets.',
  'file-search-separate': 'Keep search open beside the file manager.',
  'file-viewer': 'Read text, inspect binary data, and switch encodings.',
  'viewer-search': 'Find matching text in the current file.',
  'viewer-codepage': 'Choose an encoding for the current file.',
  'archive-pack': 'Prepare a ZIP archive with selected files.',
  'archive-unpack': 'Choose extraction options before writing files.',
  'git-status': 'Review changed files in the sample repository.',
  'git-history': 'Browse commits and their changed files.',
  'git-diff': 'Compare a file with its committed version.',
  'git-branches': 'Browse local branches without switching.',
  settings: 'Configure the file manager in VS Code settings.',
  'settings-favorites': 'Configure saved folders and groups.',
  'settings-columns': 'Choose file-list columns and visible fields.',
  'settings-shortcuts': 'Set key bindings for file manager commands.',
  'folder-locks': 'See which processes reference files in a folder.',
  'folder-lock-actions': 'Review actions for detected folder locks.',
  'folder-lock-target': 'Check a destination before copying a locked folder.',
  'folder-lock-confirmation': 'Review the warning before closing handles or unloading modules.',
  'xray-click': 'Preview the selected file in the opposite pane.',
  'xray-hover': 'Preview files after pausing on them.',
  'quick-diff-folder': 'Compare changed files with HEAD in the current folder.',
  'quick-diff-repository': 'Review changes across the full repository.'
};
function mediaName(value) {
  if (!/^\d{4}-windows-en-dark-[a-z0-9-]+\.(png|gif|webm)$/.test(value)) throw new Error('Invalid showcase media filename.');
  return value;
}
function renderGallery(manifest) {
  const lines = [begin, '## Feature walkthrough', '',
    'Windows examples with sample project files. Animations include a pointer highlight and keystroke hints. Drag-and-drop demonstrations stop at the confirmation dialog.', ''];
  for (const section of manifest.sections.filter(item => item.status === 'rendered' && item.id !== 'main')) {
    if (!section.images.length) continue;
    const excerpt = summaryExcerpts[section.id];
    lines.push(`<details>`, `<summary>${section.title}</summary>`, '');
    if (excerpt) lines.push(`<p><small>${excerpt}</small></p>`, '');
    lines.push(section.description, '');
    for (const image of section.images) {
      if (image.file.endsWith('.webm')) {
        if (image.fallback) lines.push(`![${image.alt}](${mediaDirectory}/${mediaName(image.fallback)})`, '');
        lines.push(`[Watch WebM](${mediaDirectory}/${mediaName(image.file)})`, '');
      } else lines.push(`![${image.alt}](${mediaDirectory}/${mediaName(image.file)})`, '');
    }
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
  const images = manifest.sections.filter(section => section.status === 'rendered').flatMap(section => section.images).flatMap(image => [image, ...(image.fallback ? [{ file: image.fallback }] : [])]);
  if (!images.length) throw new Error('No recorded media are available to publish.');
  for (const image of images) {
    const bytes = fs.readFileSync(path.join(input, mediaName(image.file)));
    if (image.file.endsWith('.webm') ? bytes.readUInt32BE(0) !== 0x1a45dfa3 : image.file.endsWith('.gif') ? bytes.toString('ascii', 0, 3) !== 'GIF' : bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`Invalid media: ${image.file}`);
  }
  const readmePath = path.join(root, 'README.md');
  const before = fs.readFileSync(readmePath, 'utf8'), readme = updateReadme(before, manifest);
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

module.exports = { mediaName, renderGallery, updateReadme, publish };
if (require.main === module) { try { publish(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
