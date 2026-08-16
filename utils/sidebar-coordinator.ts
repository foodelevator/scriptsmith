import {
  chatWithScript,
  ScriptChatAbortedError,
  type ChatMessage,
  type ChatSettings,
} from './ai';
import { getPageScript } from './scripts';
import {
  disableGlobalScriptSidebar,
  getAllSidebarSessions,
  getSidebarSession,
  patchSidebarChat,
  removeSidebarSessions,
  sidebarRequestStorageKey,
  sidebarWindowRequestStorageKey,
  type SidebarActivity,
  type SidebarChatState,
  type SidebarCoordinatorMessage,
  type SidebarDisplayMessage,
  type SidebarScriptRequest,
  type SidebarSession,
} from './sidebar';

const controllers = new Map<string, AbortController>();
const starting = new Set<string>();
const writes = new Map<string, Promise<unknown>>();
let reconciliation = Promise.resolve();

function messageFor(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function assignmentFor(session: SidebarSession, inScope: boolean): SidebarScriptRequest {
  return {
    sessionId: session.sessionId,
    scriptId: session.scriptId,
    windowId: session.windowId,
    nonce: session.nonce,
    inScope,
  };
}

function newest(sessions: SidebarSession[]): SidebarSession | undefined {
  return [...sessions].sort((a, b) =>
    b.createdAt - a.createdAt || b.sessionId.localeCompare(a.sessionId))[0];
}

async function validSessions(): Promise<SidebarSession[]> {
  const sessions = await getAllSidebarSessions();
  const windows = new Set((await browser.windows.getAll()).map((window) => window.id));
  const validity = await Promise.all(sessions.map(async (session) => ({
    session,
    valid: windows.has(session.windowId) && Boolean(await getPageScript(session.scriptId)),
  })));
  const stale = validity.filter(({ valid }) => !valid).map(({ session }) => session.sessionId);
  for (const sessionId of stale) controllers.get(sessionId)?.abort();
  await removeSidebarSessions(stale);
  const valid = validity.filter(({ valid }) => valid).map(({ session }) => session);
  await Promise.all(valid.map(async (session) => {
    if (session.chat.sending && !controllers.has(session.sessionId)) {
      await patchSidebarChat(session.sessionId, {
        sending: false,
        stopping: false,
        messages: finishAllActivities(session.chat.messages),
      });
    }
  }));
  return valid;
}

async function reconcileNow(): Promise<void> {
  const sessions = await validSessions();
  const tabs = await browser.tabs.query({});
  const sidePanel = browser.sidePanel;
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
  const requestKeys = tabs.flatMap((tab) =>
    tab.id === undefined ? [] : [sidebarRequestStorageKey(tab.id)]);
  const storedRequests = requestKeys.length > 0
    ? await browser.storage.session.get(requestKeys)
    : {};
  const requests = new Map<number, SidebarScriptRequest>();
  const invalidRequestKeys: string[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const key = sidebarRequestStorageKey(tab.id);
    const request = storedRequests[key] as SidebarScriptRequest | undefined;
    const session = request && sessionsById.get(request.sessionId);
    if (
      session &&
      session.scriptId === request.scriptId &&
      session.windowId === tab.windowId
    ) {
      requests.set(tab.id, assignmentFor(session, true));
    } else if (request) {
      invalidRequestKeys.push(key);
    }
  }
  if (invalidRequestKeys.length > 0) {
    await browser.storage.session.remove(invalidRequestKeys);
  }

  // Firefox has one physical sidebar per window. Follow the active tab's
  // explicit binding when possible; otherwise leave the sidebar out of scope.
  await Promise.all(tabs.filter((tab) => tab.active).map(async (active) => {
    const key = sidebarWindowRequestStorageKey(active.windowId);
    const request = active.id === undefined ? undefined : requests.get(active.id);
    if (request) {
      await browser.storage.session.set({ [key]: request });
      return;
    }
    const fallback = newest(
      sessions.filter((session) => session.windowId === active.windowId),
    );
    if (!fallback) {
      await browser.storage.session.remove(key);
      return;
    }
    await browser.storage.session.set({
      [key]: assignmentFor(fallback, false),
    });
  }));

  if (sidePanel?.setOptions) {
    await disableGlobalScriptSidebar();
    await Promise.all(tabs.flatMap((tab) => {
      if (tab.id === undefined) return [];
      const request = requests.get(tab.id);
      return [request
        ? sidePanel.setOptions({
            tabId: tab.id,
            path: `sidepanel.html?tabId=${tab.id}`,
            enabled: true,
          })
        : sidePanel.setOptions({ tabId: tab.id, enabled: false })];
    }));
    return;
  }

  // Firefox cannot make its window sidebar truly tab-scoped, so unbound tabs
  // render the out-of-scope state rather than closing it irreversibly.
}

export function reconcileSidebarSessions(): Promise<void> {
  reconciliation = reconciliation
    .catch(() => undefined)
    .then(reconcileNow)
    .catch((error) => {
      console.warn('Vibext could not reconcile sidebar sessions:', error);
    });
  return reconciliation;
}

function mutateChat(
  sessionId: string,
  mutate: (state: SidebarChatState) => SidebarChatState,
): Promise<unknown> {
  const previous = writes.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const session = await getSidebarSession(sessionId);
    if (!session) return;
    await patchSidebarChat(sessionId, mutate(session.chat));
  });
  writes.set(sessionId, next);
  void next.finally(() => {
    if (writes.get(sessionId) === next) writes.delete(sessionId);
  });
  return next;
}

