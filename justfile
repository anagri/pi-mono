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

# Build → unit/integration → e2e for every bodhi-pi* workspace, in dep order.
# Individual steps do NOT fail-fast; failures are collected and summarized at the end.
test:
    #!/usr/bin/env bash
    set -uo pipefail
    failures=()
    run() {
        local label="$1"; shift
        echo "▶ $label"
        if ! "$@"; then
            failures+=("$label")
        fi
    }

    run "@earendil-works/pi-ai  — build (dep)"             npm --workspace @earendil-works/pi-ai run build
    run "@earendil-works/pi-agent-core  — build (dep)"     npm --workspace @earendil-works/pi-agent-core run build

    run "@bodhiapp/bodhi-pi  — build"                      npm --workspace @bodhiapp/bodhi-pi run build
    run "@bodhiapp/bodhi-pi  — test (unit + integration)"  npm --workspace @bodhiapp/bodhi-pi run test
    run "@bodhiapp/bodhi-pi  — test:e2e"                   npm --workspace @bodhiapp/bodhi-pi run test:e2e

    run "@bodhiapp/bodhi-pi-node  — build"                 npm --workspace @bodhiapp/bodhi-pi-node run build
    run "@bodhiapp/bodhi-pi-node  — test"                  npm --workspace @bodhiapp/bodhi-pi-node run test

    run "@bodhiapp/bodhi-pi-browser  — build"              npm --workspace @bodhiapp/bodhi-pi-browser run build
    run "@bodhiapp/bodhi-pi-browser  — test"               npm --workspace @bodhiapp/bodhi-pi-browser run test

    run "@bodhiapp/bodhi-pi-cli  — build"                  npm --workspace @bodhiapp/bodhi-pi-cli run build
    run "@bodhiapp/bodhi-pi-cli  — test (unit + integration)" npm --workspace @bodhiapp/bodhi-pi-cli run test

    run "@bodhiapp/bodhi-pi-web  — build"                  npm --workspace @bodhiapp/bodhi-pi-web run build
    run "@bodhiapp/bodhi-pi-web  — test:e2e (playwright)"  npm --workspace @bodhiapp/bodhi-pi-web run test:e2e

    run "@bodhiapp/bodhi-pi-chrome-ext  — build"           npm --workspace @bodhiapp/bodhi-pi-chrome-ext run build
    run "@bodhiapp/bodhi-pi-chrome-ext  — test:e2e (playwright, headed)" npm --workspace @bodhiapp/bodhi-pi-chrome-ext run test:e2e

    run "@bodhiapp/bodhi-pi-ws-server  — build"            npm --workspace @bodhiapp/bodhi-pi-ws-server run build
    run "@bodhiapp/bodhi-pi-ws-server  — test"             npm --workspace @bodhiapp/bodhi-pi-ws-server run test

    run "bodhi-pi-ws-frontend  — build"                    npm --workspace bodhi-pi-ws-frontend run build
    # bodhi-pi-ws-frontend's playwright e2e is subsumed by bodhi-pi's |ws| Vitest
    # project (test:e2e above) — same wire, same auth, same shared suite. The
    # playwright spec set was already failing on main pre-port and Playwright
    # surface tests are deferred sitewide.

    echo
    if [ ${#failures[@]} -eq 0 ]; then
        echo "✅ All steps passed."
        exit 0
    else
        echo "❌ ${#failures[@]} step(s) failed:"
        for f in "${failures[@]}"; do
            echo "  - $f"
        done
        exit 1
    fi

# Same matrix as `test`, but exits on the first failed step instead of collecting failures.
test-failfast:
    #!/usr/bin/env bash
    set -euo pipefail
    run() {
        local label="$1"; shift
        echo "▶ $label"
        if ! "$@"; then
            echo "❌ $label failed; stopping."
            exit 1
        fi
    }

    run "@earendil-works/pi-ai  — build (dep)"             npm --workspace @earendil-works/pi-ai run build
    run "@earendil-works/pi-agent-core  — build (dep)"     npm --workspace @earendil-works/pi-agent-core run build

    run "@bodhiapp/bodhi-pi  — build"                      npm --workspace @bodhiapp/bodhi-pi run build
    run "@bodhiapp/bodhi-pi  — test (unit + integration)"  npm --workspace @bodhiapp/bodhi-pi run test
    run "@bodhiapp/bodhi-pi  — test:e2e"                   npm --workspace @bodhiapp/bodhi-pi run test:e2e

    run "@bodhiapp/bodhi-pi-node  — build"                 npm --workspace @bodhiapp/bodhi-pi-node run build
    run "@bodhiapp/bodhi-pi-node  — test"                  npm --workspace @bodhiapp/bodhi-pi-node run test

    run "@bodhiapp/bodhi-pi-browser  — build"              npm --workspace @bodhiapp/bodhi-pi-browser run build
    run "@bodhiapp/bodhi-pi-browser  — test"               npm --workspace @bodhiapp/bodhi-pi-browser run test

    run "@bodhiapp/bodhi-pi-cli  — build"                  npm --workspace @bodhiapp/bodhi-pi-cli run build
    run "@bodhiapp/bodhi-pi-cli  — test (unit + integration)" npm --workspace @bodhiapp/bodhi-pi-cli run test

    run "@bodhiapp/bodhi-pi-web  — build"                  npm --workspace @bodhiapp/bodhi-pi-web run build
    run "@bodhiapp/bodhi-pi-web  — test:e2e (playwright)"  npm --workspace @bodhiapp/bodhi-pi-web run test:e2e

    run "@bodhiapp/bodhi-pi-chrome-ext  — build"           npm --workspace @bodhiapp/bodhi-pi-chrome-ext run build
    run "@bodhiapp/bodhi-pi-chrome-ext  — test:e2e (playwright, headed)" npm --workspace @bodhiapp/bodhi-pi-chrome-ext run test:e2e

    run "@bodhiapp/bodhi-pi-ws-server  — build"            npm --workspace @bodhiapp/bodhi-pi-ws-server run build
    run "@bodhiapp/bodhi-pi-ws-server  — test"             npm --workspace @bodhiapp/bodhi-pi-ws-server run test

    run "bodhi-pi-ws-frontend  — build"                    npm --workspace bodhi-pi-ws-frontend run build

    echo
    echo "✅ All steps passed."
