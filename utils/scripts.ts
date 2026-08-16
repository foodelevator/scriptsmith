import { scriptRuntimeCode } from './script-runtime';

export interface PageScript {
  id: string;
  origins: string[];
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  createdAt: number;
}

export type PageScriptChanges = Partial<
  Pick<PageScript, 'origins' | 'name' | 'description' | 'code' | 'enabled'>
>;

const STORAGE_KEY = 'pageScripts';
const REGISTRATION_PREFIX = 'vibext-';

type StoredScripts = Record<string, PageScript>;
type UserScriptsApi = typeof browser.userScripts;

function getUserScriptsApi(): UserScriptsApi {
  const api = browser.userScripts;
  if (!api) {
    throw new Error(
      'The User Scripts API is unavailable. Enable “Allow User Scripts” for Vibext in your browser’s extension settings.',
    );
  }
  return api;
}

function normalizePageScript(value: unknown): PageScript | null {
  if (!value || typeof value !== 'object') return null;
  const legacy = value as Partial<PageScript> & { origin?: unknown };
  const origins = Array.isArray(legacy.origins)
    ? legacy.origins.filter((origin): origin is string => typeof origin === 'string')
    : typeof legacy.origin === 'string'
      ? [legacy.origin]
      : [];
  if (
    typeof legacy.id !== 'string' ||
    origins.length === 0 ||
    typeof legacy.name !== 'string' ||
    typeof legacy.description !== 'string' ||
    typeof legacy.code !== 'string' ||
    (legacy.enabled !== undefined && typeof legacy.enabled !== 'boolean') ||
    typeof legacy.createdAt !== 'number'
  ) return null;

  return {
    id: legacy.id,
    origins: [...new Set(origins)],
    name: legacy.name,
    description: legacy.description,
    code: legacy.code,
    enabled: legacy.enabled ?? true,
    createdAt: legacy.createdAt,
  };
}

export async function readAllScripts(): Promise<StoredScripts> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  const entries = Object.entries(stored as Record<string, unknown>);
  const legacyShape = entries.some(([, value]) => Array.isArray(value));
  const normalized: StoredScripts = {};
  for (const [, value] of entries) {
    const values = Array.isArray(value) ? value : [value];
    for (const candidate of values) {
      const script = normalizePageScript(candidate);
      if (script) normalized[script.id] = script;
    }
  }
  if (legacyShape) await writeAllScripts(normalized);
  return normalized;
}

async function writeAllScripts(scripts: StoredScripts): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: scripts });
}

function registrationId(scriptId: string): string {
  return `${REGISTRATION_PREFIX}${scriptId}`;
}

export function matchPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

function executableCode(script: PageScript): string {
  const origins = JSON.stringify(script.origins);
  return `if (${origins}.includes(location.origin)) {\nconst vibext = ${scriptRuntimeCode(script.id)};\n${script.code}\n}`;
}

function registrationFor(script: PageScript): Browser.userScripts.RegisteredUserScript {
  return {
    id: registrationId(script.id),
    matches: script.origins.map(matchPattern),
    js: [{ code: executableCode(script) }],
    allFrames: true,
    runAt: 'document_idle',
  };
}

export function originFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch { return null; }
}

export async function getAllPageScripts(): Promise<PageScript[]> {
  return Object.values(await readAllScripts());
}

export async function getScriptsForOrigin(origin: string): Promise<PageScript[]> {
  return (await getAllPageScripts()).filter((script) => script.origins.includes(origin));
}

export async function getPageScript(scriptId: string): Promise<PageScript | null> {
  return (await readAllScripts())[scriptId] ?? null;
}

export async function addPageScript(
  input: Pick<PageScript, 'origins' | 'name' | 'description' | 'code'>,
): Promise<PageScript> {
  if (input.origins.length === 0) throw new Error('A script must have at least one origin.');
  const script: PageScript = {
    ...input,
    origins: [...new Set(input.origins)],
    id: crypto.randomUUID(), enabled: true, createdAt: Date.now(),
  };
  const api = getUserScriptsApi();
  await api.register([registrationFor(script)]);
  try {
    const stored = await readAllScripts();
    stored[script.id] = script;
    await writeAllScripts(stored);
  } catch (error) {
    await api.unregister({ ids: [registrationId(script.id)] });
    throw error;
  }
  return script;
}

