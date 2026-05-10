import { buildResolvedEnv, type ResolvedEnv } from "@bodhiapp/bodhi-pi-browser";

export const env: ResolvedEnv = buildResolvedEnv((key) => {
	const v = (import.meta.env as Record<string, string | undefined>)[key];
	return typeof v === "string" ? v : undefined;
});
