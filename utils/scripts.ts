import { scriptRuntimeCode } from './script-runtime';
import {
  isUserScriptsAvailable,
  userScriptsApi as getUserScriptsApi,
} from './user-scripts';

export interface PageScript {
  id: string;
  origins: string[];
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  createdAt: number;
}

export const SCRIPT_FILE_VERSION = 1;

export interface ScriptFileV1 {
  scriptsmith: {
    version: typeof SCRIPT_FILE_VERSION;
  };
  name: string;
  description: string;
  origins: string[];
  code: string;
}

export type PageScriptChanges = Partial<
  Pick<PageScript, 'origins' | 'name' | 'description' | 'code' | 'enabled'>
>;

export type PageScriptInput = Pick<PageScript, 'origins' | 'name' | 'description' | 'code'>;

const STORAGE_KEY = 'pageScripts';
const REGISTRATION_PREFIX = 'scriptsmith-';

type StoredScripts = Record<string, PageScript>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function importedOrigin(value: unknown, index: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Origin ${index + 1} must be a string.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Origin ${index + 1} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Origin ${index + 1} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Origin ${index + 1} must be a site origin without a path, query, or fragment.`);
  }
  return url.origin;
}

export function parseScriptFile(source: string): PageScriptInput {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  if (!isRecord(value) || !isRecord(value.scriptsmith)) {
    throw new Error('The selected file is not a scriptsmith script file.');
  }
  if (value.scriptsmith.version !== SCRIPT_FILE_VERSION) {
    const version = value.scriptsmith.version;
    throw new Error(
      typeof version === 'number'
        ? `scriptsmith script file version ${version} is not supported.`
        : 'The scriptsmith script file version is missing or invalid.',
    );
  }
  if (typeof value.name !== 'string') throw new Error('The script name must be a string.');
  if (typeof value.description !== 'string') {
    throw new Error('The script description must be a string.');
  }
  if (typeof value.code !== 'string') throw new Error('The script code must be a string.');
  if (!Array.isArray(value.origins) || value.origins.length === 0) {
    throw new Error('The script must include at least one origin.');
  }

  return {
    name: value.name,
    description: value.description,
    code: value.code,
    origins: [...new Set(value.origins.map(importedOrigin))],
  };
}

export function serializeScriptFile(script: PageScript): string {
  const payload: ScriptFileV1 = {
    scriptsmith: { version: SCRIPT_FILE_VERSION },
    name: script.name,
    description: script.description,
    origins: script.origins,
    code: script.code,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function scriptFilename(name: string): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'script';
  return `${stem}.scriptsmith.json`;
}

export function downloadScriptFile(script: PageScript): void {
  const blob = new Blob([serializeScriptFile(script)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = scriptFilename(script.name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
  return `if (${origins}.includes(location.origin)) {\nconst scriptsmith = ${scriptRuntimeCode(script.id)};\n${script.code}\n}`;
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
  input: PageScriptInput,
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
  return matchingTabsForOrigins(script.origins, windowId);
}

export async function matchingTabsForOrigins(
  origins: string[],
  windowId?: number,
): Promise<Browser.tabs.Tab[]> {
  const tabs = await browser.tabs.query(windowId === undefined ? {} : { windowId });
  const targets = new Set(origins);
  return tabs.filter((tab) => {
    const origin = originFromUrl(tab.url);
    return origin !== null && targets.has(origin);
  });
}

export interface ReloadTabsForOriginsResult {
  matched: number;
  reloaded: number;
  failedOrigins: string[];
}

export async function reloadTabsForOrigins(
  origins: string[],
): Promise<ReloadTabsForOriginsResult> {
  const tabs = await matchingTabsForOrigins(origins);
  const reloadable = tabs.flatMap((tab) => tab.id === undefined ? [] : [{ id: tab.id, url: tab.url }]);
  const results = await Promise.allSettled(
    reloadable.map(({ id }) => browser.tabs.reload(id)),
  );
  const failedOrigins = new Set<string>();
  let reloaded = 0;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      reloaded += 1;
      return;
    }
    const origin = originFromUrl(reloadable[index]?.url);
    if (origin) failedOrigins.add(origin);
  });
  return {
    matched: reloadable.length,
    reloaded,
    failedOrigins: [...failedOrigins],
  };
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
  // Nothing is registered while the API is unavailable, so there is nothing to
  // unregister and removal only has to touch storage.
  if (script.enabled && isUserScriptsAvailable()) {
    await getUserScriptsApi().unregister({ ids: [registrationId(script.id)] });
  }
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
    .filter((id) => !expectedIds.has(id));
  const missing = expected.filter((script) => !registeredIds.has(registrationId(script.id)));
  const existing = expected.filter((script) => registeredIds.has(registrationId(script.id)));
  if (staleIds.length > 0) await api.unregister({ ids: staleIds });
  if (existing.length > 0) await api.update(existing.map(registrationFor));
  if (missing.length > 0) await api.register(missing.map(registrationFor));
}
