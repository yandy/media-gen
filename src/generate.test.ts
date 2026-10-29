import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareConfigFile } from "./config.js";
import { ApiError, ConfigError, UsageError } from "./errors.js";
import {
  resolveOutDir,
  runGenerate,
  validateSize,
  type GenerateOptions,
} from "./generate.js";
import type { Dialect, ImageResult } from "./types.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations";
const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const QWEN_KEY = "sk-test-qwen-key-0123456789";
const ARK_KEY = "sk-test-ark-key-0123456789";
const QWEN_ENV = { DASHSCOPE_API_KEY: QWEN_KEY };
const ARK_ENV = { ARK_API_KEY: ARK_KEY };
const NO_KEY_ENV = {};

const originalConfigDir = process.env.MEDIAGEN_CLI_CONFIG_DIR;

let tempDir: string;
let configHome: string;
let outDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-generate-"));
  configHome = path.join(tempDir, "config");
  outDir = path.join(tempDir, "out");
  process.env.MEDIAGEN_CLI_CONFIG_DIR = configHome;
  process.env.MEDIAGEN_CLI_STATE_DIR = path.join(tempDir, "state");
  // These tests drive runGenerate() directly, bypassing main()'s bootstrap, so a
  // config has to exist here. It is the documented shape with real base URLs: the
  // seed's qwen entry is a placeholder the user must edit, which config.test.ts
  // and cli.test.ts cover.
  writeConfigFor("");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalConfigDir === undefined) {
    delete process.env.MEDIAGEN_CLI_CONFIG_DIR;
  } else {
    process.env.MEDIAGEN_CLI_CONFIG_DIR = originalConfigDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface ApiCall {
  url: string;
  body: Record<string, unknown>;
}

interface FetchStub {
  mock: ReturnType<typeof vi.fn>;
  calls: ApiCall[];
  downloads: string[];
  /** Peak number of API requests in flight at once. */
  concurrency: () => number;
}

function jsonResponse(body: unknown, init: { status?: number; requestId?: string } = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.requestId !== undefined) headers["x-request-id"] = init.requestId;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function apiResponse(data: unknown[], extra: { usage?: unknown; requestId?: string } = {}): Response {
  const body: Record<string, unknown> = { created: 1_700_000_000, data };
  if (extra.usage !== undefined) body.usage = extra.usage;
  return jsonResponse(body, { requestId: extra.requestId });
}

function imageUrl(name: string): string {
  return `https://cdn.example.com/${name}.png`;
}

function imageItem(name: string): { url: string } {
  return { url: imageUrl(name) };
}

function imageError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ApiHandler = (call: ApiCall, index: number) => Response | Promise<Response>;
type DownloadHandler = (url: string, index: number) => Response | Promise<Response>;

/** Default download behaviour: every image URL returns the same PNG bytes. */
const pngBytes: DownloadHandler = () =>
  new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });

/** A download that the CDN refuses to serve. */
function missingDownload(status = 404): Response {
  return new Response("no such object", { status });
}

/**
 * Stubs `fetch` with a router: POSTs are API calls handed to `apiHandler`,
 * everything else is an image download handed to `downloadHandler`.
 */
function stubFetch(apiHandler: ApiHandler, downloadHandler: DownloadHandler = pngBytes): FetchStub {
  const calls: ApiCall[] = [];
  const downloads: string[] = [];
  let active = 0;
  let peak = 0;

  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") {
      const index = downloads.length;
      downloads.push(url);
      return downloadHandler(url, index);
    }

    const call: ApiCall = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    const index = calls.length;
    calls.push(call);
    active += 1;
    peak = Math.max(peak, active);
    try {
      return await apiHandler(call, index);
    } finally {
      active -= 1;
    }
  });

  vi.stubGlobal("fetch", mock);
  return { mock, calls, downloads, concurrency: () => peak };
}

/** Stubs `fetch` so that any call is visible as a test failure. */
function stubFetchForbidden(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => {
    throw new Error("fetch must not be called");
  });
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

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the action to throw, but it returned normally");
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { images: [], edit: false, outDir, ...overrides };
}

function writeConfig(toml: string): void {
  fs.mkdirSync(configHome, { recursive: true });
  fs.writeFileSync(path.join(configHome, "config.toml"), toml);
}

/**
 * A complete config.toml declaring the two providers a run needs, with `extra`
 * (top-level keys only) inserted before the tables. Providers must be declared:
 * nothing is built in any more.
 */
