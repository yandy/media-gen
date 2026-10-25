import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./errors.js";
import type { ImageResult, SavedFile } from "./types.js";
import { slugModel } from "./util.js";

/** Vendor image URLs expire after 24h, so a stalled download must not hang a run. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * A vendor-supplied `outputFormat` is interpolated into a file name, so it must
 * not be able to add path separators: `"../../evil"` would otherwise escape
 * `outDir` once the name is resolved. Anything that is not a bare alphanumeric
 * extension is treated as absent and the next inference tier decides.
 */
const SAFE_EXTENSION = /^[a-z0-9]+$/;

const KNOWN_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "gif",
  "heic",
  "heif",
]);

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

export interface BuildFilenameParams {
  provider: string;
  model: string;
  stamp: string;
  index: number;
  ext: string;
}

export interface DownloadImageOptions {
  outDir: string;
  provider: string;
  model: string;
  stamp: string;
  index: number;
}

/** Deterministic, sortable name: `<provider>-<slug(model)>-<stamp>-<index>.<ext>`. */
export function buildFilename(params: BuildFilenameParams): string {
  return `${params.provider}-${slugModel(params.model)}-${params.stamp}-${params.index}.${params.ext}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * Maps a download failure onto the two messages `generate` and `output` expect:
 * a stall (before or after the headers) is a timeout, anything else names the
 * URL and the cause. Both are `ApiError`s, never a raw `DOMException`.
 */
function downloadFailure(url: string, error: unknown): ApiError {
  if (isTimeoutError(error)) {
    return new ApiError(`download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s for ${url}`);
  }
  return new ApiError(`failed to download ${url}: ${errorMessage(error)}`);
}

/** Reads the extension from a URL path, ignoring query strings and fragments. */
function extensionFromUrl(url: string): string | undefined {
  const pathname = url.split(/[?#]/)[0] ?? "";
  const extension = path.extname(pathname).toLowerCase().replace(/^\./, "");
  return KNOWN_IMAGE_EXTENSIONS.has(extension) ? extension : undefined;
}

function extensionFromContentType(contentType: string): string | undefined {
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime === undefined ? undefined : CONTENT_TYPE_EXTENSIONS[mime];
}

/**
 * Picks the saved file extension: an explicit, path-safe vendor `outputFormat`
 * first, then the URL path, then the response content type, and `png` as the
 * last resort.
 */
export function inferExtension(result: ImageResult, contentType?: string): string {
  const outputFormat = result.outputFormat?.trim().toLowerCase();
  if (outputFormat !== undefined && SAFE_EXTENSION.test(outputFormat)) {
    return outputFormat === "jpeg" ? "jpg" : outputFormat;
  }

  const fromUrl = extensionFromUrl(result.url);
  if (fromUrl !== undefined) return fromUrl;

  if (contentType !== undefined) {
    const fromContentType = extensionFromContentType(contentType);
    if (fromContentType !== undefined) return fromContentType;
  }

  return "png";
}

/** Returns `filePath`, or `x-2.ext`, `x-3.ext`, ... when earlier candidates exist. */
export function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  for (let suffix = 2; ; suffix += 1) {
    const candidate = path.join(dir, `${base}-${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Downloads one result to `outDir` and returns the path that was written.
 * Non-2xx responses and timeouts become `ApiError`s; bytes from a 2xx response
 * are saved as-is, even when they are not an image.
 */
export async function downloadImage(
  result: ImageResult,
  opts: DownloadImageOptions,
): Promise<SavedFile> {
  fs.mkdirSync(opts.outDir, { recursive: true });

  let response: Response;
  try {
    response = await fetch(result.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw downloadFailure(result.url, error);
  }

  if (!response.ok) {
    throw new ApiError(`download failed with status ${response.status} for ${result.url}`);
  }

  // The body read shares the fetch deadline, so a stall after the headers is
  // reported exactly like a stall before them.
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw downloadFailure(result.url, error);
  }

  const ext = inferExtension(result, response.headers.get("content-type") ?? undefined);
  const name = buildFilename({
    provider: opts.provider,
    model: opts.model,
    stamp: opts.stamp,
    index: opts.index,
    ext,
  });
  const target = uniquePath(path.resolve(opts.outDir, name));
  fs.writeFileSync(target, bytes);

  return { path: target, url: result.url, index: opts.index, meta: result };
}
