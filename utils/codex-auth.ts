export const CODEX_REFRESH_TOKEN_STORAGE_KEY = 'codexRefreshToken';
export const CODEX_LOGIN_STATE_STORAGE_KEY = 'codexLoginState';
export const CODEX_LOGIN_MESSAGE = 'scriptsmith:codex-login:start';
export const CODEX_SIGN_OUT_MESSAGE = 'scriptsmith:codex-login:sign-out';

const CODEX_ACCESS_TOKEN_STORAGE_KEY = 'codexAccessToken';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const LOGIN_CALLBACK_URL = 'http://localhost:1455/auth/callback';
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REVOCATION_TIMEOUT_MS = 10_000;
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexLoginState {
  id: string;
  status: 'pending' | 'complete' | 'error';
  startedAt: number;
  error?: string;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string | { code?: string; message?: string };
  error_description?: string;
  code?: string;
}

class OAuthRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OAuthRequestError';
  }
}

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

export interface CodexSignOutResult {
  revoked: boolean;
}

type CachedCredentials = CodexCredentials & { expiresAt: number };

let cachedCredentials: CachedCredentials | null = null;
let refreshPromise: Promise<CodexCredentials> | null = null;
let loginPromise: Promise<CodexLoginState> | null = null;
let storageAccessPromise: Promise<void> | null = null;
let authOwner = false;
let authRevision = 0;
let signingOut = false;
const activeRequestControllers = new Set<AbortController>();

function messageFor(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('OpenAI authentication timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response: Response, fallback: string): Promise<OAuthRequestError> {
  const text = await response.text().catch(() => '');
  let detail = text;
  let code = '';
  try {
    const body = JSON.parse(text) as OAuthTokenResponse;
    const oauthError = body.error;
    code = typeof oauthError === 'string'
      ? oauthError
      : oauthError?.code || body.code || '';
    detail = body.error_description
      || (typeof oauthError === 'object' ? oauthError?.message : oauthError)
      || text;
  } catch {
    // Keep the response text.
  }
  return new OAuthRequestError(
    detail ? `${fallback}: ${detail}` : fallback,
    code.toLowerCase(),
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('OpenAI returned an invalid access token.');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    throw new Error('Could not read the OpenAI account from the access token.');
  }
}

function accountIdFromToken(token: string): string {
  const payload = decodeJwtPayload(token);
  const auth = payload[JWT_AUTH_CLAIM];
  const accountId =
    auth && typeof auth === 'object'
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('The OpenAI access token does not contain a ChatGPT account.');
  }
  return accountId;
}

async function requireAuthOwner(): Promise<void> {
  if (!authOwner) {
    throw new Error('Authentication credentials are only available to the background service.');
  }
  await storageAccessPromise;
  if (signingOut) throw new Error('ChatGPT is being disconnected.');
}

/**
 * Makes the background service the sole credential owner and prevents content
 * scripts from reading or observing either token storage area.
 */
export function initializeCodexAuth(): Promise<void> {
  authOwner = true;
  if (!storageAccessPromise) {
    storageAccessPromise = (async () => {
      await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    })().catch(async (caught: unknown) => {
      cachedCredentials = null;
      await Promise.allSettled([
        browser.storage.local.remove(CODEX_REFRESH_TOKEN_STORAGE_KEY),
        browser.storage.session.remove(CODEX_ACCESS_TOKEN_STORAGE_KEY),
      ]);
      throw new Error(`Could not protect ChatGPT credentials: ${messageFor(caught)}`);
    });
  }
  return storageAccessPromise;
}

export function isTrustedExtensionSender(sender: Browser.runtime.MessageSender): boolean {
  const extensionRoot = browser.runtime.getURL('');
  return typeof sender.url === 'string'
    && sender.url.startsWith(extensionRoot);
}

/** Registers a background Codex request so sign-out can stop it immediately. */
export function trackCodexRequest(controller: AbortController): () => void {
  if (!authOwner) {
    throw new Error('Codex requests must run in the background service.');
  }
  activeRequestControllers.add(controller);
  return () => activeRequestControllers.delete(controller);
}

