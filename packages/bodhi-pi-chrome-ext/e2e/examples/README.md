# bodhi-pi-web demo workspace

Mount this folder in the bodhi-pi-web DirectoryGate (the **Pick folder** button on the boot screen) and you'll have working examples of every feature the e2e suite exercises.

After granting access, the status bar shows `mount: /mnt/examples` (or whatever name you picked). The agent's cwd is that mount path; everything below references it as `<mount>`.

## Slash commands

Discovered automatically from `.bodhi-pi/commands/*.md`. Try:

```
/help                    → lists local + project commands together
/echo banana             → reply "banana" (uses $1 expansion)
/say-tuesday             → reply "tuesday"
```

## Skills (markdown)

Discovered automatically from `.bodhi-pi/skills/<name>/SKILL.md`. Try:

```
/skill:say-hello world   → reply "hello, world"
```

## Skills (with run_script)

The browser ScriptExecutor wraps each script as an AsyncFunction. Try:

```
/skill:days-since-birthday 2000-01-01
```

Expected: the script computes days from your birthday to the baseline (2026-05-08) and the agent replies with the integer (`9624` for the example above).

## Extensions

Extensions are loaded automatically from `.bodhi-pi/extensions/*.js` after the
folder is mounted. Source comes from the workspace itself, dynamic-imported via
`data:text/javascript;base64,…` — no `node_modules`, no transpile step. Each
file's default export is the factory `(pi) => void`.

| File | What it does | Try it |
|---|---|---|
| `input-transform.js` | Rewrites prompts beginning with `?quick ` into a one-sentence directive. | `?quick what is 2 + 2` |
| `pirate.js` | Appends a pirate-voice rule to the system prompt. | `say hello in your own words` |
| `redact-secrets.js` | Scrubs `sk-…` API-key tokens out of tool results before they're displayed. | `read secrets.txt and tell me what's there verbatim` |
| `dynamic-tools.js` | Registers a custom LLM-callable tool `bodhi_echo`. | `call the bodhi_echo tool with the message "hello from the browser" and report what it returned` |
| `register-provider.js.disabled` | Adds a custom Anthropic model to the model dropdown. **Renaming required** — drop the `.disabled` suffix and paste a real API key inside. | `/model` (after enabling) |

The browser loader is JS-only by design; TypeScript-source extensions need an
in-browser transform (esbuild-wasm) which is deferred. In a Node host (e.g.
`bodhi-pi-cli`), the same factories work as `.ts` files via jiti.

To author your own: drop a new `*.js` file in `.bodhi-pi/extensions/`, mount the
workspace, and the worker picks it up on session start. A bad extension (parse
error, missing default export) is logged to the dev-tools console and skipped —
it does not block peer extensions or the agent.

## Built-in filesystem tools

Plain prompts that exercise the six `read` / `write` / `edit` / `ls` / `find` / `grep` tools against the seeded files.

```
write a file <mount>/poem.txt with the content "roses are red", then read it back and echo the content
```

```
edit <mount>/poem.txt — replace "world" with "earth", then read it
```

```
list the contents of <mount>/topics
```

```
find every file under <mount>/docs whose name ends in .md and tell me the count
```

```
grep for "codeword" in <mount>/notes and tell me the value
```

## Layout

```
.bodhi-pi/
├── commands/
│   ├── echo.md             — /echo <word>
│   └── say-tuesday.md      — /say-tuesday
├── skills/
│   ├── say-hello/
│   │   └── SKILL.md        — /skill:say-hello <name>
│   └── days-since-birthday/
│       ├── SKILL.md        — /skill:days-since-birthday <YYYY-MM-DD>
│       └── script.js       — invoked via run_script
└── extensions/
    ├── input-transform.js          — `?quick` prefix rewrites your prompt
    ├── pirate.js                   — system-prompt augmentation
    ├── redact-secrets.js           — scrub sk-… from tool results
    ├── dynamic-tools.js            — registers the bodhi_echo tool
    └── register-provider.js.disabled — adds an Anthropic model (rename + add key)
notes/                       — grep demo
topics/                      — ls demo
docs/                        — find demo (.md vs .txt vs .js)
scripts/                     — extra .js the find demo includes
poem.txt                     — write/read/edit demo seed
secrets.txt                  — redact-secrets demo (fake key tokens)
```

## Notes

- The mount name shown in the status bar comes from Chrome's File System Access API — it's whatever the directory's local basename is (Chrome doesn't expose absolute paths). If you mount this folder verbatim, the mount path will be `/mnt/examples`.
- Sessions persist in IndexedDB across reloads (M6) and survive page closes per-tab via `sessionStorage`.
- Click **Unmount** in the status bar to return to the picker and grant a different folder.
