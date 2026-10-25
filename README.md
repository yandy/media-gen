# mediagen

`mediagen` (`@yandy0725/mediagen-cli` on npm) is a small, non-interactive
command line tool that generates and edits images through Alibaba Bailian
(**qwen**) and Volcengine Ark (**doubao / seedream**), downloads the results to
disk, and prints their paths.

```bash
npm install -g @yandy0725/mediagen-cli
```

It is built for AI agents: explicit flags, no interactive prompts (except the
optional hidden API-key prompt in `login`), machine-readable output with
`--json`, and help text that carries the model table, the size reference and
copy-pasteable examples.

```console
# qwen: after the one-time base_url step below (ark needs no such step)
$ mediagen image generate "a red fox in fresh snow, soft morning light" --out-dir ./out
/abs/path/out/qwen-qwen-image-3-0-20261025-020839-0.png
```

## Before your first qwen call

The built-in qwen host, `https://dashscope.aliyuncs.com`, does **not** serve the
OpenAI-compatible images endpoint: it answers `404` with an empty body. Bailian
serves that endpoint only on your **workspace-scoped** host, so configure it once
(the workspace id is in the Bailian console):

```bash
mediagen login --provider qwen --base-url https://<workspace-id>.cn-beijing.maas.aliyuncs.com
```

or, equivalently, in `config.toml`:

```toml
[providers.qwen]
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"
```

There is no environment variable for the host, so a key alone is not enough for
qwen. `ark` is unaffected — its built-in host is correct. If you do call qwen
without the host, the failure is not silent: the error explains that the
endpoint does not exist on the configured host and prints the exact
`mediagen login --provider qwen --base-url ...` command above.

## What it is

- `mediagen image generate <prompt>` — text-to-image, and image-to-image when you
  add one or more `--image` references.
- `mediagen image edit <prompt>` — the same command with `--image` required.
- `mediagen login` / `mediagen logout` / `mediagen auth status` — API keys, stored in
  `auth.json` with mode `600`, never printed in full.
- `mediagen config show` / `mediagen config path` — the resolved configuration, with
  a source note per value.

It is deliberately not a platform toolbox: image generation only (no video, no
async task polling, no billing/plan management, no MCP server), two runtime
dependencies, and no automatic retry of a paid request.

## Requirements

