import { ApiError, UsageError } from "./errors.js";
import type { ParsedResponse, SavedFile, SavedMedia, VideoResult } from "./types.js";

export interface RenderedOutput {
  stdout: string;
  stderr: string;
}

export interface RenderedError extends RenderedOutput {
  exitCode: number;
}

interface JsonFile {
  path: string;
  index: number;
  size?: string;
  url: string;
}

interface JsonPayload {
  ok: boolean;
  partial: boolean;
  files: JsonFile[];
  errors: { code: string; message: string }[];
  usage?: Record<string, unknown>;
  request_id?: string;
}

/**
 * Human mode keeps stdout machine-readable: one saved file path per line.
 * Everything else, including the partial-success warning, goes to stderr.
 */
export function renderHuman(saved: SavedFile[], res: ParsedResponse): RenderedOutput {
  const lines = res.failures.map((failure) => `warning: ${failure.code}: ${failure.message}`);

  if (saved.length > 0 && res.failures.length > 0) {
    lines.push(
      `note: ${saved.length} file(s) written, ${res.failures.length} failed; ` +
        "files are already on disk, do not retry the whole request.",
    );
  }

  return {
    stdout: saved.map((file) => file.path).join("\n"),
    stderr: lines.join("\n"),
  };
}

/**
 * Only an image result carries `size`; a video result does not. The envelope
 * asks for the field instead of assuming it, and `undefined` means omitted.
 */
function imageSize(meta: SavedMedia | undefined): string | undefined {
  return meta !== undefined && "size" in meta ? meta.size : undefined;
}

/** JSON mode is a single stable envelope; absent optional fields are omitted, not null. */
export function renderJson(saved: SavedFile[], res: ParsedResponse): string {
  const payload: JsonPayload = {
    ok: saved.length > 0,
    partial: saved.length > 0 && res.failures.length > 0,
    files: saved.map((file) => {
      const size = imageSize(file.meta);
      return {
        path: file.path,
        index: file.index,
        ...(size !== undefined ? { size } : {}),
        url: file.url,
      };
    }),
    errors: res.failures.map((failure) => ({
      code: failure.code,
      message: failure.message,
    })),
  };

  if (res.usage !== undefined) {
    payload.usage = res.usage;
  }
  if (res.requestId !== undefined) {
    payload.request_id = res.requestId;
  }

  return JSON.stringify(payload);
}

interface JsonVideoFile {
  path: string;
  index: number;
  url: string;
  duration?: number;
  resolution?: string;
}

/**
 * The video envelope. It has no `partial`: one request makes one video, so a run
 * either produced a file or raised. `ok` means "the command succeeded" — a task that
 * was created and is still running is `ok: true` with `files: []`, because reporting
 * it as a failure invites the caller to submit the paid task again.
 */
interface JsonVideoPayload {
  ok: boolean;
  task_id: string;
  status: VideoResult["status"];
  files: JsonVideoFile[];
  errors: { code: string; message: string }[];
  usage?: Record<string, unknown>;
  request_id?: string;
}

/** `ImageResult` has `size`; only a video result knows its duration and resolution. */
function videoExtras(meta: SavedMedia | undefined): { duration?: number; resolution?: string } {
  const extras: { duration?: number; resolution?: string } = {};
  if (meta === undefined) return extras;
  if ("duration" in meta && typeof meta.duration === "number") extras.duration = meta.duration;
  if ("resolution" in meta && typeof meta.resolution === "string") {
    extras.resolution = meta.resolution;
  }
  return extras;
}

export function renderVideoJson(result: VideoResult): string {
  const payload: JsonVideoPayload = {
    ok: true,
    task_id: result.taskId,
    status: result.status,
    files: result.saved.map((file) => {
      const extras = videoExtras(file.meta);
      return {
        path: file.path,
        index: file.index,
        url: file.url,
        ...(extras.duration === undefined ? {} : { duration: extras.duration }),
        ...(extras.resolution === undefined ? {} : { resolution: extras.resolution }),
      };
    }),
    errors: [],
  };

  if (result.usage !== undefined) payload.usage = result.usage;
  if (result.requestId !== undefined) payload.request_id = result.requestId;
  return JSON.stringify(payload);
}

/**
 * Human mode prints one line of result either way: the saved path, or — while the
 * task is still running — its id, which is the only handle the caller has. The
 * "created and paid for" note already went to stderr when the task was created.
 */
export function renderVideoHuman(result: VideoResult): RenderedOutput {
  const lines = result.saved.length > 0 ? result.saved.map((file) => file.path) : [result.taskId];
  return { stdout: lines.join("\n"), stderr: "" };
}

/**
 * Maps an error to the CLI exit-code contract: usage errors exit 2, everything
 * else exits 1. JSON payloads go to stdout so agents can parse them reliably.
 */
export function renderError(err: unknown, json: boolean): RenderedError {
  const message = describeError(err);
  const exitCode = err instanceof UsageError ? 2 : 1;

  if (json) {
    const error: { message: string; code?: string; task_id?: string } = { message };
    if (err instanceof ApiError && err.code !== undefined) {
      error.code = err.code;
    }
    // "Paid for, not finished" is not a failure the caller should retry, and the id
    // is what makes resuming possible — so it travels in the envelope, not only in
    // the human message the caller would have to scrape.
    if (err instanceof ApiError && err.taskId !== undefined) {
      error.task_id = err.taskId;
    }
    return { stdout: JSON.stringify({ error }), stderr: "", exitCode };
  }

  return { stdout: "", stderr: message, exitCode };
}

/** Any thrown value must render readably, including strings, objects, and undefined. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.trim() ? err.message : err.name || "unknown error";
  }

  if (typeof err === "string") {
    return err.trim() ? err : "unknown error";
  }

  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    return "unknown error";
  }

  if (typeof err === "number" || typeof err === "bigint" || typeof err === "boolean") {
    return String(err);
  }

  return "unknown error";
}
