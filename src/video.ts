import { UsageError } from "./errors.js";
import type { AsyncTaskAdapter, VideoRequest } from "./types.js";
import { toImageInput } from "./util.js";

/** Everything `video generate` may carry; `--n` and `--size` are image-only. */
export interface VideoOptions {
  provider?: string;
  model?: string;
  /** `collectImage` gathers repeats, so a second one must be rejected, never dropped. */
  image?: string[];
  resolution?: string;
  ratio?: string;
  duration?: number;
  seed?: number;
  watermark?: boolean;
  generateAudio?: boolean;
  outputFormat?: "mp4" | "mov";
  outDir?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Create the task and return its id instead of waiting; read by the pipeline. */
  noWait: boolean;
}

/**
 * The one closed ratio enum all video dialects share. It is not narrowed per
 * dialect and `adaptive` is neither filled in nor stripped: which mode forbids
 * or forces it (minimax rejects it for text-to-video, forces it for
 * image-to-video) is a model rule, and that layer is the vendor's.
 */
export const RATIOS: readonly string[] = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];

/**
 * Normalizes the tier to the internal lower-case shape, then checks it against
 * the dialect's own declaration. The model layer is never consulted: a tier the
 * dialect has is accepted here even when the selected *model* would not take
 * it, because there is no per-model capability table on purpose and the vendor
 * validates at create time, before charging.
 *
 * Lower case is the internal shape; the dialect translates the casing on the
 * wire (`768p` → `768P` for minimax).
 */
export function validateResolution(value: string, adapter: AsyncTaskAdapter): string {
  const tier = value.trim().toLowerCase();

  if (!adapter.resolutions.includes(tier)) {
    throw new UsageError(
      `invalid --resolution ${JSON.stringify(value)}: the ${adapter.dialect} dialect accepts ` +
        `${adapter.resolutions.join(", ")}; whether a model supports a tier is checked by the vendor`,
    );
  }

  return tier;
}

/** Format layer only: an integer of seconds. The per-model range is checked by the vendor. */
function validateDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(
      `invalid --duration ${JSON.stringify(value)}: expected a positive integer of seconds, ` +
        `e.g. --duration 5; the range a model allows is checked by the vendor`,
    );
  }
  return value;
}

/** Format layer only: a non-negative integer; -1 is one vendor's "you pick" sentinel, not a seed. */
function validateSeed(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`invalid --seed ${JSON.stringify(value)}: expected a non-negative integer`);
  }
  return value;
}

function validateRatio(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const ratio = value.trim();
  if (!RATIOS.includes(ratio)) {
    throw new UsageError(
      `invalid --ratio ${JSON.stringify(value)}: expected one of ${RATIOS.join(", ")}`,
    );
  }
  return ratio;
}

function validatePrompt(prompt: string): string {
  const text = prompt.trim();
  if (text === "") {
    throw new UsageError("a video prompt is required: pass the clip's description as the first argument");
  }
  return text;
}

/**
 * One image, the first frame. `--image` is collected rather than overwritten, so
 * a second path arrives here as a second element; dropping it silently would
 * let the user believe a last frame went to the vendor.
 */
function firstFrame(images: readonly string[]): string | undefined {
  if (images.length > 1) {
    throw new UsageError(
      `only one --image is supported, the clip's first frame; the second --image ` +
        `${JSON.stringify(images[1])} would be a last frame (last_frame), and first/last-frame mode ` +
        `is not implemented yet`,
    );
  }
  return images[0];
}

/**
 * Dialect layer for the flags that are dialect-specific: a dialect declares the
 * wire fields it accepts in `exclusiveFields`, and anything else it is handed
 * must fail here rather than be ignored by the create endpoint after it charged.
 * The wording mirrors the image path's message for the same mistake.
 */
function rejectUndeclaredFlags(opts: VideoOptions, adapter: AsyncTaskAdapter): void {
  const declared = adapter.exclusiveFields ?? [];

  if (opts.generateAudio !== undefined && !declared.includes("generate_audio")) {
    throw undeclaredFlag("--generate-audio", "generate_audio", adapter);
  }
  if (opts.outputFormat !== undefined && !declared.includes("output_format")) {
    throw undeclaredFlag("--output-format", "output_format", adapter);
  }
}

function undeclaredFlag(
  flag: string,
  field: keyof VideoRequest,
  adapter: AsyncTaskAdapter,
): UsageError {
  return new UsageError(
    `option "${field}" (${flag}) is not supported by the ${adapter.dialect} dialect; ` +
      `remove ${flag}, or select a provider whose dialect accepts it`,
  );
}

/**
 * The whole local half of a video request: every check that can fail without
 * spending money, then the body itself. Pure — no network, no config, no file
 * writes; the only I/O is reading the frame path the caller gave.
 *
 * The adapter's `buildRequest` is not called here — `createTask` serializes the
 * body — so the dialect layer has to live here: `resolutions` and
 * `exclusiveFields` are the only local gate before the paid create.
 */
export function buildVideoRequest(
  prompt: string,
  opts: VideoOptions,
  model: string,
  adapter: AsyncTaskAdapter,
): VideoRequest {
  // Layer 1, format: legal shapes only, nothing vendor-specific.
  const text = validatePrompt(prompt);
  const duration = validateDuration(opts.duration);
  const seed = validateSeed(opts.seed);
  const ratio = validateRatio(opts.ratio);
  const frame = firstFrame(opts.image ?? []);

  // Layer 2, dialect: what the selected protocol declares it accepts. Layer 3,
  // the model, is the vendor's and is never answered here.
  rejectUndeclaredFlags(opts, adapter);
  const resolution =
    opts.resolution === undefined ? undefined : validateResolution(opts.resolution, adapter);

  const request: VideoRequest = { model, prompt: text };
  if (resolution !== undefined) request.resolution = resolution;
  if (ratio !== undefined) request.ratio = ratio;
  if (duration !== undefined) request.duration = duration;
  if (seed !== undefined) request.seed = seed;
  if (opts.watermark !== undefined) request.watermark = opts.watermark;
  if (opts.generateAudio !== undefined) request.generate_audio = opts.generateAudio;
  if (opts.outputFormat !== undefined) request.output_format = opts.outputFormat;

  // The frame is read last: every flag above refuses for free, and a missing
  // file must not be reported in place of a flag the user has to fix first.
  if (frame !== undefined) request.first_frame = readFrame(frame);

  return request;
}

/**
 * `toImageInput` is shared with the image path and none of its messages name a
 * flag, so the video path re-labels the failure as `--image` while keeping the
 * original cause's text and the exit-code-2 `UsageError` type.
 */
function readFrame(value: string): string {
  try {
    return toImageInput(value);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(`invalid --image ${JSON.stringify(value)}: ${error.message}`);
  }
}
