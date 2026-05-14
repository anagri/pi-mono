// Never throws — used by hook-level cleanup paths where a hanging cleanup
// would otherwise consume the entire afterEach budget.
export async function withTimeout<T>(label: string, ms: number, op: () => Promise<T>): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			console.warn(`[bodhi-pi e2e] cleanup "${label}" exceeded ${ms}ms; abandoning`);
			resolve(undefined);
		}, ms);
	});
	try {
		return await Promise.race([
			op().catch((err) => {
				console.warn(`[bodhi-pi e2e] cleanup "${label}" threw:`, err);
				return undefined;
			}),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
