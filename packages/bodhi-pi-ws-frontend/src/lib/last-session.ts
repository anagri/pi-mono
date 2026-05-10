const PREFIX = "bodhi-pi-ws:lastSession";

function key(serverUrl: string, userId: number | string): string {
	return `${PREFIX}:${serverUrl}:${userId}`;
}

export function read(serverUrl: string, userId: number | string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(key(serverUrl, userId));
	} catch {
		return null;
	}
}

export function write(serverUrl: string, userId: number | string, sessionId: string): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(key(serverUrl, userId), sessionId);
	} catch {
		// quota / private mode — ignore
	}
}

export function clear(serverUrl: string, userId: number | string): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(key(serverUrl, userId));
	} catch {
		// ignore
	}
}