function finishAllActivities(messages: SidebarDisplayMessage[]): SidebarDisplayMessage[] {
  return messages.map((message) => message.role === 'activity'
    ? {
        ...message,
        activities: message.activities.map((activity) => ({ ...activity, pending: false })),
      }
    : message);
}

function addActivity(
  messages: SidebarDisplayMessage[],
  activity: SidebarActivity,
): SidebarDisplayMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'activity') {
    return [...messages, { role: 'activity', activities: [activity] }];
  }
  const lastActivity = last.activities[last.activities.length - 1];
  const activities = activity.kind === 'thinking' && lastActivity?.kind === 'thinking'
    ? [...last.activities.slice(0, -1), activity]
    : [...last.activities, activity];
  return [...messages.slice(0, -1), { role: 'activity', activities }];
}

function setActivityPending(
  messages: SidebarDisplayMessage[],
  id: string,
  pending: boolean,
): SidebarDisplayMessage[] {
  return messages.map((message) => message.role === 'activity'
    ? {
        ...message,
        activities: message.activities.map((activity) =>
          activity.id === id ? { ...activity, pending } : activity),
      }
    : message);
}

async function startChat(sessionId: string, settings: ChatSettings): Promise<void> {
  await (writes.get(sessionId) ?? Promise.resolve()).catch(() => undefined);
  const session = await getSidebarSession(sessionId);
  if (!session || session.chat.sending) return;
  const script = await getPageScript(session.scriptId);
  const content = session.chat.draft.trim();
  if (!script || !content) return;

  const userMessage: ChatMessage = {
    role: 'user',
    content,
    ...(session.chat.selectedElement
      ? { selectedElement: session.chat.selectedElement }
      : {}),
  };
  const conversation: ChatMessage[] = [
    ...session.chat.messages.filter(
      (message): message is ChatMessage => message.role !== 'activity',
    ),
    userMessage,
  ];
  let assistantIndex: number | null = null;
  let receivedText = false;
  let scriptEdited = false;
  const codeBefore = script.code;
  const controller = new AbortController();
  controllers.set(sessionId, controller);
  await patchSidebarChat(sessionId, {
    messages: [...session.chat.messages, userMessage],
    draft: '',
    selectedElement: null,
    sending: true,
    stopping: false,
    error: '',
  });

  try {
    const result = await chatWithScript({
      sessionId,
      scriptId: session.scriptId,
      windowId: session.windowId,
      messages: conversation,
      settings,
      history: session.chat.transcript,
    }, {
      onResponseStart() {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: finishAllActivities(state.messages),
        }));
      },
      onThinkingStart(id) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: addActivity(state.messages, {
            id, kind: 'thinking', pending: true,
          }),
        }));
      },
      onThinkingDone(id) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: setActivityPending(state.messages, id, false),
        }));
      },
      onToolCall(id, name) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: addActivity(state.messages, {
            id, kind: 'tool', toolName: name, pending: true,
          }),
        }));
      },
      onToolCallDone(id) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: setActivityPending(state.messages, id, false),
        }));
      },
      onToolExecutionStart(id) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: setActivityPending(state.messages, id, true),
        }));
      },
      onToolResult(id) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          messages: setActivityPending(state.messages, id, false),
        }));
      },
      onScriptChange(updated) {
        if (updated.code !== codeBefore) scriptEdited = true;
        void reconcileSidebarSessions();
      },
      onTranscriptItems(items) {
        void mutateChat(sessionId, (state) => ({
          ...state,
          transcript: [...state.transcript, ...items],
        }));
      },
      onContextUsage(contextUsage) {
        void mutateChat(sessionId, (state) => ({ ...state, contextUsage }));
      },
      onTextDelta(delta) {
        receivedText = true;
        void mutateChat(sessionId, (state) => {
          if (assistantIndex === null) {
            assistantIndex = state.messages.length;
            return {
              ...state,
              messages: [...state.messages, { role: 'assistant', content: delta }],
            };
          }
          return {
            ...state,
            messages: state.messages.map((message, index) =>
              index === assistantIndex && message.role === 'assistant'
                ? { ...message, content: `${message.content}${delta}` }
                : message),
          };
        });
      },
    }, controller.signal);
    if (result.script.code !== codeBefore) scriptEdited = true;
    if (!receivedText) {
      await mutateChat(sessionId, (state) => ({
        ...state,
        messages: [...state.messages, { role: 'assistant', content: result.message }],
      }));
    }
  } catch (caught) {
    if (!(caught instanceof ScriptChatAbortedError)) {
      await mutateChat(sessionId, (state) => ({ ...state, error: messageFor(caught) }));
    }
  } finally {
    await mutateChat(sessionId, (state) => ({
      ...state,
      messages: finishAllActivities(state.messages),
      sending: false,
      stopping: false,
      scriptChanged: state.scriptChanged || scriptEdited,
      ...(scriptEdited ? { applyStatus: '' } : {}),
    }));
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
  }
}

