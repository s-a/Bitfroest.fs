const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releaseContext, verifiedReleaseAssets } = require('./release-policy.cjs');

function runCommand(command, args) {
  const capture = command === 'git' || (command === 'gh' && args[1] === 'view');
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status}.`);
  return result.stdout || '';
}

function publishMarketplace({ tag, source, directory, event, ref, run = runCommand }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  const context = releaseContext(`refs/tags/${tag}`, manifest, lock);
  if (manifest.publisher !== 'bitfroest' || !context.prerelease) throw new Error('Only the configured beta publisher may be used.');
  if (!((event === 'push' && ref === `refs/tags/${tag}`) || (event === 'workflow_dispatch' && ref === 'refs/heads/main'))) throw new Error('Marketplace publication requires a pushed tag or a manual release from main.');
  const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release source commit.');
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'tagName,isDraft,assets']));
  const names = ['win32-x64', 'linux-x64'].flatMap(target => {
    const name = `bitfroest-fs-${context.version}-${target}.vsix`;
    return [name, `${name}.sha256`, `${name}.json`];
  });
  if (release.tagName !== tag || release.isDraft !== false || release.assets?.length !== names.length || names.some(name => !release.assets.some(asset => asset.name === name))) throw new Error('A published release with exactly the supported platform assets is required.');
  fs.mkdirSync(directory, { recursive: true });
  run('gh', ['release', 'download', tag, '--dir', directory, ...names.flatMap(name => ['--pattern', name])]);
  const assets = verifiedReleaseAssets(directory, context, commit);
  run('npm', ['exec', '--yes', '--package', '@vscode/vsce@4.1.0', '--', 'vsce', 'publish', '--oidc', '--pre-release', '--skip-duplicate', '--packagePath', ...assets.filter(name => name.endsWith('.vsix'))]);
}

if (require.main === module) {
  try {
    publishMarketplace({ tag: process.env.MARKETPLACE_TAG, source: path.resolve('release-source'), directory: path.join(process.env.RUNNER_TEMP, 'marketplace-release'), event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { publishMarketplace };
