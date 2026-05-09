default:
    @just --list

# Copy untracked .env* files from the main worktree into the current worktree, then npm install.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
    here=$(git rev-parse --show-toplevel)
    if [ "$main" = "$here" ]; then
        echo "Already in main worktree ($main); skipping .env* copy."
    else
        echo "Copying .env* from $main → $here"
        cd "$main"
        find . -type f -name '.env*' -not -name '*.example' \
            -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 |
        while IFS= read -r -d '' f; do
            rel=${f#./}
            dest="$here/$rel"
            mkdir -p "$(dirname "$dest")"
            cp "$f" "$dest"
            echo "  $rel"
        done
    fi
    echo "▶ npm install (workspace root)"
    cd "$here"
    npm install

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
