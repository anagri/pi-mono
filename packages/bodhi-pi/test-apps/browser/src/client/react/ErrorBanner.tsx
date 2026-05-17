export function ErrorBanner({ message }: { message: string }) {
	return (
		<p data-testid="error-message" role="alert">
			{message}
		</p>
	);
}
