import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { authenticateRequest, extractBearerToken } from "./middleware.js";
import { encodeToken } from "./token.js";

function fakeReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
	return { headers } as unknown as IncomingMessage;
}

describe("auth middleware", () => {
	it("extracts a Bearer token", () => {
		const req = fakeReq({ authorization: "Bearer abc.def" });
		expect(extractBearerToken(req)).toBe("abc.def");
	});

	it("returns undefined when missing", () => {
		expect(extractBearerToken(fakeReq({}))).toBeUndefined();
	});

	it("returns undefined when wrong scheme", () => {
		expect(extractBearerToken(fakeReq({ authorization: "Basic abc" }))).toBeUndefined();
	});

	it("authenticateRequest succeeds with a valid bearer", () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const req = fakeReq({ authorization: `Bearer ${tok}` });
		expect(authenticateRequest(req)).toEqual({ id: 1, email: "alice@example.com" });
	});

	it("authenticateRequest throws without auth header", () => {
		expect(() => authenticateRequest(fakeReq({}))).toThrow();
	});

	it("authenticateRequest throws on malformed token", () => {
		const req = fakeReq({ authorization: "Bearer !!!notbase64!!!" });
		expect(() => authenticateRequest(req)).toThrow();
	});
});