async function readRefreshToken(): Promise<string> {
  const stored = await browser.storage.local.get(CODEX_REFRESH_TOKEN_STORAGE_KEY);
  const token = stored[CODEX_REFRESH_TOKEN_STORAGE_KEY];
  return typeof token === 'string' ? token.trim() : '';
}

async function saveRefreshToken(token: string): Promise<void> {
  await browser.storage.local.set({ [CODEX_REFRESH_TOKEN_STORAGE_KEY]: token });
}

function isCachedCredentials(value: unknown): value is CachedCredentials {
  if (!value || typeof value !== 'object') return false;
  const credentials = value as Partial<CachedCredentials>;
  return (
    typeof credentials.accessToken === 'string' &&
    typeof credentials.accountId === 'string' &&
    typeof credentials.expiresAt === 'number'
  );
}

async function readCachedCredentials(): Promise<CachedCredentials | null> {
  const stored = await browser.storage.session.get(CODEX_ACCESS_TOKEN_STORAGE_KEY);
  const credentials = stored[CODEX_ACCESS_TOKEN_STORAGE_KEY];
  return isCachedCredentials(credentials) ? credentials : null;
}

async function cacheCredentials(credentials: CachedCredentials): Promise<void> {
  cachedCredentials = credentials;
  await browser.storage.session.set({
    [CODEX_ACCESS_TOKEN_STORAGE_KEY]: credentials,
  });
}

