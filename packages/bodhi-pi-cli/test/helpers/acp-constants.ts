export const stdInitParams = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;
