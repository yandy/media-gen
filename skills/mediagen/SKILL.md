---
name: mediagen
description: Use this skill whenever the user wants an image or a short video generated, created, drawn, illustrated, edited, modified, restyled, recoloured, upscaled, or composed from reference pictures — "draw me a picture", "generate a logo", "edit this photo", "make this image blue", "put this character in that scene", "render this text into an image", "make a video of this", "animate this photo", "generate a clip". It drives the `mediagen` CLI, which calls Alibaba Bailian qwen-image and Volcengine Ark doubao/seedream image models, and Volcengine Ark doubao/seedance or MiniMax H3 for video, saving the results as local files.
---

# mediagen: generate and edit images, and generate video

`mediagen` is a small, non-interactive media CLI: it writes every result to a local
file and prints the path. Each successful call is a paid API request — and for video,
the money is spent when the task is created, minutes before the clip exists.

## When to use it

- A new image from a text description (text-to-image).
- A change to an existing image: restyle, recolour, add or remove something,
  combine several references, upscale (pass `--image` plus a larger `--size`),
  or render text (CJK or Latin) into an image.
- A short video from text, or from one first frame: `video generate` (see below).

## When not to use it

- Audio, or documents: this build makes images and video only.
- Long-form video, editing an existing clip, or joining clips: only short generated
  clips are supported.
- Describing or analysing an image: `mediagen` writes images, it cannot see them.
- Local pixel work (crop, resize, convert, compress): use an image tool
  instead — `mediagen` spends money and round-trips to a vendor.

## One-time setup

Nothing is built in: a provider is declared in `config.toml`, which any command
creates on first use (with three entries — `aliyun`, `volcengine`, `minimax` — plus
commented examples for a gateway) and then validates before it runs.

```bash
mediagen config show        # prints what resolves; any command creates config.toml on first use
```

`base_url` is the origin: the protocol appends the endpoint path, version segment
included, per task. Both seeded entries run as written: `volcengine` on Ark, `aliyun`
on Bailian's native protocol (`api_type = "dashscope"`), which the public host serves.
Bailian's OpenAI-compatible endpoint (`compatible-mode`) is only served on a
workspace-scoped host — switch `base_url` to
`https://{workspace-id}.cn-beijing.maas.aliyuncs.com` if you want that protocol. A
`base_url` still containing `<...>` is rejected before sending anything.

Each provider holds `models = [...]` per task, and a model that is not listed there is
refused before anything is sent: add the id to that list instead of creating another
provider. To add another entry without hand-editing:

```bash
mediagen config add my-proxy --api-type openai --base-url https://proxy.example.com \
  --model qwen-image-3.0 --api-key-env MY_PROXY_KEY     # --task video for a video table
```

Then store keys:

```bash
mediagen login --provider aliyun --api-key sk-...      # auth.json in ~/.local/state, mode 600
mediagen login --provider volcengine --api-key sk-...
mediagen auth status                                   # which key each provider would use
```

A key belongs to a provider entry: the `--api-key` flag overrides its
`api_key_env` environment variable, which overrides `auth.json`. There is no
dialect-level default key variable. No variable sets the host — hosts live only in
`config.toml`. Never echo a key back to the user; the CLI only ever prints it
masked.

## Commands

```bash
# text to image; files land in --out-dir (default: output_dir in config.toml, else the cwd)
# --provider names an entry in config.toml; aliyun needs its workspace base_url first
mediagen image generate "a red fox in fresh snow, soft morning light" --out-dir ./out

# edit one local image (local paths are read and sent as base64 data URLs)
mediagen image edit "make the sky sunset orange, keep the composition" --image ./photo.jpg

# combine several references: repeat --image, and say which image is which
mediagen image edit "the character from the first image wearing the jacket from the second" \
  --image ./character.png --image ./jacket.png

# machine-readable, for parsing paths and errors
mediagen image generate "minimalist logo for a coffee roastery" --provider volcengine --n 4 --seed 42 --json
```

Add `--json` whenever you intend to parse the result. Without it, stdout is one
absolute file path per line and warnings go to stderr.

## Picking a model

| model | how to select | pick it when |
|---|---|---|
| `qwen-image-3.0` | `--provider aliyun` (needs its workspace `base_url`) | text rendering (CJK + Latin) and image editing |
| seedream 5.0 flash | `--provider volcengine` | speed: drafts, iteration, many variants |
| seedream 5.0 pro | `--provider volcengine --model doubao-seedream-5-0-pro` | highest quality; slower and more expensive |

