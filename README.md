# Vibext

A browser extension for prompting a chatbot to make changes to web pages and retain those changes for the relevant page or site. Changes can include hiding an element or reading values from a page and inserting a derived value. The extension will also let the user select an element to refer to in a prompt.

The extension is built with WXT, Svelte, and TypeScript. Scripts are stored per origin, listed in the popup, and run at `document_idle` whenever a matching page loads. Use **Add script** or **Edit script** to open the sidebar and chat with an OpenAI-powered agent that can edit the script, its name, and its description over multiple turns. Chat history lasts only for the current sidebar session.

An OpenAI API key is required. Enter it in the popup's **OpenAI API key** setting; it is stored in extension-local browser storage and sent only to OpenAI for chat requests. The agent currently uses `gpt-5.6-sol`.

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
