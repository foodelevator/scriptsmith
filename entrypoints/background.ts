import {
  CODEX_LOGIN_ALARM,
  pollCodexLogin,
  resumeCodexLogin,
} from '../utils/codex-auth';
import { syncRegisteredScripts } from '../utils/scripts';
import { startScriptCoordinator } from '../utils/coordinator';
import { startSidebarCoordinator } from '../utils/sidebar-coordinator';

export default defineBackground(() => {
  startScriptCoordinator();
  startSidebarCoordinator();
  // Remove credentials saved by versions that used the separately billed API.
  void browser.storage.local.remove('openaiApiKey');

  const sync = () => {
    void browser.userScripts?.configureWorld?.({ messaging: true }).catch((error) => {
      console.warn('Vibext could not enable user-script messaging:', error);
    });
    void syncRegisteredScripts().catch((error) => {
      // Browsers can require the user to explicitly enable the User Scripts API.
      console.warn('Vibext could not synchronize page scripts:', error);
    });
  };

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CODEX_LOGIN_ALARM) void pollCodexLogin();
  });
  browser.runtime.onInstalled.addListener(sync);
  browser.runtime.onStartup.addListener(() => {
    sync();
    void resumeCodexLogin();
  });
  void resumeCodexLogin();
});
