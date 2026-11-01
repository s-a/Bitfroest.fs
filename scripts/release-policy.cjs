const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseContext(ref, manifest, lock) {
  if (!versionPattern.test(manifest.version)) throw new Error('Package version must use major.minor.patch.');
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) throw new Error('Package and lock versions must match.');
  const release = ref.startsWith('refs/tags/');
  if (release && !new RegExp(`^refs/tags/v${versionPattern.source.slice(1, -1)}$`).test(ref)) throw new Error('Invalid version tag.');
  if (release && ref !== `refs/tags/v${manifest.version}`) throw new Error('The version tag must match the package version.');
  return { version: manifest.version, release, prerelease: manifest.preview === true };
}

function targetFor(platform, arch, experimental = false) {
  const target = `${platform}-${arch}`;
  if (['win32-x64', 'linux-x64'].includes(target)) return { target, release: true };
  if (target === 'darwin-arm64') {
    if (!experimental) throw new Error('macOS requires an explicit experimental build.');
    return { target, release: false };
  }
  throw new Error(`Target ${target} is not configured.`);
}

function validatePackageEntries(names) {
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || name.includes('\0')) throw new Error(`Unsafe archive path: ${name}`);
    if (!['extension.vsixmanifest', '[Content_Types].xml'].includes(name) && !name.startsWith('extension/')) throw new Error(`Unexpected archive root: ${name}`);
    if (/^extension\/(?:Docs|design|scripts|tests|coverage|\.github|\.git|\.vscode)\//i.test(name) || /^extension\/native\/src\//i.test(name) || /\.(?:exe|com|bat|cmd|ps1|py|obj|o|pdb|lib|exp)$/i.test(name) || /(?:^|\/)CMakeLists\.txt$/i.test(name)) throw new Error(`Unexpected development or executable file: ${name}`);
  }
  if (!names.includes('extension/native/binding.node')) throw new Error('Native binding is missing from the package.');
  if (!names.includes('extension/node_modules/@zip.js/zip.js/package.json')) throw new Error('ZIP runtime dependency is missing from the package.');
  if (!names.includes('extension/package.json') || !names.includes('extension/extension.js')) throw new Error('Extension entry point or manifest is missing.');
}

function validateMarketplaceIcon(bytes) {
  if (!bytes?.length) throw new Error('Marketplace icon is missing or empty.');
  if (bytes.length > 1024 * 1024) throw new Error('Marketplace icon exceeds the 1024 KB upload limit.');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Marketplace icon must have a valid PNG header.');
  for (const dimension of [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]) {
    if (dimension < 128 || dimension > 1024) throw new Error('Marketplace icon dimensions must be between 128 and 1024 pixels.');
  }
}

function verifiedReleaseAssets(directory, context, commit) {
  const assets = [];
  for (const target of ['win32-x64', 'linux-x64']) {
    const filename = path.join(directory, `bitfroest-fs-${context.version}-${target}.vsix`);
    const metadata = JSON.parse(fs.readFileSync(`${filename}.json`, 'utf8'));
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    if (metadata.target !== target || metadata.experimental !== false || metadata.version !== context.version || metadata.commit !== commit || metadata.sha256 !== hash) throw new Error(`Release provenance mismatch for ${target}.`);
    if (fs.readFileSync(`${filename}.sha256`, 'utf8') !== `${hash}  ${path.basename(filename)}\n`) throw new Error(`Checksum mismatch for ${target}.`);
    assets.push(filename, `${filename}.sha256`, `${filename}.json`);
  }
  if (fs.readdirSync(directory).length !== assets.length) throw new Error('Unexpected or experimental release assets.');
  return assets;
}

module.exports = { releaseContext, targetFor, validatePackageEntries, verifiedReleaseAssets, validateMarketplaceIcon };
