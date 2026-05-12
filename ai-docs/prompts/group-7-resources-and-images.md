# Phase J — Resource diagnostics + multimodal (images)

**Read first:** `ai-docs/prompts/process.md` (working rules + retrospective)
AND `ai-docs/prompts/group-0-upstream-alignment.md` (Phase 0 should land
first — affects whether resource discovery code stays bodhi-pi-local or
adopts `harness/{prompt-templates,skills}.ts`).
**Reference impl:** for image content,
`packages/coding-agent/src/core/tools/` (`read.ts` handles inline images;
look for `ImageContent` use). For resource collision + source-info,
`packages/coding-agent/src/core/{commands,skills,extensions}/` and the
loader/registry code there.
**Current state:** `packages/bodhi-pi/PARITY.md`.
**Source intent:** `ai-docs/parity-post-extension.md` §3.5 + §3.2 (image
tool results) + §3.8 (image input UI).

> **Upstream context (2026-05-11):** pi-ai 0.74 added an entire **image
> *output*** API (`ImagesApi`, `ImagesProvider`, `ImagesModel`,
> `ImagesContext`, `AssistantImages`, `images()` function, registered
> under `providers/images/register-builtins.js` with an OpenRouter
> backend). This phase's outcomes #4–#7 are about image **input** —
> orthogonal to those new exports. Don't conflate the two; the new
> images API is for prompts that *generate* images, not for letting an
> agent read an existing image. `ImageContent` (the input-side type) is
> unchanged.
>
> Phase 0 may adopt `harness/{prompt-templates,skills}.ts` which would
> change the surface where outcomes #1–#3 (collision diagnostics,
> source-info) live. Re-read after Phase 0 lands.

---

## Functional outcomes

After this phase a user of any bodhi-pi reference host should observe:

### Resources & diagnostics

1. **When two sources contribute a command, skill, or tool with the same
   name, the agent reports the collision** rather than silently choosing
   a winner. Today multi-source loading (project + user + extension)
   merges with builtins-win + project-wins-on-collision, but the user
   never sees that a conflict occurred.
2. **Each loaded resource carries source info** — which file or extension
   contributed it. The user can see "where did this `/foo` slash come
   from?" via an existing or new diagnostic surface.
3. **A diagnostic dump** is available from every host (slash command +
   bodhi-pi-cli flag) listing all loaded extensions / skills / commands
   with their source paths + any load errors. This is the user-facing
   debugging entry point when things misbehave.

### Multimodal (images)

4. **Tools can return inline image content.** The `read` tool, when
   pointed at an image file (PNG, JPG, etc.), returns an `image` content
   block alongside any text. The model sees the image in its tool result.
   Hosts that render tool-call cards display the image inline.
5. **Image-bearing tool calls work end-to-end** with at least one
   multimodal provider (OpenAI vision, Anthropic Claude, etc.).
6. **Users can paste/upload images in browser hosts** (web, chrome-ext,
   ws-frontend, http frontend). The image becomes an `image` content block
   in the next user prompt. The model receives it.
7. **The CLI host** supports an `@file` or `--image <path>` ergonomic for
   attaching images from disk — not a paste UI, but a way to get an
   image into a prompt without typing base64.

Each is observable through the chat UI / ACP surface (no whitebox).

---

## Rough directional pointers

### Diagnostics

- `packages/bodhi-pi/src/extensions/merge.ts` is where command/tool
  merge happens today; that's the place where collision detection lives
  too. Decide: warn (continue with chosen winner) or fail (refuse to
  load both)?
- Skills and commands have similar merge points
  (`packages/bodhi-pi/src/skills/`, `src/commands/`).
- "Source info" needs to flow with the resource — likely a new field on
  `PromptTemplate` / `Skill` / `AgentTool` (or a sidecar map keyed by
  name). Coding-agent's pattern is the reference.
- Diagnostic surface: either a new
  `_bodhi-pi/diagnostics/dump` extension method returning a structured
  payload + a `/diagnostics` slash in every host, or piggy-back on
  `/session` stats with an `?extended` flag. Confirm shape with the user.

### Images

- pi-ai's message types include `ImageContent` (check
  `node_modules/@earendil-works/pi-ai/dist/types.d.ts`). ACP's content
  types support `image` (look at `@agentclientprotocol/sdk` content
  blocks).
