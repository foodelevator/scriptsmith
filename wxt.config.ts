import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  webExt: {
    binaries: {
      chrome: '/usr/bin/helium-browser',
    },
  },
  manifest: {
    name: 'scriptsmith',
    description:
      'Prompt a chatbot to create and retain changes for web pages.',
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; img-src 'none'; font-src 'none'; media-src 'none';",
    },
    permissions: [
      'scripting',
      'storage',
      'userScripts',
      'webNavigation',
    ],
    host_permissions: [
      'http://*/*',
      'https://*/*',
      // 'https://auth.openai.com/*',
      // 'https://chatgpt.com/*',
    ],
  },
});
