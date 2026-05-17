import type { SetupFormValues } from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";
import type { FormEvent } from "react";

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
		<form className="setup-form" data-testid="setup-form" onSubmit={handleSubmit}>
			<div className="setup-form-row">
				<label htmlFor="setup-user-id">user-id</label>
				<input id="setup-user-id" data-testid="user-id" name="user-id" type="text" required />
			</div>
			<div className="setup-form-row">
				<label htmlFor="setup-user-email">user-email</label>
				<input id="setup-user-email" data-testid="user-email" name="user-email" type="text" required />
			</div>
			<div className="setup-form-row">
				<label htmlFor="setup-seed">seed-files</label>
				<textarea id="setup-seed" data-testid="seed-files" name="seed-files" rows={8} />
			</div>
			<div className="setup-form-row">
				<label htmlFor="setup-config">config</label>
				<textarea id="setup-config" data-testid="config" name="config" rows={8} />
			</div>
			<button className="setup-form-submit" data-testid="setup-submit" type="submit">
				setup
			</button>
		</form>
	);
}
