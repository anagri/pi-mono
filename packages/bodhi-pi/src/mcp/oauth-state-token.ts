export function makeStateToken(tenantId: string | undefined): string {
	const arr = new Uint8Array(24);
	globalThis.crypto.getRandomValues(arr);
	const random = base64UrlEncodeBytes(arr);
	if (tenantId === undefined) return random;
	return `${base64UrlEncodeString(tenantId)}.${random}`;
}

export function decodeTenantFromState(state: string): string | null {
	const idx = state.indexOf(".");
	if (idx <= 0) return null;
	try {
		return base64UrlDecodeToString(state.slice(0, idx));
	} catch {
		return null;
	}
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return globalThis.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(s));
}

function base64UrlDecodeToString(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = globalThis.atob(padded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder("utf-8").decode(bytes);
}