export function startSidebarCoordinator(): void {
  void reconcileSidebarSessions();
  browser.tabs.onCreated.addListener(() => void reconcileSidebarSessions());
  browser.tabs.onUpdated.addListener(() => void reconcileSidebarSessions());
  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.storage.session.remove(sidebarRequestStorageKey(tabId))
      .finally(() => reconcileSidebarSessions());
  });
  browser.tabs.onActivated.addListener(() => void reconcileSidebarSessions());
  browser.windows.onRemoved.addListener(() => void reconcileSidebarSessions());
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.pageScripts) void reconcileSidebarSessions();
  });
  browser.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as Partial<SidebarCoordinatorMessage>;
    if (message.type === 'vibext:sidebar:reconcile') {
      return reconcileSidebarSessions();
    }
    if (message.type === 'vibext:sidebar:patch-chat' && message.sessionId && message.patch) {
      return mutateChat(message.sessionId, (state) => ({ ...state, ...message.patch }));
    }
    if (message.type === 'vibext:sidebar:start-chat' && message.sessionId && message.settings) {
      if (!starting.has(message.sessionId) && !controllers.has(message.sessionId)) {
        starting.add(message.sessionId);
        const turn = startChat(message.sessionId, message.settings).finally(() => {
          starting.delete(message.sessionId!);
        });
        // Keeping the message response open also keeps an MV3 service worker
        // alive for the streamed request when every panel instance is hidden.
        return turn.then(() => ({ ok: true }));
      }
      return Promise.resolve({ ok: true });
    }
    if (message.type === 'vibext:sidebar:stop-chat' && message.sessionId) {
      const controller = controllers.get(message.sessionId);
      if (controller) {
        void mutateChat(message.sessionId, (state) => ({ ...state, stopping: true }));
        controller.abort();
      }
      return Promise.resolve({ ok: true });
    }
    if (message.type === 'vibext:sidebar:clear-chat' && message.sessionId) {
      return mutateChat(message.sessionId, (state) => state.sending
        ? state
        : {
            ...state,
            messages: [],
            transcript: [],
            contextUsage: null,
            draft: '',
            error: '',
            selectedElement: null,
          });
    }
    return undefined;
  });
}
