import { describe, expect, it } from "vitest";
import { decodeToken, encodeToken } from "./token.js";

describe("auth token", () => {
	it("encodes and decodes a round-trip", () => {
		const u = { id: 7, email: "carol@example.com" };
		const tok = encodeToken(u);
		expect(decodeToken(tok)).toEqual(u);
	});

	it("rejects malformed base64", () => {
		expect(() => decodeToken("!!!notbase64!!!")).toThrow();
	});

	it("rejects token with non-numeric id", () => {
		const bad = Buffer.from(JSON.stringify({ id: "x", email: "a@b" }), "utf8").toString("base64url");
		expect(() => decodeToken(bad)).toThrow(/id must be a finite number/);
	});

	it("rejects token with empty email", () => {
		const bad = Buffer.from(JSON.stringify({ id: 1, email: "" }), "utf8").toString("base64url");
		expect(() => decodeToken(bad)).toThrow(/email must be a non-empty string/);
	});

	it("rejects token whose JSON is not an object", () => {
		const bad = Buffer.from('"hi"', "utf8").toString("base64url");
		expect(() => decodeToken(bad)).toThrow(/not an object/);
	});
});
