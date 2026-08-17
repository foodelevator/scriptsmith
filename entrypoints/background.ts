import {
  CODEX_LOGIN_MESSAGE,
  resumeCodexLogin,
  startCodexLogin,
} from '../utils/codex-auth';
import { syncRegisteredScripts } from '../utils/scripts';
import { startScriptCoordinator } from '../utils/coordinator';
import { startSidebarCoordinator } from '../utils/sidebar-coordinator';
import {
  USER_SCRIPTS_SYNC_MESSAGE,
  isUserScriptsAvailable,
  userScriptsApi,
} from '../utils/user-scripts';

export default defineBackground(() => {
  startScriptCoordinator();
  startSidebarCoordinator();
  const recoverCodexLogin = resumeCodexLogin();
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

  browser.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as { type?: string };
    if (message.type === USER_SCRIPTS_SYNC_MESSAGE) {
      return sync()
        .then(() => ({ ok: true }))
        .catch((caught: unknown) => ({
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
    }
    if (message.type !== CODEX_LOGIN_MESSAGE) return undefined;
    // Keeping this response open also keeps the MV3 service worker alive while
    // the authentication tab is open.
    return recoverCodexLogin
      .then(() => startCodexLogin())
      .then(() => ({ ok: true }))
      .catch((caught: unknown) => ({
        ok: false,
        error: caught instanceof Error ? caught.message : String(caught),
      }));
  });
  browser.permissions?.onAdded?.addListener(syncQuietly);
  browser.runtime.onInstalled.addListener(syncQuietly);
  browser.runtime.onStartup.addListener(syncQuietly);
});
