/**
 * Host-injected filesystem the agent uses for every file operation.
 *
 * bodhi-pi never imports `node:fs` directly. Hosts construct a `Filesystem`
 * (Node-fs adapter, in-memory, OPFS, S3, etc.) and pass it via
 * `BodhiPiConfig.filesystem`. There is no default fallback.
 *
 * This is *not* the ACP `fs/read_text_file` / `fs/write_text_file` mechanism.
 * Those let an agent fetch files from a remote client (e.g., browser IDE).
 * bodhi-pi's `Filesystem` is the local handle the host gives the agent.
 */
export interface Filesystem {
	/** Read a UTF-8 text file. Rejects if the path is missing or is a directory. */
	readTextFile(absolutePath: string): Promise<string>;

	/** Overwrite (or create) a UTF-8 text file. Caller must ensure parent dir exists. */
	writeTextFile(absolutePath: string, content: string): Promise<void>;

	/** Direct children of the directory. Rejects if path is not a directory. */
	list(absolutePath: string): Promise<DirEntry[]>;

	/** stat — rejects if path doesn't exist. */
	stat(absolutePath: string): Promise<FileStat>;

	/** Cheap existence check. Never rejects; returns false on any error. */
	exists(absolutePath: string): Promise<boolean>;

	/** Create a directory. `recursive: true` is a no-op if it already exists. */
	mkdir(absolutePath: string, opts?: { recursive?: boolean }): Promise<void>;

	/** Delete a file or directory. `recursive: true` removes a non-empty dir. */
	remove(absolutePath: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface DirEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
}

export interface FileStat {
	isFile: boolean;
	isDirectory: boolean;
	size: number;
	mtimeMs: number;
}
