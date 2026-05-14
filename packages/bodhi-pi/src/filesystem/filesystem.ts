/**
 * Host-injected filesystem. Paths are POSIX-absolute. Every method except `exists` rejects on
 * failure; `exists` returns `false` on any error. `writeTextFile` does NOT auto-create parent
 * dirs — the agent calls `mkdir({ recursive: true })` before settings writes.
 *
 * Not the ACP `fs/*` mechanism: those let a remote agent fetch files from a client; this is the
 * local handle bodhi-pi runs against.
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
