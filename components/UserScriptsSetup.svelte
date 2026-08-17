<script lang="ts">
  import {
    extensionDetailsUrl,
    openExtensionDetails,
    requestUserScriptsPermission,
    restoreUserScripts,
  } from '../utils/user-scripts';

  export let compact = false;
  export let onAvailable: () => void = () => {};

  const firefox = import.meta.env.FIREFOX;
  const detailsUrl = extensionDetailsUrl();

  let showAddress = false;
  let copied = false;
  let checking = false;
  let granting = false;
  let stillOff = false;
  let grantError = '';

  async function settle(): Promise<boolean> {
    if (!(await restoreUserScripts())) return false;
    onAvailable();
    return true;
  }

  async function openSettings(): Promise<void> {
    if (await openExtensionDetails()) return;
    showAddress = true;
  }

  async function copyAddress(): Promise<void> {
    if (!detailsUrl) return;
    try {
      await navigator.clipboard.writeText(detailsUrl);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
    }
  }

  async function grant(): Promise<void> {
    if (granting) return;
    granting = true;
    grantError = '';
    stillOff = false;
    try {
      const granted = await requestUserScriptsPermission();
      if (!granted || !(await settle())) stillOff = true;
    } catch (caught) {
      grantError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      granting = false;
    }
  }

  async function checkAgain(): Promise<void> {
    if (checking) return;
    checking = true;
    stillOff = false;
    try {
      stillOff = !(await settle());
    } finally {
      checking = false;
    }
  }
</script>

<section class="setup" class:compact aria-labelledby="user-scripts-setup-title">
  <h2 id="user-scripts-setup-title">One step left before scriptsmith can work</h2>
  <p class="lead">
    scriptsmith works by running small scripts on the pages you choose. Your
    browser keeps that switched off until you allow it, so scripts cannot be
    added or run yet. Anything you have already saved is still here — it just is
    not running.
  </p>

  {#if firefox}
    <ol>
      <li>
        Give scriptsmith permission. Firefox will ask you to confirm.
        <div class="step-action">
          <button
            class="setup-primary"
            type="button"
            on:click={() => void grant()}
            disabled={granting}
          >{granting ? 'Asking Firefox…' : 'Allow scriptsmith to run scripts'}</button>
        </div>
      </li>
      <li>Come back here and choose <strong>Check again</strong>.</li>
    </ol>

    <details>
      <summary>Firefox did not ask me, or I said no</summary>
      <ol>
        <li>Open <code>about:addons</code> in a new tab.</li>
        <li>Click <strong>scriptsmith</strong> in the list.</li>
        <li>Open the <strong>Permissions</strong> tab.</li>
        <li>Switch on <strong>Run user scripts</strong>.</li>
      </ol>
    </details>
  {:else}
    <ol>
      <li>
        Open scriptsmith's details page.
        {#if showAddress || !detailsUrl}
          <p class="hint">
            Paste this address into your browser's address bar and press Enter:
          </p>
          <div class="step-action address">
            <code>{detailsUrl ?? 'chrome://extensions'}</code>
            <button class="setup-secondary" type="button" on:click={() => void copyAddress()}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>
        {:else}
          <div class="step-action">
            <button class="setup-primary" type="button" on:click={() => void openSettings()}>
              Open extension settings
            </button>
          </div>
        {/if}
      </li>
      <li>Find <strong>Allow User Scripts</strong> and switch it on.</li>
      <li>Come back here and choose <strong>Check again</strong>.</li>
    </ol>
  {/if}

  <div class="setup-footer">
    <button
      class="setup-secondary"
      type="button"
      on:click={() => void checkAgain()}
      disabled={checking}
    >{checking ? 'Checking…' : 'Check again'}</button>
    {#if stillOff}
      <p class="hint" role="status">
        {#if firefox}
          scriptsmith still is not allowed. You can also switch it on from
          <code>about:addons</code> — see above.
        {:else}
          Still switched off. Make sure you switched it on for
          <strong>scriptsmith</strong> specifically.
        {/if}
      </p>
    {/if}
  </div>

  {#if grantError}
    <p class="setup-error" role="alert">{grantError}</p>
  {/if}
</section>

<style>
  .setup {
    display: grid;
    gap: 11px;
    border: 1px solid light-dark(#f0e0ba, rgb(230 180 80 / 28%));
    border-radius: 12px;
    padding: 14px 15px;
    background: var(--warning-subtle);
  }

  .setup h2 {
    margin: 0;
    color: var(--warning-text);
    font-size: 14px;
    font-weight: 650;
    letter-spacing: normal;
    text-transform: none;
  }

  .setup.compact h2 {
    font-size: 13px;
  }

  .setup p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.45;
  }

  .setup.compact p {
    font-size: 12px;
  }

  .lead {
    max-width: 72ch;
  }

  .setup ol {
    margin: 0;
    padding-left: 20px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.45;
  }

  .setup.compact ol {
    font-size: 12px;
  }

  .setup li + li {
    margin-top: 9px;
  }

  .step-action {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  .address code {
    flex: 1 1 auto;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 8px;
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .setup code {
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  .hint {
    font-size: 12px;
  }

  .setup-primary,
  .setup-secondary {
    flex: none;
    border-radius: 8px;
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .setup-primary {
    border: 0;
    color: var(--on-accent);
    background: var(--accent-bg);
  }

  .setup-primary:hover:not(:disabled) {
    background: var(--accent-bg-hover);
  }

  .setup-secondary {
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    background: var(--surface);
  }

  .setup-secondary:hover:not(:disabled) {
    background: var(--surface-2);
  }

  .setup-primary:disabled,
  .setup-secondary:disabled {
    opacity: 0.6;
    cursor: default;
  }

  details {
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.45;
  }

  summary {
    cursor: pointer;
    font-weight: 600;
  }

  details ol {
    margin-top: 7px;
    font-size: 12px;
  }

  .setup-footer {
    display: grid;
    gap: 7px;
    justify-items: start;
    border-top: 1px solid light-dark(#f0e0ba, rgb(230 180 80 / 22%));
    padding-top: 11px;
  }

  .setup-error {
    color: var(--danger-text);
    font-size: 12px;
  }
</style>
