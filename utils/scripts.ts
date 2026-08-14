export interface PageScript {
  id: string;
  origin: string;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  createdAt: number;
}

export type PageScriptChanges = Partial<
  Pick<PageScript, 'name' | 'description' | 'code' | 'enabled'>
>;

const STORAGE_KEY = 'pageScripts';
const REGISTRATION_PREFIX = 'vibext-';

type StoredScripts = Record<string, PageScript[]>;

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
  const script = value as Partial<PageScript>;
  if (
    typeof script.id !== 'string' ||
    typeof script.origin !== 'string' ||
    typeof script.name !== 'string' ||
    typeof script.description !== 'string' ||
    typeof script.code !== 'string' ||
    (script.enabled !== undefined && typeof script.enabled !== 'boolean') ||
    typeof script.createdAt !== 'number'
  ) {
    return null;
  }

  // Scripts saved before per-script toggles were introduced remain enabled.
  return { ...script, enabled: script.enabled ?? true } as PageScript;
}

async function readAllScripts(): Promise<StoredScripts> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];

  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).map(([origin, scripts]) => [
      origin,
      Array.isArray(scripts)
        ? scripts
            .map(normalizePageScript)
            .filter((script): script is PageScript => script !== null)
        : [],
    ]),
  );
}

async function writeAllScripts(scripts: StoredScripts): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: scripts });
}

function registrationId(scriptId: string): string {
  return `${REGISTRATION_PREFIX}${scriptId}`;
}

function matchPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

function executableCode(script: PageScript): string {
  // Match patterns cannot distinguish ports, so retain an exact origin guard.
  return `if (location.origin === ${JSON.stringify(script.origin)}) {\n${script.code}\n}`;
}

function registrationFor(script: PageScript): Browser.userScripts.RegisteredUserScript {
  return {
    id: registrationId(script.id),
    matches: [matchPattern(script.origin)],
    js: [{ code: executableCode(script) }],
    runAt: 'document_idle',
  };
}

export function originFromUrl(url: string | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export async function getScriptsForOrigin(origin: string): Promise<PageScript[]> {
  const scripts = await readAllScripts();
  return scripts[origin] ?? [];
}

export async function getPageScript(
  origin: string,
  scriptId: string,
): Promise<PageScript | null> {
  const scripts = await getScriptsForOrigin(origin);
  return scripts.find((script) => script.id === scriptId) ?? null;
}

export async function addPageScript(
  input: Pick<PageScript, 'origin' | 'name' | 'description' | 'code'>,
): Promise<PageScript> {
  const script: PageScript = {
    ...input,
    id: crypto.randomUUID(),
    enabled: true,
    createdAt: Date.now(),
  };
  const api = getUserScriptsApi();

  // Registration also validates the JavaScript before it is persisted.
  await api.register([registrationFor(script)]);

  try {
    const stored = await readAllScripts();
    stored[script.origin] = [...(stored[script.origin] ?? []), script];
    await writeAllScripts(stored);
  } catch (error) {
    await api.unregister({ ids: [registrationId(script.id)] });
    throw error;
  }

  return script;
}

export async function updatePageScript(
  script: PageScript,
  changes: PageScriptChanges,
): Promise<PageScript> {
  const stored = await readAllScripts();
  const scriptsForOrigin = stored[script.origin] ?? [];
  const current = scriptsForOrigin.find((candidate) => candidate.id === script.id);
  if (!current) throw new Error('The script no longer exists.');

  // Merge into the stored version so a toggle made while the editor is open
  // is not accidentally overwritten by a later code or metadata edit.
  const updated: PageScript = { ...current, ...changes };
  const api = getUserScriptsApi();

  if (current.enabled && updated.enabled) {
    // Updating the registration validates changed JavaScript before it is saved.
    await api.update([registrationFor(updated)]);
  } else if (!current.enabled && updated.enabled) {
    await api.register([registrationFor(updated)]);
  } else if (current.enabled && !updated.enabled) {
    await api.unregister({ ids: [registrationId(current.id)] });
  }

  stored[current.origin] = scriptsForOrigin.map((candidate) =>
    candidate.id === current.id ? updated : candidate,
  );
  try {
    await writeAllScripts(stored);
  } catch (error) {
    if (current.enabled && updated.enabled) {
      await api.update([registrationFor(current)]);
    } else if (!current.enabled && updated.enabled) {
      await api.unregister({ ids: [registrationId(current.id)] });
    } else if (current.enabled && !updated.enabled) {
      await api.register([registrationFor(current)]);
    }
    throw error;
  }

  return updated;
}

export async function setPageScriptEnabled(
  script: PageScript,
  enabled: boolean,
): Promise<PageScript> {
  return updatePageScript(script, { enabled });
}

export async function runPageScriptNow(
  script: PageScript,
  tabId: number,
): Promise<string | null> {
  const current = await getPageScript(script.origin, script.id);
  if (!current) throw new Error('The script no longer exists.');
  if (!current.enabled) throw new Error('Enable this script before running it.');

  const api = getUserScriptsApi();

  // execute() is newer than register(); older browsers will run it on reload.
  if (typeof api.execute !== 'function') return null;

  const results = await api.execute({
    js: [{ code: executableCode(current) }],
    target: { tabId },
  });
  const failed = results.find((result) => 'error' in result && result.error);
  if (failed && 'error' in failed) throw new Error(failed.error);
  return 'ran';
}

export async function removePageScript(script: PageScript): Promise<void> {
  const api = getUserScriptsApi();
  if (script.enabled) {
    await api.unregister({ ids: [registrationId(script.id)] });
  }

  const stored = await readAllScripts();
  const remaining = (stored[script.origin] ?? []).filter(
    (candidate) => candidate.id !== script.id,
  );

  if (remaining.length > 0) stored[script.origin] = remaining;
  else delete stored[script.origin];

  await writeAllScripts(stored);
}

export async function syncRegisteredScripts(): Promise<void> {
  const api = getUserScriptsApi();
  const stored = await readAllScripts();
  const expected = Object.values(stored).flat().filter((script) => script.enabled);
  const expectedIds = new Set(expected.map((script) => registrationId(script.id)));
  const registered = await api.getScripts();
  const registeredIds = new Set(registered.map((script) => script.id));
  const staleIds = registered
    .map((script) => script.id)
    .filter((id) => id.startsWith(REGISTRATION_PREFIX) && !expectedIds.has(id));
  const missing = expected.filter(
    (script) => !registeredIds.has(registrationId(script.id)),
  );

  if (staleIds.length > 0) await api.unregister({ ids: staleIds });
  if (missing.length > 0) await api.register(missing.map(registrationFor));
}