export async function updatePageScript(script: PageScript, changes: PageScriptChanges): Promise<PageScript> {
  const stored = await readAllScripts();
  const current = stored[script.id];
  if (!current) throw new Error('The script no longer exists.');
  const updated: PageScript = { ...current, ...changes };
  updated.origins = [...new Set(updated.origins)];
  if (updated.origins.length === 0) throw new Error('A script must have at least one origin.');
  const api = getUserScriptsApi();
  if (current.enabled && updated.enabled) await api.update([registrationFor(updated)]);
  else if (!current.enabled && updated.enabled) await api.register([registrationFor(updated)]);
  else if (current.enabled && !updated.enabled) await api.unregister({ ids: [registrationId(current.id)] });

  stored[current.id] = updated;
  try { await writeAllScripts(stored); }
  catch (error) {
    if (current.enabled && updated.enabled) await api.update([registrationFor(current)]);
    else if (!current.enabled && updated.enabled) await api.unregister({ ids: [registrationId(current.id)] });
    else if (current.enabled && !updated.enabled) await api.register([registrationFor(current)]);
    throw error;
  }
  return updated;
}

export function addOriginToScript(script: PageScript, origin: string): Promise<PageScript> {
  return updatePageScript(script, { origins: [...new Set([...script.origins, origin])] });
}

export function removeOriginFromScript(script: PageScript, origin: string): Promise<PageScript> {
  if (!script.origins.includes(origin)) throw new Error('That origin is not part of the script.');
  if (script.origins.length === 1) throw new Error('A script must keep at least one origin.');
  return updatePageScript(script, { origins: script.origins.filter((item) => item !== origin) });
}

export function setPageScriptEnabled(script: PageScript, enabled: boolean): Promise<PageScript> {
  return updatePageScript(script, { enabled });
}

export async function matchingTabsInWindow(
  script: PageScript,
  windowId: number,
): Promise<Browser.tabs.Tab[]> {
  const tabs = await browser.tabs.query({ windowId });
  return tabs.filter((tab) => {
    const origin = originFromUrl(tab.url);
    return origin !== null && script.origins.includes(origin);
  });
}

export async function runPageScriptNow(
  script: PageScript,
  windowId: number,
): Promise<number | null> {
  const current = await getPageScript(script.id);
  if (!current) throw new Error('The script no longer exists.');
  if (!current.enabled) throw new Error('Enable this script before running it.');
  const api = getUserScriptsApi();
  if (typeof api.execute !== 'function') return null;
  const tabs = await matchingTabsInWindow(current, windowId);
  const tabIds = tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
  let count = 0;
  for (const targetTabId of tabIds) {
    const results = await api.execute({
      js: [{ code: executableCode(current) }],
      target: { tabId: targetTabId, allFrames: true },
    });
    const failed = results.find((result) => 'error' in result && result.error);
    if (failed && 'error' in failed) throw new Error(failed.error);
    count += 1;
  }
  return count;
}

export async function removePageScript(script: PageScript): Promise<void> {
  const api = getUserScriptsApi();
  if (script.enabled) await api.unregister({ ids: [registrationId(script.id)] });
  const stored = await readAllScripts();
  delete stored[script.id];
  await writeAllScripts(stored);
}

export async function syncRegisteredScripts(): Promise<void> {
  const api = getUserScriptsApi();
  const expected = (await getAllPageScripts()).filter((script) => script.enabled);
  const expectedIds = new Set(expected.map((script) => registrationId(script.id)));
  const registered = await api.getScripts();
  const registeredIds = new Set(registered.map((script) => script.id));
  const staleIds = registered.map((script) => script.id)
    .filter((id) => id.startsWith(REGISTRATION_PREFIX) && !expectedIds.has(id));
  const missing = expected.filter((script) => !registeredIds.has(registrationId(script.id)));
  const existing = expected.filter((script) => registeredIds.has(registrationId(script.id)));
  if (staleIds.length > 0) await api.unregister({ ids: staleIds });
  if (existing.length > 0) await api.update(existing.map(registrationFor));
  if (missing.length > 0) await api.register(missing.map(registrationFor));
}
