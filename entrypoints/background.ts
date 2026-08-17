import {
  CODEX_LOGIN_MESSAGE,
  resumeCodexLogin,
  startCodexLogin,
} from '../utils/codex-auth';
import { syncRegisteredScripts } from '../utils/scripts';
import { startScriptCoordinator } from '../utils/coordinator';
import { startSidebarCoordinator } from '../utils/sidebar-coordinator';

export default defineBackground(() => {
  startScriptCoordinator();
  startSidebarCoordinator();
  const recoverCodexLogin = resumeCodexLogin();
  // Remove credentials saved by versions that used the separately billed API.
  void browser.storage.local.remove('openaiApiKey');

  const sync = () => {
    void browser.userScripts?.configureWorld?.({ messaging: true }).catch((error) => {
      console.warn('scriptsmith could not enable user-script messaging:', error);
    });
    void syncRegisteredScripts().catch((error) => {
      // Browsers can require the user to explicitly enable the User Scripts API.
      console.warn('scriptsmith could not synchronize page scripts:', error);
    });
  };

  browser.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as { type?: string };
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
  browser.runtime.onInstalled.addListener(sync);
  browser.runtime.onStartup.addListener(() => {
    sync();
  });
});
