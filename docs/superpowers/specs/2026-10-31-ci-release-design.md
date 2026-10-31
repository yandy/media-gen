# CI and release: GitHub Actions owns both

Date: 2026-10-31
Status: awaiting approval — A (ubuntu + node 24), publish via OIDC trusted publishing

## Why

This repo has no `.github/` directory. Every guarantee its suite carries — the packaged
entry point spawns, the skill still routes instead of documenting, the smoke test drives
`main()` end to end — only runs when someone remembers to type `npm test` before pushing.
Nothing runs on a pull request, so the three commits after the last PR are the first
evidence that the suite is still green by habit rather than by check.

Release has the same shape. `README.md` ends with one line: `npm pack --dry-run`, then
`npm version patch && npm publish`. That line carries no tag, no changelog, no check that
the tarball is the one the tests ran against, and no record of what was published. It also
depends on a laptop with a WebAuthn security key at hand.

`pi-packages` already solved both: `.github/workflows/test.yml` for CI and
`.github/workflows/publish.yml` for a `release: published` → `npm publish --provenance`
pipeline authenticated by OIDC, documented in `docs/guides/release.md`. This design copies
that shape into a single-package repository.

## Goals

- Every push to `main` and every pull request runs typecheck, tests and a build.
- Publishing is one `gh release create`. The workflow builds, verifies and publishes with
  provenance; no npm token lives in this repository or on the maintainer's disk.
- The tarball is checked: a package that would ship without `dist/` or `skills/` fails in
  CI, not in a user's `npx`.
- One document says how to cut a release, including the part that has to happen once on
  npmjs.com before the first automated publish can work.

## Non-goals

- Windows. `src/cli.entry.test.ts` spawns npm's `.bin/mediagen` shim directly; on Windows
  that shim is a `.cmd` and `spawnSync` without a shell cannot run it. A Windows matrix is
  a real change to the tests, not a matrix line, and nobody runs this CLI on Windows today.
- A linter. The repo has no `biome.json` and no `eslint` config; introducing one now means
  reformatting every file in the same commit that adds CI. `tsc --noEmit` already runs in
  strict mode and the tests are the style argument.
- Node 18/20/22 coverage, despite `engines: ">=18"`. See "Node 24 only" below.
- Auto-generated changelogs, `semantic-release`, git tags from `npm version`. `npm version
  --no-git-tag-version` keeps the tag in `gh release create`, where the notes go.
- Any change to `src/`.

## Anti-goals (would make this a failure even if it ships)

- A workflow that is green because it skips something. `npm test` must be the same command
  a developer runs, in the same repository layout, with the build it produces.
- A publish path that can ship a version the tag does not name, or a tarball built from a
  dirty tree.
- A release document that assumes the trusted publisher is already configured, leaving the
  first `gh release create` to fail with an opaque `E401`/`E404` and no next step.

## Approaches

- **A. ubuntu-latest + node 24.** `lockfile-sync` plus one `test` job running
  `typecheck && test && build`, matching the reference's `test-full` shape minus the path
  filter and the Windows leg. Smallest surface that can go red for the right reasons.
- **B. ubuntu-latest + node [22, 24] matrix.** A adds one thing: it proves the suite on the
  previous LTS. Costs one more job; buys coverage of `engines` claims the repo never
  verified.
- **C. ubuntu + Windows, node 24 (full parity with `pi-packages`).** Would need
  `cli.entry.test.ts` reworked for `.cmd` shims and a pass over `chmodSync`-adjacent
  assertions. Two jobs' worth of YAML, one unrelated bug hunt.

**Chosen: A.** The maintainer's call, on the grounds that this repository's CI should
assert what it can assert today and add platforms when someone actually uses one. B stays
a one-line change later (`strategy.matrix.node: [22, 24]`); C became its own task.

## The work

### `.github/workflows/test.yml`

