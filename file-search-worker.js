const { parentPort, workerData } = require('node:worker_threads');
const { searchFiles } = require('./file-search');
const { createSearchMetadata } = require('./search-metadata');
const skipped = new Set();
parentPort.on('message', message => { if (message.type === 'skip' && typeof message.directory === 'string') skipped.add(message.directory); });
const metadata = createSearchMetadata();
let lastProgress = 0;
searchFiles({ roots: workerData.roots,
  attributes: workerData.settings.attributesEnabled || workerData.settings.pluginsEnabled ? (target, stat) => metadata.attributes(target, stat) : undefined,
  skipDirectory: target => [...skipped].some(root => target === root || target.startsWith(root + '/')),
  onProgress(value) { if (Date.now() - lastProgress >= 50) { lastProgress = Date.now(); parentPort.postMessage({ type: 'progress', value }); } },
  onResult(row) { if (!workerData.settings.duplicates) parentPort.postMessage({ type: 'match', row }); }
}, workerData.settings).then(result => parentPort.postMessage({ type: 'complete', result }), error => parentPort.postMessage({ type: 'error', error: error.message })).finally(() => { metadata.dispose(); parentPort.close(); });
