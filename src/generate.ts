import fs from "node:fs";
import os from "node:os";
import { shellArg } from "./toml.js";
import path from "node:path";
import { getDialect } from "./api/index.js";
import { resolveApiKey } from "./auth.js";
import { loadConfig, resolveProvider } from "./config.js";
import { downloadImage } from "./download.js";
import { ApiError, ConfigError, UsageError } from "./errors.js";
import { callImageApi } from "./http.js";
import type {
  Dialect,
  ImageRequest,
  ImageResult,
  ParsedResponse,
  ProviderConfig,
  SavedFile,
} from "./types.js";
import { normalizeHttpBaseUrl, nowStamp, toImageInput } from "./util.js";

export interface GenerateOptions {
  provider?: string;
  model?: string;
  images: string[];
  size?: string;
  n?: number;
  seed?: number;
  watermark?: boolean;
  negativePrompt?: string;
  promptExtend?: boolean;
  promptExtendMode?: "direct" | "agent";
  enableThinking?: boolean;
  outputFormat?: "png" | "jpeg";
  optimizePrompt?: "standard" | "fast";
  layerDecomposition?: boolean;
  background?: "transparent" | "opaque";
  outDir?: string;
  apiKey?: string;
  baseUrl?: string;
  edit: boolean;
}

export interface GenerateResult {
  saved: SavedFile[];
  response: ParsedResponse;
  provider: ProviderConfig;
}

/** Resolution tiers both vendors understand; pixel pairs are passed through. */
const SIZE_TIERS = ["1K", "1.5K", "2K", "3K", "4K"];
const PIXEL_PAIR = /^(\d+)x(\d+)$/;

/** The documented per-run image cap; on ark every image is a paid request. */
const N_LIMIT = 6;

/**
 * Light format check only: a tier, a `WxH` pair of positive integers joined by a
 * lowercase `x`, or `auto` on qwen. The value is passed to the vendor unchanged,
 * so arbitrary ark aspect ratios keep working without a per-vendor whitelist.
 */
export function validateSize(size: string, apiType: Dialect): void {
  const value = size.trim();

  if (SIZE_TIERS.includes(value.toUpperCase())) return;

  const pair = PIXEL_PAIR.exec(value);
  if (pair !== null && Number(pair[1]) > 0 && Number(pair[2]) > 0) return;

  if (apiType === "qwen" && value.toLowerCase() === "auto") return;

  const accepted =
    apiType === "qwen"
      ? `a tier (${SIZE_TIERS.join(", ")}), a WxH pixel pair of positive integers using a lowercase "x" (e.g. 1024x1024), or "auto"`
      : `a tier (${SIZE_TIERS.join(", ")}) or a WxH pixel pair of positive integers using a lowercase "x" (e.g. 1024x1024); "auto" is qwen-only`;
  throw new UsageError(`invalid --size ${JSON.stringify(size)}: expected ${accepted}`);
}

/**
 * Resolves the output directory: `--out-dir` beats config `output_dir` beats the
 * cwd. A leading `~` is expanded and the result is always absolute.
 */
export function resolveOutDir(
  outDir: string | undefined,
  configOutDir: string | undefined,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string {
  return path.resolve(cwd, expandHome(outDir ?? configOutDir ?? cwd, home));
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

function normalizeBaseUrl(value: string): string {
  const normalized = normalizeHttpBaseUrl(value);
  if (normalized === undefined) {
    throw new UsageError(
      `invalid --base-url ${JSON.stringify(value)}: expected an absolute http(s) URL without query or fragment`,
    );
  }
  return normalized;
}

function validateN(value: number | undefined): number {
  const n = value ?? 1;
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(
      `invalid --n ${JSON.stringify(value)}: expected an integer in the accepted range 1-${N_LIMIT}`,
    );
  }
  if (n > N_LIMIT) {
    throw new UsageError(
      `invalid --n ${n}: the limit is ${N_LIMIT} images per run; the accepted range is 1-${N_LIMIT}` +
        " (ark sends one paid request per image)",
    );
  }
  return n;
}

function validateSeed(value: number | undefined): number | undefined {
  if (value !== undefined && !Number.isInteger(value)) {
    throw new UsageError(`invalid --seed ${JSON.stringify(value)}: expected an integer`);
  }
  return value;
}

/**
 * Creates the output directory before the paid request: an unwritable or
 * impossible `--out-dir` must cost nothing, and the failure must name the path.
 */
function ensureOutDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `cannot create the output directory ${dir}: ${cause}; ` +
        "check --out-dir (or output_dir in config.toml)",
    );
  }
}

