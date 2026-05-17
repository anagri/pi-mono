// Back-compat re-export for the pre-split `./lib/seed-parser` subpath
// (consumed by test-app-http frontend). Removed in Commit 5 once the http
// commit retargets to `@bodhiapp/bodhi-pi-test-app-utils/seed-parser`.
export { parseSeedFiles } from "@bodhiapp/bodhi-pi-test-app-utils/seed-parser";
