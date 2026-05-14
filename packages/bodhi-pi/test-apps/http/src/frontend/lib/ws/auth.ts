export interface UserCtx {
	id: number;
	email: string;
}

export function encodeToken(user: UserCtx): string {
	const json = JSON.stringify(user);
	// Browser btoa returns base64 with +/=; convert to base64url.
	return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
