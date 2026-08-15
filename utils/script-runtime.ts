export function scriptRuntimeCode(scriptId: string): string {
  return `(() => {
    const runtimeKey = ${JSON.stringify(scriptId)};
    const runtimes = globalThis.__vibextRuntimes ??= {};
    if (runtimes[runtimeKey]) return runtimes[runtimeKey];
    let values = {};
    let peers = [];
    let port = null;
    let reconnectTimer = null;
    const listeners = new Set();
    const connect = () => {
      if (port || !globalThis.chrome?.runtime?.connect) return;
      try {
        port = chrome.runtime.connect({ name: 'vibext-script:' + ${JSON.stringify(scriptId)} });
        port.onMessage.addListener((message) => {
          if (message?.type !== 'peers' || !Array.isArray(message.peers)) return;
          peers = message.peers;
          for (const listener of listeners) { try { listener(peers); } catch (error) { console.error(error); } }
        });
        port.onDisconnect.addListener(() => {
          port = null;
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, 500);
        });
        port.postMessage({ type: 'hello', origin: location.origin, url: location.href, values });
      } catch { port = null; }
    };
    const api = {
      publish(nextValues) {
        if (!nextValues || typeof nextValues !== 'object' || Array.isArray(nextValues)) return;
        values = nextValues;
        connect();
        try { port?.postMessage({ type: 'publish', origin: location.origin, url: location.href, values }); } catch {}
      },
      onPeers(callback) {
        if (typeof callback !== 'function') return () => {};
        listeners.add(callback);
        try { callback(peers); } catch (error) { console.error(error); }
        connect();
        return () => listeners.delete(callback);
      },
    };
    runtimes[runtimeKey] = api;
    return api;
  })();`;
}
