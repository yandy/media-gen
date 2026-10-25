---
name: media-cli
description: Use this skill whenever the user wants an image generated, created, drawn, illustrated, edited, modified, restyled, recoloured, upscaled, or composed from reference pictures — "draw me a picture", "generate a logo", "edit this photo", "make this image blue", "put this character in that scene", "render this text into an image". It drives the `media` CLI, which calls Alibaba Bailian qwen-image and Volcengine Ark doubao/seedream image models and saves the results as local files.
---

# media-cli: generate and edit images

`media` is a small, non-interactive image CLI: it writes every result to a local
file and prints the path. Each successful call is a paid API request.

## When to use it

- A new image from a text description (text-to-image).
- A change to an existing image: restyle, recolour, add or remove something,
  combine several references, upscale (pass `--image` plus a larger `--size`),
  or render text (CJK or Latin) into an image.

## When not to use it

- Video, audio, or documents: this build is image-only.
- Describing or analysing an image: `media` writes images, it cannot see them.
- Local pixel work (crop, resize, convert, compress): use an image tool
  instead — `media` spends money and round-trips to a vendor.

## One-time setup

```bash
# qwen needs BOTH a key and its workspace-scoped host; the built-in host 404s:
media login --provider qwen --base-url https://<workspace-id>.cn-beijing.maas.aliyuncs.com
media login --provider qwen --api-key sk-...   # stored in auth.json, mode 600
media login --provider ark  --api-key sk-...   # ark needs no host step
media auth status                              # which key each provider would use
```

`DASHSCOPE_API_KEY` (qwen) and `ARK_API_KEY` (ark) work instead of `login`, and
`--api-key sk-...` overrides both for a single call; no variable sets the host,
so qwen still needs the `base_url` step above. Never echo a key back to the
user; the CLI only ever prints it masked.

## Commands

```bash
# text to image; files land in --out-dir (default: output_dir in config.toml, else the cwd)
# qwen: only after the base_url step above; --provider ark works without it
media image generate "a red fox in fresh snow, soft morning light" --out-dir ./out

# edit one local image (local paths are read and sent as base64 data URLs)
media image edit "make the sky sunset orange, keep the composition" --image ./photo.jpg

# combine several references: repeat --image, and say which image is which
media image edit "the character from the first image wearing the jacket from the second" \
  --image ./character.png --image ./jacket.png

# machine-readable, for parsing paths and errors
media image generate "minimalist logo for a coffee roastery" --provider ark --n 4 --seed 42 --json
```

Add `--json` whenever you intend to parse the result. Without it, stdout is one
absolute file path per line and warnings go to stderr.

## Picking a model

| model | how to select | pick it when |
|---|---|---|
| `qwen-image-3.0` | `--provider qwen` (the default; needs its workspace `base_url`) | text rendering (CJK + Latin) and image editing |
| seedream 5.0 flash | `--provider ark` | speed: drafts, iteration, many variants |
| seedream 5.0 pro | `--provider ark --model doubao-seedream-5-0-pro` | highest quality; slower and more expensive |

Vendor ids are dated snapshots: override with `--model` (`media config show`
prints the id in use). `--provider` picks the dialect and response shape.

## Counting images

`--n` accepts 1-6 (else exit 2). qwen returns them from one request; **ark fans
out into one paid request per image** (seeded `seed`, `seed+1`, ...), so `--n 4`
on ark costs four requests. Keep `--n` at 1 while iterating on a prompt.

## Reading the result

- Exit 0: success. `--json` gives `{ok, partial, files[{path,index,url}], errors[], usage, request_id}`.
- Exit 0 with `partial: true`: some images arrived, some failed. The files on
  disk were already paid for — report them and do not re-run the whole request.
- Exit 1: an API/config failure; the message says what to change — a qwen `404`
  names the workspace host and prints the `media login --base-url` fix. No files.
- Exit 2: a usage error (bad flag, bad `--size`, `--n` outside 1-6, an
  `--out-dir` that cannot be created, or a vendor-specific flag sent to the
  wrong dialect). Fix the command; nothing was sent or paid for.

Boolean flags take an explicit value: `--watermark false`, not `--no-watermark`.

## Rules

1. Report the saved file path(s) back to the user, exactly as printed. That is
   the deliverable — a generation the user cannot find was wasted money.
2. Never re-run a request that already produced files; retry only a clean failure.
3. Never print an API key, and never invent flags: everything supported is
   listed by `media image generate --help` (flags, sizes, vendor-specific
   options, examples) and `media image edit --help`.
