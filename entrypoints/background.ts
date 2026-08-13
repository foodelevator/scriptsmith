import { syncRegisteredScripts } from '../utils/scripts';

export default defineBackground(() => {
  const sync = () => {
    void syncRegisteredScripts().catch((error) => {
      // Browsers can require the user to explicitly enable the User Scripts API.
      console.warn('Vibext could not synchronize page scripts:', error);
    });
  };

  browser.runtime.onInstalled.addListener(sync);
  browser.runtime.onStartup.addListener(sync);
});
