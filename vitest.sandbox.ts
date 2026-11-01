import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Every test file starts with throwaway HOME / XDG_CONFIG_HOME / XDG_STATE_HOME /
 * MEDIAGEN_CLI_CONFIG_DIR / MEDIAGEN_CLI_STATE_DIR, set before the file's own
 * imports run. A test that
 * forgets to isolate itself then cannot read or write the developer's real
 * config — isolation stops being a convention each file has to remember.
 *
 * The file also fails if the run leaves a non-ignored entry in the repository
 * root, which is how a generated PNG once ended up in a `git add -A`.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-test-home-"));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg");
process.env.MEDIAGEN_CLI_CONFIG_DIR = path.join(sandbox, "mediagen");
process.env.MEDIAGEN_CLI_STATE_DIR = path.join(sandbox, "mediagen-state");

const repoRoot = process.cwd();
const before = new Set(fs.readdirSync(repoRoot));

afterAll(() => {
  const added = fs.readdirSync(repoRoot).filter((entry) => !before.has(entry));
  // Ignored paths are build output and scratch (dist/, .worktrees/, …); anything
  // else would show up in `git status` after a plain `npm test`.
  const leftovers = added.filter((entry) => !isIgnored(entry));
  fs.rmSync(sandbox, { recursive: true, force: true });

  if (leftovers.length > 0) {
    throw new Error(
      `the test run left files in the repository root: ${leftovers.join(", ")}; ` +
        "write them under a temporary directory instead",
    );
  }
});

function isIgnored(entry: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", entry], { cwd: repoRoot }).status === 0;
}
