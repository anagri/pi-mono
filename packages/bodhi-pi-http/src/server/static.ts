import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

/**
 * File server for `dist/public/`. Returns `true` if it served the request.
 *
 * SPA fallback: any GET that doesn't match a real file under `rootDir` and
 * isn't an API path falls through to `index.html` so React Router (or hash
 * routing if we ever add it) works.
 *
 * Returns a no-op handler when `rootDir/index.html` doesn't exist (dev mode
 * where Vite serves the frontend directly).
 */
export function createStaticHandler(rootDir: string): StaticHandler {
	let indexHtmlPath: string | undefined;
	try {
		const candidate = path.resolve(rootDir, "index.html");
		statSync(candidate);
		indexHtmlPath = candidate;
	} catch {
		indexHtmlPath = undefined;
	}

	return (req, res) => {
		if (!indexHtmlPath) return false;
		if (req.method !== "GET") return false;
		const url = req.url ?? "/";
		// API paths must NOT be intercepted.
		if (url === "/acp" || url === "/healthz" || url.startsWith("/acp/") || url.startsWith("/healthz?")) return false;

		const cleanPath = url.split("?")[0].split("#")[0];
		const safeRel = cleanPath.replace(/^\/+/, "").replace(/\.\.+/g, "");
		const candidate = path.resolve(rootDir, safeRel);

		// Only serve files within rootDir. (path.resolve normalizes; check prefix.)
		if (!candidate.startsWith(rootDir)) return false;

		try {
			const stat = statSync(candidate);
			if (stat.isFile()) {
				return serveFile(res, candidate, stat.size);
			}
		} catch {
			// fall through to SPA fallback
		}

		// SPA fallback to index.html
		try {
			const stat = statSync(indexHtmlPath);
			return serveFile(res, indexHtmlPath, stat.size);
		} catch {
			return false;
		}
	};
}

function serveFile(res: ServerResponse, filePath: string, size: number): boolean {
	const ext = path.extname(filePath).toLowerCase();
	const mime = MIME[ext] ?? "application/octet-stream";
	res.writeHead(200, {
		"content-type": mime,
		"content-length": size,
	});
	createReadStream(filePath).pipe(res);
	return true;
}
