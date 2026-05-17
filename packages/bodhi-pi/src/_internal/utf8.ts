/**
 * Runtime-neutral UTF-8 byte helpers. Replace Node's `Buffer.byteLength` /
 * `Buffer.from(...).subarray(...).toString(...)` so the core works in
 * browser/Worker bundles without `vite-plugin-node-polyfills` shipping
 * `Buffer` as a global.
 *
 * Both `TextEncoder` and `TextDecoder` are universal (Node ≥11, all browsers,
 * Web Workers, MV3 service workers).
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export function byteLengthUtf8(value: string): number {
	return encoder.encode(value).length;
}

/**
 * Truncate `value` to at most `maxBytes` UTF-8 bytes. The result is decoded
 * back to a string; a truncation that lands inside a multi-byte codepoint
 * produces a replacement character (`U+FFFD`), matching the user-visible
 * behaviour of `Buffer.from(...).subarray(...).toString("utf-8")`.
 */
export function truncateBytesUtf8(value: string, maxBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.length <= maxBytes) return value;
	return decoder.decode(bytes.subarray(0, maxBytes));
}
