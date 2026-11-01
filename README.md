# mediagen

English | [简体中文](README.zh-CN.md)

Generate and edit images through Alibaba Bailian (Qwen-Image) and Volcengine Ark
(**doubao / seedream**), and generate video through Ark (**doubao / seedance**) or
MiniMax (**H3**). Save results to disk, print their paths. Explicit flags, no
interactive prompts, `--json` for programs.

```bash
npm install -g @yandy0725/mediagen-cli

# Any command creates a commented config.toml on first use, and every run
# validates it before the command runs; config show itself only reads it.
mediagen config show

# Add an entry: one account (origin + key); the protocol goes on its task table
mediagen config add my-proxy --api-type openai \
  --base-url https://abc123.cn-beijing.maas.aliyuncs.com \
  --model qwen-image-3.0 --api-key-env DASHSCOPE_API_KEY
# add --task video for a video table; another model is one more entry in models

mediagen login --provider my-proxy --api-key sk-...

mediagen image generate "a red fox in fresh snow, soft morning light" --provider my-proxy --out-dir ./out
# /abs/path/out/my-proxy-qwen-image-3-0-20261025-020839-0.png
```

Node >= 18, two runtime dependencies, a DashScope and/or Ark API key.

## Commands

| command | what it does |
|---|---|
| `mediagen image generate <prompt>` | text to image; add `--image` to edit |
| `mediagen image edit <prompt>` | the same, with `--image` required |
| `mediagen video generate <prompt>` | text to video, or from one first frame; creates a paid task |
| `mediagen video status <task-id>` | look at one task once, and save its video if it finished |
| `mediagen login` / `logout` / `auth status` | store, remove, inspect API keys |
| `mediagen config show` / `config path` | resolved config, and where it lives |
| `mediagen config add <name>` | create a provider in config.toml; everything else is a manual edit |

`mediagen image generate --help` and `mediagen video generate --help` are the
reference: every flag, the model table, the size reference, examples. Everything below
is the short version.

## Models and flags

| model | provider | pick it when |
|---|---|---|
| `qwen-image-3.0` | `--provider aliyun` | text rendering (CJK + Latin), editing; needs your workspace host (see below) |
| `doubao-seedream-5-0-flash-260915` | `--provider volcengine` | speed: drafts, iteration |
| `doubao-seedream-5-0-pro` | `--provider volcengine --model doubao-seedream-5-0-pro` | highest quality |

| video model | provider | pick it when |
|---|---|---|
| `doubao-seedance-1-0-pro-250528` | `--provider volcengine` | text to video, or animate one first frame |
| `MiniMax-H3` | `--provider minimax` | the same, up to 2K, from MiniMax |

`aliyun`, `volcengine` and `minimax` are the provider names the first run writes into
`config.toml`; rename them freely. A model is usable only if it is listed in
`models = [...]` under that provider's table for the task (`image` or `video`), and a
second model of the same vendor is one more entry there — never another provider. Ids are dated snapshots, so
edit `models` (and `default`) in `config.toml` as they roll forward.

### Protocols

Each provider's task table declares its own `api_type`, so one account can speak one
protocol for images and another for video:

| `api_type` | wire format | pick it when |
|---|---|---|
| `openai` | the OpenAI Images shape: flat `{model, prompt, size, n}`, `data[].url` back | Bailian's `compatible-mode`, most third-party proxies |
| `dashscope` | Alibaba's native shape: `input.messages` + `parameters`, `output.choices[].message.content[].image` back | Bailian's native endpoint, or a gateway that exposes it (see below) |
| `ark` | Volcengine's own API: OpenAI-shaped for images, with its own parameters and per-item errors | Volcengine Ark, for images and video |
| `minimax` | MiniMax's video API: `content[]` items typed `text`/`image_url`, result nested under `task` | MiniMax H3, video only |

`dashscope` serves images only; it has no video task. `video generate` speaks `ark`
or `minimax`, and each declares its own resolution tiers (`ark`: 480p/720p/1080p/4k,
`minimax`: 480p/768p/2k) — a tier the selected dialect does not have fails locally,
while which tier a *model* supports is the vendor's call, checked when the task is
created and before anything is billed.

`qwen` still works as a deprecated alias of `openai`. A flag the selected protocol
does not accept fails before any paid request is sent (`--output-format` is ark-only,
`--prompt-extend-mode` is openai-only; on video, `--seed`/`--generate-audio`/
`--output-format`/`--watermark` are ark-only). `--size` takes a tier (`2K`), pixels
(`2048x2048`), or `auto` (openai only); `dashscope` takes pixels only, because it
sends `宽*高` and has no tier or `auto` concept. `--n` takes 1-6 — on ark each image
is a separate paid request.

