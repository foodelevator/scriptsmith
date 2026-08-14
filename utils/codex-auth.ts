export const CODEX_REFRESH_TOKEN_STORAGE_KEY = 'codexRefreshToken';
export const CODEX_LOGIN_STATE_STORAGE_KEY = 'codexLoginState';
export const CODEX_LOGIN_ALARM = 'vibext-codex-login';

const CODEX_ACCESS_TOKEN_STORAGE_KEY = 'codexAccessToken';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const DEVICE_CALLBACK_URL = `${AUTH_BASE_URL}/deviceauth/callback`;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexLoginState {
  id: string;
  status: 'pending' | 'complete' | 'error';
  userCode: string;
  verificationUrl: string;
  startedAt: number;
  intervalSeconds: number;
  error?: string;
  deviceAuthId?: string;
}

interface DeviceCodeResponse {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

type CachedCredentials = CodexCredentials & { expiresAt: number };

let cachedCredentials: CachedCredentials | null = null;
let refreshPromise: Promise<CodexCredentials> | null = null;
let polling = false;

function messageFor(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('OpenAI authentication timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    const body = JSON.parse(text) as OAuthTokenResponse;
    detail = body.error_description || body.error || text;
  } catch {
    // Keep the response text.
  }
  return new Error(detail ? `${fallback}: ${detail}` : fallback);
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
    if (response.status === 400 || response.status === 401) {
      cachedCredentials = null;
    }
    throw await responseError(response, `OpenAI authentication failed (${response.status})`);
  }
  return response.json() as Promise<OAuthTokenResponse>;
}

async function refreshCredentials(): Promise<CodexCredentials> {
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
    if (/\(400\)|\(401\)|invalid.grant|expired|revoked/i.test(messageFor(error))) {
      await browser.storage.local.remove(CODEX_REFRESH_TOKEN_STORAGE_KEY);
    }
    throw error;
  }

  if (!tokens.access_token) throw new Error('OpenAI did not return an access token.');
  const nextRefreshToken = tokens.refresh_token || refreshToken;
  if (nextRefreshToken !== refreshToken) await saveRefreshToken(nextRefreshToken);

  const credentials: CachedCredentials = {
    accessToken: tokens.access_token,
    accountId: accountIdFromToken(tokens.access_token),
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  await cacheCredentials(credentials);
  return credentials;
}

export async function getCodexCredentials(forceRefresh = false): Promise<CodexCredentials> {
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

export function invalidateCodexAccessToken(): void {
  cachedCredentials = null;
  void browser.storage.session.remove(CODEX_ACCESS_TOKEN_STORAGE_KEY);
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

function scheduleLoginPoll(intervalSeconds: number): void {
  browser.alarms.create(CODEX_LOGIN_ALARM, {
    when: Date.now() + Math.max(1, intervalSeconds) * 1000,
  });
}

export async function startCodexLogin(): Promise<CodexLoginState> {
  await cancelCodexLogin();
  const response = await fetchWithTimeout(
    `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    },
  );
  if (response.status === 404) {
    throw new Error(
      'Device-code sign-in is disabled. Enable it in your ChatGPT security settings and try again.',
    );
  }
  if (!response.ok) {
    throw await responseError(response, `Could not start ChatGPT sign-in (${response.status})`);
  }

  const body = (await response.json()) as DeviceCodeResponse;
  const deviceAuthId = body.device_auth_id;
  const userCode = body.user_code || body.usercode;
  const parsedInterval = Number(body.interval ?? 5);
  if (!deviceAuthId || !userCode) {
    throw new Error('OpenAI returned an invalid device sign-in response.');
  }

  const state: CodexLoginState = {
    id: crypto.randomUUID(),
    status: 'pending',
    userCode,
    verificationUrl: `${AUTH_BASE_URL}/codex/device`,
    startedAt: Date.now(),
    intervalSeconds:
      Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 5,
    deviceAuthId,
  };
  await setLoginState(state);
  scheduleLoginPoll(state.intervalSeconds);
  return state;
}

export async function cancelCodexLogin(): Promise<void> {
  await browser.alarms.clear(CODEX_LOGIN_ALARM);
  await browser.storage.session.remove(CODEX_LOGIN_STATE_STORAGE_KEY);
}

export async function signOutCodex(): Promise<void> {
  cachedCredentials = null;
  await cancelCodexLogin();
  await Promise.all([
    browser.storage.local.remove(CODEX_REFRESH_TOKEN_STORAGE_KEY),
    browser.storage.session.remove(CODEX_ACCESS_TOKEN_STORAGE_KEY),
  ]);
}

export async function pollCodexLogin(): Promise<void> {
  if (polling) return;
  polling = true;
  let loginId: string | null = null;
  try {
    const state = await getCodexLoginState();
    if (!state || state.status !== 'pending' || !state.deviceAuthId) return;
    loginId = state.id;
    if (Date.now() - state.startedAt >= LOGIN_TIMEOUT_MS) {
      await setLoginState({ ...state, status: 'error', error: 'ChatGPT sign-in timed out.' });
      return;
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${AUTH_BASE_URL}/api/accounts/deviceauth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: state.deviceAuthId,
            user_code: state.userCode,
          }),
        },
      );
    } catch {
      if (await isCurrentLogin(state.id)) scheduleLoginPoll(state.intervalSeconds);
      return;
    }

    if (response.status === 403 || response.status === 404) {
      if (await isCurrentLogin(state.id)) scheduleLoginPoll(state.intervalSeconds);
      return;
    }
    if (!response.ok) {
      throw await responseError(response, `ChatGPT sign-in failed (${response.status})`);
    }

    const code = (await response.json()) as DeviceTokenResponse;
    if (!code.authorization_code || !code.code_verifier) {
      throw new Error('OpenAI returned an invalid device authorization code.');
    }
    if (!(await isCurrentLogin(state.id))) return;
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: code.authorization_code,
      redirect_uri: DEVICE_CALLBACK_URL,
      client_id: CODEX_CLIENT_ID,
      code_verifier: code.code_verifier,
    });
    if (!tokens.refresh_token) throw new Error('OpenAI did not return a refresh token.');
    if (!(await isCurrentLogin(state.id))) return;
    await saveRefreshToken(tokens.refresh_token);
    if (tokens.access_token) {
      await cacheCredentials({
        accessToken: tokens.access_token,
        accountId: accountIdFromToken(tokens.access_token),
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      });
    }
    await browser.alarms.clear(CODEX_LOGIN_ALARM);
    await setLoginState({
      ...state,
      status: 'complete',
      deviceAuthId: undefined,
    });
  } catch (error) {
    const state = await getCodexLoginState();
    if (state?.status === 'pending' && state.id === loginId) {
      await setLoginState({
        ...state,
        status: 'error',
        deviceAuthId: undefined,
        error: messageFor(error),
      });
    }
  } finally {
    polling = false;
  }
}

export async function resumeCodexLogin(): Promise<void> {
  const state = await getCodexLoginState();
  if (state?.status === 'pending') scheduleLoginPoll(1);
}