function writeConfigFor(extra: string): void {
  writeConfig(
    [
      'default_provider = "dashscope"',
      extra,
      "",
      "[providers.dashscope]",
      'api_type = "qwen"',
      'base_url = "https://dashscope.aliyuncs.com"',
      'api_key_env = "DASHSCOPE_API_KEY"',
      "",
      "[providers.dashscope.image]",
      'default = "qwen-image-3.0"',
      'models = ["qwen-image-3.0", "qwen-image-edit-2509"]',
      "",
      "[providers.volcengine]",
      'api_type = "ark"',
      'base_url = "https://ark.cn-beijing.volces.com"',
      'api_key_env = "ARK_API_KEY"',
      "",
      "[providers.volcengine.image]",
      'default = "doubao-seedream-5-0-flash-260915"',
      'models = ["doubao-seedream-5-0-flash-260915"]',
      "",
    ].join("\n"),
  );
}

describe("validateSize", () => {
  const valid: Array<[string, Dialect]> = [
    ["1K", "ark"],
    ["1.5K", "ark"],
    ["2K", "ark"],
    ["3K", "openai"],
    ["4K", "openai"],
    ["2k", "ark"],
    ["1.5k", "openai"],
    ["1728x2160", "ark"],
    ["1024x1024", "openai"],
    ["100x100", "ark"],
    ["auto", "openai"],
    ["AUTO", "openai"],
  ];

  it.each(valid)("accepts %s for the %s dialect", (size, apiType) => {
    expect(() => validateSize(size, apiType)).not.toThrow();
  });

  const invalid: Array<[string, Dialect]> = [
    ["auto", "ark"],
    ["huge", "ark"],
    ["100*100", "openai"],
    ["1024X1024", "ark"],
    ["0x100", "openai"],
    ["100x0", "openai"],
    ["1024x", "ark"],
    ["x1024", "ark"],
    ["", "openai"],
    ["2KK", "ark"],
    ["1024x1024x1024", "ark"],
    ["1024 x 1024", "openai"],
  ];

  it.each(invalid)("rejects %s for the %s dialect", (size, apiType) => {
    const error = thrownBy(() => validateSize(size, apiType));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(size === "" ? '""' : size);
    expect(error.message).toContain("1K");
    expect(error.message).toContain("1024x1024");
  });

  it("names the invalid value with quotes so an empty value is visible", () => {
    const error = thrownBy(() => validateSize("", "ark"));

    expect(error.message).toContain('invalid --size ""');
  });

  it("mentions that auto is openai-only when an ark provider asks for it", () => {
    const error = thrownBy(() => validateSize("auto", "ark"));

    expect(error.message).toContain("openai-only");
  });

  it("lists auto as an accepted form for qwen", () => {
    const error = thrownBy(() => validateSize("nope", "openai"));

    expect(error.message).toContain('"auto"');
    expect(error.message).not.toContain("openai-dialect");
  });
});

describe("resolveOutDir", () => {
  it("prefers the flag over the config value and the cwd", () => {
    expect(resolveOutDir("/flag/out", "/config/out", "/cwd", "/home/u")).toBe("/flag/out");
  });

  it("falls back to the config value, then to the cwd", () => {
    expect(resolveOutDir(undefined, "/config/out", "/cwd", "/home/u")).toBe("/config/out");
    expect(resolveOutDir(undefined, undefined, "/cwd", "/home/u")).toBe("/cwd");
  });

  it("resolves a relative directory against the cwd", () => {
    expect(resolveOutDir("media-out", undefined, "/cwd", "/home/u")).toBe("/cwd/media-out");
    expect(resolveOutDir("./nested/out", undefined, "/cwd", "/home/u")).toBe("/cwd/nested/out");
  });

  it("expands a leading ~ to the home directory", () => {
    expect(resolveOutDir("~/media-out", undefined, "/cwd", "/home/u")).toBe("/home/u/media-out");
    expect(resolveOutDir("~", undefined, "/cwd", "/home/u")).toBe("/home/u");
    expect(resolveOutDir(undefined, "~/from-config", "/cwd", "/home/u")).toBe("/home/u/from-config");
  });

  it("leaves a ~ that is not a home shorthand alone", () => {
    expect(resolveOutDir("~other/out", undefined, "/cwd", "/home/u")).toBe("/cwd/~other/out");
  });
});

