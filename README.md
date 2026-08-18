# scriptsmith

A browser extension for prompting a chatbot to make changes to web pages and retain those changes for the relevant page or site. Changes can include hiding an element or reading values from a page and inserting a derived value. The element picker beside the chat box lets the user select a highlighted page element and attach its precise CSS selector and HTML snapshot to the next prompt.

The extension is built with WXT, Svelte, and TypeScript. Scripts can target one or more origins and run at `document_idle` whenever a matching page loads. The popup lists scripts for the current site, while **Manage all scripts** opens a full-page list of every saved script and its target sites. Each script has one global on/off state; disabled scripts remain saved and editable but do not run. Use **Add script** or **Edit script** from a matching site to open a tab-scoped sidebar. Editors opened for the same script in one window share their conversation, draft, and live agent state. The OpenAI-powered agent can edit the script, its name, and its description over multiple turns. It cannot widen a script's reach on its own: when it wants the script to cover another site, it has to ask, and the sidebar shows the exact origin and what allowing it means. Until you allow it, the script does not run there and the agent cannot inspect your open tabs on that site. After code changes, the sidebar offers **Run now** for immediate execution or **Reload pages** for a clean application across matching tabs. Chat history lasts only for the current sidebar session.

A ChatGPT account with Codex access is required. Use **Sign in** in the popup and complete OpenAI's browser authorization flow. The extension uses OAuth authorization code flow with PKCE and captures Codex's localhost callback from the sign-in tab. The Codex refresh token is stored in extension-local browser storage and used only to obtain access tokens for Codex requests. The agent currently uses `gpt-5.6-sol` through the user's Codex subscription.

## Before your first script

scriptsmith runs its scripts through the browser's User Scripts API, which browsers keep switched off until you allow it. Until then the popup and the manager page show a setup card in place of the usual actions, with a button that takes you to the right page and a **Check again** button to confirm once you are done.

On Chromium, open the extension's details page (the card's **Open extension settings** button goes straight there, or paste `chrome://extensions/?id=<extension id>` into the address bar), then switch on **Allow User Scripts**. Chrome 138 or later is required for that switch.

On Firefox, the card's **Allow scriptsmith to run scripts** button raises Firefox's own permission prompt. If you dismiss it, open `about:addons`, click **scriptsmith**, open the **Permissions** tab, and switch on **Run user scripts**. Firefox 136 or later is required.

Saved scripts survive the switch being turned off — they simply stop running, and scriptsmith registers them again as soon as it is allowed back in.

## Importing and exporting scripts

Open **Manage all scripts** from the popup to import, export, enable, disable, or remove scripts across every site. Use **Export** beside a script to download it as a portable `.scriptsmith.json` file. **Import script** selects and imports one of these files without leaving the manager page. Imported scripts keep the origins declared in the file and are enabled immediately.

Runtime changes cannot update code that has already run in an open page. After enabling, disabling, importing, or removing scripts, use **Reload affected tabs** to apply the new state to matching open tabs. Removing a script requires confirmation in both the popup and the full-page manager.

The version 1 file format is JSON:

```json
{
  "scriptsmith": { "version": 1 },
  "name": "Example script",
  "description": "What the script does",
  "origins": ["https://example.com"],
  "code": "console.log('Hello');"
}
```

The file contains only portable script data. scriptsmith creates a new internal ID and timestamp when importing; enabled state is not exported.

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

The Firefox scripts pass `--mv3`. Manifest V3 is required there because Firefox only exposes the User Scripts API used here under MV3, and only as an optional permission the extension requests at runtime.

Create a production build with `npm run build` or `npm run build:firefox`.

## Chrome Web Store review material

- [Reviewer instructions](docs/chrome-web-store-review.md)
- [Arbitrary JavaScript source-to-execution analysis](docs/user-script-execution.md)
- [Draft remote-code declaration](docs/remote-code-declaration.md)