async function tokenRequest(parameters: Record<string, string>): Promise<OAuthTokenResponse> {
  const response = await fetchWithTimeout(`${AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
  });
  if (!response.ok) {
    throw await responseError(response, `OpenAI authentication failed (${response.status})`);
  }
  return response.json() as Promise<OAuthTokenResponse>;
}

async function clearStoredCredentials(): Promise<void> {
  cachedCredentials = null;
  await Promise.all([
    browser.storage.local.remove(CODEX_REFRESH_TOKEN_STORAGE_KEY),
    browser.storage.session.remove(CODEX_ACCESS_TOKEN_STORAGE_KEY),
  ]);
}

function isPermanentRefreshError(caught: unknown): boolean {
  if (!(caught instanceof OAuthRequestError)) return false;
  return [
    'invalid_grant',
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
  ].includes(caught.code);
}

async function refreshCredentials(): Promise<CodexCredentials> {
  const revision = authRevision;
  const refreshToken = await readRefreshToken();
  if (!refreshToken) throw new Error('Sign in with ChatGPT before chatting.');

  let tokens: OAuthTokenResponse;
  try {
    tokens = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    });
  } catch (error) {
    if (revision === authRevision && isPermanentRefreshError(error)) {
      await clearStoredCredentials();
    }
    throw error;
  }

  const nextRefreshToken = tokens.refresh_token || refreshToken;
  if (revision !== authRevision || signingOut) {
    await revokeRefreshToken(nextRefreshToken);
    throw new Error('ChatGPT was disconnected while credentials were refreshing.');
  }
  if (!tokens.access_token) throw new Error('OpenAI did not return an access token.');
  if (nextRefreshToken !== refreshToken) await saveRefreshToken(nextRefreshToken);

  if (revision !== authRevision || signingOut) {
    await revokeRefreshToken(nextRefreshToken);
    throw new Error('ChatGPT was disconnected while credentials were refreshing.');
  }
  const credentials: CachedCredentials = {
    accessToken: tokens.access_token,
    accountId: accountIdFromToken(tokens.access_token),
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  await cacheCredentials(credentials);
  return credentials;
}

export async function getCodexCredentials(forceRefresh = false): Promise<CodexCredentials> {
  await requireAuthOwner();
  if (!(await readRefreshToken())) {
    cachedCredentials = null;
    throw new Error('Sign in with ChatGPT before chatting.');
  }
  if (!forceRefresh && !cachedCredentials) {
    cachedCredentials = await readCachedCredentials();
  }
  if (
    !forceRefresh &&
    cachedCredentials &&
    cachedCredentials.expiresAt > Date.now() + 60_000
  ) {
    return cachedCredentials;
  }
  if (!refreshPromise) {
    refreshPromise = refreshCredentials().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function invalidateCodexAccessToken(): Promise<void> {
  await requireAuthOwner();
  cachedCredentials = null;
  await browser.storage.session.remove(CODEX_ACCESS_TOKEN_STORAGE_KEY);
}

export async function hasCodexSubscription(): Promise<boolean> {
  return Boolean(await readRefreshToken());
}

export async function getCodexLoginState(): Promise<CodexLoginState | null> {
  const stored = await browser.storage.session.get(CODEX_LOGIN_STATE_STORAGE_KEY);
  const state = stored[CODEX_LOGIN_STATE_STORAGE_KEY];
  if (!state || typeof state !== 'object') return null;
  return state as CodexLoginState;
}

async function setLoginState(state: CodexLoginState): Promise<void> {
  await browser.storage.session.set({ [CODEX_LOGIN_STATE_STORAGE_KEY]: state });
}

async function isCurrentLogin(id: string): Promise<boolean> {
  const state = await getCodexLoginState();
  return state?.id === id && state.status === 'pending';
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomUrlSafe(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

async function captureAuthorizationCallback(authorizationUrl: string): Promise<string> {
  const expectedAuthorization = new URL(authorizationUrl);
  const expectedCallback = new URL(LOGIN_CALLBACK_URL);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let tabId: number | undefined;

    const cleanup = () => {
      browser.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
      browser.tabs.onRemoved.removeListener(onTabRemoved);
      clearTimeout(timeout);
    };

    const finish = (error?: unknown, callbackUrl?: string, closeTab = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeTab && tabId !== undefined) {
        void browser.tabs.remove(tabId).catch(() => undefined);
      }
      if (error !== undefined) {
        reject(error);
      } else if (callbackUrl) {
        resolve(callbackUrl);
      } else {
        reject(new Error('OpenAI did not return an authorization response.'));
      }
    };

    const onBeforeNavigate = (details: Browser.webNavigation.WebNavigationBaseCallbackDetails) => {
      if (details.frameId !== 0) return;
      let navigation: URL;
      try {
        navigation = new URL(details.url);
      } catch {
        return;
      }
      if (tabId === undefined) {
        const isAuthorizationStart =
          navigation.origin === expectedAuthorization.origin
          && navigation.pathname === expectedAuthorization.pathname
          && navigation.searchParams.get('state')
            === expectedAuthorization.searchParams.get('state');
        if (!isAuthorizationStart) return;
        tabId = details.tabId;
      }
      if (details.tabId !== tabId) return;
      if (
        navigation.origin === expectedCallback.origin
        && navigation.pathname === expectedCallback.pathname
      ) {
        finish(undefined, navigation.toString());
      }
    };

    const onTabRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        finish(new Error('ChatGPT sign-in was cancelled.'), undefined, false);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error('ChatGPT sign-in timed out.'));
    }, LOGIN_TIMEOUT_MS);

    browser.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    browser.tabs.onRemoved.addListener(onTabRemoved);
    void browser.tabs.create({ url: authorizationUrl, active: true })
      .then((tab) => {
        if (tab.id === undefined) {
          finish(new Error('Could not open the ChatGPT sign-in tab.'));
        } else if (tabId !== undefined && tabId !== tab.id) {
          void browser.tabs.remove(tab.id).catch(() => undefined);
          finish(new Error('Could not identify the ChatGPT sign-in tab.'));
        } else {
          tabId = tab.id;
        }
      })
      .catch((error) => {
        finish(error);
      });
  });
}

async function runCodexLogin(): Promise<CodexLoginState> {
  await requireAuthOwner();
  await cancelCodexLogin();
  const revision = authRevision;
  const state: CodexLoginState = {
    id: crypto.randomUUID(),
    status: 'pending',
    startedAt: Date.now(),
  };
  await setLoginState(state);

  try {
    const redirectUri = LOGIN_CALLBACK_URL;
    const verifier = randomUrlSafe(32);
    const challenge = await pkceChallenge(verifier);
    const oauthState = randomUrlSafe(32);
    const authorizationUrl = new URL(`${AUTH_BASE_URL}/oauth/authorize`);
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: oauthState,
    }).toString();

    const responseUrl = await captureAuthorizationCallback(authorizationUrl.toString());

    const callback = new URL(responseUrl);
    const callbackError = callback.searchParams.get('error_description')
      || callback.searchParams.get('error');
    if (callbackError) throw new Error(callbackError);
    if (callback.searchParams.get('state') !== oauthState) {
      throw new Error('OpenAI returned an invalid sign-in state.');
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('OpenAI did not return an authorization code.');
    if (!(await isCurrentLogin(state.id))) {
      throw new Error('ChatGPT sign-in was cancelled.');
    }

    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    });
    if (!tokens.refresh_token) throw new Error('OpenAI did not return a refresh token.');
    if (!(await isCurrentLogin(state.id)) || revision !== authRevision || signingOut) {
      await revokeRefreshToken(tokens.refresh_token);
      throw new Error('ChatGPT sign-in was cancelled.');
    }

    await saveRefreshToken(tokens.refresh_token);
    if (revision !== authRevision || signingOut) {
      await revokeRefreshToken(tokens.refresh_token);
      await clearStoredCredentials();
      throw new Error('ChatGPT sign-in was cancelled.');
    }
    if (tokens.access_token) {
      await cacheCredentials({
        accessToken: tokens.access_token,
        accountId: accountIdFromToken(tokens.access_token),
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      });
    }
    if (revision !== authRevision || signingOut) {
      await revokeRefreshToken(tokens.refresh_token);
      await clearStoredCredentials();
      throw new Error('ChatGPT sign-in was cancelled.');
    }

    const complete: CodexLoginState = { ...state, status: 'complete' };
    await setLoginState(complete);
    if (revision !== authRevision || signingOut) {
      await revokeRefreshToken(tokens.refresh_token);
      await clearStoredCredentials();
      await cancelCodexLogin();
      throw new Error('ChatGPT sign-in was cancelled.');
    }
    return complete;
  } catch (error) {
    console.error('scriptsmith ChatGPT sign-in failed:', error);
    if (await isCurrentLogin(state.id)) {
      await setLoginState({
        ...state,
        status: 'error',
        error: messageFor(error),
      });
    }
    throw error;
  }
}

export function startCodexLogin(): Promise<CodexLoginState> {
  if (!authOwner) {
    return Promise.reject(new Error('ChatGPT sign-in must be started by the background service.'));
  }
  if (!loginPromise) {
    loginPromise = runCodexLogin().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

export async function cancelCodexLogin(): Promise<void> {
  await browser.storage.session.remove(CODEX_LOGIN_STATE_STORAGE_KEY);
}

async function revokeRefreshToken(token: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${AUTH_BASE_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        token_type_hint: 'refresh_token',
        client_id: CODEX_CLIENT_ID,
      }),
    }, REVOCATION_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

async function signOutFromOwner(): Promise<CodexSignOutResult> {
  await requireAuthOwner();
  signingOut = true;
  authRevision += 1;
  for (const controller of activeRequestControllers) controller.abort();
  activeRequestControllers.clear();
  let revoked = false;
  try {
    await cancelCodexLogin();
    const refreshing = refreshPromise;
    if (refreshing) await refreshing.catch(() => undefined);
    const refreshToken = await readRefreshToken();
    revoked = !refreshToken || await revokeRefreshToken(refreshToken);
  } finally {
    try {
      await clearStoredCredentials();
    } finally {
      refreshPromise = null;
      signingOut = false;
    }
  }
  return { revoked };
}

export async function signOutCodex(): Promise<CodexSignOutResult> {
  if (authOwner) return signOutFromOwner();
  const result = await browser.runtime.sendMessage({
    type: CODEX_SIGN_OUT_MESSAGE,
  }) as { ok?: boolean; revoked?: boolean; error?: string } | undefined;
  if (!result?.ok) throw new Error(result?.error || 'Could not disconnect ChatGPT.');
  return { revoked: result.revoked === true };
}

export async function resumeCodexLogin(): Promise<void> {
  const state = await getCodexLoginState();
  if (state?.status === 'pending') {
    await setLoginState({
      ...state,
      status: 'error',
      error: 'ChatGPT sign-in was interrupted. Please try again.',
    });
  }
}
