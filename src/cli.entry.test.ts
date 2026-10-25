/**
 * Regression coverage for the *packaged* entry point: `dist/cli.js` as npm
 * installs it, reached through the symlink that `bin.media` creates.
 *
 * `src/cli.test.ts` drives `main()` in-process, which never executes the shebang,
 * the invoked-as-script guard, the argv slicing or the `process.exit` wiring. This
 * file spawns real child processes against the real build artifact so those four
 * lines are covered too. It lives in its own file so the fast in-process suite
 * stays fast (this one builds once and forks a process per test).
 *
 * The guard compares `import.meta.url` against `process.argv[1]`. Node resolves the
 * main module through `realpath` unless `--preserve-symlinks-main` is given, so a
 * naive `pathToFileURL(process.argv[1]).href` comparison is false when the CLI is
 * invoked through npm's symlink: `main()` never runs and the process exits 0 with
 * no output. Every assertion below that requires *non-empty* stdout exists to catch
 * exactly that failure mode.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const srcDir = path.join(repoRoot, "src");
/** What `package.json` `bin.media` points at, i.e. the file npm symlinks into `.bin`. */
const entry = path.join(repoRoot, "dist", "cli.js");

const SPAWN_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 180_000;

/** Newest mtime of any `.ts` file under `dir`, so a stale `dist/` is rebuilt. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else if (item.isFile() && item.name.endsWith(".ts")) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * Asserts against the real build artifact rather than a `tsx` run of `src/cli.ts`,
 * because the artifact is what ships: the shebang and the exec bit only exist there.
 * Rebuilds only when `dist/cli.js` is missing or older than any source file, so
 * repeat runs stay cheap. Same command as `package.json`'s `build` script, invoked
 * through the local tsup bin so the test does not depend on npm being on PATH.
 */
function ensureBuilt(): void {
  let builtAt: number;
  try {
    builtAt = fs.statSync(entry).mtimeMs;
  } catch {
    builtAt = 0;
  }
  if (builtAt >= newestSourceMtime(srcDir)) return;

  const tsup = path.join(repoRoot, "node_modules", "tsup", "dist", "cli-default.js");
  const result = spawnSync(
    process.execPath,
    [tsup, "src/cli.ts", "--format", "esm", "--target", "node18", "--clean"],
    { cwd: repoRoot, encoding: "utf8", timeout: BUILD_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    throw new Error(
      `npm run build equivalent failed (status ${String(result.status)}):\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    );
  }
}

/** Fails with the child's own diagnostics instead of a bare `null` status. */
function expectRan(result: SpawnSyncReturns<string>): void {
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `expected exit 0, got ${String(result.status)} (signal ${String(result.signal)})\n` +
        `stdout: ${JSON.stringify(result.stdout)}\nstderr: ${JSON.stringify(result.stderr)}`,
    );
  }
}

let tempDir: string;
let configDir: string;
/** A symlink to `entry`, standing in for the `media` binary npm creates. */
let link: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  ensureBuilt();
}, BUILD_TIMEOUT_MS + 5_000);

beforeEach(() => {
  // realpath so the expected config path matches even where /tmp is itself a link.
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "media-entry-")));
  configDir = path.join(tempDir, "config");
  fs.mkdirSync(configDir, { recursive: true });

  link = path.join(tempDir, "bin", "media");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(entry, link);

  env = { ...process.env, MEDIA_CLI_CONFIG_DIR: configDir };
  delete env.XDG_CONFIG_HOME;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("packaged entry point", () => {
  it("runs the command when invoked through a symlink, and prints something", () => {
    const result = spawnSync(process.execPath, [link, "config", "path"], {
      env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    expectRan(result);
    // The non-empty assertion is the whole point: exit 0 with no output is the bug.
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout.trim()).toBe(path.join(configDir, "config.toml"));
    expect(result.stderr).toBe("");
  });

  it("runs the command when invoked by its real path, and prints something", () => {
    const result = spawnSync(process.execPath, [entry, "config", "path"], {
      env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    expectRan(result);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout.trim()).toBe(path.join(configDir, "config.toml"));
    expect(result.stderr).toBe("");
  });

  it("propagates a non-zero exit code through the symlink", () => {
    const result = spawnSync(process.execPath, [link, "image", "edit", "x"], {
      env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    // `image edit` without `--image` is a usage error: exit 2, message on stderr.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toMatch(/--image/);
  });

  it("is executable through the shebang, as an installed bin", () => {
    expect(fs.readFileSync(entry, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    expect(fs.statSync(entry).mode & 0o111).not.toBe(0);

    // No `node` prefix: the kernel resolves the shebang, exactly like `media config path`.
    const result = spawnSync(link, ["config", "path"], {
      env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    expectRan(result);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout.trim()).toBe(path.join(configDir, "config.toml"));
  });

  it("does nothing when imported instead of run", async () => {
    // `node -e` leaves `process.argv[1]` undefined, and the import is not the main
    // module either: both must keep `main()` from running (this is what makes the
    // in-process suite in cli.test.ts safe).
    const script =
      `const m = await import(${JSON.stringify(pathToFileURL(entry).href)});` +
      `if (typeof m.main !== "function") throw new Error("main is not exported");` +
      `console.log("imported-without-running");`;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    expectRan(result);
    expect(result.stdout.trim()).toBe("imported-without-running");
    expect(result.stdout).not.toContain("config.toml");
    expect(result.stdout).not.toContain("Usage: media");
  });

  it("is the file package.json publishes as the media binary", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { bin: Record<string, string> };

    expect(pkg.bin.media).toBe("./dist/cli.js");
    expect(path.resolve(repoRoot, pkg.bin.media)).toBe(entry);
  });
});
