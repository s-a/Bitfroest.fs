const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectRuntimeSource } = require('./support/runtime-architecture.cjs');

test('runtime policy rejects process imports regardless of import syntax or alias', () => {
  for (const source of [
    "const { execFile: run } = require('node:child_process'); run('powershell.exe', []);",
    "import { spawn as run } from 'child_process'; run('pwsh', []);",
    "import('node:' + 'child_process').then(worker => worker.execFile('powershell.exe'));",
    "module.require(`node:child_process`).spawn('pwsh');",
    "export { spawn } from 'node:child_process';"
  ]) assert.ok(inspectRuntimeSource(source, 'runtime.js').length, source);
});

test('runtime policy rejects opaque module loaders and code generation', () => {
  for (const source of [
    'require(moduleName);',
    'import(moduleName);',
    'const load = require;',
    'const load = require.bind(null);',
    "globalThis.process.getBuiltinModule('child_process');",
    "const { createRequire } = require('node:module');",
    "process.getBuiltinModule('child_process');",
    "process['binding']('spawn_sync');",
    "const compile = new Function('return process');",
    "eval('require(moduleName)');"
  ]) assert.ok(inspectRuntimeSource(source, 'runtime.js').length, source);
});

test('runtime policy accepts built-in file access and packaged native bindings', () => {
  assert.deepEqual(inspectRuntimeSource([
    "const fs = require('node:fs/promises');",
    "const native = require('./native/binding.node');",
    "const label = 'powershell.exe'; // ordinary text does not execute a process",
    "module.exports = { fs, native, label };"
  ].join('\n'), 'runtime.js'), []);
});

test('invalid JavaScript fails closed instead of bypassing the runtime policy', () => {
  assert.ok(inspectRuntimeSource('const broken = ;', 'runtime.js').length);
});

test('source comments cannot disable the execution policy', () => {
  assert.ok(inspectRuntimeSource("/* eslint-disable runtime/no-external-execution */\nrequire('node:child_process');", 'runtime.js').length);
});
