import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { expect } from "vitest";

export type SelectOption = SessionConfigOption & { type: "select" };

/** Narrow a `SessionConfigOption` to the `select` shape, asserting on the way. */
export function asSelectOption(opt: SessionConfigOption | undefined): SelectOption {
	expect(opt, "expected a SessionConfigOption").toBeDefined();
	expect(opt?.type).toBe("select");
	return opt as SelectOption;
}
