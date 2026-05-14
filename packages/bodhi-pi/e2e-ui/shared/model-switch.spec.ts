import { test } from "../fixtures.ts";

// Requires UI-side slash dispatch for /model in ChatPanel composer + currentModel
// tracking from setSessionConfigOption responses. Tracked as follow-up after
// Commit 6 (matrix gate).
test.skip("model-switch: /model anthropic mid-thread updates data-current-model", async () => {});
