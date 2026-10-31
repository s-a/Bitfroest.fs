const path = require('node:path');

function stubPackagedNativeBinding(t, operations) {
  const filename = path.resolve(__dirname, '../../native/binding.node');
  const previous = require.cache[filename];
  const calls = [], sessions = [];
  let generation = 0n;
  const binding = {
    apiVersion: { major: 1, minor: 0 },
    capabilities: Object.fromEntries(Object.keys(operations).map(operation => [operation, { status: 'supported' }])),
    openSession() {
      const session = { closed: false, generation: ++generation,
        invoke(operation, request) { calls.push({ operation, request }); return Promise.resolve().then(() => operations[operation](request)); },
        close() { const changed = !session.closed; session.closed = true; return changed; },
        whenClosed() { return Promise.resolve(); }
      };
      sessions.push(session); return session;
    }
  };
  require.cache[filename] = { id: filename, filename, loaded: true, exports: binding };
  t.after(() => { if (previous) require.cache[filename] = previous; else delete require.cache[filename]; });
  return { calls, sessions };
}
module.exports = { stubPackagedNativeBinding };
