const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { validateSettings } = require('./file-search');

function createSearchProvider({ roots }) {
  const jobs = new Map(), completed = new Map(); let disposed = false;
  return {
    async run(id, input, callbacks = {}) {
      if (disposed) throw new Error('Die Dateisuche ist geschlossen.');
      if (jobs.has(id) || completed.has(id)) throw new Error('Die Suchkennung wird bereits verwendet.');
      const settings = validateSettings(input);
      return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'file-search-worker.js'), { workerData: { roots, settings } });
        const job = { worker, partial: [], settled: false };
        job.finish = (result, error) => {
          if (job.settled) return; job.settled = true; jobs.delete(id);
          if (error) reject(error); else { if (!disposed && !job.released) completed.set(id, result.results); resolve(result); }
        };
        jobs.set(id, job);
        worker.on('message', message => {
          if (job.settled) return;
          if (message.type === 'progress') callbacks.onProgress?.(message.value);
          if (message.type === 'match') job.partial.push(message.row);
          if (message.type === 'complete') job.finish(message.result);
          if (message.type === 'error') job.finish(null, new Error(message.error));
        });
        worker.on('error', error => job.finish(null, error));
        worker.on('exit', code => { if (!job.settled && !job.cancelling) job.finish(null, new Error(`Der Suchprozess wurde beendet (${code}).`)); });
      });
    },
    cancel(id) { const job = jobs.get(id); if (!job || job.cancelling) return; job.cancelling = true; job.worker.terminate().then(() => job.finish({ results: job.partial, errors: [], cancelled: true })); },
    skip(id, directory) { jobs.get(id)?.worker.postMessage({ type: 'skip', directory }); },
    results: id => completed.get(id),
    release(id) { const job = jobs.get(id); if (job) job.released = true; this.cancel(id); completed.delete(id); },
    clear() { for (const id of jobs.keys()) this.release(id); completed.clear(); },
    dispose() { disposed = true; for (const id of jobs.keys()) this.cancel(id); completed.clear(); }
  };
}
module.exports = { createSearchProvider };
