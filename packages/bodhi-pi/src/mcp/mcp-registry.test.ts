import { describe, expect, it } from "vitest";
import type { McpConnectionProvider } from "./mcp-connection-provider.js";
import { McpRegistry } from "./mcp-registry.js";
import type { McpToolInfo } from "./mcp-types.js";

function stubProvider(toolsBySlug: Record<string, McpToolInfo[]>): McpConnectionProvider {
	return {
		connect: async () => ({ toolNames: [] }),
		disconnect: async () => {},
		reconnect: async () => ({ toolNames: [] }),
		getTools: () => undefined,
		getToolNames: (slug) => toolsBySlug[slug]?.map((t) => `${slug}__${t.name}`),
		getToolInfos: (slug) => toolsBySlug[slug],
		isConnected: (slug) => slug in toolsBySlug,
		listConnectedSlugs: () => Object.keys(toolsBySlug),
		onChange: () => () => {},
	};
}

describe("McpRegistry.getToolAnnotations", () => {
	it("returns annotations for an included tool with readOnlyHint", () => {
		const tools: McpToolInfo[] = [{ name: "read_file", annotations: { readOnlyHint: true } }];
		const registry = new McpRegistry(new Map(), stubProvider({ github: tools }));
		registry.setInclusion("s1", ["github"]);
		expect(registry.getToolAnnotations("s1", "github__read_file")).toEqual({ readOnlyHint: true });
	});

	it("returns annotations for a destructive tool", () => {
		const tools: McpToolInfo[] = [{ name: "delete_repo", annotations: { destructiveHint: true } }];
		const registry = new McpRegistry(new Map(), stubProvider({ github: tools }));
		registry.setInclusion("s1", ["github"]);
		expect(registry.getToolAnnotations("s1", "github__delete_repo")).toEqual({ destructiveHint: true });
	});

	it("returns undefined for a tool without annotations", () => {
		const tools: McpToolInfo[] = [{ name: "plain" }];
		const registry = new McpRegistry(new Map(), stubProvider({ github: tools }));
		registry.setInclusion("s1", ["github"]);
		expect(registry.getToolAnnotations("s1", "github__plain")).toBeUndefined();
	});

	it("returns undefined for a slug not included by the session", () => {
		const tools: McpToolInfo[] = [{ name: "read_file", annotations: { readOnlyHint: true } }];
		const registry = new McpRegistry(new Map(), stubProvider({ github: tools }));
		// note: session 's1' is NOT in inclusion
		expect(registry.getToolAnnotations("s1", "github__read_file")).toBeUndefined();
	});

	it("returns undefined for an unknown tool inside an included slug", () => {
		const tools: McpToolInfo[] = [{ name: "read_file" }];
		const registry = new McpRegistry(new Map(), stubProvider({ github: tools }));
		registry.setInclusion("s1", ["github"]);
		expect(registry.getToolAnnotations("s1", "github__unknown_tool")).toBeUndefined();
	});

	it("returns undefined for a malformed name (no __ separator)", () => {
		const registry = new McpRegistry(new Map(), stubProvider({ github: [] }));
		registry.setInclusion("s1", ["github"]);
		expect(registry.getToolAnnotations("s1", "no_separator")).toBeUndefined();
	});

	it("preserves all annotation fields", () => {
		const tools: McpToolInfo[] = [
			{
				name: "complex",
				annotations: {
					title: "Complex Tool",
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: true,
				},
			},
		];
		const registry = new McpRegistry(new Map(), stubProvider({ srv: tools }));
		registry.setInclusion("s1", ["srv"]);
		expect(registry.getToolAnnotations("s1", "srv__complex")).toEqual({
			title: "Complex Tool",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
	});
});
