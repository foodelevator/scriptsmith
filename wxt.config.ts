import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  webExt: {
    binaries: {
      chrome: '/usr/bin/helium-browser',
    },
  },
  manifest: ({ browser }) => {
    // Firefox treats userScripts as an optional permission the user grants from
    // inside the extension; Chromium ships it as a switch on the details page.
    const firefox = browser === 'firefox';
    return {
      name: 'scriptsmith',
      description:
        'Prompt a chatbot to create and retain changes for web pages.',
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self'; img-src 'none'; font-src 'none'; media-src 'none';",
      },
      permissions: [
        'scripting',
        'storage',
        'webNavigation',
        ...(firefox ? [] : ['userScripts']),
      ],
      ...(firefox ? { optional_permissions: ['userScripts'] } : {}),
      host_permissions: [
        'http://*/*',
        'https://*/*',
        // 'https://auth.openai.com/*',
        // 'https://chatgpt.com/*',
      ],
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'scriptsmith@magnusson.space',
                // The MV3 User Scripts API landed in Firefox 136.
                strict_min_version: '136.0',
              },
            },
          }
        : {}),
    };
  },
});
