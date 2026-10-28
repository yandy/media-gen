import { ApiError, UsageError } from "../errors.js";
import type {
  AsyncTaskAdapter,
  AsyncTaskResult,
  ImageRequest,
  ImageResult,
  ParsedResponse,
  TaskAdapter,
  TaskOutcome,
  VideoRequest,
} from "../types.js";

/**
 * Fields that only the openai dialect accepts. Receiving one on the ark dialect
 * means the caller selected a flag for the wrong protocol;
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
        `option "${field}" is openai-dialect only and is not supported by the ark dialect; remove it or set api_type = "openai" on this task`,
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
 * Normalize an ark response. Unlike the openai dialect, ark may reject individual `data`
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

export const ArkDialect: TaskAdapter = {
  createPath: "/api/v3/images/generations",
  buildRequest: buildArkRequest,
  parseResponse: parseArkResponse,
};

/** One collection for both verbs: POST creates, GET .../{id} polls. */
const ARK_VIDEO_TASKS_PATH = "/api/v3/contents/generations/tasks";

/**
 * Translate the internal video request into ark's task body. The prompt and the
 * first frame share one ordered `content` array — ark derives the mode from
 * which items are present, so no mode field is sent. Keys are assigned
 * explicitly so unknown request keys never leak into the vendor payload.
 */
export function buildArkVideoRequest(req: VideoRequest): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: "text", text: req.prompt }];
  if (req.first_frame !== undefined) {
    content.push({
      type: "image_url",
      image_url: { url: req.first_frame },
      role: "first_frame",
    });
  }

  const body: Record<string, unknown> = { model: req.model, content };
  if (req.resolution !== undefined) body.resolution = req.resolution;
  if (req.ratio !== undefined) body.ratio = req.ratio;
  if (req.duration !== undefined) body.duration = req.duration;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.watermark !== undefined) body.watermark = req.watermark;
  if (req.generate_audio !== undefined) body.generate_audio = req.generate_audio;
  if (req.output_format !== undefined) body.output_format = req.output_format;

  return body;
}

/**
 * The task id of a create response. Unlike minimax's `task_id`, ark puts it at
 * the top level; a body without it is unusable, because every later poll and
 * resume needs that id.
 */
export function taskIdFromArk(json: unknown): string {
  if (!isRecord(json) || typeof json.id !== "string" || json.id === "") {
    throw new ApiError("ark create response is missing the task id");
  }
  return json.id;
}

/** The id goes in as one path segment: an id carrying `/` must not reshape the URL. */
export function arkPollPath(id: string): string {
  return `${ARK_VIDEO_TASKS_PATH}/${encodeURIComponent(id)}`;
}

function arkVideoResult(json: Record<string, unknown>): AsyncTaskResult {
  const content = json.content;
  if (!isRecord(content) || typeof content.video_url !== "string" || content.video_url === "") {
    throw new ApiError("ark task succeeded without content.video_url");
  }

  const result: AsyncTaskResult = { url: content.video_url };
  if (typeof json.model === "string") result.model = json.model;
  if (typeof json.duration === "number") result.duration = json.duration;
  if (typeof json.resolution === "string") result.resolution = json.resolution;
  if (typeof json.ratio === "string") result.ratio = json.ratio;
  if (typeof json.output_format === "string") result.format = json.output_format;
  if (isRecord(json.usage)) result.usage = json.usage;
  return result;
}

function arkVideoFailure(
  json: Record<string, unknown>,
  status: "failed" | "cancelled" | "expired",
): { code?: string; message: string } {
  const error = json.error;
  if (!isRecord(error)) {
    // Only `failed` carries a vendor error; a cancelled or expired task ends
    // without one, and the message still has to name what happened.
    return { message: `ark task ${status}` };
  }

  const failure: { code?: string; message: string } = {
    message:
      typeof error.message === "string" && error.message.trim() !== ""
        ? error.message
        : `ark task ${status}`,
  };
  if (typeof error.code === "string" && error.code !== "") failure.code = error.code;
  return failure;
}

/**
 * Read one poll response. `queued` is ark's name for "accepted, not started";
 * everything terminal becomes a result or a failure here so the polling loop
 * never has to interpret vendor vocabulary. An unknown status throws instead of
 * looping: a status nobody anticipated would otherwise poll until the budget
 * ran out and then report a paid task as unfinished.
 */
export function arkPollOutcome(json: unknown): TaskOutcome {
  if (!isRecord(json)) {
    throw new ApiError("ark task response is not a JSON object");
  }

  const status = json.status;
  if (status === "queued") return { state: "pending" };
  if (status === "running") return { state: "running" };
  if (status === "succeeded") return { state: "succeeded", result: arkVideoResult(json) };
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return { state: status, failure: arkVideoFailure(json, status) };
  }

  throw new ApiError(`ark task reported the unknown status ${JSON.stringify(status)}`);
}

export const ArkVideoDialect: AsyncTaskAdapter = {
  dialect: "ark",
  createPath: ARK_VIDEO_TASKS_PATH,
  buildRequest: buildArkVideoRequest,
  taskIdFrom: taskIdFromArk,
  pollPath: arkPollPath,
  pollOutcome: arkPollOutcome,
  resolutions: ["480p", "720p", "1080p", "4k"],
  exclusiveFields: ["generate_audio", "output_format"],
};
