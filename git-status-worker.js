const { parentPort } = require('node:worker_threads');
const { createGitStatusEngine } = require('./git-status-engine');
const Progress = require('./media/commander-progress');

const engine = createGitStatusEngine();
let queue = Promise.resolve();
parentPort.on('message', message => {
  if (message.type === 'branches') {
    engine.branches(message.directory).then(result => parentPort.postMessage({ id: message.id, result }), error => parentPort.postMessage({ id: message.id, error: error.message }));
    return;
  }
  const metadata = message.type === 'inspect' ? Promise.all(message.directories.map(async directory => {
    const info = await engine.describe(directory, message.settings, update => parentPort.postMessage({ id: message.id, type: 'progress', result: { [directory]: Progress.event({ ...Progress.read(update), stage: 'describe' }) } }));
    parentPort.postMessage({ id: message.id, type: 'progress', result: { [directory]: info.ok ? Progress.event({ ...info, stage: 'describe', phase: 'git-wait', path: directory, loading: true, overall: Progress.unknown('items', 0, 'enumerating'), current: Progress.unknown('items', 0, 'native-operation') }) : { ...info, stage: 'describe', loading: true } } });
  })) : Promise.resolve();
  metadata.catch(() => {});
  queue = queue.then(async () => {
    try {
      await metadata;
      engine.invalidate();
      const result = Object.create(null);
      for (const directory of message.directories) {
        result[directory] = await engine.inspect(directory, message.settings, update => parentPort.postMessage({ id: message.id, type: 'progress', result: { [directory]: Progress.event({ ...Progress.read(update), stage: 'inspect' }) } }));
        result[directory] = { ...result[directory], statuses: Object.fromEntries(Object.entries(result[directory].statuses).filter(([name]) => !name.includes('/'))) };
        parentPort.postMessage({ id: message.id, type: 'progress', result: { [directory]: result[directory] } });
      }
      parentPort.postMessage({ id: message.id, result });
    } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
  });
});
