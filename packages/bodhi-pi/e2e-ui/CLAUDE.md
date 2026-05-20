# bodhi-pi/e2e-ui

**Self-contained and fully bootstrapped.** Playwright browsers, all frameworks, the spawned test-app servers (http/ws), and API keys are installed/provisioned — run this suite directly with `npm --workspace @bodhiapp/bodhi-pi-e2e-ui test` (or `just test-e2e-ui`). No manual setup or external services required.

Scope a run with a filename filter (`npm --workspace @bodhiapp/bodhi-pi-e2e-ui test -- ask-mode`) or a project (`--project=http|ws|browser|chrome-ext`). The same `e2e-ui/shared/*.spec.ts` files run under all four projects; per-project transport wiring lives in `playwright.config.ts`.
