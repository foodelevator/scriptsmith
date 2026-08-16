<script lang="ts">
  import { Combobox, Popover, Slider } from 'bits-ui';
  import {
    DEFAULT_CHAT_SETTINGS,
    type ChatSettings,
    type ContextUsage,
    type ChatTranscriptItem,
    type OpenAIModel,
    type ReasoningEffort,
    type SelectedElementReference,
  } from '../../utils/ai';
  import {
    CODEX_REFRESH_TOKEN_STORAGE_KEY,
    hasCodexSubscription,
  } from '../../utils/codex-auth';
  import {
    addOriginToScript,
    getPageScript,
    originFromUrl,
    matchingTabsInWindow,
    removeOriginFromScript,
    runPageScriptNow,
    type PageScript,
  } from '../../utils/scripts';
  import {
    SIDEBAR_REQUEST_STORAGE_KEY,
    getSidebarSession,
    sidebarRequestStorageKey,
    sidebarSessionStorageKey,
    sidebarWindowRequestStorageKey,
    type SidebarChatState,
    type SidebarDisplayMessage,
    type SidebarScriptRequest,
  } from '../../utils/sidebar';
  type ElementSelectionResponse = {
    ok: boolean;
    origin?: string;
    cancelled?: boolean;
    error?: string;
    element?: Pick<SelectedElementReference, 'selector' | 'label' | 'html'>;
  };

  const CHAT_SETTINGS_STORAGE_KEY = 'scriptsmith:chat-settings';
  const modelOptions: { value: OpenAIModel; label: string }[] = [
    { value: 'gpt-5.6-luna', label: 'Luna' },
    { value: 'gpt-5.6-terra', label: 'Terra' },
    { value: 'gpt-5.6-sol', label: 'Sol' },
  ];
  const reasoningOptions: {
    value: ReasoningEffort;
    label: string;
    shortLabel: string;
  }[] = [
    { value: 'none', label: 'None', shortLabel: 'N' },
    { value: 'low', label: 'Low', shortLabel: 'L' },
    { value: 'medium', label: 'Medium', shortLabel: 'M' },
    { value: 'high', label: 'High', shortLabel: 'H' },
    { value: 'xhigh', label: 'XHigh', shortLabel: 'XH' },
    { value: 'max', label: 'Max', shortLabel: 'MX' },
  ];

  const tabIdParameter = new URLSearchParams(location.search).get('tabId');
  const panelTabId = tabIdParameter && /^\d+$/.test(tabIdParameter)
    ? Number(tabIdParameter)
    : null;
  let requestStorageKey = panelTabId === null
    ? SIDEBAR_REQUEST_STORAGE_KEY
    : sidebarRequestStorageKey(panelTabId);

  let request: SidebarScriptRequest | null = null;
  let script: PageScript | null = null;
  let messages: SidebarDisplayMessage[] = [];
  let transcript: ChatTranscriptItem[] = [];
  let contextUsage: ContextUsage | null = null;
  let draft = '';
  let signedIn = false;
  let loading = true;
  let sending = false;
  let stopping = false;
  let applying = false;
  let scriptChanged = false;
  let applyStatus = '';
  let error = '';
  let selectedElement: SelectedElementReference | null = null;
  let selectingElement = false;
  let openOrigins: string[] = [];
  let siteOrigin = '';
  let addingSite = false;
  let removingOrigin: string | null = null;
  let selectionRequestId = 0;
  let messagesElement: HTMLElement;
  let chatSettings: ChatSettings = { ...DEFAULT_CHAT_SETTINGS };
  let settingsOpen = false;
  let settingsWrite: Promise<void> = Promise.resolve();
  let selectionTabIds: number[] = [];

  $: selectedModel = modelOptions.find(
    (option) => option.value === chatSettings.model,
  ) ?? modelOptions[2]!;
  $: reasoningIndex = Math.max(
    0,
    reasoningOptions.findIndex(
      (option) => option.value === chatSettings.reasoningEffort,
    ),
  );
  $: selectedReasoning = reasoningOptions[reasoningIndex]!;

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function applyChatState(state: SidebarChatState): void {
    messages = state.messages;
    transcript = state.transcript;
    contextUsage = state.contextUsage;
    draft = state.draft;
    sending = state.sending;
    stopping = state.stopping;
    scriptChanged = state.scriptChanged;
    applyStatus = state.applyStatus;
    error = state.error;
    selectedElement = state.selectedElement;
  }

  async function patchChat(patch: Partial<SidebarChatState>): Promise<void> {
    if (!request) return;
    await browser.runtime.sendMessage({
      type: 'scriptsmith:sidebar:patch-chat',
      sessionId: request.sessionId,
      patch,
    });
  }

  function contextUsageColor(usedPercent: number): string {
    if (usedPercent < 20) return 'var(--usage-high)';
    if (usedPercent < 50) return 'var(--usage-medium)';
    if (usedPercent < 80) return 'var(--usage-low)';
    return 'var(--usage-critical)';
  }

  function contextUsageLabel(usage: ContextUsage): string {
    return `${Math.round(usage.usedPercent)}% context used · ${usage.inputTokens.toLocaleString()} / ${usage.contextWindowTokens.toLocaleString()} tokens`;
  }

  type AssistantSanitizer = {
    allowAttribute: (attribute: string) => boolean;
  };

  type AssistantSanitizerConstructor = new (
    configuration?: 'default',
  ) => AssistantSanitizer;

  type SanitizingElement = HTMLElement & {
    setHTML?: (
      html: string,
      options?: { sanitizer: AssistantSanitizer },
    ) => void;
  };

  function createAssistantSanitizer(): AssistantSanitizer | null {
    const SanitizerApi = (
      globalThis as typeof globalThis & {
        Sanitizer?: AssistantSanitizerConstructor;
      }
    ).Sanitizer;
    if (!SanitizerApi) return null;

    try {
      const sanitizer = new SanitizerApi('default');
      sanitizer.allowAttribute('style');
      return sanitizer;
    } catch {
      return null;
    }
  }

  const assistantSanitizer = createAssistantSanitizer();

  function renderAssistantHtml(node: HTMLElement, initialContent: string) {
    const render = (content: string): void => {
      const sanitizingNode = node as SanitizingElement;
      if (
        typeof sanitizingNode.setHTML !== 'function'
        || !assistantSanitizer
      ) {
        node.classList.add('plain-text-fallback');
        node.textContent = content;
        return;
      }

      node.classList.remove('plain-text-fallback');
      sanitizingNode.setHTML(content, { sanitizer: assistantSanitizer });
      for (const anchor of node.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const href = anchor.getAttribute('href');
        try {
          const url = new URL(href ?? '');
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TypeError('Unsupported link protocol.');
          }
          anchor.href = url.href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          anchor.referrerPolicy = 'no-referrer';
        } catch {
          anchor.removeAttribute('href');
        }
      }
    };

    render(initialContent);
    return { update: render };
  }

  function normalizedChatSettings(value: unknown): ChatSettings {
    const candidate = value && typeof value === 'object'
      ? value as Partial<ChatSettings>
      : {};
    return {
      model: modelOptions.some((option) => option.value === candidate.model)
        ? candidate.model as OpenAIModel
        : DEFAULT_CHAT_SETTINGS.model,
      reasoningEffort: reasoningOptions.some(
        (option) => option.value === candidate.reasoningEffort,
      )
        ? candidate.reasoningEffort as ReasoningEffort
        : DEFAULT_CHAT_SETTINGS.reasoningEffort,
      fastMode: typeof candidate.fastMode === 'boolean'
        ? candidate.fastMode
        : DEFAULT_CHAT_SETTINGS.fastMode,
    };
  }

  async function loadChatSettings(): Promise<void> {
    try {
      const stored = await browser.storage.local.get(CHAT_SETTINGS_STORAGE_KEY);
      chatSettings = normalizedChatSettings(stored[CHAT_SETTINGS_STORAGE_KEY]);
    } catch (caught) {
      error = `Could not load agent settings: ${messageFor(caught)}`;
    }
  }

  function updateChatSettings(next: Partial<ChatSettings>): void {
    chatSettings = { ...chatSettings, ...next };
    const snapshot = { ...chatSettings };
    settingsWrite = settingsWrite
      .then(() => browser.storage.local.set({
        [CHAT_SETTINGS_STORAGE_KEY]: snapshot,
      }))
      .catch((caught) => {
        error = `Could not save agent settings: ${messageFor(caught)}`;
      });
  }

  function updateReasoningIndex(index: number): void {
    const option = reasoningOptions[Math.round(index)];
    if (option) updateChatSettings({ reasoningEffort: option.value });
  }

  function isMissingContentScript(caught: unknown): boolean {
    return /receiving end does not exist|could not establish connection/i.test(
      messageFor(caught),
    );
  }

  async function sendPageMessage(
    tabId: number,
    message: Record<string, string>,
    injectIfMissing = false,
  ): Promise<ElementSelectionResponse> {
    try {
      return await browser.tabs.sendMessage(tabId, message) as ElementSelectionResponse;
    } catch (caught) {
      if (!injectIfMissing || !isMissingContentScript(caught)) throw caught;
      await browser.scripting.executeScript({
        target: { tabId },
        // @ts-expect-error WXT models this generated path as root-relative.
        files: ['content-scripts/content.js'],
      });
      return await browser.tabs.sendMessage(tabId, message) as ElementSelectionResponse;
    }
  }

  function cancelElementSelection(tabId: number): void {
    void sendPageMessage(tabId, { type: 'scriptsmith:cancel-element-selection' })
      .catch(() => undefined);
  }

  function cancelElementSelections(): void {
    for (const tabId of selectionTabIds) cancelElementSelection(tabId);
    selectionTabIds = [];
  }

  async function toggleElementSelection(): Promise<void> {
    if (!request || !script || !request.inScope) return;

    if (selectingElement) {
      selectionRequestId += 1;
      selectingElement = false;
      cancelElementSelections();
      return;
    }

    const currentRequestId = ++selectionRequestId;
    selectingElement = true;
    error = '';
    await patchChat({ error: '' });
    try {
      const tabs = await browser.tabs.query({ windowId: request.windowId });
      const active = tabs.find((tab) => tab.active && tab.id !== undefined);
      if (!active || active.id === undefined) throw new Error('No active page is available.');
      const activeSplitViewId = (active as Browser.tabs.Tab & { splitViewId?: number }).splitViewId;
      const visible = tabs.filter((tab) => {
        if (tab.id === undefined) return false;
        if (tab.id === active.id) return true;
        const splitViewId = (tab as Browser.tabs.Tab & { splitViewId?: number }).splitViewId;
        return activeSplitViewId !== undefined && activeSplitViewId >= 0 &&
          splitViewId === activeSplitViewId;
      });
      const eligible = visible.filter((tab) => {
        const origin = originFromUrl(tab.url);
        return origin !== null && script?.origins.includes(origin);
      });
      if (eligible.length === 0) {
        throw new Error('The visible page is not one of this script\'s sites. Add the site first.');
      }
      selectionTabIds = eligible.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
      const response = await Promise.any(selectionTabIds.map(async (tabId) => ({
        tabId,
        response: await sendPageMessage(
          tabId,
          { type: 'scriptsmith:start-element-selection' },
          true,
        ),
      })));
      if (currentRequestId !== selectionRequestId) return;
      cancelElementSelections();
      if (!response.response.origin || !script?.origins.includes(response.response.origin)) {
        throw new Error(
          `This tab is on ${response.response.origin ?? 'an unknown page'}, which is not one of this script's sites. Add the site first.`,
        );
      }
      if (response.response.ok && response.response.element) {
        selectedElement = {
          ...response.response.element,
          tabId: response.tabId,
          origin: response.response.origin,
        };
        await patchChat({ selectedElement });
      } else if (!response.response.cancelled) {
        throw new Error(response.response.error || 'Could not select an element.');
      }
    } catch (caught) {
      cancelElementSelections();
      if (currentRequestId === selectionRequestId) {
        error = messageFor(caught);
        await patchChat({ error });
      }
    } finally {
      if (currentRequestId === selectionRequestId) selectingElement = false;
    }
  }

  async function readRequest(): Promise<void> {
    loading = true;
    error = '';

    try {
      const stored = await browser.storage.session.get(requestStorageKey);
      const next = stored[requestStorageKey] as
        | SidebarScriptRequest
        | undefined;
      if (!next) {
        cancelElementSelections();
        selectionRequestId += 1;
        selectingElement = false;
        selectedElement = null;
        request = null;
        script = null;
        error = 'Choose Add script or Edit script from the scriptsmith popup.';
        return;
      }

      if (request?.sessionId !== next.sessionId) {
        cancelElementSelections();
        selectionRequestId += 1;
        selectingElement = false;
      }
      request = next;
      const [nextScript, session, tabs] = await Promise.all([
        getPageScript(next.scriptId),
        getSidebarSession(next.sessionId),
        browser.tabs.query({ windowId: next.windowId }),
      ]);
      script = nextScript;
      if (session) applyChatState(session.chat);
      const origins = tabs.flatMap((tab) => {
        const origin = originFromUrl(tab.url);
        return origin ? [origin] : [];
      });
      openOrigins = [...new Set(origins)].filter(
        (origin) => !nextScript?.origins.includes(origin),
      ).sort();
      if (!script) error = 'This script no longer exists.';
      if (!session) error = 'This editing session is no longer available.';
    } catch (caught) {
      error = messageFor(caught);
      await patchChat({ error });
    } finally {
      loading = false;
    }
  }

  async function refreshOpenOrigins(): Promise<void> {
    const tabs = await browser.tabs.query(
      request ? { windowId: request.windowId } : {},
    );
    const origins = tabs.flatMap((tab) => {
      const origin = originFromUrl(tab.url);
      return origin ? [origin] : [];
    });
    openOrigins = [...new Set(origins)]
      .filter((origin) => !script?.origins.includes(origin))
      .sort();
  }

  $: filteredOpenOrigins = openOrigins.filter((origin) =>
    origin.toLowerCase().includes(siteOrigin.trim().toLowerCase()),
  );

  async function addSite(): Promise<void> {
    if (!script || addingSite) return;
    const origin = originFromUrl(siteOrigin.trim());
    if (!origin || origin !== siteOrigin.trim().replace(/\/$/, '')) {
      error = 'Choose or enter a valid HTTP(S) origin.';
      return;
    }
    if (script.origins.includes(origin)) {
      error = 'This script already runs on that site.';
      return;
    }
    addingSite = true;
    error = '';
    try {
      script = await addOriginToScript(script, origin);
      openOrigins = openOrigins.filter((candidate) => candidate !== origin);
      siteOrigin = '';
      applyStatus = `Added ${origin}. Reload that site if it is already open.`;
      await patchChat({ applyStatus, error: '' });
    } catch (caught) {
      error = messageFor(caught);
      await patchChat({ error });
    } finally {
      addingSite = false;
    }
  }

  async function removeSite(origin: string): Promise<void> {
    if (!script || removingOrigin || script.origins.length === 1) return;
    removingOrigin = origin;
    error = '';
    try {
      script = await removeOriginFromScript(script, origin);
      await refreshOpenOrigins();
      applyStatus = `Removed ${origin} from this script.`;
      await patchChat({ applyStatus, error: '' });
    } catch (caught) {
      error = messageFor(caught);
      await patchChat({ error });
    } finally {
      removingOrigin = null;
    }
  }

  async function send(): Promise<void> {
    const content = draft.trim();
    if (!content || !request || !script || sending || selectingElement) return;
    settingsOpen = false;
    try {
      await patchChat({ draft: content, error: '' });
      await browser.runtime.sendMessage({
        type: 'scriptsmith:sidebar:start-chat',
        sessionId: request.sessionId,
        settings: { ...chatSettings },
      });
    } catch (caught) {
      error = messageFor(caught);
      await patchChat({ error });
    }
  }

  async function stopSending(): Promise<void> {
    if (!request || !sending || stopping) return;
    await browser.runtime.sendMessage({
      type: 'scriptsmith:sidebar:stop-chat',
      sessionId: request.sessionId,
    });
  }

  async function clearConversation(): Promise<void> {
    if (!request || sending || selectingElement) return;
    settingsOpen = false;
    await browser.runtime.sendMessage({
      type: 'scriptsmith:sidebar:clear-chat',
      sessionId: request.sessionId,
    });
  }

  async function runNow(): Promise<void> {
    if (!script || !request || applying) return;
    applying = true;
    error = '';
    applyStatus = '';

    try {
      const result = await runPageScriptNow(script, request.windowId);
      if (result !== null) {
        scriptChanged = false;
        const count = result;
        applyStatus = `Current script run on ${count} ${count === 1 ? 'page' : 'pages'}.`;
        await patchChat({ scriptChanged: false, applyStatus, error: '' });
      } else {
        error = 'This browser cannot run the script immediately. Reload the page instead.';
        await patchChat({ error });
      }
    } catch (caught) {
      error = messageFor(caught);
      await patchChat({ error });
    } finally {
      applying = false;
    }
  }

  async function reloadPages(): Promise<void> {
    if (!request || !script || applying) return;
    applying = true;
    error = '';
    applyStatus = '';

    try {
      const tabs = await matchingTabsInWindow(script, request.windowId);
      const tabIds = tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
      await Promise.all(tabIds.map((tabId) => browser.tabs.reload(tabId)));
      scriptChanged = false;
      const count = tabIds.length;
      applyStatus = `${count} matching ${count === 1 ? 'page' : 'pages'} reloaded with the current script.`;
      await patchChat({ scriptChanged: false, applyStatus, error: '' });
    } catch (caught) {
      error = messageFor(caught);
      await patchChat({ error });
    } finally {
      applying = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function copyDebugTranscript(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ input: transcript }, null, 2));
      applyStatus = 'Chat transcript copied as JSON.';
      await patchChat({ applyStatus });
    } catch (caught) {
      error = `Could not copy chat transcript: ${messageFor(caught)}`;
      await patchChat({ error });
    }
  }

  function handleDebugShortcut(event: KeyboardEvent): void {
    if (
      event.altKey &&
      event.key.toLowerCase() === 'c'
    ) {
      event.preventDefault();
      if (!event.repeat) void copyDebugTranscript();
    }
  }

  $: if (messagesElement && messages.length) {
    tick().then(() => {
      messagesElement.scrollTo({ top: messagesElement.scrollHeight });
    });
  }

  onMount(() => {
    void (async () => {
      if (panelTabId === null) {
        const currentWindow = await browser.windows.getCurrent();
        if (currentWindow.id !== undefined) {
          requestStorageKey = sidebarWindowRequestStorageKey(currentWindow.id);
        }
      }
      signedIn = await hasCodexSubscription();
      await Promise.all([readRequest(), loadChatSettings()]);
    })();

    const listener = (
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[CODEX_REFRESH_TOKEN_STORAGE_KEY]) {
        signedIn =
          typeof changes[CODEX_REFRESH_TOKEN_STORAGE_KEY].newValue === 'string';
      }
      if (areaName === 'local' && changes[CHAT_SETTINGS_STORAGE_KEY]) {
        chatSettings = normalizedChatSettings(
          changes[CHAT_SETTINGS_STORAGE_KEY].newValue,
        );
      }
      if (areaName === 'local' && changes.pageScripts && request) {
        void getPageScript(request.scriptId).then((nextScript) => {
          script = nextScript;
          if (nextScript) {
            openOrigins = openOrigins.filter(
              (origin) => !nextScript.origins.includes(origin),
            );
          }
        });
      }
      if (areaName === 'session' && changes[requestStorageKey]) {
        void readRequest();
      }
      if (
        areaName === 'session' &&
        request &&
        changes[sidebarSessionStorageKey(request.sessionId)]
      ) {
        const change = changes[sidebarSessionStorageKey(request.sessionId)]!;
        const next = change.newValue as
          | import('../../utils/sidebar').SidebarSession
          | undefined;
        if (next) applyChatState(next.chat);
      }
    };
    browser.storage.onChanged.addListener(listener);
    window.addEventListener('keydown', handleDebugShortcut);
    return () => {
      browser.storage.onChanged.removeListener(listener);
      window.removeEventListener('keydown', handleDebugShortcut);
      cancelElementSelections();
    };
  });
