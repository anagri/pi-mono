import { describe, expect, it } from "vitest";
import { decodeToken, encodeToken } from "../../src/auth/token.js";

describe("token codec", () => {
	it("round-trips a valid user", () => {
		const user = { id: 42, email: "alice@example.com" };
		const token = encodeToken(user);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeToken(token)).toEqual(user);
	});

	it("rejects malformed base64", () => {
		expect(() => decodeToken("!!!not-base64!!!")).toThrow();
	});

	it("rejects non-JSON payload", () => {
		const token = Buffer.from("not json", "utf8").toString("base64url");
		expect(() => decodeToken(token)).toThrow();
	});

	it("rejects missing id", () => {
		const token = Buffer.from(JSON.stringify({ email: "a@b.c" }), "utf8").toString("base64url");
		expect(() => decodeToken(token)).toThrow(/id/);
	});

	it("rejects non-numeric id", () => {
		const token = Buffer.from(JSON.stringify({ id: "1", email: "a@b.c" }), "utf8").toString("base64url");
		expect(() => decodeToken(token)).toThrow(/id/);
	});

	it("rejects missing email", () => {
		const token = Buffer.from(JSON.stringify({ id: 1 }), "utf8").toString("base64url");
		expect(() => decodeToken(token)).toThrow(/email/);
	});

	it("rejects empty email", () => {
		const token = Buffer.from(JSON.stringify({ id: 1, email: "" }), "utf8").toString("base64url");
		expect(() => decodeToken(token)).toThrow(/email/);
	});
});
