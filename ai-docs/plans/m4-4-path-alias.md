# Path Aliases for `packages/bodhi-pi-*`

## Context

The three bodhi-pi packages (`bodhi-pi`, `bodhi-pi-cli`, `bodhi-pi-node`) currently use deep relative imports — 77 occurrences of `from "../..."` across `src/`, `test/`, and `e2e/`. Examples like `../test/helpers/cli-harness.js` from `e2e/` or `../../src/index.js` from `test/helpers/` are fragile (break on file moves) and hard to read.

Goal: introduce a per-package path alias `@/` → `<package>/src/` (and `@test/` → `<package>/test/` for cross-tree test/e2e imports) so deep relative imports become anchored, readable paths.

Build constraint: builds run via `tsgo` (TypeScript Go compiler), which **does not rewrite import paths** during emit — same as `tsc`. Therefore a runtime path-rewriter is required for compiled `dist/` output that ships to npm. Per user choice, we use `tsc-alias` post-build. Vitest already supports `resolve.alias` natively.

## Design

Two aliases per package (defined locally — they are not visible to package consumers, only used internally):
- `@/*` → `<package>/src/*`
- `@test/*` → `<package>/test/*`

Three resolution layers must agree:
1. **Type-checking** (editor LSP + `tsgo` build): `paths` in tsconfig.
2. **Test runtime** (vitest): `resolve.alias` in vitest configs.
3. **Production runtime** (compiled `dist/`): `tsc-alias` post-build rewrites `@/foo.js` → `./foo.js` in emitted JS + `.d.ts`.

