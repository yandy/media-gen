import { ApiError, UsageError } from "../errors.js";
import type {
  ImageRequest,
  ImageResult,
  ParsedResponse,
  TaskAdapter,
} from "../types.js";

/**
 * Fields that only the ark dialect accepts. Receiving one on the openai dialect
 * means the caller selected a vendor-specific flag for the wrong protocol;
 * fail loudly rather than dropping it from the wire body.
 */
const ARK_ONLY_FIELDS = [
  "output_format",
  "optimize_prompt_mode",
  "layer_decomposition",
  "background",
] as const satisfies readonly (keyof ImageRequest)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translate the internal request into Alibaba Bailian's flat image-generation
 * body. Keys are assigned explicitly so unknown request keys never leak into
 * the vendor payload and undefined options stay omitted.
 */
export function buildQwenRequest(req: ImageRequest): Record<string, unknown> {
  for (const field of ARK_ONLY_FIELDS) {
    if (req[field] !== undefined) {
      throw new UsageError(
        `option "${field}" is ark-only and is not supported by the openai dialect; remove it or set api_type = "ark" on this task`,
      );
    }
  }

  if (req.prompt_extend_mode === "agent" && req.images.length > 0) {
    throw new UsageError(
      'prompt_extend_mode "agent" is only supported for text-to-image; image-to-image (图生图) does not support it',
    );
  }

  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
  };

  if (req.images.length === 1) {
    body.image = req.images[0];
  } else if (req.images.length > 1) {
    body.image = [...req.images];
  }

  body.n = req.n;

  if (req.size !== undefined) body.size = req.size;
  if (req.negative_prompt !== undefined) body.negative_prompt = req.negative_prompt;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.prompt_extend !== undefined) body.prompt_extend = req.prompt_extend;
  if (req.prompt_extend_mode !== undefined) body.prompt_extend_mode = req.prompt_extend_mode;
  if (req.enable_thinking !== undefined) body.enable_thinking = req.enable_thinking;
  if (req.watermark !== undefined) body.watermark = req.watermark;

  return body;
}

/**
 * Normalize a qwen response. qwen reports failures at the body level, so
 * per-image failures are always empty; usage is passed through unchanged.
 */
export function parseQwenResponse(json: unknown, requestId?: string): ParsedResponse {
  if (!isRecord(json)) {
    throw new ApiError("openai API returned a response that is not a JSON object");
  }

  if ("error" in json && json.error !== undefined && json.error !== null) {
    if (!isRecord(json.error)) {
      throw new ApiError("openai API returned an unrecognized error body");
    }
    const code = typeof json.error.code === "string" ? json.error.code : undefined;
    const message =
      typeof json.error.message === "string" && json.error.message.trim() !== ""
        ? json.error.message
        : "openai API request failed";
    throw new ApiError(message, code);
  }

  if (!("data" in json) || json.data === undefined) {
    throw new ApiError("openai API response is missing the data array");
  }
  if (!Array.isArray(json.data)) {
    throw new ApiError("openai API response data is not an array");
  }
  if (json.data.length === 0) {
    throw new ApiError("openai API returned no images");
  }

  const images: ImageResult[] = json.data.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.url !== "string" || entry.url === "") {
      throw new ApiError(`openai API response image ${index + 1} is missing a url`);
    }
    return { url: entry.url };
  });

  const parsed: ParsedResponse = { images, failures: [] };
  if (requestId !== undefined) parsed.requestId = requestId;
  if (isRecord(json.usage)) parsed.usage = json.usage;
  return parsed;
}

export const QwenDialect: TaskAdapter = {
  createPath: "/compatible-mode/v1/images/generations",
  buildRequest: buildQwenRequest,
  parseResponse: parseQwenResponse,
};
