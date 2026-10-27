import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for `http://` and `https://` URLs, false for local paths and data URLs. */
export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Normalizes a base URL for concatenation with a dialect endpoint: absolute
 * http(s) only, no credentials, no query or fragment, trailing slashes removed.
 * Returns undefined when `value` does not qualify, so each caller can raise its
 * own error class.
 *
 * The delimiter test runs on the raw string: `URL` reports an empty `search` and
 * `hash` for a dangling `?` or `#`, yet the literal concatenation would still
 * swallow the endpoint (`https://h/v1?` + `/images/generations` sends
 * `path=/v1&query=?/images/generations`). Credentials are refused for the same
 * reason they are refused in a log line: every caller echoes `base_url` back.
 */
export function normalizeHttpBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (/[?#]/.test(trimmed)) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Normalizes an image reference into a value both vendors accept: a URL, a
 * `data:` URL, or a local file encoded as `data:<mime>;base64,<data>`.
 */
export function toImageInput(value: string): string {
  if (value.startsWith("data:")) return value;
  if (isUrl(value)) return value;

  const extension = path.extname(value).toLowerCase();
  const mime = IMAGE_MIME_TYPES[extension];
  if (mime === undefined) {
    const supported = Object.keys(IMAGE_MIME_TYPES).join(", ");
    throw new UsageError(
      `unsupported image extension "${extension || "(none)"}" for ${value}; supported extensions: ${supported}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(value);
  } catch (error) {
    throw new UsageError(`cannot read image ${value}: ${errorMessage(error)}`);
  }

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Local-time timestamp in `yyyyMMdd-HHmmss` form, suitable for file names. */
export function nowStamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/** Lowercases a model id and collapses every run of non-alphanumerics to `-`. */
export function slugModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
