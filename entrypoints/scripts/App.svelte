<script lang="ts">
  import { onMount } from 'svelte';
  import {
    addPageScript,
    downloadScriptFile,
    getAllPageScripts,
    parseScriptFile,
    reloadTabsForOrigins,
    removePageScript,
    setPageScriptEnabled,
    type PageScript,
    type PageScriptInput,
  } from '../../utils/scripts';
  import { hasCodexSubscription } from '../../utils/codex-auth';
  import {
    MAX_REVIEWABLE_CODE_CHARS,
    reviewScriptFile,
    type ScriptReview,
  } from '../../utils/script-review';
  import {
    isUserScriptsAvailable,
    restoreUserScripts,
  } from '../../utils/user-scripts';
  import UserScriptsSetup from '../../components/UserScriptsSetup.svelte';

  let scripts: PageScript[] = [];
  let scriptFileInput: HTMLInputElement;
  let trustDialog: HTMLDialogElement;
  let pendingImport: PageScriptInput | null = null;
  let review: ScriptReview | null = null;
  let reviewError = '';
  let reviewing = false;
  let reviewAbort: AbortController | null = null;
  let signedIn = false;
  let loading = true;
  let importing = false;
  let reloading = false;
  let busyScriptId: string | null = null;
  let pendingReloadOrigins: string[] = [];
  let error = '';
  let status = '';
  let userScriptsReady = isUserScriptsAvailable();

  const NEEDS_USER_SCRIPTS = 'Allow User Scripts first — see the notice above.';

  $: reviewable =
    pendingImport !== null && pendingImport.code.length <= MAX_REVIEWABLE_CODE_CHARS;

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
      downloadScriptFile(script);
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

  async function openTrustPrompt(file: File): Promise<void> {
    if (busyScriptId !== null || importing || reloading) return;
    try {
      pendingImport = parseScriptFile(await file.text());
      trustDialog.showModal();
    } catch (caught) {
      error = messageFor(caught);
    }
  }

  function closeTrustPrompt(): void {
    reviewAbort?.abort();
    pendingImport = null;
    review = null;
    reviewError = '';
    reviewing = false;
  }

  async function runReview(): Promise<void> {
    if (pendingImport === null || reviewing) return;
    reviewing = true;
    review = null;
    reviewError = '';
    reviewAbort = new AbortController();
    const requested = pendingImport;
    try {
      const result = await reviewScriptFile(requested, reviewAbort.signal);
      if (pendingImport === requested) review = result;
    } catch (caught) {
      if (pendingImport === requested) reviewError = messageFor(caught);
    } finally {
      // A closed prompt has already cleared this state for its own request.
      if (pendingImport === requested) {
        reviewAbort = null;
        reviewing = false;
      }
    }
  }

  async function confirmImport(): Promise<void> {
    if (pendingImport === null || importing) return;
    const input = pendingImport;
    trustDialog.close();
    importing = true;
    error = '';
    status = '';
    try {
      const imported = await addPageScript(input);
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

  function userScriptsEnabled(): void {
    userScriptsReady = true;
    void loadScripts();
  }

  async function recheckUserScripts(): Promise<void> {
    const available = isUserScriptsAvailable();
    if (available === userScriptsReady) return;
    if (!available) {
      userScriptsReady = false;
      return;
    }
    await restoreUserScripts();
    userScriptsEnabled();
  }

  onMount(() => {
    void loadScripts(true);
    void hasCodexSubscription().then((value) => (signedIn = value));
    // The user leaves this tab to flip the browser's switch and comes back.
    const onFocus = () => void recheckUserScripts();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const listener = (
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes.pageScripts) void loadScripts();
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      browser.storage.onChanged.removeListener(listener);
    };
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
      title={userScriptsReady ? undefined : NEEDS_USER_SCRIPTS}
      on:click={chooseScriptFile}
      disabled={!userScriptsReady || importing || reloading || busyScriptId !== null}
    >{importing ? 'Importing…' : 'Import script'}</button>
    <input
      bind:this={scriptFileInput}
      type="file"
      accept=".scriptsmith.json,application/json"
      on:change={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void openTrustPrompt(file);
      }}
    />
  </header>

  {#if !userScriptsReady}
    <UserScriptsSetup onAvailable={userScriptsEnabled} />
  {/if}

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
        <p>Import a scriptsmith script file to add it here.</p>
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
              <label
                class="script-toggle"
                title={userScriptsReady
                  ? `${script.enabled ? 'Disable' : 'Enable'} ${script.name} on all sites`
                  : NEEDS_USER_SCRIPTS}
              >
                <input
                  type="checkbox"
                  role="switch"
                  checked={script.enabled}
                  aria-label={`${script.enabled ? 'Disable' : 'Enable'} ${script.name} on all sites`}
                  disabled={!userScriptsReady || busyScriptId !== null || importing || reloading}
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

<dialog
  class="trust"
  bind:this={trustDialog}
  aria-labelledby="trust-title"
  on:close={closeTrustPrompt}
>
  {#if pendingImport}
    <h2 id="trust-title">Only add “{pendingImport.name}” if you trust it</h2>
    <p class="trust-lead">
      A script is a small program. Once added, this one runs by itself every time
      you visit:
    </p>

    <div class="sites trust-sites">
      <ul>
        {#each pendingImport.origins as origin}
          <li><span>{origin}</span></li>
        {/each}
      </ul>
    </div>

    <div class="trust-block">
      <h3>While you are on those sites it can</h3>
      <ul class="trust-points">
        <li>See and change everything on the page, including what you type in — messages, addresses, passwords, card numbers.</li>
        <li>Do anything there that you could do yourself, since you are already signed in.</li>
        <li>Send whatever it sees to whoever wrote it.</li>
      </ul>
      <p class="trust-note">
        A script can hide what it really does, so nothing here can prove it is
        harmless. Add it only if you trust whoever gave it to you.
      </p>
    </div>

    {#if pendingImport.description}
      <details>
        <summary>What the author says it does</summary>
        <p class="trust-description">{pendingImport.description}</p>
      </details>
    {/if}

    <details>
      <summary>Show the script's code</summary>
      <pre>{pendingImport.code}</pre>
    </details>

    <div class="trust-check">
      <div class="trust-check-head">
        <div>
          <strong>Not sure? Have ChatGPT read it</strong>
          <p>
            It explains the code in plain words and points out anything that looks
            off. It can be fooled or miss things, so treat it as a second opinion,
            not proof.
          </p>
        </div>
        {#if signedIn && review === null && reviewable}
          <button
            class="secondary"
            type="button"
            on:click={() => void runReview()}
            disabled={reviewing}
          >{reviewing ? 'Reading…' : 'Check the code'}</button>
        {/if}
      </div>

      {#if !reviewable}
        <p class="trust-note">
          This script is too long to check in one piece, and checking only part of
          it would tell you nothing about the rest.
        </p>
      {:else if !signedIn}
        <p class="trust-note">
          Sign in with ChatGPT from the scriptsmith popup to use this check.
        </p>
      {:else if reviewing}
        <p class="trust-note">Sending the script to ChatGPT. This can take a minute.</p>
      {/if}

      {#if reviewError}
        <p class="message error" role="alert">{reviewError}</p>
      {/if}

      {#if review}
        <div class="trust-review">
          <p class="trust-summary">{review.summary}</p>
          {#if review.matchesDescription === 'no'}
            <p class="trust-verdict mismatch">
              It does more than the description above says.
            </p>
          {:else if review.matchesDescription === 'unclear'}
            <p class="trust-verdict">
              It could not tell whether the code matches the description above.
            </p>
          {/if}

          {#if review.concerns.length > 0}
            <ul class="concerns">
              {#each review.concerns as concern}
                <li class:high={concern.severity === 'high'}>
                  <strong>{concern.title}</strong>
                  <span>{concern.detail}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="trust-note">
              It found nothing beyond what the description claims. That is not a
              guarantee — the access listed above still applies.
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="trust-actions">
      <button class="secondary" type="button" on:click={() => trustDialog.close()}>Cancel</button>
      <button
        class="primary"
        type="button"
        on:click={() => void confirmImport()}
        disabled={importing}
      >I trust this script — add it</button>
    </div>
  {/if}
</dialog>
