export interface TestUser {
	id: number;
	email: string;
}

// Mirror of packages/bodhi-pi-http/src/server/auth/token.ts encodeToken — no signature, PoC trust posture.
export function mintTestToken(user: TestUser = { id: 1, email: "test@example.com" }): string {
	return Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
}
