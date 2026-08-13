# Vibext

A browser extension for prompting a chatbot to make changes to web pages and retain those changes for the relevant page or site. Changes can include hiding an element or reading values from a page and inserting a derived value. The extension will also let the user select an element to refer to in a prompt.

The extension is built with WXT, Svelte, and TypeScript. Chatbot integration is not implemented yet; for now, text entered in the popup is treated directly as JavaScript. Scripts are stored per origin, listed in the popup, and run at `document_idle` whenever a matching page loads. A newly added script is also run immediately when the browser supports it.

Vibext uses the browser's User Scripts API. Chromium users may need to enable **Allow User Scripts** for Vibext on the extension's details page (or enable extension developer mode on older Chromium versions).

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
