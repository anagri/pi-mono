export interface UserCtx {
	id: number;
	email: string;
}

const STORAGE_KEY = "bodhi-pi-http.token";

/** Browser-side `encodeToken` — base64url JSON. Mirrors server `encodeToken`. */
export function encodeToken(user: UserCtx): string {
	const json = JSON.stringify(user);
	return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeToken(token: string): UserCtx {
	const padded = token.replace(/-/g, "+").replace(/_/g, "/");
	const json = atob(padded);
	const parsed = JSON.parse(json) as { id?: unknown; email?: unknown };
	if (typeof parsed.id !== "number" || typeof parsed.email !== "string") {
		throw new Error("invalid token shape");
	}
	return { id: parsed.id, email: parsed.email };
}

export function loadStoredToken(): string | undefined {
	const raw = localStorage.getItem(STORAGE_KEY);
	return raw ?? undefined;
}

export function storeToken(token: string): void {
	localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken(): void {
	localStorage.removeItem(STORAGE_KEY);
}
