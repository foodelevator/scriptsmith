<script lang="ts">
  import {
    getScriptsForOrigin,
    originFromUrl,
    removePageScript,
    setPageScriptEnabled,
    type PageScript,
  } from '../../utils/scripts';
  import { createDraftScript } from '../../utils/ai';
  import {
    CODEX_LOGIN_STATE_STORAGE_KEY,
    CODEX_REFRESH_TOKEN_STORAGE_KEY,
    cancelCodexLogin,
    getCodexLoginState,
    hasCodexSubscription,
    signOutCodex,
    startCodexLogin,
    type CodexLoginState,
  } from '../../utils/codex-auth';
  import {
    getCodexUsage,
    type CodexUsage,
  } from '../../utils/codex-usage';
  import {
    openScriptSidebar,
    prepareScriptSidebar,
  } from '../../utils/sidebar';

  let scripts: PageScript[] = [];
  let origin: string | null = null;
  let tabId: number | null = null;
  let windowId: number | undefined;
  let loading = true;
  let working = false;
  let togglingScriptId: string | null = null;
  let signedIn = false;
  let signingIn = false;
  let loginState: CodexLoginState | null = null;
  let codexUsage: CodexUsage | null = null;
  let usageLoading = false;
  let usageError = '';
  let status = '';
  let error = '';

  function messageFor(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function usageColor(remainingPercent: number): string {
    if (remainingPercent > 80) return '#16a34a';
    if (remainingPercent > 50) return '#2563eb';
    if (remainingPercent > 20) return '#ca8a04';
    return '#dc2626';
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
      codexUsage = await getCodexUsage();
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
      loginState = await startCodexLogin();
    } catch (caught) {
      signingIn = false;
      error = messageFor(caught);
    }
  }

  async function openSignInPage(): Promise<void> {
    if (!loginState) return;
    try {
      await navigator.clipboard.writeText(loginState.userCode);
    } catch {
      // The code remains visible if clipboard access is unavailable.
    }
    await browser.tabs.create({ url: loginState.verificationUrl });
  }

  async function cancelSignIn(): Promise<void> {
    await cancelCodexLogin();
    signingIn = false;
    loginState = null;
  }

  async function signOut(): Promise<void> {
    error = '';
    status = '';
    try {
      await signOutCodex();
      signedIn = false;
      signingIn = false;
      loginState = null;
      codexUsage = null;
      usageError = '';
      status = 'Signed out of ChatGPT.';
    } catch (caught) {
      error = messageFor(caught);
    }
  }

  async function openEditor(script: PageScript): Promise<void> {
    if (tabId === null || working) return;
    working = true;
    error = '';
    status = '';

    try {
      await openScriptSidebar(
        { scriptId: script.id, origin: script.origin },
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
      await openEditor(script);
    } catch (caught) {
      error = messageFor(caught);
      working = false;
    }
  }

  async function toggleScript(script: PageScript, enabled: boolean): Promise<void> {
    if (togglingScriptId !== null) return;
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
        if (next?.status === 'complete') {
          signedIn = true;
          void loadUsage();
          status = 'Signed in with ChatGPT.';
        } else if (next?.status === 'error') {
          error = next.error ?? 'ChatGPT sign-in failed.';
        }
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
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
          <li class:disabled-script={!script.enabled}>
            <div class="script-details">
              <strong>{script.name}</strong>
              <p>{script.description}</p>
            </div>
            <div class="script-actions">
              <label class="script-toggle" title={`${script.enabled ? 'Disable' : 'Enable'} ${script.name}`}>
                <span class="toggle-label">{script.enabled ? 'On' : 'Off'}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={script.enabled}
                  aria-label={`${script.enabled ? 'Disable' : 'Enable'} ${script.name}`}
                  disabled={working || togglingScriptId !== null}
                  on:change={(event) => void toggleScript(script, event.currentTarget.checked)}
                />
                <span class="toggle-track" aria-hidden="true"><span></span></span>
              </label>
              <button
                class="edit-script"
                type="button"
                on:click={() => void openEditor(script)}
                disabled={working || togglingScriptId !== null}
              >Edit script</button>
              <button
                class="remove"
                type="button"
                aria-label={`Remove ${script.name}`}
                title={`Remove ${script.name}`}
                on:click={() => void remove(script)}
                disabled={working || togglingScriptId !== null}
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
    disabled={!origin || tabId === null || working || togglingScriptId !== null}
  >{working ? 'Opening…' : 'Add script'}</button>

  <section class="account" aria-labelledby="account-heading">
    <div class="section-heading">
      <h2 id="account-heading">Codex subscription</h2>
      {#if signedIn}
        {#if codexUsage}
          <div
            class="usage-ring"
            style={`--usage-color: ${usageColor(codexUsage.remainingPercent)}`}
            title={`${codexUsage.remainingPercent}% Codex usage left`}
            role="img"
            aria-label={`${codexUsage.remainingPercent}% Codex usage left`}
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
          {#if resetLabel(codexUsage.limitingWindow.resetAt)}
            <span class="usage-reset">
              Resets in {resetLabel(codexUsage.limitingWindow.resetAt)}
            </span>
          {/if}
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
        <p>Vibext uses your ChatGPT Codex subscription.</p>
        <button class="secondary" type="button" on:click={() => void signOut()}>Sign out</button>
      </div>
    {:else if signingIn && loginState}
      <div class="device-login">
        <p>Enter this one-time code on the OpenAI page:</p>
        <strong>{loginState.userCode}</strong>
        <div class="login-actions">
          <button
            class="secondary sign-in"
            type="button"
            on:click={() => void openSignInPage()}
          >Copy code and sign in</button>
          <button class="secondary" type="button" on:click={() => void cancelSignIn()}>Cancel</button>
        </div>
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
