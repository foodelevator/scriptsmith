# User-script execution boundary

Reviewer-facing summary verified against commit `4ad624511f41c56fb9b8347b2d88b77097cb9249`, package version `0.0.0`, on 2026-08-18.

## Policy boundary

scriptsmith handles JavaScript from three places: a user-selected `.scriptsmith.json` file, OpenAI-generated saved customizations, and OpenAI-generated live diagnostics. AI-generated text originates remotely even though the user requests and controls the editing session.

All such code is executed only through Chrome's documented [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts) API. It is never passed to `eval`, `Function`, a remote `<script>`, or `chrome.scripting.executeScript`. The [Manifest V3 exception](https://developer.chrome.com/docs/webstore/program-policies/policies#additional_requirements_for_manifest_v3) is claimed only for code covered by the User Scripts API; all other extension behavior is packaged and reviewable. Whether remotely AI-generated code is aligned with the API's intended purpose remains a Chrome Web Store review decision, not a claim of advance approval.

## Source-to-execution flow

1. **Imported scripts:** [`parseScriptFile()`](../utils/scripts.ts) validates the file and normalizes its HTTP(S) origins. [`entrypoints/scripts/App.svelte`](../entrypoints/scripts/App.svelte) shows every origin, the risks, and the full source; import proceeds only after **I trust this script — add it**. `addPageScript()` registers the script, then stores its `code` and other `PageScript` fields under `pageScripts` in `browser.storage.local` (registration is rolled back if storage fails).
2. **AI-generated saved scripts:** clicking **Add script** approves the active tab's exact origin and creates an empty record. OpenAI's `edit_script` tool updates `PageScript.code` through `updatePageScript()`, which updates the User Scripts registration and local record. An `add_origin` tool call pauses for explicit approval of the displayed exact origin; without approval, neither execution nor inspection is allowed there.
3. **Live diagnostics:** OpenAI's `evaluate_script` tool supplies code plus an explicit tab and frame. [`resolveEvaluationTarget()`](../utils/ai.ts) requires that the tab belongs to the editing window, the frame still exists, and its current exact HTTP(S) origin is already approved. `evaluateScript()` then calls `userScripts.execute()` for only that tab and frame. Diagnostic source is not saved automatically.

`registrationFor()` wraps saved code with a second `location.origin` allowlist check and produces a `RegisteredUserScript` using `allFrames: true` and `document_idle`. No world is specified, so Chrome uses the default isolated `USER_SCRIPT` world. **Run now** uses the same wrapper with `userScripts.execute()`.

Disabling or removing a script unregisters it. On startup, installation/update, and restored User Scripts access, `syncRegisteredScripts()` removes stale registrations and updates or recreates enabled records. User-script code cannot request extension permissions or change its own stored origins.

## User-script messaging

The background enables `configureWorld({ messaging: true })`. The only receiver is `runtime.onUserScriptConnect` in [`utils/coordinator.ts`](../utils/coordinator.ts):

- accepts ports named `scriptsmith-script:<nonempty id>` with a browser-provided sender tab ID;
- accepts only `hello` and `publish` messages containing string `origin`, string `url`, and a non-array object `values`;
- keeps those values in service-worker memory and sends same-script ports `peers` arrays containing `{ tabId, origin, url, values, self }`;
- removes data on disconnect.

The receiver does not execute or persist message data, contact OpenAI, change registrations, or expose other privileged operations. Reported `origin`, `url`, and `values` remain untrusted user-script data.

## Execution-sink inventory

| Sink | Location and input |
| --- | --- |
| `userScripts.register()` | `addPageScript()`, enabling, and registration repair in [`utils/scripts.ts`](../utils/scripts.ts); wrapped imported/AI-generated saved code |
| `userScripts.update()` | saved edits and registration repair in `utils/scripts.ts`; wrapped saved code |
| `userScripts.execute()` | `runPageScriptNow()` in `utils/scripts.ts`; wrapped saved code |
| `userScripts.execute()` | `evaluateScript()` in [`utils/ai.ts`](../utils/ai.ts); live diagnostic code |
| `scripting.executeScript()` | [`entrypoints/sidepanel/App.svelte`](../entrypoints/sidepanel/App.svelte); only packaged `content-scripts/content.js` for the element picker |

Source and the Chrome MV3 production artifact contain no call to `eval`, `Function`/`new Function`, arbitrary dynamic import, script-element creation, or remote script URL. The built manager contains the words “eval, new Function…” only as plain text in its import-review prompt. Its HTML `<script>` tags reference package-relative bundles.

## Verification

On 2026-08-18, `bun run postinstall`, `bun run check`, and `bun run build` passed (`svelte-check`: 0 errors/warnings). Searches of source and `.output/chrome-mv3` found only the sinks above.

A clean Chrome profile test with **Allow User Scripts** on and off was not possible in this non-interactive environment; release-candidate testing remains tracked by [#27](https://github.com/foodelevator/scriptsmith/issues/27) and [#31](https://github.com/foodelevator/scriptsmith/issues/31).

Update this document whenever a code source, execution sink, origin rule, world configuration, or user-script message changes.
