const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createGitStatusProvider(options = {}) {
  let worker, closed = false, sequence = 0;
  const pending = new Map(), shared = new Map();
  function stop(error) {
    const current = worker; worker = undefined;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear(); shared.clear();
    current?.terminate();
  }
  function start() {
    if (worker) return;
    const current = options.createWorker ? options.createWorker() : new Worker(path.join(__dirname, 'git-status-worker.js'), { env: options.workerEnv || process.env });
    worker = current;
    current.on('message', message => {
      if (worker !== current) return;
      if (message.type === 'changed') { options.onChange?.(); return; }
      const job = pending.get(message.id);
      if (!job) return;
      if (message.type === 'progress') { for (const listener of job.listeners) listener(message.result); return; }
      pending.delete(message.id); clearTimeout(job.timer);
      message.error ? job.reject(new Error(message.error)) : job.resolve(message.result);
    });
    current.on('error', error => { if (worker === current) stop(error); });
    current.on('exit', () => { if (worker === current) stop(new Error('Git status worker exited')); });
  }
  function request(type, payload, onProgress) {
    if (closed) return Promise.reject(new Error('Git status provider closed'));
    const key = JSON.stringify([type, payload]);
    if (shared.has(key)) {
      const job = shared.get(key);
      if (onProgress) job.listeners.add(onProgress);
      return job.promise;
    }
    start();
    const id = ++sequence;
    const listeners = new Set(onProgress ? [onProgress] : []);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('Git status timed out')), options.timeout || 20000);
      timer.unref?.(); pending.set(id, { resolve, reject, timer, listeners });
      worker.postMessage({ id, type, ...payload });
    });
    const job = { promise, listeners };
    shared.set(key, job);
    promise.finally(() => { if (shared.get(key) === job) shared.delete(key); }).catch(() => {});
    return promise;
  }
  return {
    inspect: (directories, settings = {}, onProgress) => request('inspect', { directories, settings }, onProgress),
    branches: directory => request('branches', { directory }),
    suspend() { stop(new Error('Git status suspended')); },
    dispose() { closed = true; stop(new Error('Git status provider closed')); }
  };
}

module.exports = { createGitStatusProvider };
