---
name: mediagen
description: Use this skill whenever the user wants an image generated, created, drawn, illustrated, edited, modified, restyled, recoloured, upscaled, or composed from reference pictures — "draw me a picture", "generate a logo", "edit this photo", "make this image blue", "put this character in that scene", "render this text into an image". It drives the `mediagen` CLI, which calls Alibaba Bailian qwen-image and Volcengine Ark doubao/seedream image models and saves the results as local files.
---

# mediagen: generate and edit images

`mediagen` is a small, non-interactive image CLI: it writes every result to a local
file and prints the path. Each successful call is a paid API request.

## When to use it

- A new image from a text description (text-to-image).
- A change to an existing image: restyle, recolour, add or remove something,
  combine several references, upscale (pass `--image` plus a larger `--size`),
  or render text (CJK or Latin) into an image.

## When not to use it

- Video, audio, or documents: this build is image-only.
- Describing or analysing an image: `mediagen` writes images, it cannot see them.
- Local pixel work (crop, resize, convert, compress): use an image tool
  instead — `mediagen` spends money and round-trips to a vendor.

## One-time setup

Nothing is built in: a provider is declared in `config.toml`, which any command
creates on first use (with two commented entries: `dashscope`, `volcengine`) and
then validates before it runs.

```bash
mediagen config show        # prints what resolves; any command creates config.toml on first use
```

`base_url` ends at the version segment: the dialect appends the endpoint file name
(`/images/generations`) itself. qwen needs its workspace-scoped host, and the public
host 404s, so the seeded `[providers.dashscope].base_url` is a placeholder you must
finish: replace `<workspace-id>` with your workspace id, keeping the pattern, e.g.
`https://abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` (ark's seed is
usable as written). Until then `image generate` and `image edit` exit 1 without
sending anything; `config show`, `config path` and `auth status` still work, and
`login` exits 2 with the same message. To add another entry without hand-editing:

```bash
mediagen config add my-proxy --api-type qwen --base-url https://proxy.example.com/v1 \
  --model qwen-image-3.0 --api-key-env MY_PROXY_KEY
```

Then store keys:

```bash
mediagen login --provider dashscope --api-key sk-...   # stored in auth.json, mode 600
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
# --provider names an entry in config.toml; dashscope needs its workspace base_url first
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
| `qwen-image-3.0` | `--provider dashscope` (the default; needs its workspace `base_url`) | text rendering (CJK + Latin) and image editing |
| seedream 5.0 flash | `--provider volcengine` | speed: drafts, iteration, many variants |
| seedream 5.0 pro | `--provider volcengine --model doubao-seedream-5-0-pro` | highest quality; slower and more expensive |

`dashscope` / `volcengine` are the two names the first run writes into
`config.toml`; they are the seed's choices, not built-ins. Vendor ids are dated
snapshots: override with `--model` (`mediagen config show` prints the id in use).
`--provider` picks the entry point, and the entry's `api_type` picks the dialect
and response shape.

## Counting images

`--n` accepts 1-6 (else exit 2). qwen returns them from one request; **ark fans
out into one paid request per image** (seeded `seed`, `seed+1`, ...), so `--n 4`
on ark costs four requests. Keep `--n` at 1 while iterating on a prompt.

## Reading the result

- Exit 0: success. `--json` gives `{ok, partial, files[{path,index,url}], errors[], usage, request_id}`.
- Exit 0 with `partial: true`: some images arrived, some failed. The files on
  disk were already paid for — report them and do not re-run the whole request.
- Exit 1: an API/config failure; the message says what to change — a qwen `404`
  names the workspace host and points at `config.toml`. No files.
- Exit 2: a usage error (bad flag, bad `--size`, `--n` outside 1-6, an
  `--out-dir` that cannot be created, or a vendor-specific flag sent to the
  wrong dialect). Fix the command; nothing was sent or paid for.

Boolean flags take an explicit value: `--watermark false`, not `--no-watermark`.

## Rules

1. Report the saved file path(s) back to the user, exactly as printed. That is
   the deliverable — a generation the user cannot find was wasted money.
2. Never re-run a request that already produced files; retry only a clean failure.
3. Never print an API key, and never invent flags: everything supported is
   listed by `mediagen image generate --help` (flags, sizes, vendor-specific
   options, examples) and `mediagen image edit --help`.
