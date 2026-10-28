import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./errors.js";
import type { ImageResult, MediaKind, SavedFile, SavedMedia } from "./types.js";
import { slugModel } from "./util.js";

/** Vendor image URLs expire after 24h, so a stalled download must not hang a run. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * A clip is one large file from a slower endpoint than an image, so a video
 * download gets its own, longer deadline instead of the image one.
 */
export const VIDEO_DOWNLOAD_TIMEOUT_MS = 600_000;

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

const KNOWN_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv"]);

const IMAGE_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

const VIDEO_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
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

/** `kind` is required here: the extension rules and the deadline both depend on it. */
export interface DownloadMediaOptions extends DownloadImageOptions {
  kind: MediaKind;
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
 *
 * The timeout message repeats the deadline that was actually used, so a video
 * stall cannot be reported as an image one.
 */
function downloadFailure(url: string, error: unknown, timeoutMs: number): ApiError {
  if (isTimeoutError(error)) {
    return new ApiError(`download timeout after ${timeoutMs / 1000}s for ${url}`);
  }
  return new ApiError(`failed to download ${url}: ${errorMessage(error)}`);
}

/** Reads the extension from a URL path, ignoring query strings and fragments. */
function extensionFromUrl(url: string, knownExtensions: Set<string>): string | undefined {
  const pathname = url.split(/[?#]/)[0] ?? "";
  const extension = path.extname(pathname).toLowerCase().replace(/^\./, "");
  return knownExtensions.has(extension) ? extension : undefined;
}

function extensionFromContentType(
  contentType: string,
  knownExtensions: Record<string, string>,
): string | undefined {
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime === undefined ? undefined : knownExtensions[mime];
}

/**
 * Picks the saved file extension for one media kind.
 *
 * An image uses the vendor `outputFormat` first, then the URL path, then the
 * content type, and `png` as the last resort.
 *
 * A video may not: its URL often carries a thumbnail suffix (`.jpg`/`.png`) or
 * no suffix at all, and naming a clip after bytes it does not hold would be a
 * lie. So `kind` outranks the URL — only a *video* URL extension can win — and
 * the fallback is `mp4` rather than `png`.
 */
export function inferExtension(
  result: SavedMedia,
  contentType?: string,
  kind: MediaKind = "image",
): string {
  if (kind === "video") {
    const fromVideoUrl = extensionFromUrl(result.url, KNOWN_VIDEO_EXTENSIONS);
    if (fromVideoUrl !== undefined) return fromVideoUrl;

    if (contentType !== undefined) {
      const fromContentType = extensionFromContentType(contentType, VIDEO_CONTENT_TYPE_EXTENSIONS);
      if (fromContentType !== undefined) return fromContentType;
    }

    return "mp4";
  }

  const outputFormat =
    "outputFormat" in result ? result.outputFormat?.trim().toLowerCase() : undefined;
  if (outputFormat !== undefined && SAFE_EXTENSION.test(outputFormat)) {
    return outputFormat === "jpeg" ? "jpg" : outputFormat;
  }

  const fromUrl = extensionFromUrl(result.url, KNOWN_IMAGE_EXTENSIONS);
  if (fromUrl !== undefined) return fromUrl;

  if (contentType !== undefined) {
    const fromContentType = extensionFromContentType(contentType, IMAGE_CONTENT_TYPE_EXTENSIONS);
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
 * Downloads one piece of media to `outDir` and returns the path that was
 * written. Non-2xx responses and timeouts become `ApiError`s; bytes from a 2xx
 * response are saved as-is, even when they are not the expected kind.
 */
export async function downloadMedia(
  result: SavedMedia,
  opts: DownloadMediaOptions,
): Promise<SavedFile> {
  const timeoutMs = opts.kind === "video" ? VIDEO_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS;
  fs.mkdirSync(opts.outDir, { recursive: true });

  let response: Response;
  try {
    response = await fetch(result.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw downloadFailure(result.url, error, timeoutMs);
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
    throw downloadFailure(result.url, error, timeoutMs);
  }

  const ext = inferExtension(result, response.headers.get("content-type") ?? undefined, opts.kind);
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

/** The image half of `downloadMedia`: the image deadline and the image extension rules. */
export async function downloadImage(
  result: ImageResult,
  opts: DownloadImageOptions,
): Promise<SavedFile> {
  return downloadMedia(result, { ...opts, kind: "image" });
}
