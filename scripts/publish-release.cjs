const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { releaseContext } = require('./release-policy.cjs');

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
  const assets = [];
  for (const target of ['win32-x64', 'linux-x64']) {
    const filename = path.join(directory, `bitfroest-fs-${context.version}-${target}.vsix`);
    const metadata = JSON.parse(fs.readFileSync(`${filename}.json`, 'utf8'));
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    if (metadata.target !== target || metadata.experimental !== false || metadata.version !== context.version || metadata.commit !== process.env.GITHUB_SHA || metadata.sha256 !== hash) throw new Error(`Release provenance mismatch for ${target}.`);
    if (fs.readFileSync(`${filename}.sha256`, 'utf8') !== `${hash}  ${path.basename(filename)}\n`) throw new Error(`Checksum mismatch for ${target}.`);
    assets.push(filename, `${filename}.sha256`, `${filename}.json`);
  }
  if (fs.readdirSync(directory).length !== assets.length) throw new Error('Unexpected or experimental release assets.');
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