- `read` tool today reads bytes via the host-injected `Filesystem`. For
  images, detect MIME by extension, base64-encode, return an `image`
  content block. Look at
  `packages/coding-agent/src/core/tools/read.ts` for the reference.
- The Filesystem interface (`bodhi-pi/src/filesystem/filesystem.ts`) may
  need a `readBinary(path) → Uint8Array` if it doesn't have one already.
- Browser-host paste/upload UI lives in
  `packages/bodhi-pi-browser/src/ui/Composer.tsx` (the input area). Paste
  handler captures image clipboard data; upload button opens a file
  picker for image MIMEs. Both append `image` blocks to the next prompt's
  content array.
- ws-frontend and bodhi-pi-http frontend have their own Composer
  equivalents — apply the same UX.
- CLI: a `@path/to/image.png` syntax in the prompt input expands to an
  `image` content block via the host-injected Filesystem before sending.

---

## Test signals to design for

Functional, blackbox:

### Diagnostics

- **Collision:** seed two project commands with the same name (one from
  `.bodhi-pi/commands/`, one from an extension); after `newSession`, the
  diagnostic dump lists both with source paths and a "winner" marker. The
  command works (winner runs) but the user sees the conflict.
- **Source info:** `/diagnostics` (or chosen surface) lists every
  command/skill/tool with its source path. The list includes builtins,
  project commands, project skills, extension contributions.
- **Diagnostic dump on errors:** an extension that throws at load time
  shows up with its error message in the diagnostic output.

### Images

- **`read` on image file:** seed a workspace with a small PNG; `read`
  the file via a faux-provider tool dispatch; assert the tool result
  includes an `image` content block with the base64 payload and a
  text caption. The Filesystem layer must round-trip binary bytes
  without corruption — test this at the filesystem unit level first.
- **Real-LLM image tool result:** a multimodal model is asked "what
  colour is this PNG?"; the model reads the image and answers. One
  real-LLM e2e per multimodal provider (OpenAI + Anthropic if both keys
  available — at minimum one).
- **Browser-host paste:** Playwright simulates clipboard image paste in
  the Composer; the next prompt's payload (captured via EventsPanel
  wire-frame tab) includes an `image` content block.
- **Browser-host upload:** Playwright `setInputFiles` on the upload
  input; same assertion as paste.
- **CLI `@image.png`:** the CLI expands the syntax before sending;
  faux-provider test asserts the prompt's content array has both `text`
  and `image` blocks.

The same blackbox rule applies — design new slash commands or extension
methods if internal state needs surfacing. **Note the existing one
sanctioned whitebox bridge** (browser FSA filesystem seed) — if image
input testing requires similar Playwright injection, document it the
same way.

---

## Open questions to confirm before coding

- **Collision policy:** warn-and-pick-a-winner (current behaviour,
  surfaced) vs hard-fail. Recommend warn + surface.
- **Diagnostic dump shape:** structured (JSON via extension method) +
  pretty-printed slash, or just slash output? Both is overkill;
  structured is testable.
- **`read` on image: same `read` tool or new `read_image` tool?** Same
  tool, MIME-detected. Easier for the model to use.
- **Max image size limits in `read`:** to avoid blowing context windows.
- **Browser paste UX:** does the pasted image show as a preview chip in
  the composer before send? (Probably yes for usability; the test asserts
  the prompt content, not the chip.)
- **CLI image syntax:** `@image.png` (auto-detect MIME) or a flag
  `--image <path>`? Probably `@<path>` to match `@file` text inclusion
  for non-image files.

---

## Boundaries

In scope:

- Resource collision diagnostics
- Source-info tracking on resources
- Diagnostic dump command (slash + CLI flag)
- Image-bearing tool results (read returns image, tools can return
  images)
- Browser-host image input (paste + upload) in web, chrome-ext,
  ws-frontend, http frontend
- CLI image-attach ergonomic

Explicitly out of scope (defer):

- Package manager (git-pinned packs of extensions/skills/commands/themes)
  — §3.5 P3, "Big surface (git URLs, ref pinning, update checking,
  GitHub API, offline mode). Defer until users ask for shared packs."
- Loading `.claude/agents/` markdown files (sub-agents) — excluded by
  design per parity report.
- EXIF orientation, photon image processing — excluded by design.
- HTML export — host concern, separate phase.
