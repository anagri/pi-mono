/** Standard ACP `initialize` params used by every test. */
export const stdInitParams = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;
