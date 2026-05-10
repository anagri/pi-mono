export interface UserCtx {
	id: number;
	email: string;
}

export function encodeToken(user: UserCtx): string {
	return Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
}

export function decodeToken(token: string): UserCtx {
	const json = Buffer.from(token, "base64url").toString("utf8");
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("token: not an object");
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) {
		throw new Error("token: id must be a finite number");
	}
	if (typeof obj.email !== "string" || obj.email.length === 0) {
		throw new Error("token: email must be a non-empty string");
	}
	return { id: obj.id, email: obj.email };
}
