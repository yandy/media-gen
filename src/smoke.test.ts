import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

/**
 * End-to-end smoke test: the real `main()` from src/cli.ts, the real config
 * loader, the real dialect adapters, the real downloader — with only `fetch`
 * replaced. Nothing here touches the network, and the explicit env object below
 * guarantees no real API key is ever read.
 */

const QWEN_KEY = "sk-smoke-qwen-0123456789";
const ARK_KEY = "sk-smoke-ark-9876543210";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations";
const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const IMAGE_URL = "https://cdn.example.com/generated.png";

/** Distinctive bytes: if they land on disk, the download path really ran. */
const IMAGE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
]);

const TRACKED_ENV = [
  "MEDIAGEN_CLI_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "DASHSCOPE_API_KEY",
  "ARK_API_KEY",
] as const;

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

let tempDir: string;
let configDir: string;
let outDir: string;
let outChunks: string[] = [];
let errChunks: string[] = [];
let originalEnv: Record<string, string | undefined> = {};

/** The only environment the CLI may see; keys are fake and scoped to this run. */
function smokeEnv(): NodeJS.ProcessEnv {
  return {
    MEDIAGEN_CLI_CONFIG_DIR: configDir,
    DASHSCOPE_API_KEY: QWEN_KEY,
    ARK_API_KEY: ARK_KEY,
  };
}

function collectInto(sink: string[]): typeof process.stdout.write {
  return ((chunk: unknown): boolean => {
    sink.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-smoke-"));
  configDir = path.join(tempDir, "config");
  outDir = path.join(tempDir, "out");
  fs.mkdirSync(configDir, { recursive: true });
  // Deliberately not created: `runGenerate` must create the output directory
  // itself, before the paid request, so the failure case can assert that the
  // directory exists but stayed empty.

  // A real config.toml, so `output_dir` keeps generated files out of the repo
  // and the run exercises config loading as well. Providers are declared here
  // because nothing is built in any more.
  fs.writeFileSync(
    path.join(configDir, "config.toml"),
    [
      'default_provider = "dashscope"',
      `output_dir = ${JSON.stringify(outDir)}`,
      "",
      "[providers.dashscope]",
      'api_type = "qwen"',
      'base_url = "https://dashscope.aliyuncs.com"',
      'model = "qwen-image-3.0"',
      'api_key_env = "DASHSCOPE_API_KEY"',
      "",
      "[providers.volcengine]",
      'api_type = "ark"',
      'base_url = "https://ark.cn-beijing.volces.com"',
      'model = "doubao-seedream-5-0-flash-260915"',
      'api_key_env = "ARK_API_KEY"',
      "",
    ].join("\n"),
  );

  for (const key of TRACKED_ENV) originalEnv[key] = process.env[key];
  for (const key of TRACKED_ENV) delete process.env[key];
  Object.assign(process.env, smokeEnv());

  outChunks = [];
  errChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(collectInto(outChunks));
  vi.spyOn(process.stderr, "write").mockImplementation(collectInto(errChunks));

  // Any request a test forgot to stub must fail loudly, not hit the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected fetch call: this test must stub every request");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv = {};
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Records every request and routes POSTs to the API handler, GETs to the image. */
function stubFetch(
  apiHandler: (call: StubCall) => Response,
  imageHandler: () => Response = () =>
    new Response(IMAGE_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
): StubCall[] {
  const calls: StubCall[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: StubCall = {
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return call.method === "POST" ? apiHandler(call) : imageHandler();
    }),
  );

  return calls;
}

function apiOk(data: unknown[], usage: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ created: 1_700_000_000, data, usage }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "smoke-request-1" },
  });
}

function stdout(): string {
  return outChunks.join("");
}

function stderr(): string {
  return errChunks.join("");
}

