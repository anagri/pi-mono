export function encodeKey(key: string): string {
	return key.replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function decodeKey(filename: string): string {
	return filename.replace(/%2F/g, "/").replace(/%25/g, "%");
}
