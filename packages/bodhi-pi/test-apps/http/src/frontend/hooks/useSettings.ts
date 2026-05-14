import { useCallback, useEffect, useState } from "react";

export interface Settings {
	email: string;
	id: number;
	sendToken: boolean;
}

const STORAGE_KEY = "bodhi-pi-http.settings";

const DEFAULT: Settings = {
	email: "alice@example.com",
	id: 1,
	sendToken: true,
};

function load(): Settings {
	if (typeof window === "undefined") return DEFAULT;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT;
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return {
			email: typeof parsed.email === "string" ? parsed.email : DEFAULT.email,
			id: typeof parsed.id === "number" && Number.isFinite(parsed.id) ? parsed.id : DEFAULT.id,
			sendToken: typeof parsed.sendToken === "boolean" ? parsed.sendToken : DEFAULT.sendToken,
		};
	} catch {
		return DEFAULT;
	}
}

export function useSettings() {
	const [settings, setSettings] = useState<Settings>(load);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch {
			// ignore quota / private mode
		}
	}, [settings]);

	const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
		setSettings((s) => ({ ...s, [key]: value }));
	}, []);

	return { settings, update };
}
