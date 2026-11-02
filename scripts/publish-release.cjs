const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { releaseContext, verifiedReleaseAssets } = require('./release-policy.cjs');
const { readReleaseNotes } = require('./check-release-notes.cjs');

function publishRelease({ source, directory, ref, event, commit, spawn = spawnSync }) {
  function run(args) {
    const result = spawn('gh', args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Release command failed with ${result.status}.`);
  }
  const context = releaseContext(ref || '', JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8')));
  if (!context.release || event !== 'push') throw new Error('Only a pushed version tag may publish a release.');
  const tag = `v${context.version}`;
  const assets = verifiedReleaseAssets(directory, context, commit);
  const notes = readReleaseNotes(source, context.version);
  const existing = spawn('gh', ['release', 'view', tag], { stdio: 'ignore' });
  if (existing.error) throw existing.error;
  if (existing.status === 0) throw new Error('This release already exists; existing releases are never overwritten.');
  const options = context.prerelease ? ['--prerelease', '--latest=false'] : [];
  run(['release', 'create', tag, '--verify-tag', '--target', commit, '--draft', '--title', `Bitfroest.fs ${tag}`, '--notes-file', notes.filename, ...options]);
  run(['release', 'upload', tag, ...assets]);
  run(['release', 'edit', tag, '--draft=false', ...options]);
}

if (require.main === module) {
  try {
    publishRelease({ source: process.cwd(), directory: path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'release'),
      ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME, commit: process.env.GITHUB_SHA });
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}

module.exports = { publishRelease };
