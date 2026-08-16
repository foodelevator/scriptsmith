import {
  getCodexCredentials,
  invalidateCodexAccessToken,
  type CodexCredentials,
} from './codex-auth';

const USAGE_URLS = [
  'https://chatgpt.com/backend-api/wham/usage',
  'https://chatgpt.com/backend-api/codex/usage',
];
const REQUEST_TIMEOUT_MS = 15_000;

export interface CodexUsageWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: number | null;
}

export interface CodexUsage {
  planType: string | null;
  remainingPercent: number;
  limitingWindow: CodexUsageWindow;
  windows: CodexUsageWindow[];
}

interface UsageResponse {
  plan_type?: unknown;
  rate_limit?: unknown;
  credits?: unknown;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowLabel(seconds: number | null, fallback: string): string {
  if (seconds === 5 * 60 * 60) return '5-hour';
  if (seconds === 7 * 24 * 60 * 60) return 'Weekly';
  if (seconds === null || seconds <= 0) return fallback;
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)}-minute`;
  if (seconds < 24 * 60 * 60) return `${Math.round(seconds / 3600)}-hour`;
  return `${Math.round(seconds / 86400)}-day`;
}

function parseWindow(value: unknown, fallbackLabel: string): CodexUsageWindow | null {
  if (!value || typeof value !== 'object') return null;
  const window = value as Record<string, unknown>;
  const usedPercent = finiteNumber(window.used_percent ?? window.usedPercent);
  if (usedPercent === null) return null;

  const windowSeconds = finiteNumber(
    window.limit_window_seconds ?? window.window_seconds,
  );
  const resetAtSeconds = finiteNumber(window.reset_at);
  const resetAfterSeconds = finiteNumber(window.reset_after_seconds);
  const resetAt = resetAtSeconds !== null
    ? resetAtSeconds * 1000
    : resetAfterSeconds !== null
      ? Date.now() + resetAfterSeconds * 1000
      : null;
  const used = clampPercent(usedPercent);

  return {
    label: windowLabel(windowSeconds, fallbackLabel),
    usedPercent: used,
    remainingPercent: 100 - used,
    resetAt,
  };
}

function parseUsage(body: UsageResponse): CodexUsage {
  const rateLimit = body.rate_limit;
  const rate = rateLimit && typeof rateLimit === 'object'
    ? rateLimit as Record<string, unknown>
    : {};
  const windows = [
    parseWindow(rate.primary_window ?? rate.primary, 'Primary'),
    parseWindow(rate.secondary_window ?? rate.secondary, 'Secondary'),
  ].filter((window): window is CodexUsageWindow => window !== null);

  if (windows.length === 0) {
    const credits = body.credits;
    const unlimited = credits && typeof credits === 'object'
      ? (credits as Record<string, unknown>).unlimited === true
      : false;
    if (!unlimited) throw new Error('OpenAI did not return Codex usage limits.');

    const limitingWindow: CodexUsageWindow = {
      label: 'Unlimited',
      usedPercent: 0,
      remainingPercent: 100,
      resetAt: null,
    };
    return {
      planType: typeof body.plan_type === 'string' ? body.plan_type : null,
      remainingPercent: 100,
      limitingWindow,
      windows: [limitingWindow],
    };
  }

  const limitingWindow = windows.reduce((lowest, window) =>
    window.remainingPercent < lowest.remainingPercent ? window : lowest,
  );
  return {
    planType: typeof body.plan_type === 'string' ? body.plan_type : null,
    remainingPercent: limitingWindow.remainingPercent,
    limitingWindow,
    windows,
  };
}

async function fetchWithTimeout(
  url: string,
  credentials: CodexCredentials,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'chatgpt-account-id': credentials.accountId,
        'OpenAI-Beta': 'codex-1',
        originator: 'scriptsmith',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Codex usage request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCodexUsage(): Promise<CodexUsage> {
  for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
    const credentials = await getCodexCredentials(authAttempt > 0);
    let unauthorized = false;

    for (const url of USAGE_URLS) {
      const response = await fetchWithTimeout(url, credentials);
      if (response.status === 401 && authAttempt === 0) {
        unauthorized = true;
        invalidateCodexAccessToken();
        break;
      }
      if (response.status === 404) continue;
      if (!response.ok) {
        throw new Error(`Could not load Codex usage (${response.status}).`);
      }
      return parseUsage(await response.json() as UsageResponse);
    }

    if (!unauthorized) break;
  }

  throw new Error('Codex usage information is unavailable.');
}
