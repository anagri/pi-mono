import { expect } from "vitest";

/**
 * Read an environment variable required by an e2e test, failing loudly if
 * it's missing. Loud-fail (rather than skip) is intentional — it surfaces
 * misconfigured environments at PR time instead of silently passing.
 */
export function requireEnv(name: string): string {
	const value = process.env[name];
	expect(value, `${name} must be set in e2e/.env.test to run e2e tests`).toBeTruthy();
	return value as string;
}