describe("runGenerate: the task binding drives the request", () => {
  it("uses the task timeout from config", async () => {
    writeConfig(`
default_provider = "dashscope"

[providers.dashscope]
api_type = "qwen"
base_url = "https://dashscope.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.dashscope.image]
default = "qwen-image-3.0"
models = ["qwen-image-3.0"]
timeout_seconds = 42
`);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => apiResponse([imageItem("a")]));

    await runGenerate("a cat", options({}), QWEN_ENV);

    expect(timeoutSpy).toHaveBeenCalledWith(42_000);
  });

  it("resolves the model from the image task's default", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("a")]));

    await runGenerate("a cat", options({}), QWEN_ENV);

    expect(stub.calls[0]?.body.model).toBe("qwen-image-3.0");
  });

  it("never fetches when the model is not declared", async () => {
    const forbidden = stubFetchForbidden();

    await expect(
      runGenerate("a cat", options({ provider: "dashscope", model: "nope" }), QWEN_ENV),
    ).rejects.toThrow(/unknown model "nope".*add it to models/);

    expect(forbidden).not.toHaveBeenCalled();
  });
});

describe("runGenerate: the dashscope dialect end to end", () => {
  const ENV = { GW_KEY: "sk-gw-1234" };

  beforeEach(() => {
    writeConfig(`
default_provider = "gw"

[providers.gw]
base_url = "https://gw.example.com"
api_key_env = "GW_KEY"

[providers.gw.image]
api_type = "dashscope"
path = "/v1/images/generations"
default = "qwen-image-2.0-pro"
models = ["qwen-image-2.0-pro"]
`);
  });

  it("posts the native body to the task's path and saves the returned image", async () => {
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            output: {
              choices: [
                { finish_reason: "stop", message: { role: "assistant", content: [{ image: imageUrl("fox") }] } },
              ],
            },
            usage: { image_count: 1, width: 1024, height: 1024 },
            request_id: "req-native-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await runGenerate("a red fox", options({ size: "1024x1024" }), ENV);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe("https://gw.example.com/v1/images/generations");
    expect(stub.calls[0]?.body).toEqual({
      model: "qwen-image-2.0-pro",
      input: { messages: [{ role: "user", content: [{ text: "a red fox" }] }] },
      parameters: { n: 1, size: "1024*1024" },
    });
    expect(stub.downloads).toEqual([imageUrl("fox")]);
    expect(result.saved).toHaveLength(1);
    expect(fs.readFileSync(result.saved[0]?.path ?? "")).toEqual(PNG_BYTES);
    expect(result.response.requestId).toBe("req-native-1");
    expect(result.response.usage).toEqual({ image_count: 1, width: 1024, height: 1024 });
  });

  it("defaults to the native endpoint when the task declares no path", async () => {
    writeConfig(`
default_provider = "gw"

[providers.gw]
base_url = "https://gw.example.com"
api_key_env = "GW_KEY"

[providers.gw.image]
api_type = "dashscope"
default = "qwen-image-2.0-pro"
models = ["qwen-image-2.0-pro"]
`);
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            output: { choices: [{ message: { content: [{ image: imageUrl("fox") }] } }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runGenerate("a red fox", options(), ENV);

    expect(stub.calls[0]?.url).toBe(
      "https://gw.example.com/api/v1/services/aigc/multimodal-generation/generation",
    );
  });

  it("sends an input image before the prompt text", async () => {
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            output: { choices: [{ message: { content: [{ image: imageUrl("fox") }] } }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const source = path.join(tempDir, "source.png");
    fs.writeFileSync(source, PNG_BYTES);
    await runGenerate("make it sunset", options({ images: [source] }), ENV);

    const body = stub.calls[0]?.body as { input: { messages: { content: unknown[] }[] } };
    const content = body.input.messages[0]?.content ?? [];
    expect(content).toHaveLength(2);
    expect(String((content[0] as { image: string }).image)).toMatch(/^data:image\/png;base64,/);
    expect(content[1]).toEqual({ text: "make it sunset" });
  });
});

describe("runGenerate", () => {
  it("sends one qwen request and saves every returned image", async () => {
    const stub = stubFetch(() =>
      apiResponse([imageItem("fox")], { usage: { total_tokens: 12 }, requestId: "req-qwen-1" }),
    );

    const result = await runGenerate("a red fox", options(), QWEN_ENV);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(QWEN_URL);
    expect(stub.calls[0]?.body).toEqual({ model: "qwen-image-3.0", prompt: "a red fox", n: 1 });
    expect(stub.downloads).toEqual([imageUrl("fox")]);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]?.index).toBe(0);
    expect(result.saved[0]?.url).toBe(imageUrl("fox"));
    expect(fs.existsSync(result.saved[0]?.path ?? "")).toBe(true);
    expect(path.dirname(result.saved[0]?.path ?? "")).toBe(path.resolve(outDir));
    expect(fs.readFileSync(result.saved[0]?.path ?? "")).toEqual(PNG_BYTES);
    expect(result.response.images).toEqual([imageItem("fox")]);
    expect(result.response.failures).toEqual([]);
    expect(result.response.usage).toEqual({ total_tokens: 12 });
    expect(result.response.requestId).toBe("req-qwen-1");
    expect(result.provider.name).toBe("dashscope");
  });

  it("carries n in a single qwen request and indexes the saved files sequentially", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("a"), imageItem("b")]));

    const result = await runGenerate("two cats", options({ n: 2 }), QWEN_ENV);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.body).toMatchObject({ n: 2 });
    expect(result.saved.map((file) => file.index)).toEqual([0, 1]);
    expect(result.saved.map((file) => file.url)).toEqual([imageUrl("a"), imageUrl("b")]);
    expect(new Set(result.saved.map((file) => file.path)).size).toBe(2);
    for (const file of result.saved) {
      expect(fs.existsSync(file.path)).toBe(true);
    }
  });

  it("applies --model to the request body and the saved file name", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("m")]));

    const result = await runGenerate("a cat", options({ model: "qwen-image-edit-2509" }), QWEN_ENV);

    expect(stub.calls[0]?.body).toMatchObject({ model: "qwen-image-edit-2509" });
    expect(path.basename(result.saved[0]?.path ?? "")).toContain("qwen-image-edit-2509");
  });

  it("rejects edit without images before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options({ edit: true }), QWEN_ENV));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("edit requires at least one --image");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("reports a missing API key as a ConfigError naming mediagen login before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options(), NO_KEY_ENV));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("mediagen login");
    // The hint must be a command that actually runs: login takes --provider.
    expect(error.message).toContain("mediagen login --provider dashscope");
    expect(error.message).not.toContain("mediagen login qwen");
    expect(error.message).toContain("dashscope");
    expect(error.message).toContain("DASHSCOPE_API_KEY");
    expect(error.message).not.toContain(QWEN_KEY);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("names the provider in the missing-key error", async () => {
    writeConfig(`
[providers.my-proxy]
base_url = "https://proxy.example.com"
api_type = "ark"
api_key_env = "MY_PROXY_KEY"

[providers.my-proxy.image]
default = "some-model"
models = ["some-model"]
`);
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options({ provider: "my-proxy" }), NO_KEY_ENV));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("mediagen login --provider my-proxy");
    expect(error.message).not.toContain("mediagen login my-proxy");
    expect(error.message).toContain("MY_PROXY_KEY");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("surfaces an unreadable local image as a UsageError before any request", async () => {
    const forbidden = stubFetchForbidden();
    const missing = path.join(tempDir, "nope.png");

    const error = await rejection(
      runGenerate("a cat", options({ images: [missing], edit: true }), QWEN_ENV),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(missing);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("validates dialect-incompatible flags before reading images or resolving the key", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(
      runGenerate(
        "a cat",
        options({ layerDecomposition: true, images: [path.join(tempDir, "nope.png")] }),
        NO_KEY_ENV,
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("layer_decomposition");
    expect(error.message).not.toContain("nope.png");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("validates --size before resolving the API key", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options({ size: "huge" }), NO_KEY_ENV));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("huge");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("reports an unreadable local image before a missing API key", async () => {
    const forbidden = stubFetchForbidden();
    const missing = path.join(tempDir, "nope.png");

    const error = await rejection(
      runGenerate("a cat", options({ images: [missing], edit: true }), NO_KEY_ENV),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(missing);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("sends ark-only flags to an ark provider", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("layers")]));

    const result = await runGenerate(
      "split the layers",
      options({ provider: "volcengine", images: ["https://example.com/ref.png"], layerDecomposition: true }),
      ARK_ENV,
    );

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(ARK_URL);
    expect(stub.calls[0]?.body).toMatchObject({
      layer_decomposition: true,
      image: "https://example.com/ref.png",
      response_format: "url",
    });
    expect(result.saved).toHaveLength(1);
  });

  it("rejects an ark-only flag on a qwen provider before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(
      runGenerate("a cat", options({ layerDecomposition: true }), QWEN_ENV),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("layer_decomposition");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects an openai-dialect flag on an ark provider before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(
      runGenerate("a cat", options({ provider: "volcengine", negativePrompt: "blurry" }), ARK_ENV),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("negative_prompt");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects qwen agent prompt extension with reference images before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(
      runGenerate(
        "a cat",
        options({ images: ["https://example.com/ref.png"], promptExtendMode: "agent" }),
        QWEN_ENV,
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("agent");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects an invalid --size before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options({ size: "huge" }), QWEN_ENV));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("huge");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("passes a valid --size through unchanged", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("sized")]));

    await runGenerate("a cat", options({ provider: "volcengine", size: "1728x2160" }), ARK_ENV);

    expect(stub.calls[0]?.body).toMatchObject({ size: "1728x2160" });
  });

  it("rejects an invalid --n before any request", async () => {
    const forbidden = stubFetchForbidden();

    for (const n of [0, -1, 2.5]) {
      const error = await rejection(runGenerate("a cat", options({ n }), QWEN_ENV));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain("--n");
      expect(error.message).toContain("1-6");
    }
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects an --n above the documented limit before any request", async () => {
    const forbidden = stubFetchForbidden();

    for (const n of [7, 100, 500]) {
      const error = await rejection(
        runGenerate("a cat", options({ provider: "volcengine", n }), ARK_ENV),
      );
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain("--n");
      expect(error.message).toContain(String(n));
      expect(error.message).toContain("6");
      expect(error.message).toContain("1-6");
    }
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("accepts the top of the documented --n range", async () => {
    const stub = stubFetch(() =>
      apiResponse([imageItem("a"), imageItem("b"), imageItem("c"), imageItem("d"), imageItem("e"), imageItem("f")]),
    );

    const result = await runGenerate("six cats", options({ n: 6 }), QWEN_ENV);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.body).toMatchObject({ n: 6 });
    expect(result.saved).toHaveLength(6);
  });

  it("rejects a non-integer --seed before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options({ seed: 1.5 }), QWEN_ENV));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("--seed");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("routes the request through --base-url without persisting it", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("proxy")]));

    const result = await runGenerate(
      "a cat",
      options({ baseUrl: "https://proxy.example.com" }),
      QWEN_ENV,
    );

    expect(stub.calls[0]?.url).toBe("https://proxy.example.com/compatible-mode/v1/images/generations");
    expect(result.provider.base_url).toBe("https://proxy.example.com");
    // Loading may seed config.toml; the one-off --base-url must not be written into it.
    const written = fs.readFileSync(path.join(configHome, "config.toml"), "utf8");
    expect(written).not.toMatch(/^base_url = "https:\/\/proxy\.example\.com"$/m);
  });

  it("joins a --base-url that carries a trailing slash exactly once", async () => {
    const stub = stubFetch(() => apiResponse([imageItem("proxy")]));

    await runGenerate("a cat", options({ baseUrl: "https://proxy.example.com/" }), QWEN_ENV);

    expect(stub.calls[0]?.url).toBe("https://proxy.example.com/compatible-mode/v1/images/generations");
  });

  it("rejects a --base-url that still carries the vendor API prefix", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(
      runGenerate(
        "a cat",
        options({
          provider: "volcengine",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        }),
        ARK_ENV,
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('it points at the sub-path "/api/v3"');
    expect(error.message).toContain("Set base_url to the origin".toLowerCase());
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects a --base-url that is not an absolute http(s) URL before any request", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(
      runGenerate("a cat", options({ baseUrl: "proxy.example.com" }), QWEN_ENV),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("--base-url");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("prefers --out-dir over the configured output_dir", async () => {
    const fromConfig = path.join(tempDir, "from-config");
    const fromFlag = path.join(tempDir, "from-flag");
    writeConfigFor(`output_dir = "${fromConfig}"`);
    stubFetch(() => apiResponse([imageItem("dir")]));

    const result = await runGenerate("a cat", options({ outDir: fromFlag }), QWEN_ENV);

    expect(path.dirname(result.saved[0]?.path ?? "")).toBe(fromFlag);
    expect(fs.existsSync(fromConfig)).toBe(false);
  });

  it("falls back to the configured output_dir when --out-dir is absent", async () => {
    const fromConfig = path.join(tempDir, "from-config");
    writeConfigFor(`output_dir = "${fromConfig}"`);
    stubFetch(() => apiResponse([imageItem("dir")]));

    const result = await runGenerate("a cat", options({ outDir: undefined }), QWEN_ENV);

    expect(path.dirname(result.saved[0]?.path ?? "")).toBe(fromConfig);
  });

  it("creates a missing nested --out-dir before the paid request", async () => {
    const nested = path.join(tempDir, "deep", "deeper", "out");
    let existedDuringRequest = false;
    stubFetch(() => {
      existedDuringRequest = fs.existsSync(nested);
      return apiResponse([imageItem("dir")]);
    });

    const result = await runGenerate("a cat", options({ outDir: nested }), QWEN_ENV);

    expect(existedDuringRequest).toBe(true);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
    expect(path.dirname(result.saved[0]?.path ?? "")).toBe(nested);
  });

  it("reports an unusable --out-dir as a UsageError naming the path, before any request", async () => {
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "a file, not a directory");
    const unusable = path.join(blocker, "out");
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options({ outDir: unusable }), QWEN_ENV));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(unusable);
    expect(error.message).toMatch(/output directory/);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("still resolves the API key before creating the output directory", async () => {
    const forbidden = stubFetchForbidden();

    const error = await rejection(runGenerate("a cat", options(), NO_KEY_ENV));

    expect(error).toBeInstanceOf(ConfigError);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("fans an ark n>1 run out into concurrent requests with an incrementing seed", async () => {
    const stub = stubFetch(async (call) => {
      await delay(10);
      return apiResponse([imageItem(`seed-${String(call.body.seed)}`)]);
    });

    const result = await runGenerate(
      "three cats",
      options({ provider: "volcengine", n: 3, seed: 100 }),
      ARK_ENV,
    );

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.map((call) => call.body.seed).sort((a, b) => Number(a) - Number(b))).toEqual([
      100, 101, 102,
    ]);
    expect(stub.concurrency()).toBe(3);
    for (const call of stub.calls) {
      expect(call.url).toBe(ARK_URL);
      expect(call.body).not.toHaveProperty("n");
    }
    expect(result.saved.map((file) => file.url)).toEqual([
      imageUrl("seed-100"),
      imageUrl("seed-101"),
      imageUrl("seed-102"),
    ]);
    expect(result.saved.map((file) => file.index)).toEqual([0, 1, 2]);
    expect(new Set(result.saved.map((file) => file.path)).size).toBe(3);
    for (const file of result.saved) {
      expect(fs.existsSync(file.path)).toBe(true);
    }
  });

  it("omits seed from ark sub-requests when no seed was given", async () => {
    const stub = stubFetch((call, index) => apiResponse([imageItem(`plain-${index}`)]));

    const result = await runGenerate("two cats", options({ provider: "volcengine", n: 2 }), ARK_ENV);

    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(call.body).not.toHaveProperty("seed");
    }
    expect(result.saved.map((file) => file.url)).toEqual([imageUrl("plain-0"), imageUrl("plain-1")]);
  });

  it("keeps the successes when one ark sub-request fails entirely", async () => {
    const stub = stubFetch((_call, index) =>
      index === 1
        ? apiResponse([imageError("SensitiveContentDetected", "content blocked")])
        : apiResponse([imageItem(`ok-${index}`)]),
    );

    const result = await runGenerate("three cats", options({ provider: "volcengine", n: 3 }), ARK_ENV);

    expect(stub.calls).toHaveLength(3);
    expect(result.saved.map((file) => file.url)).toEqual([imageUrl("ok-0"), imageUrl("ok-2")]);
    expect(result.saved.map((file) => file.index)).toEqual([0, 1]);
    expect(result.response.failures).toEqual([
      { code: "SensitiveContentDetected", message: "content blocked" },
    ]);
    expect(result.response.images).toHaveLength(2);
  });

  it("reports a transport failure in one ark sub-request as a failure, not a thrown error", async () => {
    const stub = stubFetch((_call, index) =>
      index === 0
        ? jsonResponse({ error: { code: "InternalServiceError", message: "ark is unavailable" } }, { status: 500 })
        : apiResponse([imageItem(`ok-${index}`)]),
    );

    const result = await runGenerate("two cats", options({ provider: "volcengine", n: 2 }), ARK_ENV);

    expect(result.saved.map((file) => file.url)).toEqual([imageUrl("ok-1")]);
    expect(result.response.failures).toHaveLength(1);
    expect(result.response.failures[0]?.code).toBe("InternalServiceError");
  });

  it("throws an ApiError carrying the first failure code when every sub-request fails", async () => {
    stubFetch((_call, index) =>
      apiResponse([imageError(`Code${index}`, `blocked ${index}`)]),
    );

    const error = await rejection(
      runGenerate("two cats", options({ provider: "volcengine", n: 2 }), ARK_ENV),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("Code0");
    expect(error.message).toContain("volcengine");
    expect(error.message).toContain("blocked 0");
    expect(error.message).toContain("blocked 1");
    // The output directory is created before the request; nothing was written.
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it("merges usage and requestId from the first sub-response that carries them", async () => {
    stubFetch((_call, index) =>
      index === 0
        ? apiResponse([imageItem("first")])
        : apiResponse([imageItem("second")], { usage: { total_tokens: 7 }, requestId: "req-1" }),
    );

    const result = await runGenerate("two cats", options({ provider: "volcengine", n: 2 }), ARK_ENV);

    expect(result.response.usage).toEqual({ total_tokens: 7 });
    expect(result.response.requestId).toBe("req-1");
  });

  it("propagates a single-request API failure unchanged and writes nothing", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "InvalidParameter", message: "size must be 1024x1024" } },
        { status: 400 },
      ),
    );

    const error = await rejection(runGenerate("a cat", options(), QWEN_ENV));

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("InvalidParameter");
    expect(error.message).toContain("400");
    expect(error.message).not.toContain(QWEN_KEY);
    // The output directory is created before the request; nothing was written.
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it("saves every image of an ark layer-decomposition response", async () => {
    stubFetch(() =>
      apiResponse([
        { url: imageUrl("base"), z_index: 0, output_format: "png" },
        { url: imageUrl("layer-1"), z_index: 1, output_format: "png" },
        imageError("LayerFailed", "layer 2 could not be rendered"),
      ]),
    );

    const result = await runGenerate(
      "split the layers",
      options({ provider: "volcengine", images: ["https://example.com/ref.png"], layerDecomposition: true }),
      ARK_ENV,
    );

    expect(result.saved.map((file) => file.index)).toEqual([0, 1]);
    // The saved-media union now also covers video results; zIndex is image-only.
    expect(result.saved.map((file) => (file.meta as ImageResult | undefined)?.zIndex)).toEqual([0, 1]);
    expect(result.response.failures).toEqual([
      { code: "LayerFailed", message: "layer 2 could not be rendered" },
    ]);
  });

  it("encodes a local reference image as a data URL", async () => {
    const file = path.join(tempDir, "ref.png");
    fs.writeFileSync(file, PNG_BYTES);
    const stub = stubFetch(() => apiResponse([imageItem("edited")]));

    const result = await runGenerate(
      "make it blue",
      options({ images: [file], edit: true }),
      QWEN_ENV,
    );

    const sent = stub.calls[0]?.body.image;
    expect(typeof sent).toBe("string");
    expect(sent).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    expect(result.saved).toHaveLength(1);
  });

  it("shares one timestamp across every file of a run", async () => {
    stubFetch(() => apiResponse([imageItem("a"), imageItem("b"), imageItem("c")]));

    const result = await runGenerate("three cats", options({ n: 3 }), QWEN_ENV);

    expect(result.saved).toHaveLength(3);
    const stamps = new Set(
      result.saved.map((file) => /-(\d{8}-\d{6})-\d+\.\w+$/.exec(path.basename(file.path))?.[1]),
    );
    expect(stamps.size).toBe(1);
    expect(result.saved.map((file) => path.basename(file.path))).toEqual([
      expect.stringMatching(/^dashscope-qwen-image-3-0-\d{8}-\d{6}-0\.png$/),
      expect.stringMatching(/^dashscope-qwen-image-3-0-\d{8}-\d{6}-1\.png$/),
      expect.stringMatching(/^dashscope-qwen-image-3-0-\d{8}-\d{6}-2\.png$/),
    ]);
  });

  describe("download failures", () => {
    it("keeps the images that downloaded when another download fails", async () => {
      const stub = stubFetch(
        () => apiResponse([imageItem("good"), imageItem("gone")]),
        (url) => (url === imageUrl("gone") ? missingDownload() : pngBytes(url, 0)),
      );

      const result = await runGenerate("two cats", options({ n: 2 }), QWEN_ENV);

      expect(stub.downloads).toEqual([imageUrl("good"), imageUrl("gone")]);
      expect(result.saved).toHaveLength(1);
      expect(result.saved[0]?.url).toBe(imageUrl("good"));
      expect(result.saved[0]?.index).toBe(0);
      expect(fs.readFileSync(result.saved[0]?.path ?? "")).toEqual(PNG_BYTES);
      expect(result.response.images).toHaveLength(2);
      expect(result.response.failures).toHaveLength(1);
      expect(result.response.failures[0]?.code).toBe("DownloadError");
      expect(result.response.failures[0]?.message).toContain("image 1");
      expect(result.response.failures[0]?.message).toContain(imageUrl("gone"));
      expect(result.response.failures[0]?.message).toContain("status 404");
      expect(result.response.failures[0]?.message).not.toContain(QWEN_KEY);
    });

    it("keeps the position-based index when an earlier download fails", async () => {
      stubFetch(
        () => apiResponse([imageItem("a"), imageItem("b"), imageItem("c")]),
        (url) => (url === imageUrl("a") ? missingDownload(500) : pngBytes(url, 0)),
      );

      const result = await runGenerate("three cats", options({ n: 3 }), QWEN_ENV);

      expect(result.saved.map((file) => file.index)).toEqual([1, 2]);
      expect(result.saved.map((file) => file.url)).toEqual([imageUrl("b"), imageUrl("c")]);
      expect(result.saved.map((file) => path.basename(file.path))).toEqual([
        expect.stringMatching(/-1\.png$/),
        expect.stringMatching(/-2\.png$/),
      ]);
      for (const file of result.saved) {
        expect(fs.existsSync(file.path)).toBe(true);
      }
      expect(result.response.failures).toEqual([
        { code: "DownloadError", message: expect.stringContaining("image 0") },
      ]);
    });

    it("records a transport failure while downloading as a DownloadError", async () => {
      stubFetch(
        () => apiResponse([imageItem("ok"), imageItem("unreachable")]),
        (url) => {
          if (url === imageUrl("unreachable")) throw new Error("fetch failed");
          return pngBytes(url, 0);
        },
      );

      const result = await runGenerate("two cats", options({ n: 2 }), QWEN_ENV);

      expect(result.saved.map((file) => file.url)).toEqual([imageUrl("ok")]);
      expect(result.response.failures).toHaveLength(1);
      expect(result.response.failures[0]?.code).toBe("DownloadError");
      expect(result.response.failures[0]?.message).toContain("failed to download");
      expect(result.response.failures[0]?.message).toContain("fetch failed");
    });

    it("throws an ApiError listing every download failure when nothing could be saved", async () => {
      stubFetch(
        () => apiResponse([imageItem("a"), imageItem("b")]),
        () => missingDownload(),
      );

      const error = await rejection(runGenerate("two cats", options({ n: 2 }), QWEN_ENV));

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("DownloadError");
      expect(error.message).toContain(imageUrl("a"));
      expect(error.message).toContain(imageUrl("b"));
      expect(error.message).toContain("status 404");
      expect(error.message).not.toContain(QWEN_KEY);
      expect(fs.readdirSync(outDir)).toEqual([]);
    });

    it("appends download failures after the api failures of a partial success", async () => {
      stubFetch(
        () =>
          apiResponse([
            imageItem("base"),
            imageItem("gone"),
            imageError("LayerFailed", "layer 2 could not be rendered"),
          ]),
        (url) => (url === imageUrl("gone") ? missingDownload() : pngBytes(url, 0)),
      );

      const result = await runGenerate(
        "split the layers",
        options({
          provider: "volcengine",
          images: ["https://example.com/ref.png"],
          layerDecomposition: true,
        }),
        ARK_ENV,
      );

      expect(result.saved.map((file) => file.index)).toEqual([0]);
      expect(result.response.failures.map((failure) => failure.code)).toEqual([
        "LayerFailed",
        "DownloadError",
      ]);
    });

    it("prefers the first failure code when an api failure and a download failure leave nothing saved", async () => {
      stubFetch(
        () =>
          apiResponse([
            imageError("LayerFailed", "layer 2 could not be rendered"),
            imageItem("base"),
          ]),
        () => missingDownload(),
      );

      const error = await rejection(
        runGenerate(
          "split the layers",
          options({
            provider: "volcengine",
            images: ["https://example.com/ref.png"],
            layerDecomposition: true,
          }),
          ARK_ENV,
        ),
      );

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("LayerFailed");
      expect(error.message).toContain("layer 2 could not be rendered");
      expect(error.message).toContain("DownloadError");
      expect(error.message).toContain("status 404");
    });

    it("keeps the ark sub-request that produced an image when the other returns only per-image errors", async () => {
      const stub = stubFetch((_call, index) =>
        index === 0
          ? apiResponse([imageError("SensitiveContentDetected", "content blocked")])
          : apiResponse([imageItem("ok")]),
      );

      const result = await runGenerate("two cats", options({ provider: "volcengine", n: 2 }), ARK_ENV);

      expect(stub.calls).toHaveLength(2);
      expect(result.saved).toHaveLength(1);
      expect(result.saved[0]?.url).toBe(imageUrl("ok"));
      expect(result.saved[0]?.index).toBe(0);
      expect(fs.existsSync(result.saved[0]?.path ?? "")).toBe(true);
      expect(result.response.failures).toEqual([
        { code: "SensitiveContentDetected", message: "content blocked" },
      ]);
    });
  });
});

describe("validateSize for the dashscope dialect", () => {
  it("rejects a size tier", () => {
    expect(() => validateSize("2K", "dashscope")).toThrow(/accepts only a WxH pixel pair/);
  });

  it("rejects auto", () => {
    expect(() => validateSize("auto", "dashscope")).toThrow(/accepts only a WxH pixel pair/);
  });

  it("accepts a pixel pair", () => {
    expect(() => validateSize("2048x2048", "dashscope")).not.toThrow();
  });
});
