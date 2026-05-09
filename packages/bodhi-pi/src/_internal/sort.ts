/**
 * Stable, locale-aware ascending name sort. Used by skill + slash-command
 * discovery so the agent advertises a deterministic order to the host.
 */
export function byName<T extends { name: string }>(a: T, b: T): number {
	return a.name.localeCompare(b.name);
}
