import { defineConfig } from "vitest/config";

/**
 * `.worktrees/` holds git worktrees (the isolated checkouts feature work happens
 * in), and each one carries its own copy of `src/**\/*.test.ts`. Without this
 * exclude, running the suite from the main checkout picks up every worktree's
 * tests as well: the run takes twice as long, and a worktree whose tests are
 * currently red makes the main checkout look broken.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
