const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { releaseContext, targetFor } = require('./release-policy.cjs');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
}

async function download(url, destination, expected) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected) throw new Error('SDK checksum does not match.');
  fs.writeFileSync(destination, data);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  releaseContext(process.env.GITHUB_REF || '', manifest, lock);
  const target = targetFor(process.platform, process.arch, process.env.EXPERIMENTAL_BUILD === 'true');
  if (target.target !== process.env.BUILD_TARGET) throw new Error('Runner architecture does not match the requested target.');
  const temporary = process.platform === 'win32' ? process.env.RUNNER_TEMP : os.tmpdir();
  if (!temporary) throw new Error('Runner temporary directory is unavailable.');
  const root = fs.mkdtempSync(path.join(temporary, 'bitfroest-native-'));
  const dependency = path.join(root, 'libgit2');
  run('git', ['clone', '--no-checkout', 'https://github.com/libgit2/libgit2.git', dependency]);
  run('git', ['-C', dependency, 'checkout', '--detach', '49e408b3208bc3093757a1c2db938d3590f3f412']);
  const archive = path.join(root, 'headers.tar.gz');
  await download('https://nodejs.org/dist/v24.18.0/node-v24.18.0-headers.tar.gz', archive, '6c7d41d83c3481d2301115b8ce4a44b7d4fbfa52859b1aac14f445d460137887');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  run(tar, ['-xzf', archive, '-C', root]);
  const build = path.join(root, 'build');
  const args = ['-S', 'native', '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DNODE_INCLUDE_DIR=${path.join(root, 'node-v24.18.0/include/node')}`, `-DLIBGIT2_SOURCE_DIR=${dependency}`];
  if (process.platform === 'win32') {
    const library = path.join(root, 'node.lib');
    await download('https://nodejs.org/dist/v24.18.0/win-x64/node.lib', library, '589684168a73547ca47cd22d76a4e465ef561abe89fb1b2b23fe35bbe857d505');
    args.push('-G', 'Visual Studio 18 2026', '-A', 'x64', `-DNODE_LIBRARY=${library}`);
  }
  run('cmake', args);
  run('cmake', ['--build', build, '--config', 'Release', '--parallel', '2']);
  const binary = path.join(build, process.platform === 'win32' ? 'Release/binding.node' : 'binding.node');
  fs.copyFileSync(binary, path.resolve('native/binding.node'));
  const binding = require(path.resolve('native/binding.node'));
  if (binding.apiVersion.major !== 1) throw new Error('Unexpected native API version.');
  const session = binding.openSession(); session.close();
  console.log(`Built ${target.target}, native API ${binding.apiVersion.major}.${binding.apiVersion.minor}.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
