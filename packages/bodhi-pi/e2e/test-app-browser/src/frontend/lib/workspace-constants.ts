// Workspace mount path used by the worker-side InMemory ZenFS (where the
// agent reads/writes) and surfaced as `h.cwd` to shared tests.

export const WORKSPACE_NAME = "test-workspace";
export const WORKSPACE_ROOT = `/mnt/${WORKSPACE_NAME}`;