## Output

Files are written to `--out-dir` (else `output_dir`, else the current directory) as
`<provider>-<model>-<yyyyMMdd-HHmmss>-<index>.<ext>`, never overwriting. Human mode
prints one absolute path per line on stdout; `--json` prints one object:

```json
{"ok":true,"partial":false,"files":[{"path":"/tmp/out/aliyun-qwen-image-3-0-20261025-020839-0.png","index":0,"url":"https://dashscope-result.oss-cn-beijing.aliyuncs.com/1.png"}],"errors":[],"usage":{"image_count":1},"request_id":"a1b2c3d4"}
```

`partial: true` with exit `0` means some images were saved and some failed: those
files are already paid for, so do not re-run the request. Exit codes: `0` success
(including partial), `1` API/config/runtime failure, `2` usage error — always
raised before a request is sent, so it costs nothing. Paid requests are never
retried.

A video run reports the task it created, because creating the task is what is billed:

```json
{"ok":true,"task_id":"cgt-20261028-abcd","status":"succeeded","files":[{"path":"/tmp/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4","index":0,"url":"https://...","duration":5,"resolution":"720p"}],"errors":[],"usage":{"completion_tokens":108900}}
```

There is no `partial` on video: one request makes one clip. **`ok` means the command
succeeded, not that a file exists** — `--no-wait`, and a `video status` that finds the
task still `pending` or `running`, are `{"ok":true,...,"files":[]}` with exit `0`.
Read `status` and `files`: an `ok: false` there would invite you to submit a task that
was already paid for. Note that `--no-wait` reports `status: "pending"` without having
asked — treat it as "unknown" until a `video status` call answers. When the poll budget runs out the error carries `task_id` and
code `TaskNotFinished`, and `video status <id>` resumes it without paying again.

## Configuration

`config.toml` — the file you edit — lives in the first of
`$MEDIAGEN_CLI_CONFIG_DIR`, `$XDG_CONFIG_HOME/mediagen`, `~/.config/mediagen`.

`auth.json` (mode `600`) is **state, not config**, and lives apart from it: the first
of `$MEDIAGEN_CLI_STATE_DIR`, `$XDG_STATE_HOME/mediagen`,
`~/.local/state/mediagen`. `~/.config` is the directory people sync, share and
commit; a key store there is one `.gitignore` mistake away from a leaked key. The
state directory is machine-local by definition, which is what a device-bound
credential is.

Upgrading from 0.1.1 or earlier: both directories dropped the `-cli` suffix, and nothing
migrates them for you. Move them once, then run any command:

```bash
mv ~/.config/mediagen-cli ~/.config/mediagen
mv ~/.local/state/mediagen-cli ~/.local/state/mediagen
```

(With `XDG_CONFIG_HOME` or `XDG_STATE_HOME` set, move the `mediagen-cli` directory inside
those instead. If you set `MEDIAGEN_CLI_CONFIG_DIR` or `MEDIAGEN_CLI_STATE_DIR`, the names
are unchanged and there is nothing to move.)

```toml
default_provider = "volcengine"
# output_dir = "./media-output"

[providers.volcengine]              # the account: host + key
base_url    = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]        # what that account can do, one table per task
api_type = "ark"                    # the protocol is declared here, not on the account
default  = "doubao-seedream-5-0-flash-260915"
models   = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]

[providers.volcengine.video]
api_type = "ark"
default  = "doubao-seedance-1-0-pro"
models   = ["doubao-seedance-1-0-pro"]

[providers.aliyun]
base_url    = "https://dashscope.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.aliyun.image]
api_type = "openai"
default  = "qwen-image-3.0"
models   = ["qwen-image-3.0"]

[providers.minimax]                 # a video-only account
base_url    = "https://api.minimax.io"
api_key_env = "MINIMAX_API_KEY"

[providers.minimax.video]
api_type = "minimax"
default  = "MiniMax-H3"
models   = ["MiniMax-H3", "MiniMax-H3-Max"]

[providers.my-gateway]              # a gateway that serves the native protocol
base_url    = "https://gateway.example.com"
api_key_env = "MY_GATEWAY_KEY"

[providers.my-gateway.image]
api_type = "dashscope"
path     = "/v1/images/generations" # the gateway's own path, not Bailian's
default  = "qwen-image-2.0-pro"
models   = ["qwen-image-2.0-pro"]
```

