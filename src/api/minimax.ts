import { ApiError, UsageError } from "../errors.js";
import type {
  AsyncTaskAdapter,
  AsyncTaskResult,
  TaskOutcome,
  VideoRequest,
} from "../types.js";

/**
 * MiniMax H3's video API. It is a separate dialect rather than a second shape inside
 * `ark` because it is a different service: its own endpoints (and its poll path does
 * not share the create path's prefix), its own error envelope, and its own required
 * fields.
 *
 * The wire body, though, is the same vocabulary ark speaks — `content[]` items typed
 * `text` / `image_url` / `video_url` / `audio_url`, labelled with the same `role`
 * names — which is what makes one internal request model serve both.
 */

/**
 * Fields this dialect does not accept, rejected here as well as by the validator. The
 * registry already expresses the policy (`exclusiveFields: []`); this list is the
 * direct-call guard, so the two must agree.
 */
const UNSUPPORTED_FIELDS = ["watermark", "generate_audio", "output_format", "seed"] as const satisfies readonly (
  | keyof VideoRequest
)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The dialect's own defaults for the two fields MiniMax requires and ark does not:
 * leaving them out is a rejected request here, so the adapter — not the CLI — decides
 * what they fall back to.
 *
 * `768p` rather than `2k` because it is the cheaper tier, and 768p is supported by
 * every H3 variant while 2K is not.
 */
const DEFAULT_RESOLUTION = "768p";
const DEFAULT_DURATION_SECONDS = 5;

/** The wire spells resolutions in upper case (`768P`, `2K`). */
function wireResolution(value: string): string {
  return value.toUpperCase();
}

export function buildMinimaxVideoRequest(req: VideoRequest): Record<string, unknown> {
  for (const field of UNSUPPORTED_FIELDS) {
    if (req[field] !== undefined) {
      throw new UsageError(
        `option "${field}" is not supported by the minimax dialect; remove it`,
      );
    }
  }

  const content: Record<string, unknown>[] = [{ type: "text", text: req.prompt }];
  if (req.first_frame !== undefined) {
    content.push({
      type: "image_url",
      image_url: { url: req.first_frame },
      role: "first_frame",
    });
  }

  // Both are required by this API, so they are always written, defaults included.
  // `ratio` is deliberately not defaulted: on a first-frame task the vendor decides
  // it from the image and ignores whatever is sent, and on a text-to-video task the
  // vendor requires a concrete value — inventing one here would silently pick a shape.
  return {
    model: req.model,
    content,
    resolution: wireResolution(req.resolution ?? DEFAULT_RESOLUTION),
    duration: req.duration ?? DEFAULT_DURATION_SECONDS,
    ...(req.ratio === undefined ? {} : { ratio: req.ratio }),
  };
}

export function taskIdFromMinimax(json: unknown): string {
  if (!isRecord(json) || typeof json.task_id !== "string" || json.task_id === "") {
    throw new ApiError("minimax create response is missing the task id");
  }
  return json.task_id;
}

export function minimaxPollPath(id: string): string {
  // Not `createPath + "/" + id`: this vendor queries under a different prefix.
  return `/v2/query/video_generation/${encodeURIComponent(id)}`;
}

function minimaxFailure(error: unknown): { code?: string; message: string } {
  // The engine already prints the state, so repeating it here would read as a
  // contradiction ("cancelled: minimax task cancelled"). Say instead that the vendor
  // explained nothing.
  const fallback = "minimax reported no message";
  if (isRecord(error)) {
    const message =
      typeof error.message === "string" && error.message.trim() !== "" ? error.message : fallback;
    const code = typeof error.type === "string" && error.type !== "" ? error.type : undefined;
    return code === undefined ? { message } : { code, message };
  }
  // The engine prefixes the state, so the fallback names it to avoid "cancelled:
  // minimax task failed", which reads as a contradiction.
  return { message: fallback };
}

/**
 * One poll body → a verdict. The result is nested under `task`, unlike ark's flat
 * document, which is the reason each dialect parses its own.
 */
export function minimaxPollOutcome(json: unknown): TaskOutcome {
  if (!isRecord(json) || !isRecord(json.task)) {
    throw new ApiError("minimax query response is missing the task object");
  }

  const task = json.task;
  const status = task.status;

  // `queued` is this vendor's word for the state the engine calls pending.
  if (status === "queued") return { state: "pending" };
  if (status === "running") return { state: "running" };

  if (status === "succeeded") {
    if (!isRecord(task.content) || typeof task.content.url !== "string" || task.content.url === "") {
      throw new ApiError("minimax task succeeded without content.url");
    }

    const result: AsyncTaskResult = { url: task.content.url };
    if (typeof task.model === "string" && task.model !== "") result.model = task.model;
    if (typeof task.duration === "number") result.duration = task.duration;
    if (typeof task.resolution === "string") result.resolution = task.resolution;
    if (typeof task.ratio === "string") result.ratio = task.ratio;
    if (isRecord(task.usage)) result.usage = task.usage;
    return { state: "succeeded", result };
  }

  if (status === "failed") return { state: "failed", failure: minimaxFailure(task.error) };
  if (status === "cancelled") return { state: "cancelled", failure: minimaxFailure(task.error) };

  // A status nobody anticipated must fail loudly: treating it as "still running" would
  // burn the whole poll budget on a paid task while the answer never changes.
  throw new ApiError(
    `minimax task reported the unknown status ${JSON.stringify(status)}`,
  );
}

/**
 * The error envelope is not the OpenAI shape: it is `{type:"error", error:{type,
 * message, http_code}}`. `error.type` is a stable category, while the numeric code the
 * vendor also embeds in `message` is text, so the category is what travels as `code`.
 */
export function parseMinimaxError(
  json: unknown,
): { code?: string; message: string } | undefined {
  if (!isRecord(json) || json.type !== "error" || !isRecord(json.error)) return undefined;
  const message = typeof json.error.message === "string" ? json.error.message.trim() : "";
  if (message === "") return undefined;
  const code = typeof json.error.type === "string" && json.error.type !== "" ? json.error.type : undefined;
  return code === undefined ? { message } : { code, message };
}

export const MinimaxVideoDialect: AsyncTaskAdapter = {
  dialect: "minimax",
  createPath: "/v2/video_generation",
  buildRequest: buildMinimaxVideoRequest,
  taskIdFrom: taskIdFromMinimax,
  pollPath: minimaxPollPath,
  pollOutcome: minimaxPollOutcome,
  parseErrorBody: parseMinimaxError,
  resolutions: ["480p", "768p", "2k"],
  // None of the dialect-specific optional fields: this API takes model, content,
  // resolution, duration and ratio, and nothing else.
  exclusiveFields: [],
};
