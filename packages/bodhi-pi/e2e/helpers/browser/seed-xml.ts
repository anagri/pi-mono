// Wire format for the `data-testid="seed-files"` field on test-app-browser /
// test-app-chrome-ext. The page-side seed parser (test-app-*/src/.../lib/seed-parser.ts)
// expects `<files><file path="...">...</file></files>` with XML-escaped content
// and `&quot;`-escaped attribute values.

export function buildSeedXml(seedFiles: Record<string, string>): string {
	if (Object.keys(seedFiles).length === 0) return "";
	const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const xmlEscapeAttr = (s: string) => xmlEscape(s).replace(/"/g, "&quot;");
	const lines = ["<files>"];
	for (const [p, content] of Object.entries(seedFiles)) {
		lines.push(`<file path="${xmlEscapeAttr(p)}">${xmlEscape(content)}</file>`);
	}
	lines.push("</files>");
	return lines.join("\n");
}
