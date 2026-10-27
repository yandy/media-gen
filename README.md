# mediagen

English | [简体中文](README.zh-CN.md)

Generate and edit images through Alibaba Bailian (**qwen**) and Volcengine Ark
(**doubao / seedream**), save them to disk, print their paths. Explicit flags, no
interactive prompts, `--json` for programs.

```bash
npm install -g @yandy0725/mediagen-cli

# The first run writes a commented config.toml; edit it directly.
mediagen config show

# Add an entry (one dialect can back several, each with its own host and model)
mediagen config add my-proxy --api-type qwen \
  --base-url https://<workspace-id>.cn-beijing.maas.aliyuncs.com \
  --model qwen-image-3.0 --api-key-env DASHSCOPE_API_KEY

mediagen login --provider my-proxy --api-key sk-...

mediagen image generate "a red fox in fresh snow, soft morning light" --out-dir ./out
# /abs/path/out/dashscope-qwen-image-3-0-20261025-020839-0.png
```

Node >= 18, two runtime dependencies, a DashScope and/or Ark API key.

## Commands

| command | what it does |
|---|---|
| `mediagen image generate <prompt>` | text to image; add `--image` to edit |
| `mediagen image edit <prompt>` | the same, with `--image` required |
| `mediagen login` / `logout` / `auth status` | store, remove, inspect API keys |
| `mediagen config show` / `config path` | resolved config, and where it lives |
| `mediagen config add <name>` | create a provider in config.toml; everything else is a manual edit |

`mediagen image generate --help` is the reference: every flag, the model table, the
size reference, examples. Everything below is the short version.

## Models and flags

| model | provider | pick it when |
|---|---|---|
| `qwen-image-3.0` | `--provider dashscope` | text rendering (CJK + Latin), editing |
| `doubao-seedream-5-0-flash-260915` | `--provider volcengine` | speed: drafts, iteration |
| `doubao-seedream-5-0-pro` | `--provider volcengine --model doubao-seedream-5-0-pro` | highest quality |

`dashscope` and `volcengine` are the two provider names the first run writes into
`config.toml`; rename them freely, or copy a section to add more entries. Ids are
dated snapshots, so override any of them with `--model` or in `config.toml`.
`--size` takes a tier (`2K`), pixels (`2048x2048`), or `auto` (qwen only); `--n`
takes 1-6 — on ark each image is a separate paid request. Vendor-specific flags
(`--negative-prompt` is qwen-only, `--output-format` is ark-only) fail before
anything is sent.

## Output

Files are written to `--out-dir` (else `output_dir`, else the current directory) as
`<provider>-<model>-<yyyyMMdd-HHmmss>-<index>.<ext>`, never overwriting. Human mode
prints one absolute path per line on stdout; `--json` prints one object:

```json
{"ok":true,"partial":false,"files":[{"path":"/tmp/out/dashscope-qwen-image-3-0-20261025-020839-0.png","index":0,"url":"https://dashscope-result.oss-cn-beijing.aliyuncs.com/1.png"}],"errors":[],"usage":{"image_count":1},"request_id":"a1b2c3d4"}
```

`partial: true` with exit `0` means some images were saved and some failed: those
files are already paid for, so do not re-run the request. Exit codes: `0` success
(including partial), `1` API/config/runtime failure, `2` usage error — always
raised before a request is sent, so it costs nothing. Paid requests are never
retried.

## Configuration

`config.toml` and `auth.json` (mode `600`) live in the first of
`$MEDIAGEN_CLI_CONFIG_DIR`, `$XDG_CONFIG_HOME/mediagen-cli`,
`~/.config/mediagen-cli`.

```toml
default_provider = "dashscope"
# output_dir = "./media-output"

[providers.dashscope]
api_type = "qwen"
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"   # qwen's images API lives on a workspace host
model = "qwen-image-3.0"
api_key_env = "DASHSCOPE_API_KEY"

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
model = "doubao-seedream-5-0-flash-260915"
api_key_env = "ARK_API_KEY"

[providers.my-proxy]              # a second entry of the same dialect
api_type = "qwen"
base_url = "https://proxy.example.com"
model = "qwen-image-3.0"
# path = "/v1/images/generations"  # optional: override the dialect default
```

A provider is one API dialect (`api_type`, either `qwen` or `ark`) plus one concrete
entry point (`base_url` + `model`). Those three fields are required; `path` and
`api_key_env` are optional (`path` falls back to the dialect default). The file is
the only source of truth: nothing is built in, and the first run just writes the
above into `config.toml` for you to edit.

A key belongs to a provider entry: `--api-key`, else that entry's `api_key_env`,
else `auth.json`. There is no dialect-level default key variable, so two entries of
the same dialect can use different keys. Keys are only ever printed masked.
`base_url` can only be set in the file — for qwen, leaving it alone is a `404`, and
the error message points at `config.toml`. Set `NODE_USE_ENV_PROXY=1` on Node >= 24
to honour `HTTP_PROXY`. Timeouts: 300 s per request, 120 s per download.

Working from an agent? `skills/mediagen/SKILL.md` says when to reach for this CLI.

---

## Development

```bash
npm install
npm run build    # tsup -> dist/cli.js
npm test         # vitest, fully offline: fetch is stubbed everywhere
npm run dev -- image generate --help
```

`src/cli.ts` wires commander and maps errors to exit codes; `src/generate.ts` runs
the pipeline (validate → resolve → call → download → report); `src/api/{qwen,ark}.ts`
are the dialect adapters behind the `DialectAdapter` seam in `src/types.ts`, with
`config.ts`, `auth.ts`, `http.ts`, `download.ts` and `output.ts` around them.

Worth preserving: every check runs before the first `fetch`; paid requests are
never retried; stdout carries the result only; no output path ever holds an
unmasked key. A provider speaking an existing dialect needs no code — only a
`config.toml` table. A new dialect means an adapter in `src/api/`, a row in
`DIALECTS` (`src/api/index.ts`) and a default path in `src/providers.ts`.

Release: `npm pack --dry-run` to inspect the tarball (`dist/` and `skills/` are
published), then `npm version patch && npm publish`. Design docs live in
`docs/superpowers/specs/`.

MIT
