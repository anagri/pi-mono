import type { FormEvent } from "react";

export interface SetupFormValues {
	userId: string;
	userEmail: string;
	seed: string;
	configRaw: string;
}

export interface SetupFormProps {
	onSubmit(values: SetupFormValues): void;
}

export function SetupForm({ onSubmit }: SetupFormProps) {
	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		onSubmit({
			userId: String(form.get("user-id") ?? "").trim(),
			userEmail: String(form.get("user-email") ?? "").trim(),
			seed: String(form.get("seed-files") ?? ""),
			configRaw: String(form.get("config") ?? "").trim(),
		});
	};
	return (
		<form data-testid="setup-form" onSubmit={handleSubmit}>
			<label>
				user-id
				<input data-testid="user-id" name="user-id" type="text" required />
			</label>
			<label>
				user-email
				<input data-testid="user-email" name="user-email" type="text" required />
			</label>
			<label>
				seed-files
				<textarea data-testid="seed-files" name="seed-files" rows={8} cols={60} />
			</label>
			<label>
				config
				<textarea data-testid="config" name="config" rows={8} cols={60} />
			</label>
			<button data-testid="setup-submit" type="submit">
				setup
			</button>
		</form>
	);
}
