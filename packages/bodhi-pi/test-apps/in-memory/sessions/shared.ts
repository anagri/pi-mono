import type { ExtensionEntry, SessionEntry } from "@bodhiapp/bodhi-pi";

// Shared payload parsers + pagination constant for the single- and
// multi-tenant SQLite session stores. Each tenant store layers its own
// scoping on top — single-tenant has no tenant column; multi-tenant scopes
// every read/write by userId — but the row -> SessionEntry / ExtensionEntry
// decoding and base64url cursor format are identical.

export const PAGE_SIZE = 50;

export function parseSessionEntry(payload: string): SessionEntry {
	const parsed: unknown = JSON.parse(payload);
	if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
		throw new Error(`SessionEntry payload missing discriminator field 'type'`);
	}
	return parsed as SessionEntry;
}

export function parseExtensionEntry(payload: string): ExtensionEntry {
	const parsed: unknown = JSON.parse(payload);
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`ExtensionEntry payload is not an object`);
	}
	const obj = parsed as { type?: unknown; extensionName?: unknown; customType?: unknown };
	if (obj.type !== "extension" || typeof obj.extensionName !== "string" || typeof obj.customType !== "string") {
		throw new Error(`ExtensionEntry payload missing 'extensionName' or 'customType'`);
	}
	return parsed as ExtensionEntry;
}

export interface PageCursor {
	updatedAt: number;
	id: string;
}

export function parseCursor(raw: string | undefined): PageCursor | undefined {
	if (!raw) return undefined;
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(raw, "base64url").toString());
	} catch {
		return undefined;
	}
	if (!decoded || typeof decoded !== "object") return undefined;
	const cur = decoded as { updatedAt?: unknown; id?: unknown };
	if (typeof cur.updatedAt !== "number" || typeof cur.id !== "string") return undefined;
	return { updatedAt: cur.updatedAt, id: cur.id };
}

export function encodeCursor(cursor: PageCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
