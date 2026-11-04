function waitForX11Display(server, { timeoutMs = 20000, diagnostics = () => '' } = {}) {
  return new Promise((resolve, reject) => {
    const ready = server.stdio[3];
    let output = '';
    const context = () => `pid=${server.pid}, exit=${server.exitCode}, signal=${server.signalCode}, readiness=${JSON.stringify(output)}: ${diagnostics()}`;
    const finish = (error, display) => {
      clearTimeout(timer);
      server.off('error', onError);
      server.off('exit', onExit);
      ready.off('data', onData);
      ready.off('end', onEnd);
      ready.off('error', onError);
      if (error) reject(error); else resolve(display);
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`The private X11 server exited with ${code}/${signal}: ${context()}`));
    const onEnd = () => finish(new Error(`The private X11 readiness stream closed before a complete display line: ${context()}`));
    const onData = data => {
      output += data.toString();
      if (output.length > 64 || (output.includes('\n') && (!/^\d+\r?\n$/.test(output) || Number(output.trim()) > 59535))) {
        finish(new Error(`The private X11 server returned an invalid display: ${context()}`));
      } else if (output.includes('\n')) {
        finish(null, `localhost:${output.trim()}`);
      }
    };
    const timer = setTimeout(() => finish(new Error(`The private X11 server did not start within ${timeoutMs} ms: ${context()}`)), timeoutMs);
    server.once('error', onError);
    server.once('exit', onExit);
    ready.on('data', onData);
    ready.once('end', onEnd);
    ready.once('error', onError);
  });
}

module.exports = { waitForX11Display };
