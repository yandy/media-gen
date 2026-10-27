import { ApiError, UsageError } from "../errors.js";
import type {
  ImageRequest,
  ImageResult,
  ParsedResponse,
  TaskAdapter,
} from "../types.js";

/**
 * Fields only the ark dialect accepts. Receiving one here means the caller
 * picked a vendor-specific flag for the wrong provider; fail loudly rather than
 * dropping it from the wire body.
 */
const ARK_ONLY_FIELDS = [
  "output_format",
  "optimize_prompt_mode",
  "layer_decomposition",
  "background",
] as const satisfies readonly (keyof ImageRequest)[];

/**
 * Fields only the OpenAI-compatible dialect accepts. The native protocol
 * documents no prompt-rewriting mode and no thinking switch, so these are
 * rejected instead of silently ignored by the server.
 */
const OPENAI_ONLY_FIELDS = ["prompt_extend_mode", "enable_thinking"] as const satisfies readonly (
  | keyof ImageRequest
)[];

/** The wire wants `宽*高`; the CLI takes `WxH` on every dialect. */
const PIXEL_PAIR = /^(\d+)x(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translates the CLI's `WxH` into the native protocol's `宽*高`. A value that is
 * not a pixel pair (a tier, "auto") is a caller error: tiers are an
 * OpenAI-compatible convenience and mapping them to pixels would be a silent
 * wrong size.
 */
export function toDashscopeSize(size: string): string {
  const value = size.trim();
  const pair = PIXEL_PAIR.exec(value);
  if (pair === null || Number(pair[1]) <= 0 || Number(pair[2]) <= 0) {
    throw new UsageError(
      `invalid --size ${JSON.stringify(size)}: the dashscope dialect sends a WxH pixel pair as 宽*高, e.g. 2048x2048`,
    );
  }
  return `${pair[1]}*${pair[2]}`;
}

/**
 * Translate the internal request into Bailian's native multimodal body. The
 * prompt is not a top-level field here: it is one `text` item inside a single
 * user message, and input images sit in the same array — images first, text
 * last, order preserved, because the model references them by position.
 */
export function buildDashscopeRequest(req: ImageRequest): Record<string, unknown> {
  for (const field of ARK_ONLY_FIELDS) {
    if (req[field] !== undefined) {
      throw new UsageError(
        `option "${field}" is ark-only and is not supported by the dashscope dialect; remove it or use an api_type = "ark" provider`,
      );
    }
  }

  for (const field of OPENAI_ONLY_FIELDS) {
    if (req[field] !== undefined) {
      throw new UsageError(
        `option "${field}" is openai dialect only and is not supported by the dashscope dialect; remove it or use an api_type = "openai" provider`,
      );
    }
  }

  const content: Record<string, unknown>[] = req.images.map((image) => ({ image }));
  content.push({ text: req.prompt });

  const parameters: Record<string, unknown> = { n: req.n };
  if (req.size !== undefined) parameters.size = toDashscopeSize(req.size);
  if (req.negative_prompt !== undefined) parameters.negative_prompt = req.negative_prompt;
  if (req.prompt_extend !== undefined) parameters.prompt_extend = req.prompt_extend;
  if (req.watermark !== undefined) parameters.watermark = req.watermark;
  if (req.seed !== undefined) parameters.seed = req.seed;

  return {
    model: req.model,
    input: { messages: [{ role: "user", content }] },
    parameters,
  };
}

/** The documentation's name for the array an image arrives in. */
const EXPECTED_SHAPE = "output.choices[].message.content[].image";

/**
 * Normalize a native response. Images live inside a chat-shaped envelope, mixed
 * with `text` items when the model interleaves them, so the array is filtered
 * rather than indexed.
 */
export function parseDashscopeResponse(json: unknown, requestId?: string): ParsedResponse {
  if (!isRecord(json)) {
    throw new ApiError("dashscope API returned a response that is not a JSON object");
  }

  // A failed task reports at the top level rather than under `error`.
  if (typeof json.code === "string" && json.code !== "") {
    const message =
      typeof json.message === "string" && json.message.trim() !== ""
        ? json.message
        : "dashscope API request failed";
    throw new ApiError(message, json.code);
  }

  if (!isRecord(json.output) || !Array.isArray(json.output.choices)) {
    throw new ApiError(`dashscope API response is missing ${EXPECTED_SHAPE}`);
  }

  const images: ImageResult[] = [];
  for (const choice of json.output.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const content = choice.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (isRecord(item) && typeof item.image === "string" && item.image !== "") {
        images.push({ url: item.image });
      }
    }
  }

  if (images.length === 0) {
    // Distinct from a malformed body: the envelope was right, the model simply
    // produced no image, and saying so points at the prompt, not the parser.
    throw new ApiError("dashscope API returned no images");
  }

  const parsed: ParsedResponse = { images, failures: [] };
  const bodyRequestId = json.request_id;
  if (requestId !== undefined) {
    parsed.requestId = requestId;
  } else if (typeof bodyRequestId === "string" && bodyRequestId !== "") {
    parsed.requestId = bodyRequestId;
  }
  if (isRecord(json.usage)) parsed.usage = json.usage;
  return parsed;
}

/**
 * The native error envelope reports failures at the top level — no `error`
 * object — so the generic extractor in http.ts cannot see them.
 */
export function parseDashscopeError(
  json: unknown,
): { code?: string; message: string } | undefined {
  if (!isRecord(json)) return undefined;
  const message = typeof json.message === "string" ? json.message.trim() : "";
  if (message === "") return undefined;

  const code =
    typeof json.code === "string" && json.code !== "" ? json.code : undefined;
  return code === undefined ? { message } : { code, message };
}

export const DashscopeDialect: TaskAdapter = {
  createPath: "/api/v1/services/aigc/multimodal-generation/generation",
  buildRequest: buildDashscopeRequest,
  parseResponse: parseDashscopeResponse,
  parseErrorBody: parseDashscopeError,
};
