# bodhi-pi-web: externalize seeded filesystem into `e2e/data/`

## Context

Today the seed bytes that drive `bodhi-pi-web/e2e/*.spec.ts` come from three different places, depending on the spec:

1. **Cross-package fs reads.** `commands.spec.ts`, `extensions.spec.ts`, and `skills.spec.ts` reach into the sibling cli package via `fs.readFileSync('../bodhi-pi-cli/test/fixtures/...')`. This couples web e2e to the cli package layout on disk and assumes the relative path holds at test time.
2. **JS template literals inlined in the spec.** `scripted-skill.spec.ts` constructs `SKILL.md` and `script.js` from arrays joined with `\n`, interpolating `${SKILL_DIR}` at module load.
3. **Inline string maps in `test.use({ workspaceSeed })`.** Smaller content like `/readme.txt: "hello"`, `/leak.txt: "..."`, and `fs-tools.spec.ts`'s several variations are scattered across spec bodies.

The result: no single place to look at "what filesystem configurations are actually exercised in browser e2e?" The cli package solved the same problem with a checked-in `test/fixtures/<scenario>/` tree plus a small `seed-workspace.ts` helper. This change ports that pattern to bodhi-pi-web — with one shape difference (flat `files` map, no `commands/skills/extensions` discriminator) and one location difference (`e2e/data/` lives inside the web package, not shared with cli).

## Why a flat `files` map (not cli's discriminated shape)

Cli's `WorkspaceSeed` splits `commands?/skills?/extensions?/files?` for ergonomics — they're convenience keys for well-known subpaths under `.bodhi-pi/`. Tests still build seeds programmatically by `loadFixture`-ing individual files; nobody points cli at a fixture dir via `--cwd`. The `fixturePath()` export is dead code, never called.

Web already has `WorkspaceSeed = { name; files: Record<string, string> }`. Keep it. The directory walker in `loadScenario` can deliver the well-known paths just as easily, and not having a discriminated shape avoids touching `seedWorkspaceProvider` (`src/workspace/provider.ts`) or every spec's seed object.

## Why scripted-skill is **not** a special case

Cli's `skills-days-since-birthday/SKILL.md` contains a literal `{SCRIPT_PATH}` token because cli writes fixtures to a tmpdir whose absolute path varies per run; cli's `seed-workspace.ts` substitutes the token at write time. Web's mount path is deterministic — always `/mnt/<seed.name>/...` — so the resolved absolute path is stable across runs and can be baked into the markdown directly. Result: web's `skills-days-since-birthday/SKILL.md` will hard-code `/mnt/demo/.bodhi-pi/skills/days-since-birthday/script.js` and skip runtime templating entirely. One-line byte deviation from cli's copy, called out here so it doesn't look accidental later.

This also lets `skills.spec.ts` (days-since-birthday describe) and `scripted-skill.spec.ts` share **one** scenario. Today they each carry their own copy of the same skill (cli-fixture-with-replaceAll vs. inline JS literal); after this change they both `loadScenario('skills-days-since-birthday')`.

## Layout: `packages/bodhi-pi-web/e2e/data/`

Mirror cli's per-feature scenario names where bytes match cli; add web-only scenarios where they don't.

