const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createGitStatusProvider(options = {}) {
  let worker, closed = false, sequence = 0;
  const pending = new Map(), shared = new Map();
  const diagnose = detail => { try { options.onDiagnostic?.(detail); } catch { /* Logging cannot interrupt a Git request. */ } };
  function stop(error) {
    diagnose({ event: 'worker-stop', message: error.message, pending: [...pending.keys()] });
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
      const job = pending.get(message.id);
      if (!job) return;
      if (message.type === 'progress') { job.progressReceived = (job.progressReceived || 0) + 1; for (const listener of job.listeners) listener(message.result); return; }
      pending.delete(message.id); clearTimeout(job.timer);
      diagnose({ event: 'query-complete', workerRequestId: message.id, error: message.error || null, progressReceived: job.progressReceived || 0 });
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
      diagnose({ event: 'query-shared', workerRequestId: job.id, progressReceived: pending.get(job.id)?.progressReceived || 0, subscribers: job.listeners.size + (onProgress && !job.listeners.has(onProgress) ? 1 : 0) });
      if (onProgress) job.listeners.add(onProgress);
      return job.promise;
    }
    start();
    const id = ++sequence;
    diagnose({ event: 'query-created', workerRequestId: id, type, directories: payload.directories });
    const listeners = new Set(onProgress ? [onProgress] : []);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('Git status timed out')), options.timeout || 20000);
      timer.unref?.(); pending.set(id, { resolve, reject, timer, listeners });
      worker.postMessage({ id, type, ...payload });
    });
    const job = { promise, listeners, id };
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
