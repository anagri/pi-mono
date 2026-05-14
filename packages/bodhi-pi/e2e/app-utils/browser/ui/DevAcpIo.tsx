export interface DevAcpIoProps {
	workspaceRoot: string;
	value: string;
	onChange(v: string): void;
	onSubmit(): void;
	onCancel(): void;
}

export function DevAcpIo({ workspaceRoot, value, onChange, onSubmit, onCancel }: DevAcpIoProps) {
	return (
		<section data-testid="acp-io">
			<p data-testid="workspace-root">{workspaceRoot}</p>
			<textarea
				data-testid="acp-input"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				rows={6}
				cols={80}
			/>
			<div>
				<button data-testid="acp-submit" type="button" onClick={onSubmit}>
					submit
				</button>
				<button data-testid="acp-cancel" type="button" onClick={onCancel}>
					cancel
				</button>
			</div>
		</section>
	);
}
