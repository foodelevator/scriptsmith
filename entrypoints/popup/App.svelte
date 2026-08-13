<script lang="ts">
  import {
    getScriptsForOrigin,
    originFromUrl,
    removePageScript,
    type PageScript,
  } from '../../utils/scripts';
  import { API_KEY_STORAGE_KEY, createDraftScript } from '../../utils/ai';
  import { openScriptSidebar } from '../../utils/sidebar';

  let scripts: PageScript[] = [];
  let origin: string | null = null;
  let tabId: number | null = null;
  let windowId: number | undefined;
  let loading = true;
  let working = false;
  let apiKey = '';
  let showApiKey = false;
  let apiSettingsOpen = false;
  let status = '';
  let error = '';

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function loadPage(): Promise<void> {
    loading = true;
    error = '';

    try {
      const [tab, stored] = await Promise.all([
        browser.tabs.query({ active: true, currentWindow: true }).then(([active]) => active),
        browser.storage.local.get(API_KEY_STORAGE_KEY),
      ]);
      const storedApiKey = stored[API_KEY_STORAGE_KEY];
      apiKey = typeof storedApiKey === 'string' ? storedApiKey : '';
      apiSettingsOpen = !apiKey;
      origin = originFromUrl(tab?.url);
      tabId = tab?.id ?? null;
      windowId = tab?.windowId;

      if (!origin) {
        error = 'Open a regular web page to manage scripts.';
        return;
      }

      scripts = await getScriptsForOrigin(origin);
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      loading = false;
    }
  }

  async function saveApiKey(): Promise<void> {
    error = '';
    try {
      const value = apiKey.trim();
      if (value) await browser.storage.local.set({ [API_KEY_STORAGE_KEY]: value });
      else await browser.storage.local.remove(API_KEY_STORAGE_KEY);
      status = value ? 'OpenAI API key saved.' : 'OpenAI API key removed.';
    } catch (caught) {
      error = messageFor(caught);
    }
  }

  async function openEditor(script: PageScript, creating: boolean): Promise<void> {
    if (tabId === null || working) return;
    working = true;
    error = '';
    status = '';

    try {
      await openScriptSidebar(
        { scriptId: script.id, origin: script.origin, creating },
        tabId,
        windowId,
      );
      window.close();
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      working = false;
    }
  }

  async function addScript(): Promise<void> {
    if (!origin || working) return;
    working = true;
    error = '';

    try {
      const script = await createDraftScript(origin);
      scripts = [...scripts, script];
      working = false;
      await openEditor(script, true);
    } catch (caught) {
      error = messageFor(caught);
      working = false;
    }
  }

  async function remove(script: PageScript): Promise<void> {
    error = '';
    status = '';

    try {
      await removePageScript(script);
      scripts = scripts.filter((candidate) => candidate.id !== script.id);
      status = `${script.name} removed.`;
    } catch (caught) {
      error = messageFor(caught);
    }
  }

  onMount(() => {
    void loadPage();
  });
</script>

<main>
  <header>
    <h1>Vibext</h1>
    <p>{origin ?? 'Scripts for the current site'}</p>
  </header>

  <section aria-labelledby="scripts-heading">
    <div class="section-heading">
      <h2 id="scripts-heading">Scripts</h2>
      {#if !loading}<span class="count">{scripts.length}</span>{/if}
    </div>

    {#if loading}
      <p class="empty">Loading scripts…</p>
    {:else if origin && scripts.length === 0}
      <p class="empty">No scripts have been added for this site.</p>
    {:else if scripts.length > 0}
      <ul class="script-list">
        {#each scripts as script (script.id)}
          <li>
            <div class="script-details">
              <strong>{script.name}</strong>
              <p>{script.description}</p>
            </div>
            <div class="script-actions">
              <button
                class="edit-script"
                type="button"
                on:click={() => void openEditor(script, false)}
                disabled={working}
              >Edit script</button>
              <button
                class="remove"
                type="button"
                aria-label={`Remove ${script.name}`}
                title={`Remove ${script.name}`}
                on:click={() => void remove(script)}
                disabled={working}
              >×</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <button
    class="add-script"
    type="button"
    on:click={() => void addScript()}
    disabled={!origin || tabId === null || working}
  >{working ? 'Opening…' : 'Add script'}</button>

  <details class="settings" bind:open={apiSettingsOpen}>
    <summary>OpenAI API key</summary>
    <div class="key-row">
      <input
        type={showApiKey ? 'text' : 'password'}
        placeholder="sk-…"
        autocomplete="off"
        bind:value={apiKey}
      />
      <button class="secondary" type="button" on:click={() => (showApiKey = !showApiKey)}>
        {showApiKey ? 'Hide' : 'Show'}
      </button>
      <button class="secondary save-key" type="button" on:click={() => void saveApiKey()}>
        Save
      </button>
    </div>
    <p>Stored locally in this browser and sent only to OpenAI.</p>
  </details>

  {#if error}<p class="message error" role="alert">{error}</p>{/if}
  {#if status}<p class="message success" role="status">{status}</p>{/if}
</main>
