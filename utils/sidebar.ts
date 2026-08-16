import type {
  ChatMessage,
  ChatTranscriptItem,
  ContextUsage,
  SelectedElementReference,
} from './ai';

export const SIDEBAR_REQUEST_STORAGE_KEY = 'sidebarScriptRequest';
export const SIDEBAR_SESSIONS_STORAGE_KEY = 'sidebarSessions';
const SIDEBAR_REQUEST_STORAGE_PREFIX = `${SIDEBAR_REQUEST_STORAGE_KEY}:`;
const SIDEBAR_WINDOW_REQUEST_STORAGE_PREFIX = `${SIDEBAR_REQUEST_STORAGE_KEY}:window:`;
const SIDEBAR_SESSION_STORAGE_PREFIX = 'sidebarSession:';
const SIDEBAR_PATH = 'sidepanel.html';

export interface SidebarActivity {
  id: string;
  kind: 'thinking' | 'tool';
  toolName?: string;
  pending: boolean;
}

export type SidebarDisplayMessage =
  | ChatMessage
  | { role: 'activity'; activities: SidebarActivity[] };

export interface SidebarChatState {
  messages: SidebarDisplayMessage[];
  transcript: ChatTranscriptItem[];
  contextUsage: ContextUsage | null;
  draft: string;
  sending: boolean;
  stopping: boolean;
  scriptChanged: boolean;
  applyStatus: string;
  error: string;
  selectedElement: SelectedElementReference | null;
}

export interface SidebarSession {
  sessionId: string;
  scriptId: string;
  windowId: number;
  nonce: string;
  createdAt: number;
  chat: SidebarChatState;
}

export interface SidebarScriptRequest {
  sessionId: string;
  scriptId: string;
  windowId: number;
  nonce: string;
  inScope: boolean;
}

export type SidebarCoordinatorMessage =
  | { type: 'scriptsmith:sidebar:reconcile' }
  | { type: 'scriptsmith:sidebar:patch-chat'; sessionId: string; patch: Partial<SidebarChatState> }
  | { type: 'scriptsmith:sidebar:start-chat'; sessionId: string; settings: import('./ai').ChatSettings }
  | { type: 'scriptsmith:sidebar:stop-chat'; sessionId: string }
  | { type: 'scriptsmith:sidebar:clear-chat'; sessionId: string };

export function sidebarRequestStorageKey(tabId: number): string {
  return `${SIDEBAR_REQUEST_STORAGE_PREFIX}${tabId}`;
}

export function sidebarWindowRequestStorageKey(windowId: number): string {
  return `${SIDEBAR_WINDOW_REQUEST_STORAGE_PREFIX}${windowId}`;
}

export function sidebarSessionStorageKey(sessionId: string): string {
  return `${SIDEBAR_SESSION_STORAGE_PREFIX}${sessionId}`;
}

function sidebarPathForTab(tabId: number): string {
  return `${SIDEBAR_PATH}?tabId=${tabId}`;
}

function emptyChatState(): SidebarChatState {
  return {
    messages: [],
    transcript: [],
    contextUsage: null,
    draft: '',
    sending: false,
    stopping: false,
    scriptChanged: false,
    applyStatus: '',
    error: '',
    selectedElement: null,
  };
}

export async function getSidebarSession(
  sessionId: string,
): Promise<SidebarSession | null> {
  const key = sidebarSessionStorageKey(sessionId);
  const stored = await browser.storage.session.get(key);
  return (stored[key] as SidebarSession | undefined) ?? null;
}

export async function createSidebarSession(
  scriptId: string,
  windowId: number,
): Promise<SidebarSession> {
  const session: SidebarSession = {
    sessionId: crypto.randomUUID(),
    scriptId,
    windowId,
    nonce: crypto.randomUUID(),
    createdAt: Date.now(),
    chat: emptyChatState(),
  };
  const index = await browser.storage.session.get(SIDEBAR_SESSIONS_STORAGE_KEY);
  const sessionIds = Array.isArray(index[SIDEBAR_SESSIONS_STORAGE_KEY])
    ? index[SIDEBAR_SESSIONS_STORAGE_KEY].filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  await browser.storage.session.set({
    [SIDEBAR_SESSIONS_STORAGE_KEY]: [...sessionIds, session.sessionId],
    [sidebarSessionStorageKey(session.sessionId)]: session,
  });
  return session;
}

