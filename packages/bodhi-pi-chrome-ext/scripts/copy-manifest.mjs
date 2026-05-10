#!/usr/bin/env node
/** Post-build copy of manifest.json + public/icons/* into dist/. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");

if (!existsSync(dist)) {
	console.error(`dist/ not found — run vite build first.`);
	process.exit(1);
}

copyFileSync(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
console.log("copied manifest.json -> dist/manifest.json");

const iconsSrc = resolve(root, "public", "icons");
if (existsSync(iconsSrc)) {
	const iconsDst = resolve(dist, "icons");
	if (!existsSync(iconsDst)) mkdirSync(iconsDst, { recursive: true });
	for (const f of readdirSync(iconsSrc)) {
		const src = join(iconsSrc, f);
		if (statSync(src).isFile()) {
			copyFileSync(src, join(iconsDst, f));
		}
	}
	console.log("copied public/icons/* -> dist/icons/");
}

for (const required of ["index.html", "background.js"]) {
	if (!existsSync(resolve(dist, required))) {
		console.error(`expected ${required} in dist/ but it's missing`);
		process.exit(1);
	}
}

console.log("dist/ is loadable as an unpacked extension.");
