const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releaseContext, verifiedReleaseAssets } = require('./release-policy.cjs');

function run(args) {
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release command failed with ${result.status}.`);
}

try {
  const context = releaseContext(process.env.GITHUB_REF || '', JSON.parse(fs.readFileSync('package.json', 'utf8')), JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));
  if (!context.release || process.env.GITHUB_EVENT_NAME !== 'push') throw new Error('Only a pushed version tag may publish a release.');
  const tag = `v${context.version}`;
  const directory = path.join(process.env.RUNNER_TEMP, 'release');
  const assets = verifiedReleaseAssets(directory, context, process.env.GITHUB_SHA);
  const existing = spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore' });
  if (existing.status === 0) throw new Error('This release already exists; existing releases are never overwritten.');
  const notes = 'Precompiled VSIX packages for Windows x64 and Linux x64. Linux has limited functionality and targets Ubuntu 24.04 or a compatible newer runtime with GLib/GIO. macOS remains experimental and is available only through Actions artifacts. File operations can cause data loss; use test data or a current, restorable backup. Checksums and build metadata accompany each package.';
  const options = context.prerelease ? ['--prerelease', '--latest=false'] : [];
  run(['release', 'create', tag, '--verify-tag', '--target', process.env.GITHUB_SHA, '--draft', '--title', `Bitfroest.fs ${tag}`, '--notes', notes, ...options]);
  run(['release', 'upload', tag, ...assets]);
  run(['release', 'edit', tag, '--draft=false', ...options]);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