A provider is **one account**: a host (`base_url`) and an optional `api_key_env`.
Each task it serves hangs off it by name (`[providers.<name>.image]`,
`[providers.<name>.video]`) and declares its own `api_type`, the model ids you allow
there plus the `default` used when `--model` is absent. `timeout_seconds` is optional
per task (300 for image, 1800 for video). Two models of the same vendor are two
entries in one `models` list, not two providers; two protocols for one account are two
`api_type` lines, not two providers. `api_type` may also sit on the account table as
the default for every task under it.

**`base_url` is the origin** — an optional gateway prefix, never a version segment.
The version segment belongs to the endpoint, which the dialect owns per task
(`/api/v3/images/generations`, `/compatible-mode/v1/images/generations`,
`/api/v1/services/aigc/multimodal-generation/generation`), so switching
task changes only the path. A `base_url` that still ends with `/api/v3`, `/api/v1` or
`/compatible-mode/v1` on a vendor host is refused before any request, with the origin
to paste in. The file is the only source of truth: nothing is built in, and the first
run just writes the above into `config.toml` for you to edit. Both seeded entries run as
written: `volcengine` on Ark and `aliyun` on Bailian's native protocol, which is served on
the public host. Move `aliyun` to your workspace host
(`https://{workspace-id}.cn-beijing.maas.aliyuncs.com`) when you switch it to the
OpenAI-compatible protocol — that endpoint is not served publicly.

**A host whose API does not live at the vendor's own path** — a gateway, or a plan
that serves `/api/plan/v3` instead of `/api/v3` — declares that prefix on the task
with `path`, and the adapter appends nothing:

```toml
[providers.volcengine]
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.volcengine.image]
path = "/images/generations"        # request goes to .../api/plan/v3/images/generations
```

Without `path`, a sub-path under a vendor's own domain is refused before any request
(it would be doubled), with the origin or the `path` value to use. `path` is only for
hosts that do not mirror the vendor's layout; the adapter's own path stays the default.

Video is asynchronous: `video generate` creates a task (that is what gets billed),
writes its id to stderr, then polls until the clip exists — two to five minutes is
normal, and the poll budget is the task's `timeout_seconds` (default 1800). The clip
URL is good for 24 hours, so `video status <id>` can fetch it later; `--no-wait` hands
the id back immediately, which is what an agent wants when its own timeout is shorter
than the vendor's render. One clip per request: `--n` belongs to images.

A key belongs to a provider entry: `--api-key`, else that entry's `api_key_env`,
else `auth.json`. There is no dialect-level default key variable, so two entries of
the same dialect can use different keys. Keys are only ever printed masked.
`base_url` lives in the file (with a one-off `--base-url` override on
`image generate`), and it is validated before any request: Bailian's
OpenAI-compatible endpoint (`compatible-mode`) is served only on a workspace-scoped
host, and the seed therefore ships the native protocol, whose endpoint is served
publicly. A `base_url` that still contains `<...>` is rejected before spending anything. `mediagen config show` prints each provider's
tasks, their models, and the endpoint each one would actually hit. Set
`NODE_USE_ENV_PROXY=1` on Node >= 24 to honour `HTTP_PROXY`. Timeouts: per request
`timeout_seconds` for the task (default 300 s, video 1800 s), 120 s per image
download and 600 s per video download. For video that budget is the *whole* poll
window, not one request: each create or poll gets 60 s, so a hung request cannot eat
the budget, and the download has its own 600 s and is not counted against it.

Working from an agent? `skills/mediagen/SKILL.md` describes what this CLI does, which tool
to prefer when the project already generates media another way, and the rules that keep a
paid request from being wasted.

---

## Development

```bash
npm install
npm run build    # tsup -> dist/cli.js
npm test         # vitest, fully offline: fetch is stubbed everywhere
npm run dev -- image generate --help
```

`src/cli.ts` wires commander and maps errors to exit codes; `src/generate.ts` runs
the pipeline (validate → resolve → call → download → report); `src/api/{qwen,ark,dashscope}.ts`
are the dialect adapters behind the `DialectAdapter` seam in `src/types.ts`, with
`config.ts`, `auth.ts`, `http.ts`, `download.ts` and `output.ts` around them.

Worth preserving: every check runs before the first `fetch`; paid requests are
never retried; stdout carries the result only; no output path ever holds an
unmasked key. A provider speaking an existing dialect needs no code — only a
`config.toml` table. A new dialect means an adapter in `src/api/`, a row in
`DIALECTS` (`src/api/index.ts`) plus its `path` field — the endpoint file name the
dialect appends to `base_url`.

Release: cut a `vX.Y.Z` GitHub Release and Actions publishes it — see
`docs/guides/release.md` (`dist/` and `skills/` are what ships, and CI runs
`npm pack --dry-run` on every push). Design docs live in `docs/superpowers/specs/`.

MIT
