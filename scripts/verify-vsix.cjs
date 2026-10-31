const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const zip = require('@zip.js/zip.js');
const { releaseContext, targetFor, validatePackageEntries } = require('./release-policy.cjs');

async function main() {
  const context = releaseContext(process.env.GITHUB_REF || '', JSON.parse(fs.readFileSync('package.json', 'utf8')), JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));
  const { target, release } = targetFor(process.platform, process.arch, process.env.EXPERIMENTAL_BUILD === 'true');
  const filename = path.join(process.env.RUNNER_TEMP, `bitfroest-fs-${context.version}-${target}.vsix`);
  const binary = fs.readFileSync(filename);
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(binary), { useWebWorkers: false });
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfroest-package-'));
  try {
    const entries = await reader.getEntries();
    validatePackageEntries(entries.map(entry => entry.filename));
    const vsixManifest = entries.find(entry => entry.filename === 'extension.vsixmanifest');
    if (!(await vsixManifest.getData(new zip.TextWriter())).includes(`TargetPlatform="${target}"`)) throw new Error('VSIX platform does not match the build target.');
    for (const entry of entries.filter(entry => entry.filename.startsWith('extension/'))) {
      const destination = path.join(extracted, entry.filename);
      if (entry.directory) { fs.mkdirSync(destination, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, await entry.getData(new zip.Uint8ArrayWriter()));
    }
    const extension = path.join(extracted, 'extension');
    const packagedManifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
    if (packagedManifest.version !== context.version) throw new Error('Packaged version does not match.');
    if (!fs.readFileSync(path.join(extension, 'native/binding.node')).equals(fs.readFileSync('native/binding.node'))) throw new Error('Packaged binding differs from the tested build.');
    const result = spawnSync(process.execPath, ['--test', 'tests/packaged-runtime.test.js'], { stdio: 'inherit', env: { ...process.env, EXTENSION_PACKAGE_TEST_PATH: extension } });
    if (result.status !== 0) throw new Error('Isolated package activation check failed.');
    const hash = crypto.createHash('sha256').update(binary).digest('hex');
    fs.writeFileSync(`${filename}.sha256`, `${hash}  ${path.basename(filename)}\n`);
    fs.writeFileSync(`${filename}.json`, JSON.stringify({ version: context.version, target, experimental: !release, commit: process.env.GITHUB_SHA, node: process.version, nodeApi: 8, libgit2: '49e408b3208bc3093757a1c2db938d3590f3f412', sha256: hash }, null, 2) + '\n');
    console.log(`Verified ${path.basename(filename)} (${entries.length} entries).`);
  } finally {
    await reader.close();
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