```
e2e/data/
├── default/
│   └── readme.txt                                                 # "hello" (current DEFAULT_SEED)
├── workspace-readme/
│   └── readme.txt                                                 # "hello world" (workspace.spec.ts)
├── commands-echo/                                                 # cli mirror, byte-for-byte
│   └── .bodhi-pi/commands/echo.md
├── commands-say-tuesday/                                          # cli mirror
│   └── .bodhi-pi/commands/say-tuesday.md
├── skills-say-hello/                                              # cli mirror
│   └── .bodhi-pi/skills/say-hello/SKILL.md
├── skills-days-since-birthday/                                    # cli mirror EXCEPT SKILL.md path baked in
│   └── .bodhi-pi/skills/days-since-birthday/
│       ├── SKILL.md                                               # `/mnt/demo/...` hard-coded, no {SCRIPT_PATH}
│       └── script.js
├── extensions-redact-secrets/                                     # cli mirror + web-only leak.txt
│   ├── leak.txt                                                   # web-only data file used by the spec
│   └── .bodhi-pi/extensions/redact-secrets.js
├── fs-tools-notes-txt/
│   └── notes.txt                                                  # "hello world"
├── fs-tools-notes-abc/
│   └── notes/
│       ├── alpha.md                                               # "A"
│       ├── beta.md                                                # "B"
│       └── gamma.md                                               # "C"
├── fs-tools-docs-tree/
│   ├── docs/
│   │   ├── intro.md                                               # "# intro"
│   │   ├── notes/draft.md                                         # "# draft"
│   │   └── readme.txt                                             # "txt"
│   └── scripts/helper.js                                          # "// js"
└── fs-tools-codeword/
    └── notes/
        ├── a.md                                                   # "# A\nthe codeword is parrot\n"
        └── b.md                                                   # "# B\njust a draft\n"
```

Specs that pass `files: {}` (empty) keep that inline — no scenario directory needed for "no files."

## The loader utility

Extend `packages/bodhi-pi-web/e2e/helpers/seed.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

export function loadScenario(name: string): Record<string, string> {
  const root = path.join(DATA_ROOT, name);
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const rel = "/" + path.relative(root, child).split(path.sep).join("/");
        out[rel] = fs.readFileSync(child, "utf8");
      }
    }
  };
  walk(root);
  return out;
}
```

Replace `DEFAULT_SEED` with a scenario-backed default:

```ts
export const DEFAULT_SEED: WorkspaceSeed = { name: "demo", files: loadScenario("default") };
```

Keep `WorkspaceSeed`, `seedWorkspace(page, seed)`, and `e2e/fixtures.ts` unchanged.

## Per-spec migration

| Spec | Current source | After |
|---|---|---|
| `chat.spec.ts` | DEFAULT_SEED (no override) | unchanged (DEFAULT_SEED now reads from `data/default/`) |
| `cross-provider.spec.ts` | DEFAULT_SEED | unchanged |
| `events.spec.ts` | DEFAULT_SEED | unchanged |
| `model-switch.spec.ts` | DEFAULT_SEED | unchanged |
| `sessions.spec.ts` | DEFAULT_SEED | unchanged |
| `commands.spec.ts` | `fs.readFileSync('../bodhi-pi-cli/...')` for echo + say-tuesday; one describe with `files:{}` | `{ ...loadScenario('commands-echo'), ...loadScenario('commands-say-tuesday') }` for the combined describe; `loadScenario('commands-echo')` for the echo-only describe; `files:{}` left as-is |
| `extensions.spec.ts` | inline `/leak.txt` + cli fs read for `redact-secrets.js` | `loadScenario('extensions-redact-secrets')` (delivers both leak.txt and the extension JS) |
| `skills.spec.ts` | cli fs read for say-hello; cli fs read + `replaceAll('{SCRIPT_PATH}', ...)` for days-since-birthday | `loadScenario('skills-say-hello')`; `loadScenario('skills-days-since-birthday')` (no replaceAll — path is baked in) |
| `scripted-skill.spec.ts` | inline JS template literals | `loadScenario('skills-days-since-birthday')` (same scenario as skills.spec.ts) |
| `fs-tools.spec.ts` | five different inline `files:{...}` overrides | one `files:{}` override stays inline; the other four become `loadScenario('fs-tools-notes-txt')`, `'...-notes-abc'`, `'...-docs-tree'`, `'...-codeword'` |
| `workspace.spec.ts` | inline `/readme.txt: "hello world"` | `loadScenario('workspace-readme')` |
| `model-persists.spec.ts` | `files:{}` | unchanged inline |
| `tool-failure.spec.ts` | `files:{}` | unchanged inline |
| `tool-replay.spec.ts` | `files:{}` | unchanged inline |

