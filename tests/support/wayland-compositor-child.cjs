const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const result = spawnSync(process.execPath, ['--test', process.argv[3]], {
  env: process.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024
});
fs.writeFileSync(process.argv[2], JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }));
process.exitCode = result.status === 0 ? 0 : 1;