function missingKeyError(provider: ProviderConfig): ConfigError {
  // The hint must be a command that runs: login takes the provider as a flag.
  const hints = [`run "mediagen login --provider ${shellArg(provider.name)}"`];
  if (provider.api_key_env) hints.push(`set ${provider.api_key_env}`);
  hints.push("pass --api-key");
  return new ConfigError(
    `no API key found for provider "${provider.name}": ${hints.join(", ")}`,
  );
}

/** Copies only the options the caller actually set, so the wire body stays clean. */
function buildImageRequest(
  prompt: string,
  opts: GenerateOptions,
  model: string,
  images: string[],
  n: number,
  seed: number | undefined,
): ImageRequest {
  const request: ImageRequest = { model, prompt, images, n };

  if (seed !== undefined) request.seed = seed;
  if (opts.size !== undefined) request.size = opts.size;
  if (opts.watermark !== undefined) request.watermark = opts.watermark;
  if (opts.negativePrompt !== undefined) request.negative_prompt = opts.negativePrompt;
  if (opts.promptExtend !== undefined) request.prompt_extend = opts.promptExtend;
  if (opts.promptExtendMode !== undefined) request.prompt_extend_mode = opts.promptExtendMode;
  if (opts.enableThinking !== undefined) request.enable_thinking = opts.enableThinking;
  if (opts.outputFormat !== undefined) request.output_format = opts.outputFormat;
  if (opts.optimizePrompt !== undefined) request.optimize_prompt_mode = opts.optimizePrompt;
  if (opts.layerDecomposition !== undefined) request.layer_decomposition = opts.layerDecomposition;
  if (opts.background !== undefined) request.background = opts.background;

  return request;
}

/** Ark serves one image per request, so `n > 1` becomes `n` seeded sub-requests. */
function fanOut(request: ImageRequest, count: number, seed: number | undefined): ImageRequest[] {
  return Array.from({ length: count }, (_unused, index) => {
    const sub: ImageRequest = { ...request, n: 1 };
    if (seed !== undefined) sub.seed = seed + index;
    return sub;
  });
}

/**
 * One failed sub-request is one failed item, not a failed run: the partial
 * success contract reports it next to the images that did arrive. Dialect
 * conflicts were already ruled out by the pre-flight `buildRequest`, so every
 * rejection here is an API or transport failure.
 */
function failedResponse(error: unknown): ParsedResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof ApiError && error.code !== undefined ? error.code : "RequestFailed";
  return { images: [], failures: [{ code, message }] };
}

function mergeResponses(responses: ParsedResponse[]): ParsedResponse {
  const merged: ParsedResponse = { images: [], failures: [] };

  for (const response of responses) {
    merged.images.push(...response.images);
    merged.failures.push(...response.failures);
    if (merged.usage === undefined) merged.usage = response.usage;
    if (merged.requestId === undefined) merged.requestId = response.requestId;
  }

  return merged;
}

function noImagesError(providerName: string, failures: ParsedResponse["failures"]): ApiError {
  const [first] = failures;
  if (first === undefined) {
    return new ApiError(`${providerName} API returned no images`);
  }

  const detail = failures.map((failure) => `${failure.code}: ${failure.message}`).join("; ");
  return new ApiError(
    `${providerName} API returned no images; ${failures.length} request(s) failed: ${detail}`,
    first.code,
  );
}

