# Vibext

A browser extension for prompting a chatbot to make changes to web pages and retain those changes for the relevant page or site. Changes can include hiding an element or reading values from a page and inserting a derived value. The extension will also let the user select an element to refer to in a prompt.

This repository is the initial extension scaffold, built with WXT, Svelte, and TypeScript. It includes entrypoints for the browser toolbar popup, background process, and page content script. Chatbot integration and stored page changes are not implemented yet.

## Development

Install the project dependencies:

```sh
npm install
```

Start a Chromium development build in Helium:

```sh
npm run dev
```

Helium is configured at `/usr/bin/helium-browser` in `wxt.config.ts`.

Or start a Firefox development build:

```sh
npm run dev:firefox
```

Create a production build with `npm run build` or `npm run build:firefox`.
