export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Element selection will run in this context. Stored JavaScript is executed
    // separately through the browser's User Scripts API.
  },
});