export async function getAllSidebarSessions(): Promise<SidebarSession[]> {
  const index = await browser.storage.session.get(SIDEBAR_SESSIONS_STORAGE_KEY);
  const sessionIds = Array.isArray(index[SIDEBAR_SESSIONS_STORAGE_KEY])
    ? index[SIDEBAR_SESSIONS_STORAGE_KEY].filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  if (sessionIds.length === 0) return [];
  const keys = sessionIds.map(sidebarSessionStorageKey);
  const stored = await browser.storage.session.get(keys);
  return sessionIds.flatMap((sessionId) => {
    const session = stored[sidebarSessionStorageKey(sessionId)] as
      | SidebarSession
      | undefined;
    return session ? [session] : [];
  });
}

export async function removeSidebarSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const removed = new Set(sessionIds);
  const sessions = await getAllSidebarSessions();
  await browser.storage.session.set({
    [SIDEBAR_SESSIONS_STORAGE_KEY]: sessions
      .map((session) => session.sessionId)
      .filter((sessionId) => !removed.has(sessionId)),
  });
  await browser.storage.session.remove(sessionIds.map(sidebarSessionStorageKey));
}

export async function patchSidebarChat(
  sessionId: string,
  patch: Partial<SidebarChatState>,
): Promise<SidebarSession | null> {
  const session = await getSidebarSession(sessionId);
  if (!session) return null;
  const updated = { ...session, chat: { ...session.chat, ...patch } };
  await browser.storage.session.set({
    [sidebarSessionStorageKey(sessionId)]: updated,
  });
  return updated;
}

export async function disableGlobalScriptSidebar(): Promise<void> {
  await browser.sidePanel?.setOptions?.({ enabled: false });
}

export async function prepareScriptSidebar(tabId: number): Promise<void> {
  const sidePanel = browser.sidePanel;
  if (!sidePanel?.setOptions) return;

  await disableGlobalScriptSidebar();
  await sidePanel.setOptions({
    tabId,
    path: sidebarPathForTab(tabId),
    enabled: true,
  });
}

export async function showScriptSidebar(
  tabId: number,
  windowId?: number,
): Promise<void> {
  if (browser.sidePanel?.open) {
    // Re-enable this tab's panel as part of the user-triggered call before
    // asking Chromium to open it.
    await prepareScriptSidebar(tabId);
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

  await browser.windows.create({
    url: browser.runtime.getURL(`/sidepanel.html?tabId=${tabId}`),
    type: 'popup',
    width: 480,
    height: 720,
    ...(windowId === undefined ? {} : { left: 0 }),
  });
}

export async function openScriptSidebar(
  request: { scriptId: string },
  tabId: number,
  windowId?: number,
): Promise<void> {
  const resolvedWindowId = windowId ?? (await browser.tabs.get(tabId)).windowId;
  const existingSessions = (await getAllSidebarSessions())
    .filter((session) =>
      session.scriptId === request.scriptId &&
      session.windowId === resolvedWindowId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const session = existingSessions[0] ??
    await createSidebarSession(request.scriptId, resolvedWindowId);
  const assignment: SidebarScriptRequest = {
    sessionId: session.sessionId,
    scriptId: session.scriptId,
    windowId: session.windowId,
    nonce: session.nonce,
    inScope: true,
  };

  // Commit the request before opening. A newly-created panel reads this key on
  // mount; opening concurrently caused it to briefly render the empty state.
  await browser.storage.session.set({
    [SIDEBAR_REQUEST_STORAGE_KEY]: assignment,
    [sidebarRequestStorageKey(tabId)]: assignment,
    [sidebarWindowRequestStorageKey(resolvedWindowId)]: assignment,
  });
  void browser.runtime.sendMessage({ type: 'scriptsmith:sidebar:reconcile' })
    .catch(() => undefined);
  await showScriptSidebar(tabId, resolvedWindowId);
}
