<script lang="ts">
  import { onMount } from 'svelte';
  import {
    downloadVibextScriptFile,
    getAllPageScripts,
    importVibextScriptFile,
    reloadTabsForOrigins,
    removePageScript,
    setPageScriptEnabled,
    type PageScript,
  } from '../../utils/scripts';

  let scripts: PageScript[] = [];
  let scriptFileInput: HTMLInputElement;
  let loading = true;
  let importing = false;
  let reloading = false;
  let busyScriptId: string | null = null;
  let pendingReloadOrigins: string[] = [];
  let error = '';
  let status = '';

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function sortedScripts(items: PageScript[]): PageScript[] {
    return [...items].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id));
  }

  function replaceScript(script: PageScript): void {
    scripts = sortedScripts([
      ...scripts.filter((candidate) => candidate.id !== script.id),
      script,
    ]);
  }

  function markAffected(origins: string[]): void {
    pendingReloadOrigins = [...new Set([...pendingReloadOrigins, ...origins])];
  }

  async function loadScripts(initial = false): Promise<void> {
    if (initial) loading = true;
    try {
      scripts = sortedScripts(await getAllPageScripts());
      error = '';
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      if (initial) loading = false;
    }
  }

  async function toggleScript(script: PageScript, enabled: boolean): Promise<void> {
    if (busyScriptId !== null || importing || reloading) return;
    busyScriptId = script.id;
    error = '';
    status = '';
    replaceScript({ ...script, enabled });
    try {
      const updated = await setPageScriptEnabled(script, enabled);
      replaceScript(updated);
      markAffected(updated.origins);
      status = `${updated.name} ${enabled ? 'enabled' : 'disabled'} on all its sites.`;
    } catch (caught) {
      replaceScript(script);
      error = messageFor(caught);
    } finally {
      busyScriptId = null;
    }
  }

  async function removeScript(script: PageScript): Promise<void> {
    if (busyScriptId !== null || importing || reloading) return;
    const confirmed = window.confirm(
      `Remove “${script.name}”?\n\nThis permanently deletes the script and cannot be undone.`,
    );
    if (!confirmed) return;

    busyScriptId = script.id;
    error = '';
    status = '';
    try {
      await removePageScript(script);
      scripts = scripts.filter((candidate) => candidate.id !== script.id);
      markAffected(script.origins);
      status = `${script.name} removed.`;
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      busyScriptId = null;
    }
  }

  function exportScript(script: PageScript): void {
    error = '';
    status = '';
    try {
      downloadVibextScriptFile(script);
      status = `${script.name} exported.`;
    } catch (caught) {
      error = messageFor(caught);
    }
  }

  function chooseScriptFile(): void {
    if (busyScriptId !== null || importing || reloading) return;
    error = '';
    status = '';
    scriptFileInput.value = '';
    scriptFileInput.click();
  }

  async function importScript(file: File): Promise<void> {
    if (busyScriptId !== null || importing || reloading) return;
    importing = true;
    error = '';
    status = '';
    try {
      const imported = await importVibextScriptFile(await file.text());
      replaceScript(imported);
      markAffected(imported.origins);
      status = `${imported.name} imported and enabled.`;
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      importing = false;
    }
  }

  async function reloadAffectedTabs(): Promise<void> {
    if (reloading || busyScriptId !== null || importing || pendingReloadOrigins.length === 0) return;
    reloading = true;
    error = '';
    status = '';
    const origins = pendingReloadOrigins;
    try {
      const result = await reloadTabsForOrigins(origins);
      pendingReloadOrigins = result.failedOrigins;
      if (result.failedOrigins.length > 0) {
        error = `Reloaded ${result.reloaded} of ${result.matched} affected tabs. Try the remaining tabs again.`;
      } else if (result.matched === 0) {
        status = 'No affected tabs are currently open.';
      } else {
        status = `Reloaded ${result.reloaded} affected ${result.reloaded === 1 ? 'tab' : 'tabs'}.`;
      }
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      reloading = false;
    }
  }

  onMount(() => {
    void loadScripts(true);
    const listener = (
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes.pageScripts) void loadScripts();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  });
</script>

<main>
  <header>
    <div>
      <h1>All scripts</h1>
      <p>Manage every script and the sites where it runs.</p>
    </div>
    <button
      class="primary import-button"
      type="button"
      on:click={chooseScriptFile}
      disabled={importing || reloading || busyScriptId !== null}
    >{importing ? 'Importing…' : 'Import script'}</button>
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
  </header>

  {#if pendingReloadOrigins.length > 0}
    <section class="reload-notice" role="status" aria-label="Reload affected tabs">
      <div>
        <strong>Open pages need reloading</strong>
        <p>Reload matching tabs to apply the latest script changes.</p>
      </div>
      <button
        class="primary"
        type="button"
        on:click={() => void reloadAffectedTabs()}
        disabled={reloading || importing || busyScriptId !== null}
      >{reloading ? 'Reloading…' : 'Reload affected tabs'}</button>
    </section>
  {/if}

  {#if error}<p class="message error" role="alert">{error}</p>{/if}
  {#if status}<p class="message success" role="status">{status}</p>{/if}

  <section class="scripts" aria-labelledby="scripts-heading">
    <div class="section-heading">
      <h2 id="scripts-heading">Scripts</h2>
      {#if !loading}<span class="count">{scripts.length}</span>{/if}
    </div>

    {#if loading}
      <p class="empty">Loading scripts…</p>
    {:else if scripts.length === 0}
      <div class="empty">
        <strong>No scripts yet</strong>
        <p>Import a Vibext script file to add it here.</p>
      </div>
    {:else}
      <ul class="script-list">
        {#each scripts as script (script.id)}
          <li class:disabled-script={!script.enabled}>
            <div class="script-copy">
              <div class="script-heading">
                <strong>{script.name}</strong>
                <span class:enabled={script.enabled} class="state">
                  {script.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p class="description">{script.description || 'No description provided.'}</p>
              <div class="sites">
                <span class="sites-label">Sites</span>
                <ul>
                  {#each script.origins as origin}
                    <li>
                      <a href={origin} target="_blank" rel="noreferrer" title={`Open ${origin}`}>
                        {origin}
                      </a>
                    </li>
                  {/each}
                </ul>
              </div>
            </div>

            <div class="script-actions">
              <label class="script-toggle" title={`${script.enabled ? 'Disable' : 'Enable'} ${script.name} on all sites`}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={script.enabled}
                  aria-label={`${script.enabled ? 'Disable' : 'Enable'} ${script.name} on all sites`}
                  disabled={busyScriptId !== null || importing || reloading}
                  on:change={(event) => void toggleScript(script, event.currentTarget.checked)}
                />
                <span class="toggle-track" aria-hidden="true"><span></span></span>
              </label>
              <button
                class="secondary"
                type="button"
                on:click={() => exportScript(script)}
                disabled={busyScriptId !== null || importing || reloading}
              >Export</button>
              <button
                class="danger"
                type="button"
                on:click={() => void removeScript(script)}
                disabled={busyScriptId !== null || importing || reloading}
              >{busyScriptId === script.id ? 'Removing…' : 'Remove'}</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>
