'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const bindingPath = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('packaged Windows binding exposes separate conditional clipboard cancellation', { skip: process.platform !== 'win32' }, () => {
  const binding = require('../native/binding.node');
  assert.equal(binding.capabilities['clipboard.cancelFiles']?.status, 'supported');
});

test('native clipboard binding validates typed requests without a sibling executable or system clipboard access', { skip: process.platform !== 'win32' }, () => {
  assert.ok(bindingPath, 'NATIVE_BINDING_TEST_PATH must point to the compiled binding');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-direct-binding-'));
  try {
    const localBinding = path.join(directory, 'binding.node');
    fs.copyFileSync(bindingPath, localBinding);
    assert.equal(fs.existsSync(path.join(directory, 'clipboard-broker-win.exe')), false);
    const script = `const assert=require('node:assert/strict');const binding=require(${JSON.stringify(localBinding)});` +
      `if(typeof binding.verifyStaLifecycle==='function')assert.equal(binding.verifyStaLifecycle(),true);` +
      `for(const op of ['clipboard.readFiles','clipboard.writeFiles','clipboard.acknowledge','clipboard.cancelFiles'])assert.equal(binding.capabilities[op]?.status,'supported');` +
      `const session=binding.openSession();try{assert.throws(()=>session.invoke('clipboard.writeFiles',{paths:['relative.txt'],mode:'copy'}),{code:'InvalidRequest'});` +
      `assert.throws(()=>session.invoke('clipboard.acknowledge',{token:'',paths:[],mode:'copy',remainingPaths:[]}),{code:'InvalidRequest'});` +
      `assert.throws(()=>session.invoke('clipboard.cancelFiles',{token:'',paths:[],mode:'copy'}),{code:'InvalidRequest'});}finally{session.close();}`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('worker termination releases its environment while a fake clipboard owner is blocked', { skip: process.platform !== 'win32' }, () => {
  const testBindingPath = process.env.NATIVE_CLIPBOARD_TEST_BINDING;
  assert.ok(testBindingPath, 'NATIVE_CLIPBOARD_TEST_BINDING must name the prebuilt fixture module.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-worker-close-'));
  try {
    const localBinding = path.join(directory, 'binding.node');
    fs.copyFileSync(testBindingPath, localBinding);
    const workerSource = `const {parentPort}=require('node:worker_threads');const binding=require(${JSON.stringify(localBinding)});parentPort.postMessage('ready');const operations=Array.from({length:4},()=>binding.startBlockedOwner());const closes=operations.map((_,index)=>binding.closeBlockedOwner(index));parentPort.postMessage('closing');setTimeout(()=>parentPort.postMessage('timer'),0);Promise.allSettled([...operations,...closes]).then(()=>parentPort.postMessage('settled'));`;
    const script = `const assert=require('node:assert/strict');const fs=require('node:fs');const {Worker}=require('node:worker_threads');const binding=require(${JSON.stringify(localBinding)});binding.prepareBlockedOwners(4);` +
      `const worker=new Worker(${JSON.stringify(workerSource)},{eval:true});let settled=false;worker.on('message',m=>{if(m==='settled')settled=true});` +
      `(async()=>{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('worker did not start')),3000);worker.once('message',()=>{clearTimeout(timer);resolve()})});` +
      `assert.equal(binding.waitBlockedOwner(5000),true,'four STAs reached the controlled FakeOwner wait');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('close did not return to JavaScript')),3000);worker.once('message',m=>{if(m==='closing'){clearTimeout(timer);resolve()}})});assert.equal(settled,false,'close and read promises remain pending while FakeOwner calls are blocked');` +
      `await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('close work starved the libuv pool')),2000);fs.readFile(${JSON.stringify(localBinding)},error=>{clearTimeout(timer);if(error)reject(error);else resolve()})});` +
      `const termination=worker.terminate();let timeout;const prompt=await Promise.race([termination.then(()=>true),new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),2000)})]);clearTimeout(timeout);` +
      `binding.releaseBlockedOwner();assert.equal(prompt,true,'Worker.terminate does not wait for blocked foreign IDataObject::GetData');await termination;` +
      `await new Promise(resolve=>setTimeout(resolve,50));assert.equal(settled,false,'terminated environment receives no late JavaScript completion')})().catch(error=>{console.error(error);process.exitCode=1});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
