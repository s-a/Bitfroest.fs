const fs = require('node:fs');
const path = require('node:path');
const { releaseContext } = require('./release-policy.cjs');

function readReleaseNotes(source, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Release notes require a valid version.');
  const filename = path.join(source, '.github', 'release-notes', `${version}.md`);
  let content;
  try { content = fs.readFileSync(filename, 'utf8'); }
  catch (error) { throw new Error(`Release notes cannot be read: ${filename} (${error.code}).`, { cause: error }); }
  const lines = content.trim().split(/\r?\n/);
  if (lines[0] !== `# Bitfroest.fs ${version}`) throw new Error(`Release notes must start with "# Bitfroest.fs ${version}": ${filename}`);
  const body = lines.slice(1).join('\n').replace(/<!--[\s\S]*?-->/g, '');
  if (!body.split('\n').some(line => line.trim() && !/^\s*#/.test(line))) throw new Error(`Release notes are empty: ${filename}`);
  if (/^\s*(?:#{1,6}\s+)?(?:\*\*|\[)?(?:draft|entwurf)\b/im.test(content) || /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/i.test(content)) {
    throw new Error(`Release notes contain a draft marker or placeholder (Draft, Entwurf, TODO, TBD, FIXME, PLACEHOLDER): ${filename}`);
  }
  return { filename, content };
}

function checkReleaseNotes({ source = process.cwd(), ref = process.env.GITHUB_REF || '' } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  const context = releaseContext(ref, manifest, lock);
  return context.release ? readReleaseNotes(source, context.version) : null;
}

if (require.main === module) {
  try {
    const notes = checkReleaseNotes();
    console.log(notes ? `Release notes verified: ${notes.filename}` : 'Development build: release notes are not required.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { readReleaseNotes, checkReleaseNotes };
