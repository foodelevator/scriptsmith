import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  webExt: {
    binaries: {
      chrome: '/usr/bin/helium-browser',
    },
  },
  manifest: {
    name: 'Vibext',
    description:
      'Prompt a chatbot to create and retain changes for web pages.',
    permissions: ['activeTab', 'storage', 'userScripts'],
    host_permissions: ['https://api.openai.com/*'],
  },
});
