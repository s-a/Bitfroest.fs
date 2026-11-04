const { spawnSync } = require('node:child_process');

function getPrepublishCommands(environment = process.env) {
  if (environment.BITFROEST_LOCAL_FAST_INSTALL === '1') return [['run', 'build:xray']];
  return [
    ['run', 'build:xray'],
    ['run', 'check:progress'],
    ['run', 'check:operations'],
    ['run', 'check:icons'],
    ['run', 'test:architecture']
  ];
}

function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('The prepublish runner must be started by npm.');
  for (const args of getPrepublishCommands()) {
    const result = spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { getPrepublishCommands };
