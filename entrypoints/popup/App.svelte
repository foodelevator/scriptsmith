<script lang="ts">
  import {
    downloadScriptFile,
    getScriptsForOrigin,
    originFromUrl,
    removePageScript,
    setPageScriptEnabled,
    type PageScript,
  } from '../../utils/scripts';
  import { createDraftScript } from '../../utils/ai';
  import {
    CODEX_LOGIN_MESSAGE,
    CODEX_LOGIN_STATE_STORAGE_KEY,
    CODEX_REFRESH_TOKEN_STORAGE_KEY,
    getCodexLoginState,
    hasCodexSubscription,
    signOutCodex,
    type CodexLoginState,
  } from '../../utils/codex-auth';
  import {
    requestCodexUsage,
    type CodexUsage,
  } from '../../utils/codex-usage';
  import {
    assignScriptSidebar,
    beginSidebarOpen,
    prepareScriptSidebar,
    showScriptSidebar,
  } from '../../utils/sidebar';
  import {
    isUserScriptsAvailable,
    restoreUserScripts,
  } from '../../utils/user-scripts';
  import UserScriptsSetup from '../../components/UserScriptsSetup.svelte';

  let scripts: PageScript[] = [];
  let origin: string | null = null;
  let tabId: number | null = null;
  let windowId: number | undefined;
  let loading = true;
  let working = false;
  let openingManager = false;
  let togglingScriptId: string | null = null;
  let reloadRequired = false;
  let reloading = false;
  let signedIn = false;
  let signingIn = false;
  let loginState: CodexLoginState | null = null;
  let codexUsage: CodexUsage | null = null;
  let usageLoading = false;
  let usageError = '';
  let status = '';
  let error = '';
  let userScriptsReady = isUserScriptsAvailable();

  const NEEDS_USER_SCRIPTS = 'Allow User Scripts first — see the notice above.';

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function usageColor(remainingPercent: number): string {
    if (remainingPercent > 80) return 'var(--usage-high)';
    if (remainingPercent > 50) return 'var(--usage-medium)';
    if (remainingPercent > 20) return 'var(--usage-low)';
    return 'var(--usage-critical)';
  }

  function resetLabel(resetAt: number | null): string {
    if (resetAt === null) return '';
    const minutes = Math.max(0, Math.ceil((resetAt - Date.now()) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  async function loadUsage(): Promise<void> {
    if (!signedIn || usageLoading) return;
    usageLoading = true;
    usageError = '';
    try {
      codexUsage = await requestCodexUsage();
    } catch (caught) {
      codexUsage = null;
      usageError = messageFor(caught);
    } finally {
      usageLoading = false;
    }
  }

  async function loadPage(): Promise<void> {
    loading = true;
    error = '';
    userScriptsReady = isUserScriptsAvailable();

    try {
      const [tab, nextSignedIn, nextLoginState] = await Promise.all([
        browser.tabs.query({ active: true, currentWindow: true }).then(([active]) => active),
        hasCodexSubscription(),
        getCodexLoginState(),
      ]);
      signedIn = nextSignedIn;
      if (nextSignedIn) void loadUsage();
      loginState = nextLoginState;
      signingIn = nextLoginState?.status === 'pending';
      const nextOrigin = originFromUrl(tab?.url);
      const nextTabId = tab?.id ?? null;
      if (nextOrigin && nextTabId !== null) await prepareScriptSidebar(nextTabId);

      origin = nextOrigin;
      tabId = nextTabId;
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

  async function signIn(): Promise<void> {
    if (signingIn) return;
    error = '';
    status = '';
    loginState = null;
    signingIn = true;
    try {
      const result = await browser.runtime.sendMessage({
        type: CODEX_LOGIN_MESSAGE,
      }) as { ok?: boolean; error?: string } | undefined;
      if (!result?.ok) {
        throw new Error(result?.error || 'Could not start ChatGPT sign-in.');
      }
    } catch (caught) {
      console.error('scriptsmith ChatGPT sign-in failed:', caught);
      signingIn = false;
      error = messageFor(caught);
    }
  }

  async function signOut(): Promise<void> {
    error = '';
    status = '';
    try {
      const { revoked } = await signOutCodex();
      signedIn = false;
      signingIn = false;
      loginState = null;
      codexUsage = null;
      usageError = '';
      status = revoked
        ? 'Signed out of ChatGPT and revoked this connection.'
        : 'Disconnected locally, but OpenAI could not confirm revocation. Remove scriptsmith in ChatGPT security settings to revoke it.';
    } catch (caught) {
      error = messageFor(caught);
    }
  }

  async function openEditor(
    script: PageScript,
    pending?: Promise<boolean> | null,
  ): Promise<void> {
    if (tabId === null || working || openingManager) return;
    // Firefox loses the click's gesture across an await, so the open has to
    // start before the bookkeeping below.
    const opened = pending ?? beginSidebarOpen();
    working = true;
    error = '';
    status = '';

    try {
      await assignScriptSidebar({ scriptId: script.id }, tabId, windowId);
      if (!(await opened)) await showScriptSidebar(tabId, windowId);
      window.close();
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      working = false;
    }
  }

  async function addScript(): Promise<void> {
    if (!origin || working || openingManager) return;
    const opened = beginSidebarOpen();
    working = true;
    error = '';

    try {
      const script = await createDraftScript(origin);
      scripts = [...scripts, script];
      working = false;
      await openEditor(script, opened);
    } catch (caught) {
      error = messageFor(caught);
      working = false;
    }
  }

  async function toggleScript(script: PageScript, enabled: boolean): Promise<void> {
    if (togglingScriptId !== null || working || openingManager) return;
    error = '';
    status = '';
    togglingScriptId = script.id;
    scripts = scripts.map((candidate) =>
      candidate.id === script.id ? { ...candidate, enabled } : candidate,
    );

    try {
      const updated = await setPageScriptEnabled(script, enabled);
      scripts = scripts.map((candidate) =>
        candidate.id === script.id ? updated : candidate,
      );
      reloadRequired = true;
      status = `${script.name} ${enabled ? 'enabled' : 'disabled'}.`;
    } catch (caught) {
      scripts = scripts.map((candidate) =>
        candidate.id === script.id ? script : candidate,
      );
      error = messageFor(caught);
    } finally {
      togglingScriptId = null;
    }
  }

  async function reloadPage(): Promise<void> {
    if (tabId === null || reloading) return;
    reloading = true;
    error = '';

    try {
      await browser.tabs.reload(tabId);
      reloadRequired = false;
      status = 'Page reloaded with the current script settings.';
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      reloading = false;
    }
  }

  async function remove(script: PageScript): Promise<void> {
    if (working || openingManager || togglingScriptId !== null) return;
    error = '';
    status = '';

    const confirmed = window.confirm(
      `Remove “${script.name}”?\n\nThis permanently deletes the script and cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      await removePageScript(script);
      scripts = scripts.filter((candidate) => candidate.id !== script.id);
      status = `${script.name} removed.`;
    } catch (caught) {
      error = messageFor(caught);
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

  async function openManager(): Promise<void> {
    if (working || openingManager || togglingScriptId !== null) return;
    openingManager = true;
    error = '';
    status = '';
    try {
      await browser.tabs.create({
        url: browser.runtime.getURL('/scripts.html'),
      });
      window.close();
    } catch (caught) {
      error = messageFor(caught);
    } finally {
      openingManager = false;
    }
  }

  function userScriptsEnabled(): void {
    userScriptsReady = true;
    void loadPage();
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
    void loadPage();
    const onFocus = () => void recheckUserScripts();
    window.addEventListener('focus', onFocus);
    const listener = (
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[CODEX_REFRESH_TOKEN_STORAGE_KEY]) {
        signedIn = typeof changes[CODEX_REFRESH_TOKEN_STORAGE_KEY].newValue === 'string';
        if (!signedIn) {
          codexUsage = null;
          usageError = '';
        }
      }
      if (areaName === 'session' && changes[CODEX_LOGIN_STATE_STORAGE_KEY]) {
        const next = changes[CODEX_LOGIN_STATE_STORAGE_KEY].newValue as
          | CodexLoginState
          | undefined;
        loginState = next ?? null;
        signingIn = next?.status === 'pending';
        if (next?.status === 'pending') {
          error = '';
        } else if (next?.status === 'complete') {
          signedIn = true;
          void loadUsage();
          status = 'Signed in with ChatGPT.';
        } else if (next?.status === 'error') {
          error = next.error ?? 'ChatGPT sign-in failed.';
        }
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      window.removeEventListener('focus', onFocus);
      browser.storage.onChanged.removeListener(listener);
      void browser.runtime.sendMessage({ type: 'scriptsmith:sidebar:reconcile' })
        .catch(() => undefined);
    };
  });
</script>

<main>
  <header>
    <h1>scriptsmith</h1>
    <p>{origin ?? 'Scripts for the current site'}</p>
  </header>

  {#if !userScriptsReady}
    <UserScriptsSetup compact onAvailable={userScriptsEnabled} />
  {/if}

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
          <li class:disabled-script={!script.enabled}>
            <div class="script-details">
              <strong>{script.name}</strong>
              <p>{script.description}</p>
              {#if script.origins.length > 1}
                <span class="multi-page" title={script.origins.join('\n')}>+{script.origins.length - 1} sites</span>
              {/if}
            </div>
            <div class="script-actions">
              <label
                class="script-toggle"
                title={userScriptsReady
                  ? `${script.enabled ? 'Disable' : 'Enable'} ${script.name}`
                  : NEEDS_USER_SCRIPTS}
              >
                <input
                  type="checkbox"
                  role="switch"
                  checked={script.enabled}
                  aria-label={`${script.enabled ? 'Disable' : 'Enable'} ${script.name}`}
                  disabled={!userScriptsReady || working || openingManager || togglingScriptId !== null}
                  on:change={(event) => void toggleScript(script, event.currentTarget.checked)}
                />
                <span class="toggle-track" aria-hidden="true"><span></span></span>
              </label>
              <button
                class="remove"
                type="button"
                aria-label={`Remove ${script.name}`}
                title={`Remove ${script.name}`}
                on:click={() => void remove(script)}
                disabled={working || openingManager || togglingScriptId !== null}
              >×</button>
              <button
                class="export-script"
                type="button"
                aria-label={`Export ${script.name}`}
                title={`Export ${script.name}`}
                on:click={() => exportScript(script)}
                disabled={working || openingManager || togglingScriptId !== null}
              >
                <svg aria-hidden="true" viewBox="0 0 20 20">
                  <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 15.5h12" />
                </svg>
              </button>
              <button
                class="edit-script"
                type="button"
                aria-label={`Edit ${script.name}`}
                title={userScriptsReady ? `Edit ${script.name}` : NEEDS_USER_SCRIPTS}
                on:click={() => void openEditor(script)}
                disabled={!userScriptsReady || working || openingManager || togglingScriptId !== null}
              >
                <svg aria-hidden="true" viewBox="0 0 20 20">
                  <path d="m4 16 3.2-.7 8-8a1.8 1.8 0 0 0-2.5-2.5l-8 8L4 16Z" />
                  <path d="m11.5 6 2.5 2.5" />
                </svg>
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if reloadRequired}
    <div class="reload-notice" role="status">
      <p>Reload the page to apply the script changes.</p>
      <button
        type="button"
        on:click={() => void reloadPage()}
        disabled={reloading || openingManager || togglingScriptId !== null}
      >{reloading ? 'Reloading…' : 'Reload page'}</button>
    </div>
  {/if}

  <div class="script-creation-actions">
    <button
      class="add-script"
      type="button"
      title={userScriptsReady ? undefined : NEEDS_USER_SCRIPTS}
      on:click={() => void addScript()}
      disabled={!userScriptsReady || !origin || tabId === null || working || openingManager || togglingScriptId !== null}
    >{working ? 'Opening…' : 'Add script'}</button>
    <button
      class="manage-scripts"
      type="button"
      on:click={() => void openManager()}
      disabled={working || openingManager || togglingScriptId !== null}
    >{openingManager ? 'Opening…' : 'Manage all scripts'}</button>
  </div>

  <section class="account" aria-labelledby="account-heading">
    <div class="section-heading">
      <h2 id="account-heading">Codex subscription</h2>
      {#if signedIn}
        {#if codexUsage}
          {@const reset = resetLabel(codexUsage.limitingWindow.resetAt)}
          {@const usageLabel = `${codexUsage.remainingPercent}% Codex usage left${reset ? ` · resets in ${reset}` : ''}`}
          <div
            class="usage-ring"
            style={`--usage-color: ${usageColor(codexUsage.remainingPercent)}`}
            title={usageLabel}
            role="img"
            aria-label={usageLabel}
          >
            <svg aria-hidden="true" viewBox="0 0 36 36">
              <circle class="usage-track" cx="18" cy="18" r="15.5" pathLength="100" />
              <circle
                class="usage-value"
                cx="18"
                cy="18"
                r="15.5"
                pathLength="100"
                stroke-dasharray={`${codexUsage.remainingPercent} 100`}
              />
            </svg>
          </div>
        {:else}
          <span
            class="usage-placeholder"
            class:loading={usageLoading}
            class:usage-failed={usageError}
            title={usageError || 'Loading Codex usage'}
          ></span>
        {/if}
      {/if}
    </div>
    {#if signedIn}
      <div class="account-row">
        <p>Signed in with ChatGPT.</p>
        <button class="secondary" type="button" on:click={() => void signOut()}>Sign out</button>
      </div>
    {:else if signingIn && loginState}
      <div class="oauth-login">
        <p>Complete sign-in in the OpenAI window.</p>
      </div>
    {:else}
      <div class="account-row">
        <p>Sign in with ChatGPT to use your Codex subscription.</p>
        <button
          class="secondary sign-in"
          class:loading={signingIn}
          type="button"
          aria-busy={signingIn}
          on:click={() => void signIn()}
          disabled={signingIn}
        >
          {signingIn ? 'Starting' : 'Sign in'}
          {#if signingIn}
            <span class="loading-dots" aria-hidden="true">
              <span></span><span></span><span></span>
            </span>
          {/if}
        </button>
      </div>
    {/if}
  </section>

  {#if error}<p class="message error" role="alert">{error}</p>{/if}
  {#if status}<p class="message success" role="status">{status}</p>{/if}
</main>