describe("smoke: mediagen image generate (qwen, text to image)", () => {
  it("saves one file and prints the JSON envelope with exit code 0", async () => {
    const calls = stubFetch(() => apiOk([{ url: IMAGE_URL }], { image_count: 1 }));

    const code = await main(["image", "generate", "a cat", "--json"]);

    expect(code).toBe(0);
    expect(stderr()).toBe("");

    // One API request, to the seeded qwen endpoint, with the env key.
    expect(calls).toHaveLength(2);
    const api = calls[0];
    expect(api.method).toBe("POST");
    expect(api.url).toBe(QWEN_URL);
    expect(api.headers.Authorization).toBe(`Bearer ${QWEN_KEY}`);
    expect(api.body).toMatchObject({ model: "qwen-image-3.0", prompt: "a cat", n: 1 });

    // stdout is exactly one parseable JSON object.
    const payload = JSON.parse(stdout()) as {
      ok: boolean;
      partial: boolean;
      files: { path: string; index: number; url: string }[];
      errors: unknown[];
      usage?: Record<string, unknown>;
      request_id?: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.partial).toBe(false);
    expect(payload.errors).toEqual([]);
    expect(payload.files).toHaveLength(1);
    expect(payload.usage).toEqual({ image_count: 1 });
    expect(payload.request_id).toBe("smoke-request-1");

    // The reported file is really on disk, holds the stubbed bytes, and sits in
    // the configured output_dir under the documented name shape.
    const saved = payload.files[0];
    expect(saved.index).toBe(0);
    expect(saved.url).toBe(IMAGE_URL);
    expect(path.dirname(saved.path)).toBe(outDir);
    expect(path.basename(saved.path)).toMatch(/^dashscope-qwen-image-3-0-\d{8}-\d{6}-0\.png$/);
    expect(fs.readFileSync(saved.path).equals(IMAGE_BYTES)).toBe(true);
    expect(fs.readdirSync(outDir)).toEqual([path.basename(saved.path)]);

    // The key never reaches the output.
    expect(stdout()).not.toContain(QWEN_KEY);
    expect(stderr()).not.toContain(QWEN_KEY);
  });
});

describe("smoke: mediagen image edit (ark, one local PNG)", () => {
  it("sends the local file as a base64 data URL in exactly one request", async () => {
    const png = path.join(tempDir, "input.png");
    fs.writeFileSync(png, IMAGE_BYTES);

    const calls = stubFetch(() =>
      apiOk(
        [{ url: "https://ark-cdn.example.com/blue.jpeg", output_format: "jpeg" }],
        { completion_tokens: 10 },
      ),
    );

    const code = await main([
      "image", "edit", "make it blue",
      "--image", png,
      "--provider", "volcengine",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(stderr()).toBe("");

    const apiCalls = calls.filter((call) => call.method === "POST");
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].url).toBe(ARK_URL);
    expect(apiCalls[0].headers.Authorization).toBe(`Bearer ${ARK_KEY}`);

    const image = apiCalls[0].body?.image;
    expect(typeof image).toBe("string");
    expect(image).toBe(`data:image/png;base64,${IMAGE_BYTES.toString("base64")}`);
    expect(String(image).startsWith("data:image/png;base64,")).toBe(true);
    expect(apiCalls[0].body).toMatchObject({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "make it blue",
      response_format: "url",
    });

    const payload = JSON.parse(stdout()) as { ok: boolean; files: { path: string }[] };
    expect(payload.ok).toBe(true);
    expect(payload.files).toHaveLength(1);
    // ark reports output_format, which drives the saved extension.
    expect(payload.files[0].path.endsWith(".jpg")).toBe(true);
    expect(fs.readFileSync(payload.files[0].path).equals(IMAGE_BYTES)).toBe(true);
    expect(stdout()).not.toContain(ARK_KEY);
  });
});

describe("smoke: API failure", () => {
  it("exits 1 with a JSON error object and writes no files", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "InternalServiceError", message: "the backend exploded" },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );

    const code = await main(["image", "generate", "a cat", "--json"]);

    expect(code).toBe(1);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    // No image was returned, so nothing was downloaded.
    expect(calls.filter((call) => call.method !== "POST")).toHaveLength(0);

    const payload = JSON.parse(stdout()) as { error: { message: string; code?: string } };
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe("InternalServiceError");
    expect(payload.error.message).toContain("500");
    expect(payload.error.message).toContain("the backend exploded");
    expect(stderr()).toBe("");

    // Created before the request, and still empty: a failed run writes nothing.
    expect(fs.existsSync(outDir)).toBe(true);
    expect(fs.readdirSync(outDir)).toEqual([]);
    expect(stdout()).not.toContain(QWEN_KEY);
  });
});
