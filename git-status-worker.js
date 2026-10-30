const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { createGitStatusEngine } = require('./git-status-engine');

const engine = createGitStatusEngine();
const watchers = new Map();
let queue = Promise.resolve(), changeTimer, fallback, generation = 0;
let lastKey, lastResult, lastTime = 0;
function changed() {
  generation++; lastKey = undefined; engine.invalidate();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => parentPort.postMessage({ type: 'changed' }), 250);
}
function watch(paths) {
  const desired = new Map(paths);
  for (const [name, saved] of watchers) if (!desired.has(name) || desired.get(name) !== saved.recursive) { saved.watcher.close(); watchers.delete(name); }
  clearInterval(fallback); fallback = undefined;
  for (const [name, recursive] of desired) {
    if (watchers.has(name)) continue;
    try {
      const watcher = fs.watch(name, { recursive }, changed);
      watcher.on('error', () => { watcher.close(); watchers.delete(name); changed(); });
      watchers.set(name, { watcher, recursive });
    } catch { fallback ||= setInterval(changed, 5000); }
  }
}
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      let result;
      if (message.type === 'branches') result = await engine.branches(message.directory);
      else {
        const key = JSON.stringify([message.directories, message.settings]);
        if (key === lastKey && Date.now() - lastTime < 2000) result = lastResult;
        else {
          const covered = directory => [...watchers].some(([root, saved]) => {
            const relative = path.relative(root, directory);
            return !relative || saved.recursive && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
          });
          if (message.directories.some(directory => !covered(directory))) engine.invalidate();
          const paths = [];
          for (const directory of message.directories) {
            try {
              const info = await engine.locate(directory);
              paths.push([directory, true], [info.gitdir, true]);
            } catch { paths.push([directory, false]); }
          }
          watch(paths);
          const started = generation;
          result = Object.create(null);
          for (const directory of message.directories) {
            result[directory] = await engine.inspect(directory, message.settings);
            result[directory] = { ...result[directory], statuses: Object.fromEntries(Object.entries(result[directory].statuses).filter(([name]) => !name.includes('/'))) };
          }
          if (generation === started) { lastKey = key; lastResult = result; lastTime = Date.now(); }
          else { engine.invalidate(); parentPort.postMessage({ type: 'changed' }); }
        }
      }
      parentPort.postMessage({ id: message.id, result });
    } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
  });
});
