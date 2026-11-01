# Drop the `-cli` suffix from the config and state directories

Date: 2026-11-01
Status: awaiting approval — approach B, hard switch with a documented one-time `mv`

## Why

The binary is `mediagen` and the product is mediagen; `-cli` is the npm package suffix
(`@yandy0725/mediagen-cli`), which is a distribution detail, not the tool's name. Today
that detail leaks into every path the user is told to look at:

- `~/.config/mediagen-cli/config.toml` (and `$XDG_CONFIG_HOME/mediagen-cli`)
- `~/.local/state/mediagen-cli/auth.json` (and `$XDG_STATE_HOME/mediagen-cli`)

`mediagen config path` prints a directory named after a package nobody types. The two
directories become `~/.config/mediagen` and `~/.local/state/mediagen`.

## What changes

`src/config.ts` owns the decision: `configDir()` (lines 14-23) and `stateDir()` (lines
31-40). Everything else derives from them — `configPath()`, `authPath()`, the seed writer,
`ensureConfigFile()` — so no other source file changes. The suffix is spelled four times
there; it becomes one module-level constant (`APP_DIR_NAME = "mediagen"`) that both
functions use, so config and state cannot drift apart the way `media-cli` →
`mediagen-cli` once drifted.

Unchanged, as a deliberate call:

- **The env overrides keep their names**: `MEDIAGEN_CLI_CONFIG_DIR` and
  `MEDIAGEN_CLI_STATE_DIR`. They are explicit escapes for scripts and tests, not the
  directory being renamed; renaming them would be a second breaking change that nobody
  asked for. (`MEDIAGEN_CLI_*` still reads as the package name, which is what a variable
  is named after.)
- No change to `config.toml` contents, the seed text, flags, or behaviour.

## Approaching it

- **A. Migrate once on first run.** If the new directory is absent and the old one exists,
  rename it (copy across filesystems) before seeding. Existing users upgrade untouched.
  Costs ~30 lines plus tests, and makes the CLI move files inside `$HOME` on its own.
- **B. Hard switch plus a documented `mv`.** Chosen. Two strings, the tests, and both
  READMEs. Predictable, no hidden filesystem surgery; the cost is that an upgrading user
  gets a fresh seed config and must re-run `login` until they read the note.
- **C. Read-through fallback.** New path first, old path read-only when the new one is
  missing. No data moves, but two locations stay alive forever and `config path` can
  disagree with the file actually read — the ambiguity this change is meant to remove.

## Goals

- `configDir()` and `stateDir()` name `mediagen` in all four branches (override, XDG,
  home).
- The READMEs state the new paths, and each carries one copy-pasteable upgrade block:

  ```
  mv ~/.config/mediagen-cli ~/.config/mediagen
  mv ~/.local/state/mediagen-cli ~/.local/state/mediagen
  ```

- The test suite pins the new paths, so a future rename cannot land half-done.

## Non-goals

- Migrating, copying, deleting or even reading `~/.config/mediagen-cli` and
  `~/.local/state/mediagen-cli`. After this change the old directories are never touched
  by any code path — a user stays free to move or delete them by hand.
- Renaming the env override variables, the npm package, the `mediagen` binary, or anything
  inside `config.toml` / `auth.json`.
- Editing historical specs and plans under `docs/superpowers/`: they record what was true
  when they were written.

## Anti-goals (would make this a failure even if it ships)

- Any silent migration, fallback read, or symlink that keeps the old directory load-bearing
  — that is approach A or C arriving through the back door.
- Changing the paths in code but leaving the user-facing documentation pointing at
  `mediagen-cli`, or vice versa: a user following the README would then move their config
  to a directory the CLI does not read.
- Losing the two test-level guarantees that the suffix change could quietly break: that the
  override variables still win, and that the state directory is never the config directory.

## Left to the builder

- Whether the test sandbox directories in `vitest.sandbox.ts` follow the rename (cosmetic:
  they are set explicitly through the override variables).
- Exact wording of the upgrade note and where it sits in each README.
- The release framing: this is a breaking change for anyone on 0.1.1, so the next version
  is 0.2.0 with the `mv` note in the release body. Decided at release time, not here.
