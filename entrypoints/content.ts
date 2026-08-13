export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Element selection and stored page changes will run in this context.
  },
});
