import { ApiError, UsageError } from "../errors.js";
import type {
  DialectAdapter,
  ImageRequest,
  ImageResult,
  ParsedResponse,
} from "../types.js";

/**
 * Fields that only the qwen dialect accepts. Receiving one on the ark dialect
 * means the caller selected a vendor-specific flag for the wrong provider;
 * fail loudly rather than dropping it from the wire body.
 */
const QWEN_ONLY_FIELDS = [
  "negative_prompt",
  "prompt_extend",
  "prompt_extend_mode",
  "enable_thinking",
] as const satisfies readonly (keyof ImageRequest)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number")) {
    return undefined;
  }
  return [...value];
}

function parseBoundingBox(value: unknown): ImageResult["boundingBox"] | undefined {
  if (!isRecord(value)) return undefined;

  const absolute = numberArray(value.absolute);
  const normalized = numberArray(value.normalized);
  if (absolute === undefined || normalized === undefined) return undefined;

  return { absolute, normalized };
}

/**
 * Translate the internal request into Volcengine Ark's image-generation body.
 * Keys are assigned explicitly so unknown request keys never leak into the
 * vendor payload and undefined options stay omitted. Ark serves one image per
 * request, so `n` is deliberately not part of the body.
 */
export function buildArkRequest(req: ImageRequest): Record<string, unknown> {
  for (const field of QWEN_ONLY_FIELDS) {
    if (req[field] !== undefined) {
      throw new UsageError(
        `option "${field}" is qwen-only and is not supported by the ark dialect; remove it or use a qwen provider`,
      );
    }
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

  if (req.size !== undefined) body.size = req.size;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.watermark !== undefined) body.watermark = req.watermark;
  if (req.output_format !== undefined) body.output_format = req.output_format;
  if (req.optimize_prompt_mode !== undefined) {
    body.optimize_prompt_options = { mode: req.optimize_prompt_mode };
  }
  if (req.layer_decomposition !== undefined) body.layer_decomposition = req.layer_decomposition;
  if (req.background !== undefined) body.background = req.background;

  body.response_format = "url";

  return body;
}

function parseArkFailure(value: Record<string, unknown>): { code: string; message: string } {
  const code =
    typeof value.code === "string" && value.code !== "" ? value.code : "UnknownError";
  const message =
    typeof value.message === "string" && value.message.trim() !== ""
      ? value.message
      : "ark API image request failed";
  return { code, message };
}

/**
 * Normalize an ark response. Unlike qwen, ark may reject individual `data`
 * items (content moderation, per-layer failures) while the rest succeed, so
 * per-item errors are collected instead of aborting the whole response. Only a
 * response with no usable image at all is an error.
 */
export function parseArkResponse(json: unknown, requestId?: string): ParsedResponse {
  if (!isRecord(json)) {
    throw new ApiError("ark API returned a response that is not a JSON object");
  }

  if ("error" in json && json.error !== undefined && json.error !== null) {
    if (!isRecord(json.error)) {
      throw new ApiError("ark API returned an unrecognized error body");
    }
    const code = typeof json.error.code === "string" ? json.error.code : undefined;
    const message =
      typeof json.error.message === "string" && json.error.message.trim() !== ""
        ? json.error.message
        : "ark API request failed";
    throw new ApiError(message, code);
  }

  if (!("data" in json) || json.data === undefined) {
    throw new ApiError("ark API response is missing the data array");
  }
  if (!Array.isArray(json.data)) {
    throw new ApiError("ark API response data is not an array");
  }

  const images: ImageResult[] = [];
  const failures: { code: string; message: string }[] = [];

  json.data.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new ApiError(`ark API response item ${index + 1} is not a JSON object`);
    }

    if ("error" in entry && entry.error !== undefined && entry.error !== null) {
      if (!isRecord(entry.error)) {
        throw new ApiError(`ark API response item ${index + 1} has an unrecognized error body`);
      }
      failures.push(parseArkFailure(entry.error));
      return;
    }

    if (typeof entry.url !== "string" || entry.url === "") {
      throw new ApiError(
        `ark API response item ${index + 1} has neither a url nor an error`,
      );
    }

    const image: ImageResult = { url: entry.url };
    if (typeof entry.size === "string") image.size = entry.size;
    if (typeof entry.output_format === "string") image.outputFormat = entry.output_format;
    if (typeof entry.z_index === "number") image.zIndex = entry.z_index;
    const boundingBox = parseBoundingBox(entry.bounding_box);
    if (boundingBox !== undefined) image.boundingBox = boundingBox;
    if (typeof entry.name === "string") image.name = entry.name;
    if (typeof entry.description === "string") image.description = entry.description;
    images.push(image);
  });

  if (images.length === 0) {
    if (failures.length > 0) {
      const [first] = failures;
      throw new ApiError(first.message, first.code);
    }
    throw new ApiError("ark API returned no images");
  }

  const parsed: ParsedResponse = { images, failures };
  if (requestId !== undefined) parsed.requestId = requestId;
  if (isRecord(json.usage)) parsed.usage = json.usage;
  return parsed;
}

export const ArkDialect: DialectAdapter = {
  path: "/images/generations",
  buildRequest: buildArkRequest,
  parseResponse: parseArkResponse,
};
