const Progress = require('./media/commander-progress');
const OPERATIONS = Object.freeze([
  'files.copy', 'files.rename', 'clipboard.readFiles', 'clipboard.writeFiles',
  'clipboard.acknowledge', 'clipboard.cancelFiles', 'shell.showContextMenu', 'shell.openAssociated',
  'shell.openTrash', 'shell.openTerminal', 'icons.resolve', 'metadata.query', 'paths.resolveNetwork',
  'encoding.describe', 'encoding.decodeBlock', 'encoding.decodeChunk', 'windows.resolveOwner',
  'windows.maximize', 'locks.scan', 'locks.releaseHandles', 'locks.unloadModules', 'locks.rename', 'git.status', 'git.info',
  'processes.terminate', 'restartDeletion.prepare', 'restartDeletion.commit'
]);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function loadNativeApi() {
  let binding;
  try { binding = require('./native/binding.node'); }
  catch (cause) { throw Object.assign(failure('BindingUnavailable', 'The packaged native binding could not be loaded.'), { cause }); }
  return createNativeApi(binding);
}

function createNativeApi(binding) {
  if (binding?.apiVersion?.major !== 1 || !Number.isInteger(binding.apiVersion.minor) || binding.apiVersion.minor < 0 || typeof binding.openSession !== 'function') {
    throw failure('IncompatibleBinding', 'Native API version 1 is required.');
  }
  const capabilities = Object.freeze(Object.fromEntries(OPERATIONS.map(operation => {
    const entry = binding.capabilities?.[operation];
    return [operation, Object.freeze(entry ? { ...entry } : { status: 'unsupported', reason: 'NotImplemented' })];
  })));
  const sessions = new Set();
  const closingSessions = new Set();
  let stopped = false;
  return Object.freeze({
    apiVersion: Object.freeze({ ...binding.apiVersion }),
    capabilities,
    openSession() {
      if (stopped) throw failure('SessionClosed', 'The native API is shut down.');
      const resource = binding.openSession();
      let closed = false;
      let nextRequest = 1n;
      let closingPromise;
      const session = Object.freeze({
        generation: resource.generation,
        invoke(operation, request, options = {}) {
          if (closed) throw failure('SessionClosed', 'The native session is closed.');
          if (!OPERATIONS.includes(operation)) throw failure('UnknownOperation', 'Unknown native operation.');
          if (capabilities[operation].status === 'unsupported') throw failure('UnsupportedOperation', `${operation} is unavailable.`);
          if (operation === 'git.status' && request?.summary === true && capabilities[operation].dirtySummary !== true) throw failure('UnsupportedOperation', 'The loaded native module does not support Git dirty summaries.');
          const requestId = nextRequest++;
          let nativePromise, progressFailure, cancelTimer, cancellationSent = false, finished = false, cancelRequested = false;
          const signal = options.signal;
          if (signal?.aborted) throw Object.assign(failure('Cancelled', 'The request was cancelled before it started.'), { name: 'AbortError', requestId, generation: resource.generation, operation, outcome: { status: 'unchanged' } });
          const notifyCancellation = () => {
            if (!nativePromise || cancellationSent) return;
            cancellationSent = true;
            try { nativePromise?.cancel?.(); } catch (error) { progressFailure ||= error; }
            if (operation === 'files.copy' && typeof nativePromise.cancelIo === 'function') {
              const cancelIo = () => {
                if (finished) return;
                try { nativePromise.cancelIo(); } catch (error) { progressFailure ||= error; }
                cancelTimer = setTimeout(cancelIo, 100);
              };
              cancelTimer = setTimeout(cancelIo, 5000);
            }
          };
          const cancel = () => {
            if (finished || cancelRequested) return;
            cancelRequested = true;
            notifyCancellation();
          };
          /** @param {Record<string, unknown> & {transferred?: number, total?: number}} event */
          const progress = event => {
            if (finished || closed || signal?.aborted || progressFailure) return;
            try {
              const transferred = event?.transferred, total = event?.total;
              const measurable = typeof transferred === 'number' && typeof total === 'number' && Number.isSafeInteger(transferred) && Number.isSafeInteger(total) && transferred >= 0 && total >= transferred;
              const measurement = measurable ? Progress.known('bytes', transferred, total) : Progress.unknown('items', 0, 'native-operation');
              options.onProgress?.(Progress.event({ ...event, phase: operation, requestId, generation: resource.generation, overall: measurement, current: measurement }));
            }
            catch (error) { progressFailure = error; cancel(); }
          };
          nativePromise = operation === 'files.copy' || operation === 'git.status' && typeof options.onProgress === 'function' ? resource.invoke(operation, request, progress) : resource.invoke(operation, request);
          if (cancelRequested) notifyCancellation();
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
          return Promise.resolve(nativePromise).then(result => {
            if (progressFailure) throw Object.assign(failure('ProgressCallbackFailed', `${operation === 'files.copy' ? 'Copy' : 'Git status'} progress could not be delivered.`), { cause: progressFailure, requestId, generation: resource.generation, operation, outcome: result });
            if (closed) throw Object.assign(failure('SessionClosed', 'The native session is closed.'), { requestId, generation: resource.generation, operation, ...(result?.status === 'committed' ? { outcome: result } : result?.outcome && typeof result.outcome === 'object' ? { outcome: result.outcome } : {}) });
            return Object.freeze({ ...result, requestId, generation: resource.generation });
          }, error => {
            if (progressFailure) throw Object.assign(failure('ProgressCallbackFailed', `${operation === 'files.copy' ? 'Copy' : 'Git status'} progress could not be delivered.`), { ...error, code: 'ProgressCallbackFailed', cause: progressFailure, requestId, generation: resource.generation, operation });
            throw Object.assign(failure(error?.code || 'NativeFailure', error?.message || 'Native operation failed.'), { cause: error, ...error, requestId, generation: resource.generation, operation });
          }).finally(() => {
            finished = true;
            clearTimeout(cancelTimer);
            signal?.removeEventListener('abort', cancel);
          });
        },
        close() {
          if (closed) return;
          resource.close();
          closed = true;
          sessions.delete(session);
          closingPromise = typeof resource.whenClosed === 'function' ? Promise.resolve(resource.whenClosed()) : Promise.resolve();
          closingSessions.add(closingPromise);
          closingPromise.then(() => closingSessions.delete(closingPromise), () => closingSessions.delete(closingPromise));
        },
        closeAsync() {
          session.close();
          return closingPromise;
        }
      });
      sessions.add(session);
      return session;
    },
    shutdown() {
      stopped = true;
      for (const session of sessions) session.close();
    },
    shutdownAsync() {
      stopped = true;
      for (const session of sessions) session.close();
      return Promise.all([...closingSessions]).then(() => undefined);
    }
  });
}

module.exports = { createNativeApi, loadNativeApi };
