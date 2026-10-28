import { ApiError, UsageError } from "./errors.js";
import type { ParsedResponse, SavedFile, SavedMedia } from "./types.js";

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

/**
 * Maps an error to the CLI exit-code contract: usage errors exit 2, everything
 * else exits 1. JSON payloads go to stdout so agents can parse them reliably.
 */
export function renderError(err: unknown, json: boolean): RenderedError {
  const message = describeError(err);
  const exitCode = err instanceof UsageError ? 2 : 1;

  if (json) {
    const error: { message: string; code?: string } = { message };
    if (err instanceof ApiError && err.code !== undefined) {
      error.code = err.code;
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
