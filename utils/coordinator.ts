interface PeerRecord {
  tabId: number;
  origin: string;
  url: string;
  values: Record<string, unknown>;
}

type UserScriptPort = Browser.runtime.Port;

const peersByScript = new Map<string, Map<number, PeerRecord>>();
const portsByScript = new Map<string, Set<UserScriptPort>>();
const PORT_PREFIX = 'scriptsmith-script:';

function broadcast(scriptId: string): void {
  const peers = [...(peersByScript.get(scriptId)?.values() ?? [])];
  for (const port of portsByScript.get(scriptId) ?? []) {
    const selfTabId = port.sender?.tab?.id;
    try {
      port.postMessage({
        type: 'peers',
        peers: peers.map((peer) => ({ ...peer, self: peer.tabId === selfTabId })),
      });
    } catch {
      // A disconnect event will clean up ports that close during a broadcast.
    }
  }
}

export function startScriptCoordinator(): void {
  browser.runtime.onUserScriptConnect?.addListener((port) => {
    if (!port.name.startsWith(PORT_PREFIX)) return;
    const scriptId = port.name.slice(PORT_PREFIX.length);
    const tabId = port.sender?.tab?.id;
    if (!scriptId || tabId === undefined) return;

    const ports = portsByScript.get(scriptId) ?? new Set<UserScriptPort>();
    ports.add(port);
    portsByScript.set(scriptId, ports);

    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const record = message as Record<string, unknown>;
      if (record.type !== 'hello' && record.type !== 'publish') return;
      if (
        typeof record.origin !== 'string' ||
        typeof record.url !== 'string' ||
        !record.values ||
        typeof record.values !== 'object' ||
        Array.isArray(record.values)
      ) return;
      const peers = peersByScript.get(scriptId) ?? new Map<number, PeerRecord>();
      peers.set(tabId, {
        tabId,
        origin: record.origin,
        url: record.url,
        values: record.values as Record<string, unknown>,
      });
      peersByScript.set(scriptId, peers);
      broadcast(scriptId);
    });

    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (ports.size === 0) portsByScript.delete(scriptId);
      const peers = peersByScript.get(scriptId);
      peers?.delete(tabId);
      if (peers?.size === 0) peersByScript.delete(scriptId);
      broadcast(scriptId);
    });
  });
}
