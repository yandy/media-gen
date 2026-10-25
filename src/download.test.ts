import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFilename, downloadImage, inferExtension, uniquePath } from "./download.js";
import { ApiError } from "./errors.js";
import type { ImageResult } from "./types.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const HTML_BYTES = Buffer.from("<!doctype html><html><body>proxy blocked</body></html>");
const STAMP = "20261024-150405";
const BASE_NAME = `qwen-qwen-image-3-0-${STAMP}-0.png`;

let tempDir: string;
let outDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-download-"));
  outDir = path.join(tempDir, "out");
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function imageResult(overrides: Partial<ImageResult> = {}): ImageResult {
  return { url: "https://cdn.example.com/generated.png", ...overrides };
}

function downloadOptions(overrides: Record<string, unknown> = {}) {
  return {
    outDir,
    provider: "qwen",
    model: "Qwen Image 3.0",
    stamp: STAMP,
    index: 0,
    ...overrides,
  };
}

function stubFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("buildFilename", () => {
  it("produces provider-slug-stamp-index.ext", () => {
    expect(
      buildFilename({
        provider: "qwen",
        model: "Qwen Image 3.0",
        stamp: STAMP,
        index: 2,
        ext: "png",
      }),
    ).toBe("qwen-qwen-image-3-0-20261024-150405-2.png");
  });

  it("does not zero-pad the index", () => {
    expect(
      buildFilename({
        provider: "ark",
        model: "doubao-seedream-5-0",
        stamp: STAMP,
        index: 0,
        ext: "jpg",
      }),
    ).toBe("ark-doubao-seedream-5-0-20261024-150405-0.jpg");
  });
});

describe("inferExtension", () => {
  it("prefers outputFormat png over the URL and content type", () => {
    const result = imageResult({
      url: "https://cdn.example.com/generated.webp",
      outputFormat: "png",
    });

    expect(inferExtension(result, "image/heic")).toBe("png");
  });

  it("maps outputFormat jpeg to jpg", () => {
    expect(inferExtension(imageResult({ outputFormat: "jpeg" }))).toBe("jpg");
  });

  it("lowercases other non-empty outputFormat values", () => {
    expect(inferExtension(imageResult({ outputFormat: "WEBP" }))).toBe("webp");
  });

  it("falls back to a known URL extension, ignoring query and fragment", () => {
    const result = imageResult({
      url: "https://cdn.example.com/path/image.WEBP?token=abc#frag",
    });

    expect(inferExtension(result, "image/heic")).toBe("webp");
  });

  it("falls back to the content type mapping, ignoring charset parameters", () => {
    expect(inferExtension(imageResult({ url: "https://cdn.example.com/download" }), "image/heic; charset=binary")).toBe(
      "heic",
    );
  });

  it("skips an unknown URL extension and uses the content type", () => {
    const result = imageResult({ url: "https://cdn.example.com/download.bin" });

    expect(inferExtension(result, "image/gif")).toBe("gif");
  });

  it("defaults to png when nothing matches", () => {
    expect(inferExtension(imageResult({ url: "https://cdn.example.com/download" }))).toBe("png");
    expect(
      inferExtension(imageResult({ url: "https://cdn.example.com/download.bin" }), "text/html"),
    ).toBe("png");
  });

  it.each([
    "../../evil",
    "..%2f..%2fevil",
    "/etc/passwd",
    "png/../../x",
    "p.ng",
    "PNG;DROP",
    "..",
    "a b",
  ])("refuses the traversal-shaped outputFormat %s and uses the next tier", (outputFormat) => {
    const fromUrl = imageResult({ url: "https://cdn.example.com/x/image.webp", outputFormat });
    expect(inferExtension(fromUrl, "image/gif")).toBe("webp");

    const nothingLeft = imageResult({ url: "https://cdn.example.com/download", outputFormat });
    expect(inferExtension(nothingLeft, "text/html")).toBe("png");
  });

  it("still accepts a plain alphanumeric outputFormat", () => {
    expect(inferExtension(imageResult({ outputFormat: "webp" }))).toBe("webp");
    expect(inferExtension(imageResult({ outputFormat: "JPEG" }))).toBe("jpg");
    expect(inferExtension(imageResult({ outputFormat: "tiff2" }))).toBe("tiff2");
  });
});

describe("uniquePath", () => {
  it("returns the input when the path is free", () => {
    const file = path.join(tempDir, "x.png");

    expect(uniquePath(file)).toBe(file);
  });

  it("inserts -2 before the extension when the path exists", () => {
    const file = path.join(tempDir, "x.png");
    fs.writeFileSync(file, "first");

    expect(uniquePath(file)).toBe(path.join(tempDir, "x-2.png"));
  });

  it("keeps counting while candidates exist", () => {
    const file = path.join(tempDir, "x.png");
    fs.writeFileSync(file, "first");
    fs.writeFileSync(path.join(tempDir, "x-2.png"), "second");

    expect(uniquePath(file)).toBe(path.join(tempDir, "x-3.png"));
  });

  it("appends the suffix when the path has no extension", () => {
    const file = path.join(tempDir, "x");
    fs.writeFileSync(file, "first");

    expect(uniquePath(file)).toBe(path.join(tempDir, "x-2"));
  });
});

