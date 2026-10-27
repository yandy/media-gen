/**
 * A protocol family, not a vendor. `openai` is the OpenAI-compatible wire
 * format; `qwen` survives only as a deprecated alias of it in config.toml.
 */
export type Dialect = "openai" | "dashscope" | "ark";

/** A provider is the ledger — protocol, origin, credentials — never a model. */
export interface ProviderConfig {
  name: string;
  api_type: Dialect;
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
  // qwen extras
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
}

/** What a provider can be asked to produce. Each task has its own endpoint and adapter. */
export type Task = "image" | "video";

/**
 * One task's wire format for one dialect. `createPath` starts at the origin and
 * carries the version/API prefix itself (`/api/v3/images/generations`), so
 * `base_url` stays a single per-provider origin no matter how many tasks the
 * provider serves.
 */
export interface TaskAdapter {
  createPath: string;
  buildRequest(req: ImageRequest): unknown;
  parseResponse(json: unknown, requestId?: string): ParsedResponse;
}

/** Which tasks this dialect implements; a task absent here has no endpoint yet. */
export type DialectAdapters = Partial<Record<Task, TaskAdapter>>;

export interface SavedFile {
  path: string;
  url: string;
  index: number;
  meta?: ImageResult;
}
