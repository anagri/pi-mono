#!/usr/bin/env node
/**
 * Enforce the host/ ↔ client/ seam in `packages/bodhi-pi/test-apps/<host>/src/`.
 *
 * Rule: a file under `<test-app>/src/host/` MAY NOT relative-import from `<test-app>/src/client/`,
 * and vice versa. Cross-package imports (`@bodhiapp/...`, `@earendil-works/...`, npm packages)
 * are unrestricted — they cross at the package boundary on purpose.
 *
 * Exception: put `// seam-exception: <reason>` on the line immediately above the import
 * statement (or `// seam-exception: <reason>` on the SAME line, trailing the import).
 * Each exception must include a human-readable reason.
 *
 * Runs as part of `npm run check` at the repo root. Fast (regex-based, no AST).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TEST_APPS = ["cli", "http", "browser", "chrome-ext"];

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
	}
	return out;
}

function isInSubtree(file, subtree) {
	const rel = relative(subtree, file);
	return rel && !rel.startsWith("..") && !resolve(subtree, rel).startsWith("..");
}

const IMPORT_RE = /^\s*(?:import|export)\b[^"';\n]*\bfrom\s+["']([^"']+)["']/;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXCEPTION_RE = /\/\/\s*seam-exception:\s*\S+/;

const violations = [];

for (const app of TEST_APPS) {
	const appRoot = join(ROOT, "packages", "bodhi-pi", "test-apps", app, "src");
	const hostDir = join(appRoot, "host");
	const clientDir = join(appRoot, "client");
	const files = [...walk(hostDir), ...walk(clientDir)];
	for (const file of files) {
		const inHost = isInSubtree(file, hostDir);
		const forbidden = inHost ? clientDir : hostDir;
		const side = inHost ? "host" : "client";
		const otherSide = inHost ? "client" : "host";
		const src = readFileSync(file, "utf8");
		const lines = src.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const staticMatch = line.match(IMPORT_RE);
			const specs = [];
			if (staticMatch) specs.push(staticMatch[1]);
			DYNAMIC_IMPORT_RE.lastIndex = 0;
			let m;
			while ((m = DYNAMIC_IMPORT_RE.exec(line)) !== null) specs.push(m[1]);
			for (const spec of specs) {
				if (!spec.startsWith(".")) continue;
				const resolved = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
				const tryPaths = [
					resolved,
					resolved.replace(/\.ts$/, ".tsx"),
					join(resolved.replace(/\.tsx?$/, ""), "index.ts"),
					join(resolved.replace(/\.tsx?$/, ""), "index.tsx"),
				];
				const crosses = tryPaths.some((p) => isInSubtree(p, forbidden));
				if (!crosses) continue;
				const prev = lines[i - 1] ?? "";
				const sameLineComment = line.split("//").slice(1).join("//");
				if (EXCEPTION_RE.test(prev) || EXCEPTION_RE.test(`//${sameLineComment}`)) continue;
				violations.push({
					file: relative(ROOT, file),
					line: i + 1,
					spec,
					side,
					otherSide,
				});
			}
		}
	}
}

if (violations.length) {
	console.error("\n✗ host/ ↔ client/ seam violations:\n");
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}`);
		console.error(`    ${v.side}/ file imports from ${v.otherSide}/: ${v.spec}`);
	}
	console.error(
		`\nFound ${violations.length} violation(s). Each ${"`host/`"} file must not relative-import from ${"`client/`"} (and vice versa).`,
	);
	console.error(`Add ${"`// seam-exception: <reason>`"} on the line ABOVE the import (or trailing) to suppress.`);
	process.exit(1);
}

console.log(`✓ host/client seam clean across ${TEST_APPS.length} test-apps`);
