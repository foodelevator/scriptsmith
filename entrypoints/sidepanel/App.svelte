<script lang="ts">
  import {
    API_KEY_STORAGE_KEY,
    chatWithScript,
    type ChatMessage,
  } from '../../utils/ai';
  import {
    getPageScript,
    runPageScriptNow,
    type PageScript,
  } from '../../utils/scripts';
  import {
    SIDEBAR_REQUEST_STORAGE_KEY,
    type SidebarScriptRequest,
  } from '../../utils/sidebar';

  let request: SidebarScriptRequest | null = null;
  let script: PageScript | null = null;
  let messages: ChatMessage[] = [];
  let draft = '';
  let apiKey = '';
  let loading = true;
  let sending = false;
  let applying = false;
  let scriptChanged = false;
  let applyStatus = '';
  let error = '';
  let messagesElement: HTMLElement;

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function readRequest(): Promise<void> {
    loading = true;
    error = '';

    try {
      const stored = await browser.storage.session.get(
        SIDEBAR_REQUEST_STORAGE_KEY,
      );
      const next = stored[SIDEBAR_REQUEST_STORAGE_KEY] as
        | SidebarScriptRequest
        | undefined;
      if (!next) {
        request = null;
        script = null;
        error = 'Choose Add script or Edit script from the Vibext popup.';
        return;
      }

      if (request?.nonce !== next.nonce) {
        messages = [];
        scriptChanged = false;
        applyStatus = '';
      }
      request = next;
      script = await getPageScript(next.origin, next.scriptId);
      if (!script) error = 'This script no longer exists.';
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      loading = false;
    }
  }

  async function send(): Promise<void> {
    const content = draft.trim();
    if (!content || !request || !script || sending) return;

    sending = true;
    error = '';
    const conversation: ChatMessage[] = [...messages, { role: 'user', content }];
    messages = conversation;
    draft = '';

    try {
      const codeBefore = script.code;
      const result = await chatWithScript({
        apiKey,
        origin: request.origin,
        scriptId: request.scriptId,
        creating: request.creating,
        messages: conversation,
      });
      script = result.script;
      if (result.script.code !== codeBefore) {
        scriptChanged = true;
        applyStatus = '';
      }
      messages = [...messages, { role: 'assistant', content: result.message }];
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      sending = false;
    }
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
        applyStatus = 'Current script run on the page.';
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

  $: if (messagesElement && messages.length) {
    tick().then(() => {
      messagesElement.scrollTo({ top: messagesElement.scrollHeight });
    });
  }

  onMount(() => {
    void (async () => {
      const stored = await browser.storage.local.get(API_KEY_STORAGE_KEY);
      const value = stored[API_KEY_STORAGE_KEY];
      apiKey = typeof value === 'string' ? value : '';
      await readRequest();
    })();

    const listener = (
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[API_KEY_STORAGE_KEY]) {
        const nextKey = changes[API_KEY_STORAGE_KEY].newValue;
        apiKey = typeof nextKey === 'string' ? nextKey : '';
      }
      if (areaName === 'session' && changes[SIDEBAR_REQUEST_STORAGE_KEY]) {
        const next = changes[SIDEBAR_REQUEST_STORAGE_KEY].newValue as
          | SidebarScriptRequest
          | undefined;
        if (next?.nonce === request?.nonce) return;
        void readRequest();
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  });
</script>

<main>
  <header>
    <div>
      <span class="eyebrow">Vibext agent</span>
      <h1>{script?.name ?? 'Script editor'}</h1>
      {#if script}<p>{script.description}</p>{/if}
    </div>
  </header>

  {#if loading}
    <div class="state">Loading script…</div>
  {:else if script}
    <section class="conversation" bind:this={messagesElement} aria-live="polite">
      {#if messages.length === 0}
        <div class="welcome">
          <h2>{request?.creating ? 'What should this script do?' : 'How should I change it?'}</h2>
          <p>
            {request?.creating
              ? 'Describe the page behavior you want. The agent will write the script and choose a name and description.'
              : 'Ask for a change. The agent will preserve the name and description unless you explicitly request otherwise.'}
          </p>
        </div>
      {/if}

      {#each messages as message}
        <article class:assistant={message.role === 'assistant'} class:user={message.role === 'user'}>
          <span>{message.role === 'assistant' ? 'Agent' : 'You'}</span>
          <p>{message.content}</p>
        </article>
      {/each}

      {#if sending}
        <article class="assistant thinking">
          <span>Agent</span>
          <p>Working on the script…</p>
        </article>
      {/if}
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
      {#if !apiKey.trim()}
        <p class="key-required" role="status">Add your OpenAI API key in the Vibext popup to start chatting.</p>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <textarea
        rows="3"
        placeholder="Describe the change you want…"
        bind:value={draft}
        on:keydown={handleKeydown}
        disabled={!apiKey.trim()}
      ></textarea>
      <div class="composer-footer">
        <span>Enter to send · Shift+Enter for newline</span>
        <button
          class="send"
          type="button"
          on:click={() => void send()}
          disabled={sending || !draft.trim() || !apiKey.trim()}
        >{sending ? 'Working…' : 'Send'}</button>
      </div>
    </section>
  {:else}
    <div class="state error">{error}</div>
  {/if}
</main>
