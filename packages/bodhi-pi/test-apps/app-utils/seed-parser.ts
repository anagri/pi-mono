// Parses the seed-files textarea XML into a Record<path, content>.
//
// Format:
//   <files>
//   <file path="apple.txt">this file has nothing of interest</file>
//   <file path="dir/banana.txt">this file mentions banana once</file>
//   </files>
//
// Empty input (whitespace-only) yields an empty record. Throws on malformed
// XML or on missing required attributes.
//
// Browser-only API: uses DOMParser. This file should only be imported from
// browser-runtime contexts (browser/chrome-ext frontends, http frontend).
// Node-side Hosts (cli, http server) must not import this.

export function parseSeedFiles(raw: string): Record<string, string> {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return {};
	const doc = new DOMParser().parseFromString(trimmed, "application/xml");
	const parseError = doc.querySelector("parsererror");
	if (parseError) {
		throw new Error(`seed-files: invalid XML — ${parseError.textContent}`);
	}
	const root = doc.documentElement;
	if (!root || root.tagName !== "files") {
		throw new Error(`seed-files: root element must be <files>, got <${root?.tagName ?? "none"}>`);
	}
	const out: Record<string, string> = {};
	for (const el of Array.from(root.children)) {
		if (el.tagName !== "file") {
			throw new Error(`seed-files: unexpected child <${el.tagName}>, only <file> allowed`);
		}
		const filePath = el.getAttribute("path");
		if (!filePath) throw new Error("seed-files: <file> requires path attribute");
		if (filePath.startsWith("/")) {
			throw new Error(`seed-files: path must be relative, got "${filePath}"`);
		}
		out[filePath] = el.textContent ?? "";
	}
	return out;
}
