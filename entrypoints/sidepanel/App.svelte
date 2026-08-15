<script lang="ts">
  import { Combobox } from 'bits-ui';
  import {
    chatWithScript,
    ScriptChatAbortedError,
    type ChatTranscriptItem,
    type ChatMessage,
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
    removeOriginFromScript,
    runPageScriptNow,
    type PageScript,
  } from '../../utils/scripts';
  import {
    SIDEBAR_REQUEST_STORAGE_KEY,
    sidebarRequestStorageKey,
    type SidebarScriptRequest,
  } from '../../utils/sidebar';

  type Activity = {
    id: string;
    kind: 'thinking' | 'tool';
    toolName?: string;
    pending: boolean;
  };
  type DisplayMessage =
    | ChatMessage
    | { role: 'activity'; activities: Activity[] };
  type ElementSelectionResponse = {
    ok: boolean;
    origin?: string;
    cancelled?: boolean;
    error?: string;
    element?: Pick<SelectedElementReference, 'selector' | 'label' | 'html'>;
  };

  const tabIdParameter = new URLSearchParams(location.search).get('tabId');
  const panelTabId = tabIdParameter && /^\d+$/.test(tabIdParameter)
    ? Number(tabIdParameter)
    : null;
  const requestStorageKey = panelTabId === null
    ? SIDEBAR_REQUEST_STORAGE_KEY
    : sidebarRequestStorageKey(panelTabId);

  let request: SidebarScriptRequest | null = null;
  let script: PageScript | null = null;
  let messages: DisplayMessage[] = [];
  let transcript: ChatTranscriptItem[] = [];
  let draft = '';
  let signedIn = false;
  let loading = true;
  let sending = false;
  let stopping = false;
  let chatController: AbortController | null = null;
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

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
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
    void sendPageMessage(tabId, { type: 'vibext:cancel-element-selection' })
      .catch(() => undefined);
  }

  async function toggleElementSelection(): Promise<void> {
    if (!request) return;
    const selectionTabId = request.tabId;

    if (selectingElement) {
      selectionRequestId += 1;
      selectingElement = false;
      cancelElementSelection(selectionTabId);
      return;
    }

    const currentRequestId = ++selectionRequestId;
    selectingElement = true;
    error = '';
    try {
      const response = await sendPageMessage(
        selectionTabId,
        { type: 'vibext:start-element-selection' },
        true,
      );
      if (currentRequestId !== selectionRequestId) return;
      if (!response.origin || !script?.origins.includes(response.origin)) {
        throw new Error(
          `This tab is on ${response.origin ?? 'an unknown page'}, which is not one of this script's sites. Add the site first.`,
        );
      }
      if (response.ok && response.element) {
        selectedElement = {
          ...response.element,
          tabId: selectionTabId,
          origin: response.origin,
        };
      } else if (!response.cancelled) {
        throw new Error(response.error || 'Could not select an element.');
      }
    } catch (caught) {
      if (currentRequestId === selectionRequestId) error = messageFor(caught);
    } finally {
      if (currentRequestId === selectionRequestId) selectingElement = false;
    }
  }

  async function readRequest(): Promise<void> {
    chatController?.abort();
    loading = true;
    error = '';

    try {
      const stored = await browser.storage.session.get(requestStorageKey);
      const next = stored[requestStorageKey] as
        | SidebarScriptRequest
        | undefined;
      if (!next) {
        if (selectingElement && request) cancelElementSelection(request.tabId);
        selectionRequestId += 1;
        selectingElement = false;
        selectedElement = null;
        request = null;
        script = null;
        error = 'Choose Add script or Edit script from the Vibext popup.';
        return;
      }

      if (request?.nonce !== next.nonce) {
        if (selectingElement && request) cancelElementSelection(request.tabId);
        selectionRequestId += 1;
        selectingElement = false;
        selectedElement = null;
        messages = [];
        transcript = [];
        scriptChanged = false;
        applyStatus = '';
      }
      request = next;
      const [nextScript, tabs] = await Promise.all([
        getPageScript(next.scriptId),
        browser.tabs.query({}),
      ]);
      script = nextScript;
      const origins = tabs.flatMap((tab) => {
        const origin = originFromUrl(tab.url);
        return origin ? [origin] : [];
      });
      openOrigins = [...new Set(origins)].filter(
        (origin) => !nextScript?.origins.includes(origin),
      ).sort();
      if (!script) error = 'This script no longer exists.';
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      loading = false;
    }
  }

  async function refreshOpenOrigins(): Promise<void> {
    const tabs = await browser.tabs.query({});
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
    } catch (caught) {
      error = messageFor(caught);
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
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      removingOrigin = null;
    }
  }

  async function send(): Promise<void> {
    const content = draft.trim();
    if (!content || !request || !script || sending || selectingElement) return;

    sending = true;
    stopping = false;
    const controller = new AbortController();
    chatController = controller;
    error = '';
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      ...(selectedElement ? { selectedElement } : {}),
    };
    const conversation: ChatMessage[] = [
      ...messages.filter(
        (message): message is ChatMessage => message.role !== 'activity',
      ),
      userMessage,
    ];
    messages = [...messages, userMessage];
    selectedElement = null;
    draft = '';
    let assistantIndex: number | null = null;
    let receivedText = false;

    function addActivity(activity: Activity): void {
      const last = messages[messages.length - 1];
      if (last?.role === 'activity') {
        const lastActivity = last.activities[last.activities.length - 1];
        if (activity.kind === 'thinking' && lastActivity?.kind === 'thinking') {
          messages = [
            ...messages.slice(0, -1),
            {
              role: 'activity',
              activities: [
                ...last.activities.slice(0, -1),
                activity,
              ],
            },
          ];
          return;
        }

        messages = [
          ...messages.slice(0, -1),
          { role: 'activity', activities: [...last.activities, activity] },
        ];
        return;
      }

      messages = [...messages, { role: 'activity', activities: [activity] }];
    }

    function setActivityPending(id: string, pending: boolean): void {
      messages = messages.map((message) =>
        message.role === 'activity'
          ? {
              ...message,
              activities: message.activities.map((activity) =>
                activity.id === id ? { ...activity, pending } : activity,
              ),
            }
          : message,
      );
    }

    function finishActivity(id: string): void {
      setActivityPending(id, false);
    }

    function finishAllActivities(): void {
      messages = messages.map((message) =>
        message.role === 'activity'
          ? {
              ...message,
              activities: message.activities.map((activity) => ({
                ...activity,
                pending: false,
              })),
            }
          : message,
      );
    }

    try {
      const codeBefore = script.code;
      const result = await chatWithScript(
        {
          scriptId: request.scriptId,
          tabId: request.tabId,
          messages: conversation,
        },
        {
          onResponseStart() {
            finishAllActivities();
          },
          onThinkingStart(itemId) {
            addActivity({ id: itemId, kind: 'thinking', pending: true });
          },
          onThinkingDone(itemId) {
            finishActivity(itemId);
          },
          onToolCall(callId, name) {
            addActivity({
              id: callId,
              kind: 'tool',
              toolName: name,
              pending: true,
            });
          },
          onToolCallDone(callId) {
            finishActivity(callId);
          },
          onToolExecutionStart(callId) {
            setActivityPending(callId, true);
          },
          onToolResult(callId) {
            finishActivity(callId);
          },
          onScriptChange(updatedScript) {
            script = updatedScript;
            openOrigins = openOrigins.filter(
              (origin) => !updatedScript.origins.includes(origin),
            );
            if (updatedScript.code !== codeBefore) {
              scriptChanged = true;
              applyStatus = '';
            }
          },
          onTranscriptItems(items) {
            transcript = [...transcript, ...items];
          },
          onTextDelta(delta) {
            receivedText = true;
            if (assistantIndex === null) {
              assistantIndex = messages.length;
              messages = [...messages, { role: 'assistant', content: delta }];
              return;
            }

            messages = messages.map((message, index) =>
              index === assistantIndex && message.role === 'assistant'
                ? { ...message, content: `${message.content}${delta}` }
                : message,
            );
          },
        },
        controller.signal,
      );
      script = result.script;
      if (result.script.code !== codeBefore) {
        scriptChanged = true;
        applyStatus = '';
      }
      if (!receivedText) {
        messages = [...messages, { role: 'assistant', content: result.message }];
      }
    } catch (caught) {
      if (!(caught instanceof ScriptChatAbortedError)) error = messageFor(caught);
    } finally {
      // Individual tools are settled by onToolResult as soon as each one
      // finishes. This is a safety net for aborted/malformed streams: once the
      // turn has ended, nothing from it should remain visually “running”.
      finishAllActivities();
      if (chatController === controller) chatController = null;
      sending = false;
      stopping = false;
    }
  }

  function stopSending(): void {
    if (!sending || stopping) return;
    stopping = true;
    chatController?.abort();
  }

  async function runNow(): Promise<void> {
    if (!script || !request || applying) return;
    applying = true;
    error = '';
    applyStatus = '';

    try {
      const result = await runPageScriptNow(script, request.tabId);
      if (result) {
        scriptChanged = false;
        const count = Number(result.split(':')[1] ?? 1);
        applyStatus = `Current script run on ${count} ${count === 1 ? 'page' : 'pages'}.`;
      } else {
        error = 'This browser cannot run the script immediately. Reload the page instead.';
      }
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      applying = false;
    }
  }

  async function reloadPage(): Promise<void> {
    if (!request || applying) return;
    applying = true;
    error = '';
    applyStatus = '';

    try {
      await browser.tabs.reload(request.tabId);
      scriptChanged = false;
      applyStatus = 'Page reloaded with the current script.';
    } catch (caught) {
      error = messageFor(caught);
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
    } catch (caught) {
      error = `Could not copy chat transcript: ${messageFor(caught)}`;
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
      signedIn = await hasCodexSubscription();
      await readRequest();
    })();

    const listener = (
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[CODEX_REFRESH_TOKEN_STORAGE_KEY]) {
        signedIn =
          typeof changes[CODEX_REFRESH_TOKEN_STORAGE_KEY].newValue === 'string';
      }
      if (areaName === 'session' && changes[requestStorageKey]) {
        const next = changes[requestStorageKey].newValue as
          | SidebarScriptRequest
          | undefined;
        if (next?.nonce === request?.nonce) return;
        void readRequest();
      }
    };
    browser.storage.onChanged.addListener(listener);
    window.addEventListener('keydown', handleDebugShortcut);
    return () => {
      browser.storage.onChanged.removeListener(listener);
      window.removeEventListener('keydown', handleDebugShortcut);
      chatController?.abort();
      if (selectingElement && request) cancelElementSelection(request.tabId);
    };
  });
</script>

<main>
  <header>
    <div>
      <h1>{script?.name ?? 'Script editor'}</h1>
      {#if script}
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
            <p>{message.content}</p>
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
            <button class="reload" type="button" on:click={() => void reloadPage()} disabled={applying}>
              Reload page
            </button>
          </div>
        </div>
      {/if}
      {#if applyStatus}<p class="apply-status" role="status">{applyStatus}</p>{/if}
      {#if !signedIn}
        <p class="auth-required" role="status">Sign in with ChatGPT in the Vibext popup to start chatting.</p>
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
            on:click={() => selectedElement = null}
          >×</button>
        </div>
      {:else if selectingElement}
        <p class="selection-hint" role="status">Hover over the page, then click an element. Press Escape to cancel.</p>
      {/if}
      <div class="composer-box">
        <textarea
          rows="3"
          placeholder="Describe the change you want…"
          bind:value={draft}
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
    </section>
  {:else}
    <div class="state error">{error}</div>
  {/if}
</main>
