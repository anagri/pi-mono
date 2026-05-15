import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JsonValue } from "../kv/kv-store.js";
import { callMcpTool } from "./mcp-client.js";
import type { McpToolInfo } from "./mcp-types.js";

export function toolName(slug: string, original: string): string {
	return `${slug}__${original}`;
}

export function parseToolName(name: string): { slug: string; original: string } | null {
	const idx = name.indexOf("__");
	if (idx <= 0) return null;
	return { slug: name.slice(0, idx), original: name.slice(idx + 2) };
}

export function adaptMcpTool(slug: string, info: McpToolInfo, client: Client): AgentTool {
	const namespaced = toolName(slug, info.name);
	const parameters = normalizeInputSchema(info.inputSchema);
	const description = info.description ?? `MCP tool ${info.name} from ${slug}`;
	return {
		name: namespaced,
		label: `mcp:${slug}:${info.name}`,
		description,
		parameters,
		execute: async (_toolCallId: string, args: unknown) => {
			const safeArgs = (args ?? {}) as Record<string, unknown>;
			const { content, isError } = await callMcpTool(client, info.name, safeArgs);
			return buildToolResult(content, isError);
		},
	} as unknown as AgentTool;
}

function normalizeInputSchema(schema: JsonValue | undefined): JsonValue {
	if (schema === undefined || schema === null) return { type: "object", properties: {}, additionalProperties: false };
	if (typeof schema !== "object" || Array.isArray(schema)) return { type: "object" };
	const obj = schema as { [k: string]: JsonValue };
	if (obj.type === undefined) return { type: "object", ...obj };
	return obj;
}

function buildToolResult(rawContent: unknown, isError: boolean): AgentToolResult<unknown> {
	const content = normalizeContent(rawContent);
	return {
		content,
		isError,
		details: undefined,
	} as AgentToolResult<unknown>;
}

interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

function normalizeContent(rawContent: unknown): Array<{ type: "text"; text: string }> {
	if (typeof rawContent === "string") return [{ type: "text", text: rawContent }];
	if (!Array.isArray(rawContent)) return [{ type: "text", text: JSON.stringify(rawContent) }];
	const out: Array<{ type: "text"; text: string }> = [];
	for (const block of rawContent as McpContentBlock[]) {
		if (block && typeof block === "object") {
			if (block.type === "text" && typeof block.text === "string") {
				out.push({ type: "text", text: block.text });
			} else if (block.type === "image" || block.type === "resource") {
				out.push({ type: "text", text: `[mcp ${block.type}]` });
			} else {
				out.push({ type: "text", text: JSON.stringify(block) });
			}
		}
	}
	if (out.length === 0) out.push({ type: "text", text: "" });
	return out;
}
