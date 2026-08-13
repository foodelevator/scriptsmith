export const SIDEBAR_REQUEST_STORAGE_KEY = 'sidebarScriptRequest';

export interface SidebarScriptRequest {
  scriptId: string;
  origin: string;
  creating: boolean;
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
  await browser.storage.session.set({ [SIDEBAR_REQUEST_STORAGE_KEY]: value });
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
    url: browser.runtime.getURL('/sidepanel.html'),
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
