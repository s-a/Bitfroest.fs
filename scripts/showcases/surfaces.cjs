/* global document, location */
const { assertSurfaceState } = require('./run.cjs');

async function captureSurface({ capture, targets, connect, connections, invoke, waitFor }) {
  const cache = new Map();
  async function connection(target) {
    if (!cache.has(target.id)) {
      const client = await connect(target.webSocketDebuggerUrl); connections.push(client); cache.set(target.id, client);
      await client.call('Runtime.enable');
    }
    return cache.get(target.id);
  }
  const inspect = async () => {
    for (const target of await targets()) {
      const native = ['editor', 'markdown', 'quickpick'].includes(capture.surface);
      if (target.type !== (native ? 'page' : 'iframe') || !target.webSocketDebuggerUrl || !native && !target.url.includes('extensionId=bitfroest.bitfroest-fs-prototype')) continue;
      const client = await connection(target);
      for (const context of client.contexts) {
        let result;
        try { result = await client.call('Runtime.evaluate', { contextId: context.id, returnByValue: true,
          expression: `(${(({ expect, ready, text }) => {
            const element = document.querySelector(expect), rect = element?.getBoundingClientRect();
            const readyRect = ready && document.querySelector(ready)?.getBoundingClientRect();
            return { visible: Boolean(rect?.width && rect?.height), ready: !ready || Boolean(readyRect?.width && readyRect?.height),
              text: element?.textContent || '', owner: location.href.includes('extensionId=bitfroest.bitfroest-fs-prototype') ? 'bitfroest.bitfroest-fs-prototype' : '',
              expected: text };
          }).toString()})(${JSON.stringify(capture)})` }); } catch { continue; }
        const state = result.result.value;
        if (!state?.visible || !state.ready || !state.text.includes(capture.text)) continue;
        return { target, client, context, state };
      }
    }
    return false;
  };
  const initial = await waitFor(inspect);
  const initialPage = initial.target.type === 'page' ? initial.target : (await targets()).find(item => item.id === initial.target.parentId);
  await (await connection(initialPage)).call('Page.bringToFront');
  if (capture.surface !== 'quickpick') await invoke('showcase.prepare-editor');
  const found = await waitFor(inspect);
  if (capture.surface === 'editor') {
    const tab = await invoke('showcase.inspect-editor');
    assertSurfaceState({ ...found.state, kind: 'editor', diff: tab.diff }, capture);
  } else if (capture.surface === 'quickpick') assertSurfaceState({ ...found.state, kind: 'quickpick' }, capture);
  else if (capture.surface !== 'markdown') assertSurfaceState({ ...found.state, kind: 'webview' }, capture);
  const pageTarget = found.target.type === 'page' ? found.target : (await targets()).find(item => item.id === found.target.parentId);
  const page = await connection(pageTarget);
  const shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (capture.surface === 'quickpick') await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  return shot;
}

module.exports = { captureSurface };
