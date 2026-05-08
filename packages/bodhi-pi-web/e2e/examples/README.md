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
└── skills/
    ├── say-hello/
    │   └── SKILL.md        — /skill:say-hello <name>
    └── days-since-birthday/
        ├── SKILL.md        — /skill:days-since-birthday <YYYY-MM-DD>
        └── script.js       — invoked via run_script
notes/                       — grep demo
topics/                      — ls demo
docs/                        — find demo (.md vs .txt vs .js)
scripts/                     — extra .js the find demo includes
poem.txt                     — write/read/edit demo seed
```

## Notes

- The mount name shown in the status bar comes from Chrome's File System Access API — it's whatever the directory's local basename is (Chrome doesn't expose absolute paths). If you mount this folder verbatim, the mount path will be `/mnt/examples`.
- Sessions persist in IndexedDB across reloads (M6) and survive page closes per-tab via `sessionStorage`.
- Click **Unmount** in the status bar to return to the picker and grant a different folder.
