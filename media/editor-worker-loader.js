(function () {
  'use strict';
  const script = document.currentScript || document.querySelector('script[src$="editor-worker-loader.js"]');
  const url = script.src.replace(/editor-worker-loader\.js(?:[?#].*)?$/, 'xray-editor-worker.js');
  const workers = new Map();
  window.MonacoEnvironment = { async getWorker() {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Editor worker could not be loaded.');
    const objectUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
    const worker = new Worker(objectUrl), terminate = worker.terminate.bind(worker);
    workers.set(worker, objectUrl);
    worker.terminate = () => { terminate(); URL.revokeObjectURL(objectUrl); workers.delete(worker); };
    return worker;
  } };
  window.addEventListener('pagehide', () => { for (const worker of workers.keys()) worker.terminate(); }, { once: true });
})();
