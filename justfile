default:
    @just --list

# Build → unit/integration → e2e for every bodhi-* workspace, in dep order.
test:
    @echo "▶ @bodhiapp/bodhi-pi  — build"
    npm --workspace @bodhiapp/bodhi-pi run build
    @echo "▶ @bodhiapp/bodhi-pi  — test (unit + integration)"
    npm --workspace @bodhiapp/bodhi-pi run test
    @echo "▶ @bodhiapp/bodhi-pi  — test:e2e"
    npm --workspace @bodhiapp/bodhi-pi run test:e2e
    @echo "▶ @bodhiapp/bodhi-pi-node  — build"
    npm --workspace @bodhiapp/bodhi-pi-node run build
    @echo "▶ @bodhiapp/bodhi-pi-node  — test"
    npm --workspace @bodhiapp/bodhi-pi-node run test
    @echo "▶ @bodhiapp/bodhi-pi-cli  — build"
    npm --workspace @bodhiapp/bodhi-pi-cli run build
    @echo "▶ @bodhiapp/bodhi-pi-cli  — test (unit + integration)"
    npm --workspace @bodhiapp/bodhi-pi-cli run test
    @echo "▶ @bodhiapp/bodhi-pi-cli  — test:e2e"
    npm --workspace @bodhiapp/bodhi-pi-cli run test:e2e