</script>

<main>
  <header>
    <div>
      <div class="header-title-row">
        <h1>{script?.name ?? 'Script editor'}</h1>
        {#if script && request?.inScope}
          <button
            class="clear-conversation"
            type="button"
            disabled={sending || selectingElement || (messages.length === 0 && !draft && !selectedElement)}
            title="Clear the shared conversation"
            on:click={() => void clearConversation()}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6" /></svg>
            Clear conversation
          </button>
        {/if}
      </div>
      {#if script && request?.inScope}
        <p>{script.description}</p>
        <div class="origin-chips" aria-label="Script sites">
          {#each script.origins as origin}
            <span title={origin}>
              <span>{origin}</span>
              <button
                type="button"
                aria-label={`Remove ${origin}`}
                title={script.origins.length === 1 ? 'A script must keep at least one site' : `Remove ${origin}`}
                disabled={script.origins.length === 1 || removingOrigin !== null}
                on:click={() => void removeSite(origin)}
              >×</button>
            </span>
          {/each}
        </div>
        <div class="add-site">
          <label for="site-origin">Add site</label>
          <div class="add-site-row">
            <div class="site-combobox">
              <Combobox.Root
                type="single"
                bind:value={siteOrigin}
                items={openOrigins.map((origin) => ({ value: origin, label: origin }))}
              >
                <Combobox.Input
                  id="site-origin"
                  class="site-origin-input"
                  placeholder="Search open tabs or enter an origin"
                  disabled={addingSite}
                  onfocus={() => void refreshOpenOrigins()}
                  oninput={(event) => siteOrigin = event.currentTarget.value}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' && !filteredOpenOrigins.includes(siteOrigin)) {
                      event.preventDefault();
                      void addSite();
                    }
                  }}
                />
                <Combobox.Trigger class="suggestion-toggle" aria-label="Show origins from open tabs" title="Show origins from open tabs">
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5" /></svg>
                </Combobox.Trigger>
                <Combobox.Portal>
                  <Combobox.Content class="site-suggestions" sideOffset={5}>
                    <Combobox.Viewport class="site-suggestions-viewport">
                      {#each filteredOpenOrigins as origin (origin)}
                        <Combobox.Item class="site-suggestion" value={origin} label={origin}>
                          {origin}
                        </Combobox.Item>
                      {:else}
                        <p>No other open sites found.</p>
                      {/each}
                    </Combobox.Viewport>
                  </Combobox.Content>
                </Combobox.Portal>
              </Combobox.Root>
            </div>
            <button class="add-site-button" type="button" on:click={() => void addSite()} disabled={addingSite || !siteOrigin.trim()}>
              {addingSite ? 'Adding…' : 'Add'}
            </button>
          </div>
          {#if openOrigins.length > 0}<small>Suggestions come from your open tabs.</small>{/if}
        </div>
        <details class="script-source">
          <summary>View code</summary>
          <pre><code>{script.code}</code></pre>
        </details>
      {/if}
    </div>
  </header>

  {#if loading}
    <div class="state">Loading script…</div>
  {:else if request && !request.inScope}
    <div class="state">This script does not run on the active tab. Switch to one of its sites to continue editing.</div>
  {:else if script}
    <section class="conversation" bind:this={messagesElement} aria-live="polite">
      {#if messages.length === 0}
        <div class="welcome">
          <h2>What should this script do?</h2>
          <p>Describe the page behavior or change you want, and the agent will update the script.</p>
        </div>
      {/if}

      {#each messages as message}
        {#if message.role === 'activity'}
          <div class="activity-row" aria-label="Agent activity">
            {#each message.activities as activity (activity.id)}
              {@const label = activity.kind === 'thinking' ? (activity.pending ? 'Thinking' : 'Thought') : `${activity.pending ? 'Using' : 'Used'} ${activity.toolName ?? 'tool'}`}
              <span
                class="activity"
                class:pending={activity.pending}
                aria-label={label}
                title={label}
              >
                {#if activity.kind === 'thinking'}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M8.5 15.5A7 7 0 1 1 15.5 15.5C14.5 16.3 14 17 14 18h-4c0-1-.5-1.7-1.5-2.5Z" /></svg>
                {:else if activity.toolName === 'edit_script'}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm10-12 3 3" /></svg>
                {:else if activity.toolName === 'evaluate_script'}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg>
                {:else if activity.toolName === 'set_name'}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 13 13 20 4 11V4h7l9 9Z" /><circle cx="8.5" cy="8.5" r="1" /></svg>
                {:else if activity.toolName === 'set_description'}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h9" /></svg>
                {:else if activity.toolName === 'add_origin' || activity.toolName === 'remove_origin'}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg>
                {:else}
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3" /></svg>
                {/if}
              </span>
            {/each}
          </div>
        {:else}
          <article class:assistant={message.role === 'assistant'} class:user={message.role === 'user'}>
            {#if message.role === 'user' && message.selectedElement}
              <div class="selected-element message-selected-element">
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 3v16l4.5-4.5L13 21l3-1.5-3.5-6H19L5 3Z" /></svg>
                <div>
                  <span>Selected element</span>
                  <code title={message.selectedElement.selector}>{message.selectedElement.label}</code>
                </div>
              </div>
            {/if}
            {#if message.role === 'assistant'}
              <div
                class="assistant-content"
                use:renderAssistantHtml={message.content}
              ></div>
            {:else}
              <p>{message.content}</p>
            {/if}
          </article>
        {/if}
      {/each}
    </section>

    <section class="composer">
      {#if scriptChanged}
        <div class="apply-changes" role="status">
          <div>
            <strong>Script updated</strong>
            <p>Run it now, or reload for a clean application.</p>
          </div>
          <div class="apply-actions">
            <button class="run-now" type="button" on:click={() => void runNow()} disabled={applying}>
              {applying ? 'Applying…' : 'Run now'}
            </button>
            <button class="reload" type="button" on:click={() => void reloadPages()} disabled={applying}>
              Reload pages
            </button>
          </div>
        </div>
      {/if}
      {#if applyStatus}<p class="apply-status" role="status">{applyStatus}</p>{/if}
      {#if !signedIn}
        <p class="auth-required" role="status">Sign in with ChatGPT in the scriptsmith popup to start chatting.</p>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if selectedElement}
        <div class="selected-element" role="status">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 3v16l4.5-4.5L13 21l3-1.5-3.5-6H19L5 3Z" /></svg>
          <div>
            <span>Selected element</span>
            <code title={selectedElement.selector}>{selectedElement.label}</code>
          </div>
          <button
            type="button"
            aria-label="Remove selected element"
            title="Remove selected element"
            on:click={() => {
              selectedElement = null;
              void patchChat({ selectedElement: null });
            }}
          >×</button>
        </div>
      {:else if selectingElement}
        <p class="selection-hint" role="status">Hover over the page, then click an element. Press Escape to cancel.</p>
      {/if}
      <div class="composer-box">
        <textarea
          rows="3"
          placeholder="Describe the change you want…"
          value={draft}
          on:input={(event) => {
            draft = event.currentTarget.value;
            void patchChat({ draft });
          }}
          on:keydown={handleKeydown}
          disabled={!signedIn}
        ></textarea>
        <div class="composer-footer">
          <div class="composer-tools">
            <button
              class="element-picker"
              class:active={selectingElement}
              type="button"
              on:click={() => void toggleElementSelection()}
              disabled={sending || !signedIn}
              aria-pressed={selectingElement}
              title={selectingElement ? 'Cancel element selection' : 'Select an element from the page'}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 3v16l4.5-4.5L13 21l3-1.5-3.5-6H19L5 3Z" /></svg>
              {selectingElement ? 'Cancel' : 'Select element'}
            </button>
            <span>↵ send · ⇧↵ newline</span>
          </div>
          <div class="composer-actions">
            {#if contextUsage}
              {@const usageLabel = contextUsageLabel(contextUsage)}
              <div
                class="context-ring"
                style={`--usage-color: ${contextUsageColor(contextUsage.usedPercent)}`}
                title={usageLabel}
                role="img"
                aria-label={usageLabel}
              >
                <svg aria-hidden="true" viewBox="0 0 36 36">
                  <circle class="context-track" cx="18" cy="18" r="15.5" pathLength="100" />
                  <circle
                    class="context-value"
                    cx="18"
                    cy="18"
                    r="15.5"
                    pathLength="100"
                    stroke-dasharray={`${contextUsage.usedPercent} 100`}
                  />
                </svg>
              </div>
            {:else}
              <span
                class="context-placeholder"
                title="Context usage is available after the first response"
                role="img"
                aria-label="Context usage is available after the first response"
              ></span>
            {/if}
            <Popover.Root bind:open={settingsOpen}>
              <Popover.Trigger
                class="agent-settings-trigger"
                disabled={sending || !signedIn}
                aria-label={`Agent settings: ${selectedModel.label}, ${selectedReasoning.label} thinking${chatSettings.fastMode ? ', Fast mode on' : ''}`}
                title={`${selectedModel.label} · ${selectedReasoning.label}${chatSettings.fastMode ? ' · Fast' : ''}`}
              >
                <span class="settings-model-symbol" aria-hidden="true">
                  {#if chatSettings.model === 'gpt-5.6-luna'}
                    <svg viewBox="0 0 24 24"><path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.5 8.5 0 1 0 10.6 10.6Z" /></svg>
                  {:else if chatSettings.model === 'gpt-5.6-terra'}
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path class="terra-land" d="m5.1 7.2 2.6-2.1 2.6.5.9 1.5-1.3 1-.3 1.8-1.7.7-.3 1.7-1.5-.3-.7-1.4-1.6-.6M13.1 4.6l3.3 1.2 2.1 2.3-.7 1.5-2.2-.5-.9 1.2 1.3 1.2-.6 2.1-1.5.7-.4 2.7-1.5 1.2-1-2.5.8-2-1.1-1.4.9-2.1 1.6-.6-.7-1.8Z" /></svg>
                  {:else}
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.8" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>
                  {/if}
                </span>
                <span>{selectedReasoning.shortLabel}</span>
                {#if chatSettings.fastMode}
                  <svg class="trigger-fast" aria-hidden="true" viewBox="0 0 24 24"><path d="m13.5 2-8 12h6l-1 8 8-12h-6l1-8Z" /></svg>
                {/if}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  class="agent-settings-popover"
                  side="top"
                  align="end"
                  sideOffset={10}
                  collisionPadding={12}
                >
                  <div class="agent-settings-row" aria-label="Agent settings">
                    <div class="model-options" role="group" aria-label="Model">
                      {#each modelOptions as option}
                        <button
                          class="model-option"
                          class:selected={chatSettings.model === option.value}
                          type="button"
                          disabled={sending}
                          aria-label={option.label}
                          aria-pressed={chatSettings.model === option.value}
                          title={option.label}
                          on:click={() => updateChatSettings({ model: option.value })}
                        >
                          {#if option.value === 'gpt-5.6-luna'}
                            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.5 8.5 0 1 0 10.6 10.6Z" /></svg>
                          {:else if option.value === 'gpt-5.6-terra'}
                            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path class="terra-land" d="m5.1 7.2 2.6-2.1 2.6.5.9 1.5-1.3 1-.3 1.8-1.7.7-.3 1.7-1.5-.3-.7-1.4-1.6-.6M13.1 4.6l3.3 1.2 2.1 2.3-.7 1.5-2.2-.5-.9 1.2 1.3 1.2-.6 2.1-1.5.7-.4 2.7-1.5 1.2-1-2.5.8-2-1.1-1.4.9-2.1 1.6-.6-.7-1.8Z" /></svg>
                          {:else}
                            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.8" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>
                          {/if}
                        </button>
                      {/each}
                    </div>
                    <div class="reasoning-control">
                      <Slider.Root
                        class="reasoning-slider"
                        type="single"
                        min={0}
                        max={reasoningOptions.length - 1}
                        step={1}
                        value={reasoningIndex}
                        disabled={sending}
                        onValueChange={updateReasoningIndex}
                      >
                        <Slider.Range class="reasoning-range" />
                        {#each reasoningOptions as _, index}
                          <Slider.Tick class="reasoning-tick" {index} />
                        {/each}
                        <Slider.ThumbLabel class="reasoning-label" index={0}>
                          {selectedReasoning.label}
                        </Slider.ThumbLabel>
                        <Slider.Thumb
                          class="reasoning-thumb"
                          index={0}
                          aria-label="Thinking level"
                          aria-valuetext={selectedReasoning.label}
                        />
                      </Slider.Root>
                    </div>
                    <button
                      class="fast-mode"
                      class:active={chatSettings.fastMode}
                      type="button"
                      disabled={sending}
                      aria-label={`Fast mode ${chatSettings.fastMode ? 'on' : 'off'}`}
                      aria-pressed={chatSettings.fastMode}
                      title={`Fast mode ${chatSettings.fastMode ? 'on' : 'off'} · 1.5× speed · 2.5× credit usage`}
                      on:click={() => updateChatSettings({ fastMode: !chatSettings.fastMode })}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m13.5 2-8 12h6l-1 8 8-12h-6l1-8Z" /></svg>
                    </button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <button
              class="send"
              class:stop={sending}
              type="button"
              on:click={() => sending ? stopSending() : void send()}
              disabled={sending ? stopping : selectingElement || !draft.trim() || !signedIn}
              aria-label={sending ? 'Stop agent request' : 'Send message'}
              title={sending ? 'Stop agent request' : 'Send message'}
            >
              {#if sending}
                <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
              {:else}
                <svg aria-hidden="true" viewBox="0 0 24 24" class="send-arrow"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
              {/if}
            </button>
          </div>
        </div>
      </div>
    </section>
  {:else}
    <div class="state error">{error}</div>
  {/if}
</main>
