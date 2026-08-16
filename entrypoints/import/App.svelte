<script lang="ts">
  import {
    importVibextScriptFile,
    type PageScript,
  } from '../../utils/scripts';

  const parameters = new URLSearchParams(location.search);
  const currentOrigin = parameters.get('origin');
  const tabIdParameter = parameters.get('tabId');
  const currentTabId = tabIdParameter && /^\d+$/.test(tabIdParameter)
    ? Number(tabIdParameter)
    : null;

  let scriptFileInput: HTMLInputElement;
  let importedScript: PageScript | null = null;
  let importing = false;
  let reloading = false;
  let error = '';

  $: targetsCurrentSite = Boolean(
    importedScript && currentOrigin && importedScript.origins.includes(currentOrigin),
  );

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function chooseScriptFile(): void {
    if (importing) return;
    error = '';
    scriptFileInput.value = '';
    scriptFileInput.click();
  }

  async function importScript(file: File): Promise<void> {
    if (importing) return;
    importing = true;
    error = '';
    try {
      importedScript = await importVibextScriptFile(await file.text());
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      importing = false;
    }
  }

  async function reloadPage(): Promise<void> {
    if (currentTabId === null || reloading) return;
    reloading = true;
    error = '';
    try {
      await browser.tabs.reload(currentTabId);
      window.close();
    } catch (caught) {
      error = messageFor(caught);
      reloading = false;
    }
  }
</script>

<main>
  <header>
    <h1>Import script</h1>
    <p>Select a Vibext script file from your computer.</p>
  </header>

  {#if importedScript}
    <section class="import-result" role="status">
      <span class="success-icon" aria-hidden="true">✓</span>
      <div>
        <strong>{importedScript.name}</strong>
        {#if targetsCurrentSite}
          <p>Imported and enabled for the current site.</p>
        {:else}
          <p>
            Imported for {importedScript.origins.length}
            {importedScript.origins.length === 1 ? 'site' : 'sites'}, but not the current site.
          </p>
        {/if}
      </div>
    </section>

    <div class="actions">
      {#if targetsCurrentSite && currentTabId !== null}
        <button
          class="primary"
          type="button"
          on:click={() => void reloadPage()}
          disabled={reloading}
        >{reloading ? 'Reloading…' : 'Reload page'}</button>
      {/if}
      <button class="secondary" type="button" on:click={() => window.close()}>Done</button>
    </div>
  {:else}
    <button
      class="primary choose-file"
      type="button"
      on:click={chooseScriptFile}
      disabled={importing}
    >{importing ? 'Importing…' : 'Choose script file'}</button>
    <input
      bind:this={scriptFileInput}
      type="file"
      accept=".vibext.json,application/json"
      on:change={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void importScript(file);
      }}
    />
    <p class="hint">Vibext validates the file before saving and enabling the script.</p>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}
</main>