- Node.js **>= 18** (the built-in `fetch` is used; there is no HTTP client dependency).
- An API key for Alibaba Bailian (DashScope) and/or Volcengine Ark.
- For qwen only: your **workspace-scoped** Bailian host,
  `https://<workspace-id>.cn-beijing.maas.aliyuncs.com` — the built-in default
  host does not serve the images endpoint. See
  [Before your first qwen call](#before-your-first-qwen-call).
- Runtime dependencies: `commander` and `smol-toml` only.

## Install

The package is `@yandy0725/mediagen-cli` and the command it installs is
`mediagen`:

```bash
npm install -g @yandy0725/mediagen-cli
mediagen --help
```

Or without a global install:

```bash
npx @yandy0725/mediagen-cli --help
```

From a checkout, for development:

```bash
git clone https://github.com/yandy/mediagen-cli && cd mediagen-cli
npm install        # commander + smol-toml
npm run build      # tsup -> dist/cli.js
npm link           # puts `mediagen` on your PATH
mediagen --help

node dist/cli.js --help       # after npm run build
npx tsx src/cli.ts --help     # straight from the sources
```

## First run: `mediagen login`

```bash
mediagen login --provider qwen --api-key sk-...   # store a key in auth.json (mode 600)
mediagen login --provider qwen --base-url https://<workspace-id>.cn-beijing.maas.aliyuncs.com
                                               # required for qwen: its built-in host 404s
mediagen login --provider ark                     # no --api-key: prompt, hidden input (needs a TTY)
mediagen login --provider ark --base-url https://proxy.example.com   # any endpoint override; stores no key
mediagen auth status                              # which key each provider would use, masked
```

qwen needs two things — a key **and** the workspace `base_url`; ark needs only a
key. `--base-url` on its own rewrites `config.toml` and stores no key.

`login` only stores keys and `base_url` overrides; it never creates a provider.
Provider definitions (`api_type` / `base_url` / `model`) live in `config.toml`,
so `mediagen login --provider my-proxy` fails until `[providers.my-proxy]` exists.

Environment variables work instead of `login` (`DASHSCOPE_API_KEY` for `qwen`,
`ARK_API_KEY` for `ark`), and `--api-key` on a single command overrides both.
The host is a different matter: no environment variable sets it, so qwen still
needs its workspace `base_url` from `mediagen login --provider qwen --base-url ...`
or `config.toml`.

## Quickstart

```bash
# 0. one-time: point qwen at your workspace host (ark needs no such step)
mediagen login --provider qwen --base-url https://<workspace-id>.cn-beijing.maas.aliyuncs.com

# 1. text to image with the default provider (qwen, once its base_url is set)
mediagen image generate "a red fox in fresh snow, soft morning light" --size 1024x1024 --out-dir ./out

# 2. edit a local image; local paths are read and sent as base64 data URLs
mediagen image edit "make the sky sunset orange, keep the composition" --image ./photo.jpg --provider qwen

# 3. combine several references: repeat --image
mediagen image edit "the character from the first image wearing the jacket from the second" \
  --image ./character.png --image ./jacket.png --provider qwen

# 4. four ark variants as JSON, for a program (or an agent) to parse
mediagen image generate "minimalist logo for a coffee roastery" --provider ark --n 4 --seed 42 --json

# 5. a third-party proxy declared as [providers.my-proxy] in config.toml
mediagen image generate "product photo on a white background" --provider my-proxy --out-dir ./shots
```

`mediagen image generate --help` and `mediagen image edit --help` print the full flag
list, the model table, the size reference and more examples.

## Commands

| command | what it does |
|---|---|
| `mediagen image generate <prompt>` | generate an image; add `--image` to edit |
| `mediagen image edit <prompt>` | identical, but at least one `--image` is required |
| `mediagen login [--provider P] [--api-key K] [--base-url U] [--json]` | store a key and/or a `base_url` override |
| `mediagen logout [--provider P] [--json]` | remove the stored key for a provider |
| `mediagen auth status [--json]` | which key each provider would use, and where it came from |
| `mediagen config show [--json]` | the effective configuration, with a source note per value |
| `mediagen config path [--json]` | where `config.toml` (and `auth.json`) live |

There is no `--version` flag; `mediagen --help` lists the commands.

## Configuration

Config directory, in precedence order:

1. `$MEDIAGEN_CLI_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/mediagen-cli`
3. `~/.config/mediagen-cli`

It holds `config.toml` (optional for `ark`; for `qwen` it must carry the
workspace `base_url`, see
[Before your first qwen call](#before-your-first-qwen-call)) and `auth.json`
(written by `login` with mode `600`, in a directory `mediagen` creates with mode
`700`).

`mediagen config path` prints the path of `config.toml` (and, with `--json`, that of
`auth.json` too); `mediagen config show` prints every value with its source
(`built-in`, `config.toml`, or `default`).

### `config.toml` reference

```toml
# ~/.config/mediagen-cli/config.toml
default_provider = "qwen"        # provider used when --provider is omitted
output_dir = "./media-output"    # where images are written; --out-dir wins

[providers.qwen]                 # built-in provider: a table here overrides the defaults
# REQUIRED for qwen — replace <workspace-id>; the built-in dashscope host 404s:
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"
# model = "qwen-image-3.0"
# path = "/compatible-mode/v1/images/generations"
# api_key_env = "DASHSCOPE_API_KEY"

[providers.ark]                  # built-in provider
# base_url = "https://ark.cn-beijing.volces.com"
# model = "doubao-seedream-5-0-flash-260915"
# path = "/api/v3/images/generations"
# api_key_env = "ARK_API_KEY"

[providers.my-proxy]             # third-party proxy: api_type + base_url + model are required
base_url = "https://proxy.example.com"
api_type = "ark"                 # dialect: "qwen" | "ark" — picks the flag set, path and response parsing
model = "some-model-name"
api_key_env = "MY_PROXY_KEY"     # optional: provider-specific env var holding the key
# path = "/v3/images/generations" # optional: override the dialect default path
```

| field | required | meaning |
|---|---|---|
| `default_provider` | no | provider used when `--provider` is omitted (default `qwen`) |
| `output_dir` | no | default output directory (default: the current directory) |
| `providers.<name>.api_type` | for a custom provider | `qwen` or `ark`: which dialect adapter encodes the request |
| `providers.<name>.base_url` | for a custom provider, and for `qwen` | absolute http(s) endpoint, no trailing path |
| `providers.<name>.model` | for a custom provider | model id sent to the vendor |
| `providers.<name>.path` | no | request path; defaults to the dialect's (`/compatible-mode/v1/images/generations` or `/api/v3/images/generations`) |
| `providers.<name>.api_key_env` | no | name of the environment variable holding this provider's key |

A built-in provider (`qwen`, `ark`) may be partially overridden — any field you
omit keeps its built-in value, except that qwen's built-in `base_url` does not
serve the images API and must be overridden with your workspace host. A name
that is not built-in must define `api_type`, `base_url` and `model`, or `mediagen`
reports the missing fields instead of sending a request.

## API key resolution

Highest precedence first:

1. the `--api-key <key>` flag on the command;
2. the environment variable named by the provider's `api_key_env` (from
   `config.toml`, or the built-in one);
3. for a built-in provider name, its conventional variable — `qwen` →
   `DASHSCOPE_API_KEY`, `ark` → `ARK_API_KEY` — even when `api_key_env` was
   overridden to something else;
4. the key stored in `auth.json` by `mediagen login`.

When none of them yields a key, the command exits `1` and names all three ways
to supply one. Keys are only ever displayed masked — the first and last four
characters (`sk-f…abcd`), or `***` for a key shorter than 12 characters — and
any key that appears in an error body is redacted.

A key alone is not sufficient for qwen: the provider also needs its
workspace-scoped `base_url`, and no environment variable supplies it. A qwen run
with only `DASHSCOPE_API_KEY` set fails with a `404` whose message names the
host to configure and the exact command to do it with.

## Environment variables

| variable | effect |
|---|---|
| `MEDIAGEN_CLI_CONFIG_DIR` | the whole config directory (`config.toml` + `auth.json`); wins over `XDG_CONFIG_HOME` |
| `XDG_CONFIG_HOME` | config directory becomes `$XDG_CONFIG_HOME/mediagen-cli` |
| `DASHSCOPE_API_KEY` | API key for the built-in `qwen` provider — the key alone is not enough: qwen also needs a workspace `base_url` (see [Before your first qwen call](#before-your-first-qwen-call)) |
| `ARK_API_KEY` | API key for the built-in `ark` provider |
| `NODE_USE_ENV_PROXY` | set to `1` on Node >= 24 to route `fetch` through `HTTP_PROXY`/`HTTPS_PROXY` (see [Proxies](#proxies-and-timeouts)) |

## Models

| model id | provider / dialect | pick it when |
|---|---|---|
| `qwen-image-3.0` | `--provider qwen` (built-in default; needs a workspace `base_url`) | text rendering (CJK + Latin) and image editing |
| `doubao-seedream-5-0-flash-260915` | `--provider ark` (built-in default) | speed: drafts, iteration, many variants |
| `doubao-seedream-5-0-pro` | `--provider ark --model doubao-seedream-5-0-pro` | highest quality; slower and more expensive |

Vendor ids are dated snapshots and roll forward, so the built-in values are only
defaults: override any of them with `--model` or in `config.toml`, without
upgrading the CLI. `--provider` selects the dialect (the accepted flag set, the
request path and the response shape); `--model` selects the exact model.

`--size` is passed through to the vendor: a tier (`1K`, `1.5K`, `2K`, `3K`,
`4K`), a `WxH` pixel pair with a lowercase `x` (e.g. `2048x2048`,
`1536x2048`), or `auto` (qwen only). Omit it for the vendor default (ark: `2K`;
qwen chooses a resolution from the prompt).

`--n` accepts 1-6 images; anything else — including `7`, `500`, `1e2` and
`0x10` — exits `2` before a request is sent. qwen returns them from a single
request; ark serves one image per request, so `--n` > 1 on ark fans out into
that many **paid** requests, seeded `seed`, `seed+1`, ...

Vendor-specific flags fail before any paid request is sent:
`--negative-prompt`, `--prompt-extend`, `--prompt-extend-mode` and
`--enable-thinking` are qwen-only; `--output-format`, `--optimize-prompt`,
`--layer-decomposition` and `--background` are ark-only. Boolean flags take an
explicit value (`--watermark false`, not `--no-watermark`).

## Output files

Images are downloaded immediately, because vendor URLs expire within ~24 hours.

- Directory: `--out-dir`, else `output_dir` from `config.toml`, else the current
  directory. A leading `~` is expanded, a relative path is resolved against the
  current directory, and the directory is created recursively **before** the
  request is sent, so an `--out-dir` that cannot be created exits `2` and costs
  nothing.
- File name: `<provider>-<model>-<yyyyMMdd-HHmmss>-<index>.<ext>`, local time,
  where `<model>` is the model id lowercased with every run of
  non-alphanumerics collapsed to `-`, and `<index>` is the position of the image
  in the run (starting at 0). A name that already exists gets a `-2`, `-3`, ...
  suffix instead of being overwritten.
- Extension: the vendor's reported output format (ark `jpeg` is saved as
  `.jpg`; a format that is not a plain `[a-z0-9]` extension is ignored, so a
  vendor value can never add a path separator), else the URL's extension, else
  the response `Content-Type`, else `.png`.
- Human mode prints one absolute path per line on stdout; warnings and the
  partial-success note go to stderr, so stdout stays pipeable.
- A failed download is reported per image and leaves a gap in the indices rather
  than renumbering the files that did land.

## `--json` output

One object on stdout, nothing else. This one is a qwen run, i.e. a host that
serves the images API (see
[Before your first qwen call](#before-your-first-qwen-call)); an ark run looks
the same apart from the file names:

```json
{"ok":true,"partial":false,"files":[{"path":"/tmp/out/qwen-qwen-image-3-0-20261025-020839-0.png","index":0,"url":"https://dashscope-result.oss-cn-beijing.aliyuncs.com/1.png"}],"errors":[],"usage":{"prompt_tokens":18,"image_count":1},"request_id":"a1b2c3d4-0000"}
```

| field | meaning |
|---|---|
| `ok` | at least one file was saved |
| `partial` | at least one file was saved **and** at least one item failed |
| `files[]` | `{path, index, url}` plus `size` when the vendor reported it |
| `errors[]` | `{code, message}` for every failed sub-request or download |
| `usage` | the vendor's usage object, omitted when it sent none |
| `request_id` | the vendor's request id, omitted when it sent none |

A partial success (exit `0`) looks like this — the files on disk were already
paid for, so do not re-run the whole request:

```json
{"ok":true,"partial":true,"files":[{"path":"/tmp/out/ark-doubao-seedream-5-0-flash-260915-20261025-020934-0.jpg","index":0,"size":"2048x2048","url":"https://ark-cdn.example.com/1.jpeg"},{"path":"/tmp/out/ark-doubao-seedream-5-0-flash-260915-20261025-020934-1.jpg","index":1,"size":"2048x2048","url":"https://ark-cdn.example.com/3.jpeg"}],"errors":[{"code":"SensitiveContentDetected","message":"image rejected by moderation"}],"usage":{"completion_tokens":12},"request_id":"ark-req-1"}
```

Failures are also JSON, on stdout, so an agent can parse them the same way:

```json
{"error":{"message":"qwen API request failed with status 500: service overloaded, retry later (code: InternalError.Algo)","code":"InternalError.Algo"}}
```

`error.code` is omitted when the vendor sent none. In human mode the same
message goes to stderr. `login`, `logout`, `auth status`, `config show` and
`config path` accept `--json` too.

## Exit codes

| code | meaning |
|---|---|
| `0` | success, **including a partial success** that saved at least one file |
| `1` | an API, configuration or runtime failure (no files were saved) |
| `2` | a usage error: unknown flag, missing prompt, `edit` without `--image`, an invalid `--size`, an `--n` outside 1-6, an invalid boolean value, an `--out-dir` that cannot be created, or a vendor-specific flag sent to the wrong dialect |

A usage error is always detected before a request is sent, so exit `2` never
costs anything. Paid requests are never retried automatically.

## Proxies and timeouts

`mediagen` talks to the vendors with the built-in `fetch` and has no proxy flags of
its own. On Node >= 24, set `NODE_USE_ENV_PROXY=1` to make `fetch` honour
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`. Alternatively point a provider's
`base_url` (in `config.toml`, or with `mediagen login --base-url`, or with the
`--base-url` flag for one call) at your own relay.

Timeouts: 300 s per API request (generation takes 10-120 s) and 120 s per image
download.

## Agent skill

The package ships [`skills/mediagen/SKILL.md`](skills/mediagen/SKILL.md): a
thin routing skill that tells an agent when to reach for `mediagen`, the three
commands that cover most requests, and the model trade-offs. Copy it into your
harness's skills directory, for example:

```bash
cp -r skills/mediagen ~/.agents/skills/     # the portable Agent Skills location
cp -r skills/mediagen ~/.pi/agent/skills/   # pi
```

Everything the skill does not cover is in `mediagen image generate --help`.

## Development

```bash
npm install
npm run build      # tsup -> dist/cli.js (ESM, node18 target)
npm test           # vitest run
npm run dev -- image generate --help   # tsx, no build step
```

The test suite is fully offline: `fetch` is stubbed everywhere, including the
end-to-end smoke test that drives `main()` in process.

## License

MIT