describe("downloadImage", () => {
  it("writes the fetched bytes and reports the resolved path", async () => {
    const result = imageResult();
    const fetchMock = stubFetch(
      () =>
        new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const saved = await downloadImage(result, downloadOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(result.url);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(saved.url).toBe(result.url);
    expect(saved.index).toBe(0);
    expect(saved.meta).toBe(result);
    expect(saved.path).toBe(path.resolve(path.join(outDir, BASE_NAME)));
    expect(fs.readFileSync(saved.path)).toEqual(PNG_BYTES);
  });

  it("creates a missing nested outDir", async () => {
    stubFetch(() => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }));
    const nested = path.join(tempDir, "a", "b", "c");

    const saved = await downloadImage(imageResult(), downloadOptions({ outDir: nested }));

    expect(fs.existsSync(nested)).toBe(true);
    expect(saved.path).toBe(path.resolve(path.join(nested, BASE_NAME)));
    expect(fs.readFileSync(saved.path)).toEqual(PNG_BYTES);
  });

  it("never overwrites an existing file from the same run", async () => {
    const firstBytes = Buffer.from("first-image");
    const secondBytes = Buffer.from("second-image");
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      const body = calls === 1 ? firstBytes : secondBytes;
      return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
    });

    const first = await downloadImage(imageResult(), downloadOptions());
    const second = await downloadImage(imageResult(), downloadOptions());

    expect(second.path).toBe(path.resolve(path.join(outDir, `qwen-qwen-image-3-0-${STAMP}-0-2.png`)));
    expect(fs.readFileSync(first.path)).toEqual(firstBytes);
    expect(fs.readFileSync(second.path)).toEqual(secondBytes);
  });

  it("throws an ApiError naming the status and URL on a 500 response", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const result = imageResult({ url: "https://cdn.example.com/broken.png" });

    const error = await rejection(downloadImage(result, downloadOptions()));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("500");
    expect(error.message).toContain("https://cdn.example.com/broken.png");
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it("saves non-image bytes from a 200 response without throwing", async () => {
    stubFetch(
      () =>
        new Response(HTML_BYTES, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const result = imageResult({ url: "https://cdn.example.com/proxy-blocked" });

    const saved = await downloadImage(result, downloadOptions());

    expect(saved.path).toBe(path.resolve(path.join(outDir, BASE_NAME)));
    expect(fs.readFileSync(saved.path)).toEqual(HTML_BYTES);
  });

  it("surfaces a fetch timeout as an ApiError mentioning timeout", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = imageResult({ url: "https://cdn.example.com/slow.png" });

    const error = await rejection(downloadImage(result, downloadOptions()));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timeout/i);
    expect(error.message).toContain("https://cdn.example.com/slow.png");
  });

  it("reports a stall while reading the body as the same timeout ApiError", async () => {
    const url = "https://cdn.example.com/stalls-after-headers.png";
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const before = await rejection(downloadImage(imageResult({ url }), downloadOptions()));

    // Headers arrived, then the body read was aborted by the same deadline.
    stubFetch(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: () =>
            Promise.reject(new DOMException("The operation was aborted", "AbortError")),
        }) as unknown as Response,
    );
    const after = await rejection(downloadImage(imageResult({ url }), downloadOptions()));

    expect(after).toBeInstanceOf(ApiError);
    expect(after.message).toMatch(/timeout/i);
    expect(after.message).toContain(url);
    expect(after.message).toBe(before.message);
    expect(fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0).toBe(false);
  });

  it("maps a non-timeout body read failure to a download ApiError", async () => {
    stubFetch(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: () => Promise.reject(new TypeError("terminated")),
        }) as unknown as Response,
    );
    const result = imageResult({ url: "https://cdn.example.com/truncated.png" });

    const error = await rejection(downloadImage(result, downloadOptions()));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("failed to download");
    expect(error.message).toContain("https://cdn.example.com/truncated.png");
    expect(error.message).toContain("terminated");
    expect(error.message).not.toMatch(/timeout/i);
  });

  it("keeps a traversal-shaped outputFormat inside outDir", async () => {
    stubFetch(
      () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const result = imageResult({
      url: "https://cdn.example.com/download",
      outputFormat: "../../evil",
    });

    const saved = await downloadImage(result, downloadOptions());

    expect(saved.path.startsWith(`${path.resolve(outDir)}${path.sep}`)).toBe(true);
    expect(path.dirname(saved.path)).toBe(path.resolve(outDir));
    expect(saved.path.endsWith(".png")).toBe(true);
    // Nothing landed next to, or above, the output directory.
    expect(fs.readdirSync(tempDir)).toEqual(["out"]);
    expect(fs.readdirSync(outDir)).toEqual([path.basename(saved.path)]);
  });
});
