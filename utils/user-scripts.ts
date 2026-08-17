export type UserScriptsApi = typeof browser.userScripts;

export const USER_SCRIPTS_SYNC_MESSAGE = 'scriptsmith:user-scripts:sync';

export const USER_SCRIPTS_UNAVAILABLE_MESSAGE =
  'scriptsmith is not allowed to run scripts yet. Open the scriptsmith popup to finish setup.';

// Chromium exposes browser.userScripts as a getter that throws while the user
// has not allowed user scripts, so reading the property is itself the test.
function readUserScriptsApi(): UserScriptsApi | null {
  try {
    return browser.userScripts ?? null;
  } catch {
    return null;
  }
}

export function isUserScriptsAvailable(): boolean {
  return readUserScriptsApi() !== null;
}

export function userScriptsApi(): UserScriptsApi {
  const api = readUserScriptsApi();
  if (!api) throw new Error(USER_SCRIPTS_UNAVAILABLE_MESSAGE);
  return api;
}

export function extensionDetailsUrl(): string | null {
  if (import.meta.env.FIREFOX) return null;
  const scheme = navigator.userAgent.includes('Edg/') ? 'edge://' : 'chrome://';
  return `${scheme}extensions/?id=${browser.runtime.id}`;
}

export async function openExtensionDetails(): Promise<boolean> {
  const url = extensionDetailsUrl();
  if (!url) return false;
  try {
    await browser.tabs.create({ url });
    return true;
  } catch {
    // Some Chromium forks refuse to let an extension navigate to their
    // settings pages; the caller falls back to showing the address.
    return false;
  }
}

export async function requestUserScriptsPermission(): Promise<boolean> {
  if (!browser.permissions?.request) return false;
  return browser.permissions.request({ permissions: ['userScripts'] });
}

export async function resyncUserScripts(): Promise<void> {
  await browser.runtime.sendMessage({ type: USER_SCRIPTS_SYNC_MESSAGE });
}

// Registrations are lost while the API is unavailable, so saved scripts have to
// be registered again the moment the browser lets us back in.
export async function restoreUserScripts(): Promise<boolean> {
  if (!isUserScriptsAvailable()) return false;
  try {
    await resyncUserScripts();
  } catch (caught) {
    console.warn('scriptsmith could not restore its scripts:', caught);
  }
  return true;
}
