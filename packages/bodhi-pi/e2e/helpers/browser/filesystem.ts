import type { Page } from "playwright";
import type { DirEntry, FileStat, Filesystem } from "@/index.js";
import { readNewFrames } from "./page-frame-reader.js";

// Read-only Filesystem proxy over the in-page InMemory ZenFS mount.
//
// Reads (readTextFile, exists) route through the page-side slash router:
// "/file <abs-path>" emits a synthetic `_test/file/read` frame; "/exists
// <abs-path>" emits `_test/file/exists`. The harness uses these to satisfy
// post-prompt readback assertions (fs.e2e.ts, commands.e2e.ts).
//
// Mutating methods throw — the e2e suite seeds via `h.setupFiles` BEFORE
// initialize (Option B, fleet-wide). list/stat throw too (zero shared-test
// usages; if added later, build a slash for them).
//
// The slash router emits its synthetic frame via `acp-input + acp-submit`
// click; we therefore funnel through the same DOM frame log used by
// BrowserAcpConnection. Frame reads share `helpers/browser/page-frame-reader.ts`
// so the `data-testid` contract stays single-source.

export interface BrowserFilesystemOptions {
	page: Page;
}

function blockMutating(method: string): never {
	throw new Error(
		`e2e browser harness: filesystem.${method}() is disabled. Use h.setupFiles({...}) before clientConn.initialize().`,
	);
}

export function createBrowserFilesystem(opts: BrowserFilesystemOptions): Filesystem {
	const { page } = opts;
	let cursor = 0;

	async function dispatchSlash(slashLine: string, expectedMethod: string): Promise<unknown> {
		// startSeq captured before submit so the poll begins from after
		// any prior unrelated frames.
		const startSeq = cursor;
		await page.fill('[data-testid="acp-input"]', slashLine);
		await page.click('[data-testid="acp-submit"]');
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const frames = await readNewFrames(page, cursor);
			for (const f of frames) {
				cursor = f.seq;
				if (f.direction !== "in") continue;
				if (!f.method.startsWith("_test/")) continue;
				if (f.method !== expectedMethod) continue;
				try {
					const body = JSON.parse(f.payload) as { result?: unknown };
					return body.result;
				} catch {
					throw new Error(`browser-filesystem: failed to parse ${expectedMethod} frame: ${f.payload}`);
				}
			}
			cursor = Math.max(cursor, startSeq);
			await page.waitForTimeout(25);
		}
		throw new Error(`browser-filesystem: timed out waiting for ${expectedMethod}`);
	}

	return {
		async readTextFile(absolutePath: string): Promise<string> {
			const result = await dispatchSlash(`/file ${absolutePath}`, "_test/file/read");
			const r = result as { ok: boolean; content?: string; error?: string };
			if (!r.ok) {
				throw new Error(`readTextFile(${absolutePath}): ${r.error ?? "not found"}`);
			}
			return r.content ?? "";
		},
		async exists(absolutePath: string): Promise<boolean> {
			const result = await dispatchSlash(`/exists ${absolutePath}`, "_test/file/exists");
			const r = result as { ok: boolean; exists: boolean };
			return r.ok && r.exists;
		},
		async list(_p: string): Promise<DirEntry[]> {
			return blockMutating("list");
		},
		async stat(_p: string): Promise<FileStat> {
			return blockMutating("stat");
		},
		async writeTextFile(): Promise<void> {
			return blockMutating("writeTextFile");
		},
		async appendTextFile(): Promise<void> {
			return blockMutating("appendTextFile");
		},
		async mkdir(): Promise<void> {
			return blockMutating("mkdir");
		},
		async remove(): Promise<void> {
			return blockMutating("remove");
		},
	};
}
