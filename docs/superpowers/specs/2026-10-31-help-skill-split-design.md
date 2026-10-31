# Help and skill: who carries what

Date: 2026-10-31
Status: approved — B, descriptive frontmatter, agent rules in the skill only

## Why

`skills/mediagen/SKILL.md` (205 lines) and the CLI's own `--help` text carry the same
reference material: the model table, the three protocols and the `qwen` alias, `--n 1-6`
with the ark fan-out warning, the `--size` rules, the ark-only flags, exit codes 0/1/2,
the `--json` envelope and `partial`, the asynchronous video contract, the output file
naming. Two copies drift: a model id or an exit-code rule changed in one place leaves
the other lying.

The skill also claims more than it can deliver. Its frontmatter fires on *any* request to
make an image or a video ("Use this skill whenever the user wants an image or a short
video generated…"), which is wrong in a project that already generates media some other
way — another CLI, a hosted service, a script in the repo. The skill is a description of
one tool, not the only way to do the job. Its frontmatter describes what the tool is and
what it can do, and stops there.

## What the two surfaces are for

They are loaded at different moments, and that is the whole design:

- **SKILL.md** is read while deciding *whether mediagen is the tool for this job* — before
  any command runs.
- **`--help`** is read after that decision, while composing the command.

So the skill keeps the decision, four commands worth copying, and the things that are
expensive to get wrong; `--help` keeps everything you look up.

## Goals

- `--help` is the single reference: a flag, a model id, an exit code or a response shape
  is written there and nowhere else in the shipped artifacts.
- The skill fits on one screen: what the tool does, setup in a line, four commands, and
  the rules whose cost is money or a lost file.
- The frontmatter describes a tool among tools: it says what mediagen can do, it does not
  tell the agent to route media requests here, and the body says to prefer a generation
  tool the project already has.

## Non-goals

- README: it stays the long form (why `auth.json` lives in the state directory, the
  workspace-host `base_url`, the `path` prefix, timeouts). It already says `--help` is the
  reference and everything below it is the short version.
- Any change to flags, behaviour, or `config.toml`.
- Making the skill exhaustive enough that an agent never reads `--help`.

## Anti-goals (would make this a failure even if it ships)

- A skill so thin that an agent generates media through mediagen *believing* it is the
  only option, or without knowing that a video task is billed when it is created.
- Losing information: anything dropped from the skill has to exist in `--help` or the
  README, or it was the only copy.

## Approaches

- **A. Skill = routing + safety (~40-60 lines).** Everything looked-up goes to `--help`.
  Dedup is complete; the cost is one `--help` run before composing a command.
- **B. A plus a one-screen cheat sheet** (four copy-pasteable commands). Chosen: an agent
  can make the first, most common call without a round-trip through `--help`, while the
  tables and flag semantics stay in one place. The four commands are a deliberate, narrow
  overlap with the examples in the two `--help` bodies.
- **C. Frontmatter only.** Rejected: leaves the drift.

## The split, concretely

Stays in the skill: what the tool does, what it cannot do, prefer a generation tool the
project already has, one-time setup, four commands, four rules (report the saved path,
never re-run a paid request, never print a key, prefer `--no-wait` when your own timeout
is short), and the three `--help` commands to read.

The rules stay in the skill **only**. They are behavioural instructions for an agent, not
documentation of the CLI: `--help` stays pure reference. The contract statements already
in the help bodies ("partial success exits 0 — do not retry the whole request", "if this
process is interrupted, do not submit again") are explanations of what the output means
and stay where they are.

Not in the skill at all: the vendor model ids and their seeding, the protocol names, the
size grammar, the `--n` fan-out rule, the `--json` envelope fields, `partial`, the
exit-code table, the output filename pattern, the resolution tiers, the `models = [...]`
narrative, the `auth.json` state-directory rationale, the workspace-host `base_url` and
the `<...>` rejection. Every one of those survives in the README or in the commented
`config.toml` the CLI writes itself.

Two additions to `--help`, both reference facts that had no home there:

| fact | where it lands |
|---|---|
| the tool generates video too | the root command's one-line description (still says images only) |
| a key belongs to a provider entry: `--api-key` → its `api_key_env` → `auth.json`, no protocol-level default | `mediagen login --help` |

## Your calls, settled in conversation

- B, not A or C.
- The agent rules live in the skill only; `--help` carries no rules block.

## Left to the builder

- Exact wording, and which four commands the cheat sheet carries.
- A regression test that fails if the skill grows reference material again (model ids,
  protocol names, exit codes, response fields, resolution tiers) or if the frontmatter
  goes back to claiming every media request.
