# Vibext

A browser extension for prompting a chatbot to make changes to web pages and retain those changes for the relevant page or site. Changes can include hiding an element or reading values from a page and inserting a derived value. The element picker beside the chat box lets the user select a highlighted page element and attach its precise CSS selector and HTML snapshot to the next prompt.

The extension is built with WXT, Svelte, and TypeScript. Scripts can target one or more origins and run at `document_idle` whenever a matching page loads. The popup lists scripts for the current site, while **Manage all scripts** opens a full-page list of every saved script and its target sites. Each script has one global on/off state; disabled scripts remain saved and editable but do not run. Use **Add script** or **Edit script** from a matching site to open a tab-scoped sidebar. Editors opened for the same script in one window share their conversation, draft, and live agent state. The OpenAI-powered agent can edit the script, its name, and its description over multiple turns. After code changes, the sidebar offers **Run now** for immediate execution or **Reload pages** for a clean application across matching tabs. Chat history lasts only for the current sidebar session.

A ChatGPT account with Codex access is required. Use **Sign in** in the popup and complete OpenAI's device-code flow. The Codex refresh token is stored in extension-local browser storage and used only to obtain access tokens for Codex requests. The agent currently uses `gpt-5.6-sol` through the user's Codex subscription.

Vibext uses the browser's User Scripts API. Chromium users may need to enable **Allow User Scripts** for Vibext on the extension's details page (or enable extension developer mode on older Chromium versions).

## Importing and exporting scripts

Open **Manage all scripts** from the popup to import, export, enable, disable, or remove scripts across every site. Use **Export** beside a script to download it as a portable `.vibext.json` file. **Import script** selects and imports one of these files without leaving the manager page. Imported scripts keep the origins declared in the file and are enabled immediately.

Runtime changes cannot update code that has already run in an open page. After enabling, disabling, importing, or removing scripts, use **Reload affected tabs** to apply the new state to matching open tabs. Removing a script requires confirmation in both the popup and the full-page manager.

The version 1 file format is JSON:

```json
{
  "vibext": { "version": 1 },
  "name": "Example script",
  "description": "What the script does",
  "origins": ["https://example.com"],
  "code": "console.log('Hello');"
}
```

The file contains only portable script data. Vibext creates a new internal ID and timestamp when importing; enabled state is not exported.

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
