export const SIDEBAR_REQUEST_STORAGE_KEY = 'sidebarScriptRequest';
const SIDEBAR_REQUEST_STORAGE_PREFIX = `${SIDEBAR_REQUEST_STORAGE_KEY}:`;
const SIDEBAR_PATH = 'sidepanel.html';

export function sidebarRequestStorageKey(tabId: number): string {
  return `${SIDEBAR_REQUEST_STORAGE_PREFIX}${tabId}`;
}

function sidebarPathForTab(tabId: number): string {
  return `${SIDEBAR_PATH}?tabId=${tabId}`;
}

export interface SidebarScriptRequest {
  scriptId: string;
  origin: string;
  tabId: number;
  nonce: string;
}

export async function selectScriptForSidebar(
  request: Omit<SidebarScriptRequest, 'nonce'>,
): Promise<void> {
  const value: SidebarScriptRequest = {
    ...request,
    nonce: crypto.randomUUID(),
  };
  await browser.storage.session.set({
    // Firefox's sidebar is window-scoped and continues to use the latest
    // request. Chromium panels use the tab-specific key.
    [SIDEBAR_REQUEST_STORAGE_KEY]: value,
    [sidebarRequestStorageKey(value.tabId)]: value,
  });
}

export async function disableGlobalScriptSidebar(): Promise<void> {
  await browser.sidePanel?.setOptions?.({ enabled: false });
}

export async function prepareScriptSidebar(tabId: number): Promise<void> {
  const sidePanel = browser.sidePanel;
  if (!sidePanel?.setOptions) return;

  // The manifest's default path creates a global panel. Disable that default,
  // then override it for this tab so switching tabs hides this panel.
  await disableGlobalScriptSidebar();
  await sidePanel.setOptions({
    tabId,
    path: sidebarPathForTab(tabId),
    enabled: true,
  });
}

export async function clearScriptSidebarRequest(tabId: number): Promise<void> {
  await browser.storage.session.remove(sidebarRequestStorageKey(tabId));
}

export async function showScriptSidebar(
  tabId: number,
  windowId?: number,
): Promise<void> {
  if (browser.sidePanel?.open) {
    await browser.sidePanel.open({ tabId });
    return;
  }

  const firefoxSidebar = (
    browser as typeof browser & {
      sidebarAction?: { open(): Promise<void> };
    }
  ).sidebarAction;
  if (firefoxSidebar?.open) {
    await firefoxSidebar.open();
    return;
  }

  // A standalone extension window is a fallback for browsers without a
  // programmatic sidebar API.
  await browser.windows.create({
    url: browser.runtime.getURL(`/sidepanel.html?tabId=${tabId}`),
    type: 'popup',
    width: 480,
    height: 720,
    ...(windowId === undefined ? {} : { left: 0 }),
  });
}

export async function openScriptSidebar(
  request: Omit<SidebarScriptRequest, 'nonce' | 'tabId'>,
  tabId: number,
  windowId?: number,
): Promise<void> {
  // Invoke open before awaiting storage so Chromium still considers this part
  // of the popup button's user gesture. The sidebar listens for the selection.
  const selecting = selectScriptForSidebar({ ...request, tabId });
  const opening = showScriptSidebar(tabId, windowId);
  await Promise.all([selecting, opening]);
}
