# bodhi-pi-chrome-ext

PoC Chrome extension that runs the `@bodhiapp/bodhi-pi` agent inside an MV3 extension. The chat UI lives at `chrome-extension://<id>/index.html`; the agent runs in a Web Worker spawned from that page.

## Quick start

```sh
# 1. one-time: generate the extension keypair (stable id across reloads + e2e)
npm run gen-key

# 2. set API keys
cp .env.example .env
# fill VITE_OPENAI_API_KEY (and optionally VITE_ANTHROPIC_API_KEY)

# 3. build
npm install
npm run build

# 4. load the extension in Chrome
#    - chrome://extensions
#    - Developer mode ON
#    - Load unpacked → select dist/
#    - Verify the id matches the contents of .ext-id

# 5. click the action icon → a new tab opens at chrome-extension://<id>/index.html
```

## E2e

```sh
npm run test:e2e
```

Playwright launches a persistent context with `--load-extension=<dist>` (headed mode, since MV3 extensions don't load reliably in headless).

## Known PoC limitations

MV3 forbids `'unsafe-eval'` in extension page CSP, so the AsyncFunction-based `BrowserScriptExecutor` (`run_script`) and the data-URL extension loader (`createBrowserExtensionLoader`) don't work here. Specs that exercise those (`scripted-skill.spec.ts`, `extensions.spec.ts`) are expected to fail in this host. Real apps that need scripting under MV3 must move execution into a sandboxed iframe or offscreen document.

See `CLAUDE.md` for the full architecture + source-code rules.
