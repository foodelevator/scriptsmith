<script lang="ts">
  import {
    addPageScript,
    getScriptsForOrigin,
    originFromUrl,
    removePageScript,
    runPageScriptNow,
    type PageScript,
  } from '../../utils/scripts';

  let prompt = '';
  let scripts: PageScript[] = [];
  let origin: string | null = null;
  let tabId: number | null = null;
  let loading = true;
  let saving = false;
  let status = '';
  let error = '';

  function scriptDescription(code: string): string {
    const firstLine = code
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);

    if (!firstLine) return 'Custom page script';
    return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
  }

  async function loadPage(): Promise<void> {
    loading = true;
    error = '';

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      origin = originFromUrl(tab?.url);
      tabId = tab?.id ?? null;

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

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function send(): Promise<void> {
    const code = prompt.trim();
    if (!code || !origin || tabId === null || saving) return;

    saving = true;
    error = '';
    status = '';

    try {
      const number = scripts.length + 1;
      const script = await addPageScript({
        origin,
        name: `Script ${number}`,
        description: scriptDescription(code),
        code,
      });

      scripts = [...scripts, script];
      prompt = '';
      const runResult = await runPageScriptNow(script, tabId);
      status = runResult
        ? `${script.name} saved and run.`
        : `${script.name} saved. Reload the page to run it.`;
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      saving = false;
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

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
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
            <button
              class="remove"
              type="button"
              aria-label={`Remove ${script.name}`}
              title={`Remove ${script.name}`}
              on:click={() => void remove(script)}
            >×</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="composer" aria-labelledby="new-script-heading">
    <h2 id="new-script-heading">New script</h2>
    <label for="prompt">JavaScript</label>
    <textarea
      id="prompt"
      name="prompt"
      placeholder="document.querySelector('.ad')?.remove();"
      rows="6"
      bind:value={prompt}
      on:keydown={handleKeydown}
      disabled={!origin || saving}
    ></textarea>

    <div class="actions">
      <span class="shortcut">Ctrl/⌘ + Enter</span>
      <button
        class="send"
        type="button"
        on:click={() => void send()}
        disabled={!origin || !prompt.trim() || saving}
      >{saving ? 'Saving…' : 'Send'}</button>
    </div>
  </section>

  {#if error}<p class="message error" role="alert">{error}</p>{/if}
  {#if status}<p class="message success" role="status">{status}</p>{/if}
</main>