`aliyun` / `volcengine` are the two names the first run writes into
`config.toml`; they are the seed's choices, not built-ins. A model is usable only
if it is listed in `models = [...]` under that provider's `image` table, so vendor
ids — dated snapshots that roll forward — are refreshed by editing that list (and
`default`); `--model` picks among the listed ids, and anything else exits 1 before
sending. `--provider` picks the account; the **task table's `api_type`** picks the
protocol and with it the request body and response shape (`openai`, `dashscope`,
`ark`; `qwen` is a deprecated alias of `openai`). Flags a protocol does not accept
fail before any paid request.

## Counting images

`--n` accepts 1-6 (else exit 2). `openai` and `dashscope` return them from one
request; **ark fans
out into one paid request per image** (seeded `seed`, `seed+1`, ...), so `--n 4`
on ark costs four requests. Keep `--n` at 1 while iterating on a prompt.

## Video

Video is asynchronous, and the order of events matters more than the flags:

1. `video generate` **creates and pays for a task**, then writes the task id to stderr
   and polls until the clip exists. Two to five minutes is normal; the budget is the
   task's `timeout_seconds` (default 1800 s).
2. The clip URL is good for 24 hours, and the task id for days, so a paid task can
   always be collected later with `video status <id>`.

```bash
# wait for it (humans, and agents whose timeout is longer than a few minutes)
mediagen video generate "a red fox running through deep snow, golden hour" --out-dir ./clips

# do not wait: create it, take the id, and collect it in a later step
mediagen video generate "a slow pan over a frozen lake" --no-wait --json

# collect it later — nothing is created and nothing is billed
mediagen video status <task-id> --json
```

**Prefer `--no-wait` when your own command timeout is short.** A blocking
`video generate` that you kill mid-poll leaves a paid task behind; the id on stderr is
the only handle on it, and re-running the command pays twice for the same clip.

`video status` asks once and never waits: `status: "pending"`/`"running"` is a normal
answer (exit 0, `files: []`), so poll it on your own schedule. Note that `--no-wait`
reports `status: "pending"` as an assumption — it never asked — so treat that field as
"unknown" until a `video status` call answers. When it reports
`succeeded` it downloads the clip and prints the path.

Video models: `doubao-seedance-1-0-pro-250528` on `--provider volcengine`, or
`MiniMax-H3` on `--provider minimax`. Each dialect has its own resolution tiers
(`ark`: 480p/720p/1080p/4k; `minimax`: 480p/768p/2k) — a tier the dialect lacks exits
2 locally, while which tier a *model* supports is the vendor's check at create time,
before billing. One clip per request: there is no `--n`. `--seed`,
`--generate-audio`, `--output-format` and `--watermark` are ark-only, and any other
dialect rejects them before sending.

## Reading the result

- Exit 0: success. `--json` gives `{ok, partial, files[{path,index,url}], errors[], usage, request_id}`.
- Exit 0 with `partial: true`: some images arrived, some failed. The files on
  disk were already paid for — report them and do not re-run the whole request.
- Exit 1: an API/config failure; the message says what to change — a qwen `404`
  names the workspace host and points at `config.toml`. No files.
- Exit 2: a usage error (bad flag, bad `--size`, `--n` outside 1-6, an
  `--out-dir` that cannot be created, or a vendor-specific flag sent to the
  wrong dialect). Fix the command; nothing was sent or paid for.

Video adds one rule that is easy to get wrong: **`ok` means the command succeeded, not
that a file exists.** A video envelope is
`{ok, task_id, status, files[{path,index,url,duration,resolution}], errors[], usage}`,
with no `partial`. `--no-wait`, and a `video status` that finds the task still running,
are `{"ok":true,...,"files":[]}` with exit 0 — read `status` to decide whether to come
back, and never treat `files: []` as a failure to retry. A budget that runs out raises
an error carrying `task_id` and code `TaskNotFinished`: collect it with
`video status <id>`, do not submit it again.

Boolean flags take an explicit value: `--watermark false`, not `--no-watermark`.

## Rules

1. Report the saved file path(s) back to the user, exactly as printed. That is
   the deliverable — a generation the user cannot find was wasted money.
2. Never re-run a request that already produced files, and never re-submit a video
   task whose id you have; retry only a clean failure that produced no task at all.
3. Never print an API key, and never invent flags: everything supported is
   listed by `mediagen image generate --help`, `mediagen image edit --help`, and
   `mediagen video generate --help` (flags, sizes, vendor-specific options, examples).
