export type Dialect = "qwen" | "ark";

export interface ProviderConfig {
  name: string;
  api_type: Dialect;
  base_url: string;
  model: string;
  path: string;
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

export interface DialectAdapter {
  buildRequest(req: ImageRequest): unknown;
  parseResponse(json: unknown, requestId?: string): ParsedResponse;
}

export interface SavedFile {
  path: string;
  url: string;
  index: number;
  meta?: ImageResult;
}