`@test/*` only needs layers 1 + 2 (test files don't ship to dist).

## Per-package configuration changes

Apply the same shape to `packages/bodhi-pi/`, `packages/bodhi-pi-cli/`, `packages/bodhi-pi-node/`.

### 1. `tsconfig.build.json` — add baseUrl + paths

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": "./src",
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.e2e.ts", "**/*.d.ts"]
}
```

`baseUrl: "./src"` so `paths` are resolved relative to `src/`. Only `@/*` here — `@test/*` is for test code only and goes in the editor-facing tsconfig (next).

### 2. New `tsconfig.json` per package — for editor LSP & vitest type-check

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@test/*": ["./test/*"]
    }
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "e2e/**/*.ts"]
}
```

The editor LSP picks the **nearest** tsconfig — this file wins inside the package, taking precedence over the root `tsconfig.json` for files under it. Root `tsconfig.json` is unchanged (it already provides cross-package `@bodhiapp/...` resolution at the workspace level).

### 3. `vitest.config.ts` and `vitest.e2e.config.ts` — add alias

In every existing vitest config (`bodhi-pi/vitest.config.ts`, `bodhi-pi/vitest.e2e.config.ts`, `bodhi-pi-cli/vitest.config.ts`, `bodhi-pi-cli/vitest.e2e.config.ts`, `bodhi-pi-node/vitest.config.ts`), append two entries to the existing `resolve.alias` array:

```ts
{ find: /^@\//, replacement: path.resolve(here, "src/") + "/" },
{ find: /^@test\//, replacement: path.resolve(here, "test/") + "/" },
```

Order matters — put these **after** the existing package-name aliases so the package-name regex is matched first.

### 4. `package.json` — add tsc-alias + update build script

DevDep: `"tsc-alias": "^1.8.10"` (latest stable). Scripts:

```jsonc
{
  "scripts": {
    "clean": "shx rm -rf dist",
    "build": "tsgo -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    "dev": "tsgo -p tsconfig.build.json --watch --preserveWatchOutput",
    // ... rest unchanged
  }
}
```

`dev` is intentionally not changed — vitest resolves `@/` live via its alias, so dev mode does not need rewritten output. If a workflow surfaces that needs rewritten `dist/` in watch mode, we can add `tsc-alias --watch` then.

Run `npm install` once at the workspace root after editing `package.json` files.

## Mechanical conversion of 77 imports

Rules (apply per package):

| From | To |
|---|---|
| In `src/<dir>/file.ts`, import `../<rest>.js` or `../../<rest>.js` referencing another `src/` path | `@/<resolved-from-src>.js` |
| In `test/**/*.ts` or `e2e/**/*.ts`, import `../src/<rest>.js` or `../../src/<rest>.js` | `@/<rest>.js` |
| In `e2e/**/*.ts`, import `../test/<rest>.js` | `@test/<rest>.js` |
| Single-`../` imports **within the same tree** (e.g. `test/foo.ts` → `../helpers/bar.js`) | leave as-is — already short and unambiguous |

Example transformations (verified against current grep output):

- `src/acp/agent.ts`: `import ... from "../commands/discovery.js"` → `from "@/commands/discovery.js"`
- `src/tools/walk.ts`: `import type { Filesystem } from "../filesystem/filesystem.js"` → `from "@/filesystem/filesystem.js"`
- `test/helpers/cli-harness.ts`: `import { createCliAgent } from "../../src/agent.js"` → `from "@/agent.js"`
- `e2e/commands.e2e.ts`: `import { createTestHarness } from "../test/helpers/harness.js"` → `from "@test/helpers/harness.js"`

Conversion approach: a single mechanical pass per package using `grep` + scripted edits. Each file's import paths can be rewritten with a small Node script (or careful `sed`) and reviewed via `git diff` before committing. Tests after each package's pass act as the safety net.

## Critical files to modify

Per package (× 3 packages: `bodhi-pi`, `bodhi-pi-cli`, `bodhi-pi-node`):
- `packages/<pkg>/tsconfig.build.json` — add `baseUrl` + `paths`
- `packages/<pkg>/tsconfig.json` — **new file**, editor + vitest type-check
- `packages/<pkg>/vitest.config.ts` — append `@/` and `@test/` aliases
- `packages/<pkg>/package.json` — add `tsc-alias` devDep, update `build` script
- All `*.ts` files in `src/`, `test/`, `e2e/` containing matching `from "../..."` imports

Additionally:
- `packages/bodhi-pi/vitest.e2e.config.ts` — append aliases
- `packages/bodhi-pi-cli/vitest.e2e.config.ts` — append aliases
- (No e2e config in `bodhi-pi-node`)

Workspace-root files: **no changes**.

## Verification

Per package, in order:

1. **Type-check** — open one converted source file in the editor; confirm no red squigglies on `@/` imports.
2. **Build** — `cd packages/<pkg> && npm run build`. Confirm:
   - Build succeeds.
   - `dist/**/*.js` and `dist/**/*.d.ts` contain **no** `@/` strings (use `grep -r "@/" dist/ | grep -v node_modules` — should be empty after `tsc-alias`).
3. **Unit tests** — `cd packages/<pkg> && npm test`. All existing tests pass; vitest resolves `@/` and `@test/` cleanly.
4. **E2E tests** (bodhi-pi, bodhi-pi-cli only) — `npm run test:e2e`. Requires real API keys per existing flow. If env not available, skip but verify the configs at least load (`vitest --run --config vitest.e2e.config.ts --reporter=verbose --listTests`).
5. **CLI smoke** — `cd packages/bodhi-pi-cli && npm run build && node dist/cli.js --help` (or the equivalent invocation) to confirm `dist/` runs in real Node without `@/` resolution failures.
6. **Workspace-level guard** — from repo root: `grep -rn "from ['\"]\\.\\." packages/bodhi-pi*/src packages/bodhi-pi*/test packages/bodhi-pi*/e2e | grep -v node_modules` — should print only the intentionally-kept short relatives (intra-folder single-`../` cases), no deep parent climbs into `src/` or `test/`.

## Out of scope

- Other packages under `packages/` (only `bodhi-pi*` is touched per request).
- Changing the publish format / bundling (we keep tsgo + per-file emit + tsc-alias post-step).
- Updating the root workspace `tsconfig.json` (its existing package-name paths are sufficient for cross-package work).
- Migrating `dev` script to also run `tsc-alias --watch` (deferred until a use case demands it).