After migration, no spec under `e2e/` should `fs.readFileSync` from the cli package. Grep `bodhi-pi-cli/test/fixtures` under `packages/bodhi-pi-web/` should return zero hits.

## Critical files

| Path | Change |
|---|---|
| `packages/bodhi-pi-web/e2e/data/**` | NEW directory tree (~13 scenarios, ~20 files) |
| `packages/bodhi-pi-web/e2e/helpers/seed.ts` | extend: add `loadScenario(name)`, switch `DEFAULT_SEED.files` to `loadScenario("default")` |
| `packages/bodhi-pi-web/e2e/commands.spec.ts` | drop `fs`/`path`/`fileURLToPath`/`FIXTURES_ROOT` imports; replace `fixture(...)` with `loadScenario(...)` |
| `packages/bodhi-pi-web/e2e/extensions.spec.ts` | drop fs imports, inline leak.txt → `loadScenario('extensions-redact-secrets')` |
| `packages/bodhi-pi-web/e2e/skills.spec.ts` | drop fs imports + replaceAll → two `loadScenario` calls |
| `packages/bodhi-pi-web/e2e/scripted-skill.spec.ts` | drop SCRIPT/SKILL_MD literals → `loadScenario('skills-days-since-birthday')` |
| `packages/bodhi-pi-web/e2e/fs-tools.spec.ts` | replace four inline file maps with `loadScenario(...)` |
| `packages/bodhi-pi-web/e2e/workspace.spec.ts` | replace inline `/readme.txt` with `loadScenario('workspace-readme')` |
| `packages/bodhi-pi-web/CLAUDE.md` | one line in **Test conventions**: note that scenario bytes live under `e2e/data/<scenario>/`, loaded via `loadScenario(name)` from `e2e/helpers/seed.ts` |

Files NOT changing: `e2e/fixtures.ts`, `src/workspace/provider.ts`, `src/workspace/types.ts`, `WorkspaceSeed` shape.

## Reusable existing utilities

- `seedWorkspace(page, seed)` in `e2e/helpers/seed.ts:9` — unchanged; receives the same shape, content just comes from disk now.
- `seedWorkspaceProvider(opts)` in `src/workspace/provider.ts:63` — unchanged; consumes the flat `files` map exactly as today.
- `WorkspaceSeed` type in `e2e/helpers/seed.ts:3` — unchanged.

## Verification

1. **Unit-level sanity for `loadScenario`:** none needed — each spec's own assertion path proves the bytes were seeded correctly (commands run, skills invoke, extensions transform, fs tools find files).
2. **Run a single migrated spec headlessly first:**
   ```bash
   cd packages/bodhi-pi-web
   npx playwright test e2e/commands.spec.ts --project=chromium
   ```
3. **Full e2e suite (real LLM, gpt-4o-mini):**
   ```bash
   cd packages/bodhi-pi-web
   npm run test:e2e
   ```
   Expected: all currently-green specs (21 per CLAUDE.md) stay green. No skipped specs introduced.
4. **Decoupling check:**
   ```bash
   rg -n "bodhi-pi-cli/test/fixtures" packages/bodhi-pi-web/
   ```
   Expected: zero hits after migration.
5. **Optional spot check:** open `e2e/data/` in a file browser and confirm scenarios exist for every feature listed in the migration table.

## Out of scope

- Touching cli's `test/fixtures/` or `test/helpers/seed-workspace.ts`. Cli keeps its own copy of the same skill/command/extension scenarios. Drift between the two is acceptable and explicit (web pre-resolves `{SCRIPT_PATH}`; cli substitutes at runtime).
- Removing cli's dead `fixturePath()` export. Separate cleanup if anyone cares.
- Hoisting fixtures to a shared repo-root location. Considered, rejected: the user picked "Own copy under e2e/data/" so each publishable package stays self-contained.
- Switching `WorkspaceSeed` to a discriminated `commands?/skills?/extensions?/files?` shape. Rejected: cli's split is convenience sugar, and the directory walker delivers the same paths without a type-level split.
