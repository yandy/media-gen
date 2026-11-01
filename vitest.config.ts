import { defineConfig } from "vitest/config";

/**
 * The suite lives in `tests/`, not beside its sources. The `include` is anchored at
 * the repository root, and that anchor does double duty: it also keeps `.worktrees/`
 * out of the run. `.worktrees/` holds git worktrees (the isolated checkouts feature
 * work happens in), each carrying its own copy of `tests/**\/*.test.ts`. A bare
 * `**\/*.test.ts` default would pick up every worktree's tests as well: the run takes
 * twice as long, and a worktree whose tests are currently red makes the main checkout
 * look broken.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Isolates HOME/XDG/config for every file, and fails a file that dirties the
    // repository root. See vitest.sandbox.ts.
    setupFiles: ["./vitest.sandbox.ts"],
  },
});
