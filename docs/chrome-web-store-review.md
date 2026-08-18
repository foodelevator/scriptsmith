# Chrome Web Store reviewer instructions

> Draft: add release-candidate and reviewer-account details before submission ([#11](https://github.com/foodelevator/scriptsmith/issues/11), [#38](https://github.com/foodelevator/scriptsmith/issues/38)).

scriptsmith imports or asks OpenAI to create JavaScript customizations for user-approved sites. Saved code and live AI diagnostics execute only through `chrome.userScripts` in its default `USER_SCRIPT` world. The extension does not pass this code to `eval`, `Function`, a remote script tag, or `chrome.scripting.executeScript`; its Scripting API call injects only the packaged element picker.

See the [source-to-execution summary and sink inventory](user-script-execution.md) and [remote-code declaration](remote-code-declaration.md).

To verify: install the package in clean Chrome 138+, enable **Allow User Scripts**, create a script on an HTTP(S) page, exercise **Run now** and page reload, and decline then approve an exact-origin request. Import a `.scriptsmith.json` file and confirm that all origins and source appear before approval. Finally disable and remove the scripts and confirm they no longer run after reload.

The User Scripts API exception is claimed only for arbitrary page code passed through that API. All other behavior is packaged and reviewable; alignment of remotely AI-generated code remains for Chrome Web Store review.
