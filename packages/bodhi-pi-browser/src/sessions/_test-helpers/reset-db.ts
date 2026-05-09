/**
 * Test-only helper: delete a Dexie/IndexedDB database between tests so the
 * `fake-indexeddb` polyfill doesn't carry state across vitest cases.
 *
 * Lives under `_test-helpers/` (not exported from `src/index.ts`) per the
 * "test fixtures stay out of the publishable surface" rule in CLAUDE.md.
 */
export async function resetDb(dbName: string): Promise<void> {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}