Triggers: `push` to `main`, `pull_request` to `main`. `concurrency` keyed on the ref with
`cancel-in-progress`, so superseded runs on the same ref are cancelled (rapid pushes to a PR
branch). A push to `main` and its PR key on different refs — `refs/heads/main` versus
`refs/pull/N/merge` — so those two run alongside each other rather than cancelling. Jobs:

1. `lockfile-sync` — `actions/checkout@v7`, `actions/setup-node@v7` (node 24), then
   `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and
   `git diff --exit-code -- package-lock.json`. A `package.json` edit that forgot the
   lockfile fails here instead of at `npm ci` in the next job.
2. `test` — checkout, setup-node 24 with `cache: npm`, `npm ci`,
   `npm run typecheck && npm test`, `npm run build`, then `npm pack --dry-run`, whose
   stdout must list both `dist/` and `skills/`. `timeout-minutes: 20`.

`npm test` already runs `tsup` through `src/cli.entry.test.ts`; step order does not matter,
but the explicit `npm run build` is what proves the `prepack` path works on a clean clone,
and `npm pack --dry-run` exercises it a third time with `files` filtering on top.

### `.github/workflows/publish.yml`

Trigger: `release: published`. `permissions: contents: read` and `id-token: write` — the
latter is the whole authentication, since npm trusts this repository's workflow via OIDC.

1. checkout the release tag, setup-node 24 with `registry-url: https://registry.npmjs.org`
   (no `cache`, so a stale cache cannot mask a broken `npm ci`).
2. Tag guard: fail unless `github.event.release.tag_name` equals `v` + the `version` in
   `package.json`. This is the single-package replacement for the reference's
   `pi-<name>-v*` case statement, and it makes the tag format a rule rather than a habit.
3. `npm ci`, then `npm test` — publishing an untested tarball is the failure this whole
   design exists to prevent, and a release tag can point at any commit.
4. `npm publish --provenance`. `prepack` builds `dist/` as part of it.

### `package.json`

Add `"typecheck": "tsc --noEmit"`. Nothing else changes: `build`, `test`, `prepack` and
`files` are the CI/publish contract and already say the right thing.

### `docs/guides/release.md` (new, Chinese, mirroring `pi-packages/docs/guides/release.md`)

The flow, in order: CI green → `npm version <x.y.z> --no-git-tag-version` → commit
`v<x.y.z>` with both `package.json` and `package-lock.json` → `git push origin main` →
`gh release create v<x.y.z> --target <sha> --title "v<x.y.z>"` → watch the workflow.

Plus the four things that cost a maintainer an afternoon otherwise:

- **One-time npmjs.com setup.** The `@yandy0725/mediagen-cli` package settings need a
  Trusted Publisher: GitHub Actions, owner `yandy`, repository `mediagen-cli`, workflow
  filename `publish.yml`, environment left empty. Without it the publish step fails.
- **Timing.** `npm publish` returns 202 and the package is visible ~5 minutes later while
  npm scans it. A 404 from the registry right after a green run is not a failure.
- **No 2FA, no token.** The workflow has neither, so `npm login` on the laptop is only
  needed for the manual fallback.
- **Manual fallback.** If Actions cannot publish, `npm login` + `npm publish` locally with
  the security key still works; it produces no provenance, so the npm page shows no
  "Built and signed on GitHub Actions" badge.

`README.md` and `README.zh-CN.md`: replace the two-line release sentence with one line
pointing at `docs/guides/release.md`, keeping the `npm pack --dry-run` fact where it is.

## What's left to the builder

- Whether the tag guard compares `v${version}` or accepts a bare `X.Y.Z` too. Pick one and
  put it in the document; the guard and the document must agree.
- Whether `lockfile-sync` shares the `test` job. Two jobs is the reference's shape; one job
  is fewer runner starts. Follow the reference.
- Exact `npm pack --dry-run` assertion: settled during implementation — anchor both greps on
  the `npm notice` contents lines (`^npm notice .*dist/cli\.js`). Unanchored, `dist/cli.js`
  also matches tsup's build echo in the same merged stream, so the assertion would pass for a
  tarball that does not contain the file.
- The Chinese wording in `docs/guides/release.md`.
