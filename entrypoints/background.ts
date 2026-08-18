import {
  CODEX_LOGIN_MESSAGE,
  CODEX_SIGN_OUT_MESSAGE,
  initializeCodexAuth,
  isTrustedExtensionSender,
  resumeCodexLogin,
  signOutCodex,
  startCodexLogin,
} from '../utils/codex-auth';
import {
  CODEX_USAGE_MESSAGE,
  getCodexUsage,
} from '../utils/codex-usage';
import {
  CODEX_REVIEW_CANCEL_MESSAGE,
  CODEX_REVIEW_MESSAGE,
  reviewScriptFile,
} from '../utils/script-review';
import type { PageScriptInput } from '../utils/scripts';
import { syncRegisteredScripts } from '../utils/scripts';
import { startScriptCoordinator } from '../utils/coordinator';
import {
  abortSidebarCodexRequests,
  startSidebarCoordinator,
} from '../utils/sidebar-coordinator';
import {
  USER_SCRIPTS_SYNC_MESSAGE,
  isUserScriptsAvailable,
  userScriptsApi,
} from '../utils/user-scripts';

export default defineBackground(() => {
  const initializeAuth = initializeCodexAuth();
  const recoverCodexLogin = initializeAuth.then(() => resumeCodexLogin());
  void recoverCodexLogin.catch((error: unknown) => {
    console.error('scriptsmith could not initialize protected authentication:', error);
  });
  const reviewControllers = new Map<string, AbortController>();
  startScriptCoordinator();
  startSidebarCoordinator();
  // Remove credentials saved by versions that used the separately billed API.
  void browser.storage.local.remove('openaiApiKey');

  // Browsers can require the user to explicitly allow the User Scripts API, so
  // nothing here may assume browser.userScripts is reachable.
  const sync = async (): Promise<void> => {
    if (!isUserScriptsAvailable()) return;
    await userScriptsApi().configureWorld?.({ messaging: true })
      .catch((error: unknown) => {
        console.warn('scriptsmith could not enable user-script messaging:', error);
      });
    await syncRegisteredScripts();
  };

  const syncQuietly = () => {
    void sync().catch((error: unknown) => {
      console.warn('scriptsmith could not synchronize page scripts:', error);
    });
  };

  browser.runtime.onMessage.addListener((raw: unknown, sender) => {
    const message = raw as {
      type?: string;
      requestId?: unknown;
      input?: unknown;
    };
    if (message.type === USER_SCRIPTS_SYNC_MESSAGE) {
      return sync()
        .then(() => ({ ok: true }))
        .catch((caught: unknown) => ({
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
    }

    const isCodexMessage = [
      CODEX_LOGIN_MESSAGE,
      CODEX_SIGN_OUT_MESSAGE,
      CODEX_USAGE_MESSAGE,
      CODEX_REVIEW_MESSAGE,
      CODEX_REVIEW_CANCEL_MESSAGE,
    ].includes(message.type ?? '');
    if (!isCodexMessage) return undefined;
    if (!isTrustedExtensionSender(sender)) {
      return Promise.resolve({ ok: false, error: 'This request is not allowed.' });
    }

    if (message.type === CODEX_LOGIN_MESSAGE) {
      // Keeping this response open also keeps the MV3 service worker alive
      // while the authentication tab is open.
      return recoverCodexLogin
        .then(() => startCodexLogin())
        .then(() => ({ ok: true }))
        .catch((caught: unknown) => ({
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
    }
    if (message.type === CODEX_SIGN_OUT_MESSAGE) {
      abortSidebarCodexRequests();
      for (const controller of reviewControllers.values()) controller.abort();
      return initializeAuth
        .then(() => signOutCodex())
        .then(({ revoked }) => ({ ok: true, revoked }))
        .catch((caught: unknown) => ({
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
    }
    if (message.type === CODEX_USAGE_MESSAGE) {
      return initializeAuth
        .then(() => getCodexUsage())
        .then((usage) => ({ ok: true, usage }))
        .catch((caught: unknown) => ({
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
    }
    if (message.type === CODEX_REVIEW_CANCEL_MESSAGE) {
      if (typeof message.requestId === 'string') {
        reviewControllers.get(message.requestId)?.abort();
      }
      return Promise.resolve({ ok: true });
    }
    if (
      message.type !== CODEX_REVIEW_MESSAGE
      || typeof message.requestId !== 'string'
      || !message.input
      || typeof message.input !== 'object'
    ) {
      return Promise.resolve({ ok: false, error: 'Invalid review request.' });
    }

    const requestId = message.requestId;
    const controller = new AbortController();
    reviewControllers.set(requestId, controller);
    return initializeAuth
      .then(() => reviewScriptFile(message.input as PageScriptInput, controller.signal))
      .then((review) => ({ ok: true, review }))
      .catch((caught: unknown) => ({
        ok: false,
        error: caught instanceof Error ? caught.message : String(caught),
      }))
      .finally(() => {
        if (reviewControllers.get(requestId) === controller) {
          reviewControllers.delete(requestId);
        }
      });
  });
  browser.permissions?.onAdded?.addListener(syncQuietly);
  browser.runtime.onInstalled.addListener(syncQuietly);
  browser.runtime.onStartup.addListener(syncQuietly);
});
