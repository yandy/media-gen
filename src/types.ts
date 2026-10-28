/**
 * A protocol family, not a vendor. `openai` is the OpenAI-compatible wire
 * format; `qwen` survives only as a deprecated alias of it in config.toml.
 */
export type Dialect = "openai" | "dashscope" | "ark";

/** A provider is the ledger — host, credentials — never a model. */
export interface ProviderConfig {
  name: string;
  /**
   * The provider-level default protocol, unresolved: a task may override it.
   * Never decide how to serialize from this — read `TaskBinding.dialect`, which
   * is the protocol the run actually speaks.
   */
  api_type?: Dialect;
  base_url: string;
  api_key_env?: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  images: string[];      // URLs or data URLs
  size?: string;
  n: number;
  seed?: number;
  watermark?: boolean;
  // openai / dashscope options
  negative_prompt?: string;
  prompt_extend?: boolean;
  prompt_extend_mode?: "direct" | "agent";
  enable_thinking?: boolean;
  // ark extras
  output_format?: "png" | "jpeg";
  optimize_prompt_mode?: "standard" | "fast";
  layer_decomposition?: boolean;
  background?: "transparent" | "opaque";
}

export interface ImageResult {
  url: string;
  size?: string;
  outputFormat?: string;
  zIndex?: number;
  boundingBox?: { absolute: number[]; normalized: number[] };
  name?: string;
  description?: string;
}

export interface ParsedResponse {
  images: ImageResult[];
  failures: { code: string; message: string }[];
  usage?: Record<string, unknown>;
  requestId?: string;
}

/** Everything one run needs to know: which provider, which task, which model, how long. */
export interface TaskBinding {
  provider: ProviderConfig;
  task: Task;
  model: string;
  timeout_ms: number;
  /** A task's own endpoint path, for hosts whose layout differs from the vendor's. */
  path?: string;
  /** The effective protocol for this run: the task's api_type, else the provider's. */
  dialect: Dialect;
}

/** What a provider can be asked to produce. Each task has its own endpoint and adapter. */
export type Task = "image" | "video";

/**
 * One task's wire format for one dialect. `createPath` starts at the origin and
 * carries the version/API prefix itself (`/api/v3/images/generations`), so
 * `base_url` stays a single per-provider origin no matter how many tasks the
 * provider serves.
 *
 * This is the synchronous, one-round-trip shape. Async tasks have a second
 * phase — create, poll, fetch result — and live in their own
 * `AsyncTaskAdapter`: a sync adapter cannot express "not finished yet", so
 * folding the two together would put polling inside parseResponse.
 */
export interface TaskAdapter {
  createPath: string;
  buildRequest(req: ImageRequest): unknown;
  parseResponse(json: unknown, requestId?: string): ParsedResponse;
  /**
   * Extracts a vendor error from a non-2xx body. Dialects whose errors do not
   * use `{ error: { code, message } }` implement this; callers fall back to the
   * generic shape when it is absent or returns undefined.
   */
  parseErrorBody?(json: unknown): { code?: string; message: string } | undefined;
}

/** The internal request for one video task. Field names are the wire names. */
export interface VideoRequest {
  model: string;
  prompt: string;
  /** One image, as a URL or data URL; the first frame of the clip. */
  first_frame?: string;
  /** Already lower-cased; the dialect translates the casing on the wire. */
  resolution?: string;
  ratio?: string;
  /** Seconds. */
  duration?: number;
  seed?: number;
  watermark?: boolean;
  generate_audio?: boolean;
  output_format?: "mp4" | "mov";
}

/** One video task's output, read from the polling response that finished it. */
export interface AsyncTaskResult {
  url: string;
  /** The model id the server echoed: the name on disk must not be a guess. */
  model?: string;
  duration?: number;
  resolution?: string;
  ratio?: string;
  format?: string;
  usage?: Record<string, unknown>;
}

/** How one poll ended. Everything but pending/running is terminal. */
export type TaskOutcome =
  | { state: "pending" | "running" }
  | { state: "succeeded"; result: AsyncTaskResult }
  | {
      state: "failed" | "cancelled" | "expired";
      failure: { code?: string; message: string };
    };

/**
 * One task's async wire format: create, poll, read the outcome. The video half
 * of the registry, next to `TaskAdapter` rather than folded into it.
 */
export interface AsyncTaskAdapter {
  createPath: string;
  buildRequest(req: VideoRequest): unknown;
  /** The dialects disagree on the field name, so every one reads its own. */
  taskIdFrom(json: unknown): string;
  /** A function, not a suffix rule: a dialect's poll prefix may differ from its create path. */
  pollPath(id: string): string;
  /** One poll response into an explicit outcome, or "not done yet". */
  pollOutcome(json: unknown): TaskOutcome;
  /** Same contract as `TaskAdapter.parseErrorBody`. */
  parseErrorBody?(json: unknown): { code?: string; message: string } | undefined;
  /** Which resolution values this dialect accepts; validated locally before paying. */
  resolutions: readonly string[];
  /** Flags only this dialect accepts; another dialect receiving one must fail locally. */
  exclusiveFields?: readonly (keyof VideoRequest)[];
}

/** Which tasks this dialect implements; a task absent here has no endpoint yet. */
export type DialectAdapters = {
  image?: TaskAdapter;
  video?: AsyncTaskAdapter;
};

/** The two media kinds the download layer saves; each has its own extensions and deadline. */
export type MediaKind = "image" | "video";

/**
 * Either kind of media a run can save. A video is a finished async task's
 * result — there is no second video shape, `AsyncTaskResult` already carries
 * url/duration/resolution/format.
 */
export type SavedMedia = ImageResult | AsyncTaskResult;

export interface SavedFile {
  path: string;
  url: string;
  index: number;
  meta?: SavedMedia;
}