/**
 * One failed download is one failed item, not a failed run: the generation was
 * already paid for and the vendor URL expires within 24h, so an agent told
 * "nothing succeeded" would re-generate and pay twice. The message keeps the
 * `downloadImage` cause verbatim (it names the status and the URL) and prefixes
 * the position in the run, so a gap in `saved[].index` is explainable.
 */
function downloadFailure(
  index: number,
  image: ImageResult,
  error: unknown,
): ParsedResponse["failures"][number] {
  const cause = error instanceof Error ? error.message : String(error);
  return { code: "DownloadError", message: `image ${index} (${image.url}): ${cause}` };
}

/** Every image came back but none reached the disk: report all accumulated failures. */
function nothingSavedError(providerName: string, failures: ParsedResponse["failures"]): ApiError {
  const detail = failures.map((failure) => `${failure.code}: ${failure.message}`).join("; ");
  const code = failures[0]?.code;
  return new ApiError(
    `${providerName} API returned images but none could be saved; ${failures.length} failure(s): ${detail}`,
    code === undefined || code === "" ? "DownloadError" : code,
  );
}

/**
 * Runs one generate/edit request end to end. Every check that can fail without
 * spending money runs before the first `fetch`: flags, provider, size, dialect
 * compatibility, image inputs, the API key, and the output directory. Paid
 * requests are never retried.
 */
export async function runGenerate(
  prompt: string,
  opts: GenerateOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GenerateResult> {
  if (opts.edit && opts.images.length === 0) {
    throw new UsageError("edit requires at least one --image");
  }
  const n = validateN(opts.n);
  const seed = validateSeed(opts.seed);
  const baseUrl = opts.baseUrl === undefined ? undefined : normalizeBaseUrl(opts.baseUrl);

  const config = loadConfig();
  const resolved = resolveProvider(opts.provider ?? config.default_provider, config);
  const provider = baseUrl === undefined ? resolved : { ...resolved, base_url: baseUrl };

  const dialect = getDialect(provider.api_type);
  if (opts.size !== undefined) validateSize(opts.size, provider.api_type);
  const model = opts.model ?? provider.model;

  // Build once with the raw references so the adapter can reject flags this
  // dialect does not accept, then swap in the prepared image inputs.
  const draft = buildImageRequest(prompt, opts, model, opts.images, n, seed);
  dialect.buildRequest(draft);
  const request: ImageRequest = { ...draft, images: draft.images.map(toImageInput) };

  const auth = resolveApiKey(provider, opts.apiKey, env);
  if (auth === null) throw missingKeyError(provider);

  const outDir = resolveOutDir(opts.outDir, config.output_dir);
  ensureOutDir(outDir);

  const fanOutRequests =
    provider.api_type === "ark" && n > 1 ? fanOut(request, n, seed) : [request];
  const responses =
    fanOutRequests.length === 1
      ? [await callImageApi({ provider, apiKey: auth.key, request: fanOutRequests[0] })]
      : await Promise.all(
          fanOutRequests.map((sub) =>
            callImageApi({ provider, apiKey: auth.key, request: sub }).catch(failedResponse),
          ),
        );

  const response = mergeResponses(responses);
  if (response.images.length === 0) throw noImagesError(provider.name, response.failures);

  const stamp = nowStamp();
  // Downloads run concurrently but are collected with `allSettled`, which keeps
  // the result in image order: `saved` stays sorted by `index` and a rejected
  // download leaves a gap instead of renumbering the files that did land.
  const outcomes = await Promise.allSettled(
    response.images.map((image, index) =>
      downloadImage(image, { outDir, provider: provider.name, model, stamp, index }),
    ),
  );

  const saved: SavedFile[] = [];
  response.images.forEach((image, index) => {
    const outcome = outcomes[index];
    if (outcome.status === "fulfilled") {
      saved.push(outcome.value);
    } else {
      response.failures.push(downloadFailure(index, image, outcome.reason));
    }
  });

  if (saved.length === 0) throw nothingSavedError(provider.name, response.failures);

  return { saved, response, provider };
}
