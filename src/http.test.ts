import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, UsageError } from "./errors.js";
import {
  REQUEST_TIMEOUT_MS as SINGLE_REQUEST_TIMEOUT_MS,
  callApi,
  createTask,
  parseJsonOrThrow,
  pollTask,
} from "./http.js";
import type { ImageRequest, ParsedResponse, ProviderConfig, Task, TaskBinding } from "./types.js";

const API_KEY = "sk-test-secret-key-0123456789";
const QWEN_URL = "https://dashscope.example.com/compatible-mode/v1/images/generations";
const REQUEST_ID = "req-0001";
const REQUEST_TIMEOUT_MS = 300_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "qwen",
    api_type: "openai",
    base_url: "https://dashscope.example.com",
    ...overrides,
  };
}

function bindingFor(overrides: Partial<ProviderConfig> = {}, task: Task = "image"): TaskBinding {
  const providerConfig = provider(overrides);
  return {
    provider: providerConfig,
    task,
    model: "qwen-image-3.0",
    timeout_ms: REQUEST_TIMEOUT_MS,
    dialect: providerConfig.api_type ?? "openai",
  };
}

/** A binding for transport tests: they exercise the wire, not selection. */
function bindingOf(providerConfig: ProviderConfig, task: Task = "image"): TaskBinding {
  return {
    provider: providerConfig,
    task,
    model: "qwen-image-3.0",
    timeout_ms: REQUEST_TIMEOUT_MS,
    dialect: providerConfig.api_type ?? "openai",
  };
}

function imageRequest(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    model: "qwen-image-3.0",
    prompt: "a cat",
    images: [],
    n: 1,
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

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the action to throw, but it returned normally");
}

function jsonResponse(body: unknown, status = 200, requestId?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (requestId !== undefined) headers["x-request-id"] = requestId;
  return new Response(JSON.stringify(body), { status, headers });
}

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com";
const VIDEO_REQUEST = { model: "m", prompt: "p" };

/**
 * A video binding for transport tests. `timeout_ms` is the whole poll budget,
 * deliberately unrelated to the timeout one create or poll request may take.
 */
function arkBinding(overrides: Partial<TaskBinding> = {}, baseUrl = ARK_BASE_URL): TaskBinding {
  return {
    provider: { name: "ark", api_type: "ark", base_url: baseUrl },
    task: "video",
    model: "m",
    timeout_ms: 1_800_000,
    dialect: "ark",
    ...overrides,
  };
}

function minimaxBinding(): TaskBinding {
  return {
    provider: { name: "minimax", api_type: "minimax", base_url: "https://api.minimax.io" },
    task: "video",
    model: "MiniMax-H3",
    timeout_ms: 1_800_000,
    dialect: "minimax",
  };
}

interface VideoCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Records every video round trip and replays one response per call. Unlike the
 * image stub there is no download branch, so `GET` is recorded too.
 */
function stubVideoFetch(
  ...responses: Array<Response | (() => Promise<Response>)>
): { calls: VideoCall[] } {
  const calls: VideoCall[] = [];
  let next = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[name.toLowerCase()] = value;
      }
      calls.push({
        url,
        method: init?.method,
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });

      const entry = responses[next];
      next += 1;
      // One response per call, so an extra request fails loudly instead of
      // replaying a body the test never meant to send twice.
      if (entry === undefined) throw new Error("stubVideoFetch has no response to replay");
      return typeof entry === "function" ? entry() : entry.clone();
    }),
  );

  return { calls };
}

/** What a hung request looks like to http.ts: `isTimeoutError` reads these names. */
function timeoutRejection(): () => Promise<Response> {
  return () =>
    Promise.reject(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    );
}

describe("callApi: the binding decides task and timeout", () => {
  it("uses the binding's timeout for the abort signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/1.png" }] }),
    );

    await callApi({
      binding: { ...bindingFor(), timeout_ms: 42_000 },
      apiKey: API_KEY,
      request: imageRequest(),
    });

    // The value matters, not the type: timeout_ms: 1 would satisfy an instanceof check.
    expect(timeoutSpy).toHaveBeenCalledWith(42_000);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a task the dialect has no adapter for, before any fetch", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: [] }));

    await expect(
      callApi({
        binding: bindingFor({}, "video"),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    ).rejects.toThrow('the "openai" dialect has no "video" adapter; implemented tasks: image');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a video binding even on a dialect that has a video adapter, before any fetch", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: [] }));

    const error = await rejection(
      callApi({
        binding: bindingFor(
          { name: "ark", api_type: "ark", base_url: "https://ark.cn-beijing.volces.com" },
          "video",
        ),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    // The image transport's own guard, not getAdapter's missing-adapter message:
    // both mention "video", so only the full sentence proves which one fired.
    expect(error.message).toBe(
      'this request is for the image task; the binding is for the "video" task',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("callApi: a task's path override", () => {
  it("appends the declared path instead of the adapter's", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/1.png" }] }),
    );

    await callApi({
      binding: {
        provider: provider({
          name: "ark-plan",
          api_type: "ark",
          base_url: "https://ark.cn-beijing.volces.com/api/plan/v3",
        }),
        task: "image",
        model: "m",
        timeout_ms: REQUEST_TIMEOUT_MS,
        path: "/images/generations",
        dialect: "ark",
      },
      apiKey: API_KEY,
      request: imageRequest(),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations",
    );
  });
});

describe("callApi: the wire", () => {
  it("POSTs the joined URL with bearer auth and the body built by the adapter", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/cat.png" }] }, 200, REQUEST_ID),
    );

    const parsed = await callApi({
      binding: bindingOf(provider()),
      apiKey: API_KEY,
      request: imageRequest(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(QWEN_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "qwen-image-3.0",
      prompt: "a cat",
      n: 1,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(parsed.images).toEqual([{ url: "https://cdn.example.com/cat.png" }]);
    expect(parsed.failures).toEqual([]);
  });

  it("appends the adapter path, which starts at the origin, to base_url", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/1.png" }] }),
    );

    await callApi({
      binding: bindingOf(provider({
        name: "volcengine",
        api_type: "ark",
        base_url: "https://ark.cn-beijing.volces.com",
      })),
      apiKey: API_KEY,
      request: imageRequest(),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    );
  });

  it("reaches the qwen images endpoint through the workspace host's compatible-mode prefix", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/1.png" }] }),
    );

    await callApi({
      binding: bindingOf(provider({ base_url: "https://abc.cn-beijing.maas.aliyuncs.com" })),
      apiKey: API_KEY,
      request: imageRequest(),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations",
    );
  });

  it("surfaces the x-request-id header into ParsedResponse.requestId", async () => {
    stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/cat.png" }] }, 200, REQUEST_ID),
    );

    const parsed = await callApi({
      binding: bindingOf(provider()),
      apiKey: API_KEY,
      request: imageRequest(),
    });

    expect(parsed.requestId).toBe(REQUEST_ID);
  });

  it("delegates body interpretation to the provider's dialect", async () => {
    stubFetch(() =>
      jsonResponse({
        data: [{ url: "https://cdn.example.com/cat.png" }],
        usage: { total_tokens: 42 },
      }),
    );

    const parsed = await callApi({
      binding: bindingOf(provider()),
      apiKey: API_KEY,
      request: imageRequest(),
    });

    expect(parsed.images).toEqual([{ url: "https://cdn.example.com/cat.png" }]);
    expect(parsed.usage).toEqual({ total_tokens: 42 });
  });

  it("throws an ApiError carrying the vendor code and message on a JSON error response", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(
        { error: { code: "InvalidParameter", message: "size must be 1024x1024" } },
        400,
      ),
    );

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("InvalidParameter");
    expect(error.message).toContain("size must be 1024x1024");
    expect(error.message).toContain("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns an HTML error body into a truncated ApiError instead of a SyntaxError", async () => {
    const html = `<html>\n<body>502 Bad Gateway${"x".repeat(800)}TAIL_MARKER</body>\n</html>`;
    stubFetch(
      () => new Response(html, { status: 502, headers: { "content-type": "text/html" } }),
    );

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toContain("502");
    expect(error.message).toContain("<html> <body>");
    expect(error.message).not.toContain("TAIL_MARKER");
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeLessThan(320);
  });

  it("throws an ApiError, not a SyntaxError, when a 200 response has an empty body", async () => {
    stubFetch(() => new Response("", { status: 200 }));

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toContain("200");
    expect(error.message).toMatch(/empty/i);
  });

  it("surfaces a hung request as an ApiError mentioning timeout", async () => {
    const controller = new AbortController();
    let requestedTimeoutMs: number | undefined;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      requestedTimeoutMs = ms;
      setTimeout(() => {
        controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      }, 5);
      return controller.signal;
    });
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(requestedTimeoutMs).toBe(REQUEST_TIMEOUT_MS);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timeout/i);
  });

  it("wraps a network failure in an ApiError naming the host and the reason", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toContain("dashscope.example.com");
    expect(error.message).toContain("fetch failed");
  });

  it("maps a timeout while reading the response body to an ApiError", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
    } as unknown as Response;
    stubFetch(() => response);

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timeout/i);
    expect(error.message).toContain("dashscope.example.com");
  });

  it("lets a UsageError from buildRequest propagate unchanged without calling fetch", async () => {
    const fetchMock = stubFetch(() => jsonResponse({}, 200));

    const error = await rejection(
      callApi({
        binding: bindingOf(provider()),
        apiKey: API_KEY,
        request: imageRequest({ output_format: "png" }),
      }),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.message).toContain("output_format");
    expect(error.message).toContain("ark-only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an ApiError from the dialect parser unchanged", async () => {
    stubFetch(() => jsonResponse({}, 200));

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("missing the data array");
  });

  it("never includes the API key in an error message", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () =>
        jsonResponse(
          { error: { code: "InvalidParameter", message: "bad request" } },
          400,
        ),
      () => new Response("<html>502 proxy error</html>", { status: 502 }),
      () => new Response("", { status: 200 }),
      () => Promise.reject(new TypeError("connection refused")),
    ];

    for (const impl of failures) {
      stubFetch(impl);
      const error = await rejection(
        callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
      );
      expect(error.message).not.toContain(API_KEY);
    }
  });

  it("redacts the API key when an error body echoes it", async () => {
    const responses = [
      new Response(`<html><body>Authorization: Bearer ${API_KEY}</body></html>`, {
        status: 502,
      }),
      jsonResponse({ error: { code: "Auth", message: `invalid key ${API_KEY}` } }, 401),
    ];

    for (const response of responses) {
      stubFetch(() => response);
      const error = await rejection(
        callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).toContain("[redacted]");
    }
  });

  it("redacts the API key when the vendor error code echoes it", async () => {
    const codes = [`InvalidApiKey.${API_KEY}`, API_KEY];

    for (const code of codes) {
      stubFetch(() =>
        jsonResponse({ error: { code, message: "the key is not valid" } }, 401),
      );

      const error = await rejection(
        callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
      );

      expect(error).toBeInstanceOf(ApiError);
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).toContain("[redacted]");
      expect(error.message).toContain("the key is not valid");
      expect((error as ApiError).code).toBeDefined();
      expect((error as ApiError).code ?? "").not.toContain(API_KEY);
      expect((error as ApiError).code ?? "").toContain("[redacted]");
    }
  });

  it("keeps a numeric vendor code instead of dropping it", async () => {
    stubFetch(() => jsonResponse({ error: { code: 40001, message: "invalid parameter" } }, 400));

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("40001");
    expect(error.message).toContain("(code: 40001)");
    expect(error.message).toContain("400");
  });

  it("ignores a vendor code that is neither a string nor a finite number", async () => {
    stubFetch(() =>
      jsonResponse({ error: { code: { nested: "object" }, message: "invalid parameter" } }, 400),
    );

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect((error as ApiError).code).toBeUndefined();
    expect(error.message).not.toContain("code:");
  });
  it("strips terminal escapes and control bytes from a hostile error body", async () => {
    stubFetch(
      () =>
        new Response(
          "\u001b[31m\u001b[1mRED\u001b[0m danger\u0007 \u001b]0;pwned\u0007 \u0000end",
          { status: 502 },
        ),
    );

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("502");
    expect(error.message).toContain("danger");
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(error.message).not.toContain("[31m");
    expect(error.message).not.toContain("pwned");
  });

  it("reports a payload it cannot serialize as itself, not as a network failure", async () => {
    const fetchMock = stubFetch(() => jsonResponse({}, 200));
    const request = imageRequest({ prompt: 10n as unknown as string });

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request }),
    );

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/BigInt/);
    expect(error.message).not.toMatch(/failed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("callApi: a native error body", () => {
  it("surfaces the code the dashscope dialect reports at the top level", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            request_id: "r1",
            code: "InvalidApiKey",
            message: "Invalid API-key provided.",
          }),
          { status: 401 },
        ),
    );

    const error = await rejection(
      callApi({
        binding: bindingOf(
          provider({ name: "gw", api_type: "dashscope", base_url: "https://gw.example.com" }),
        ),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    // The code only exists when the adapter parsed the envelope; a body excerpt
    // would carry the text but no code.
    expect((error as ApiError).code).toBe("InvalidApiKey");
    expect(error.message).toContain("Invalid API-key provided.");
  });
});

describe("callApi: a 404 with an empty body", () => {
  function arkProvider(): ProviderConfig {
    return provider({
      name: "ark",
      api_type: "ark",
      base_url: "https://ark.cn-beijing.volces.com",
    });
  }

  it("tells a qwen caller which host serves the images API and how to set it", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callApi({
        binding: bindingOf(provider({ base_url: "https://dashscope.aliyuncs.com" })),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("404");
    expect(error.message).toContain("dashscope.aliyuncs.com");
    expect(error.message).toContain("maas.aliyuncs.com");
    // The remedy lives in config.toml; there is no login flag for a host any more.
    expect(error.message).not.toContain("mediagen login");
    expect(error.message).toContain("config.toml");
    expect(error.message).toContain(
      'base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"',
    );
    expect(error.message).toContain("appends the endpoint path");
    expect(error.message).not.toContain(API_KEY);
  });

  it("reports the workspace host for a hand-declared qwen entry too", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callApi({
        binding: bindingOf(provider({ name: "my-qwen", base_url: "https://relay.example.com" })),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    );

    expect(error.message).toContain("relay.example.com");
    expect(error.message).toContain("[providers.my-qwen]");
    expect(error.message).toContain("maas.aliyuncs.com");
  });

  it("leaves a dashscope 404 on the normal path, with no workspace-host remedy", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callApi({
        binding: bindingOf(
          provider({ name: "gw", api_type: "dashscope", base_url: "https://gw.example.com" }),
        ),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("maas.aliyuncs.com");
  });

  it("leaves an ark 404 on the normal path", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callApi({ binding: bindingOf(arkProvider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("maas.aliyuncs.com");
    expect(error.message).not.toContain("--base-url");
  });

  it("keeps the vendor message for a qwen 404 that carries a body", async () => {
    stubFetch(() => jsonResponse({ error: { code: "ModelNotFound", message: "no such model" } }, 404));

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error.message).toContain("no such model");
    expect(error.message).not.toContain("maas.aliyuncs.com");
    expect((error as ApiError).code).toBe("ModelNotFound");
  });

  it("does not turn another empty-body status into the endpoint remedy", async () => {
    stubFetch(() => new Response("", { status: 503 }));

    const error = await rejection(
      callApi({ binding: bindingOf(provider()), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error.message).toContain("503");
    expect(error.message).not.toContain("maas.aliyuncs.com");
  });
});

describe("parseJsonOrThrow", () => {
  it("returns the parsed JSON value", () => {
    expect(parseJsonOrThrow('{"data":[{"url":"https://cdn.example.com/a.png"}]}', 200)).toEqual({
      data: [{ url: "https://cdn.example.com/a.png" }],
    });
  });

  it("throws a truncated ApiError with the status for non-JSON text", () => {
    const text = `<html>${"y".repeat(800)}TAIL_MARKER</html>`;

    const error = thrownBy(() => parseJsonOrThrow(text, 500));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("500");
    expect(error.message).toContain("<html>");
    expect(error.message).not.toContain("TAIL_MARKER");
    expect(error.message.length).toBeLessThan(300);
  });

  it("throws an ApiError for an empty body", () => {
    const error = thrownBy(() => parseJsonOrThrow("   \n", 200));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/empty/i);
  });
});

describe("createTask: the async video task is created exactly once", () => {
  it("posts the built body to the create path with bearer auth", async () => {
    const stub = stubVideoFetch(jsonResponse({ id: "cgt-1" }));

    const out = await createTask({ binding: arkBinding(), apiKey: "sk-x", request: VIDEO_REQUEST });

    expect(out.taskId).toBe("cgt-1");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(`${ARK_BASE_URL}/api/v3/contents/generations/tasks`);
    expect(stub.calls[0]?.method).toBe("POST");
    // Only the bearer header is required: neither dialect declares extra headers.
    expect(stub.calls[0]?.headers).toEqual({
      authorization: "Bearer sk-x",
      "content-type": "application/json",
    });
    expect(stub.calls[0]?.body).toEqual({
      model: "m",
      content: [{ type: "text", text: "p" }],
    });
  });

  it("caps one create request at the request timeout, not at the poll budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubVideoFetch(jsonResponse({ id: "cgt-1" }));

    await createTask({ binding: arkBinding(), apiKey: "sk-x", request: VIDEO_REQUEST });

    // The value, not the type: a hung request must not be able to eat the budget.
    expect(timeoutSpy).toHaveBeenCalledWith(SINGLE_REQUEST_TIMEOUT_MS);
    expect(SINGLE_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("lets a task's path override cover both create and poll", async () => {
    const stub = stubVideoFetch(
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "running" }),
    );
    const binding = arkBinding({ path: "/v1/videos" }, "https://ark.example.com");

    await createTask({ binding, apiKey: "sk-x", request: VIDEO_REQUEST });
    await pollTask({ binding, apiKey: "sk-x", taskId: "cgt-1" });

    expect(stub.calls[0]?.url).toBe("https://ark.example.com/v1/videos");
    expect(stub.calls[1]?.url).toBe("https://ark.example.com/v1/videos/cgt-1");
  });

  it("reports a non-2xx create with the vendor error and never leaks the key", async () => {
    const stub = stubVideoFetch(
      jsonResponse({ error: { code: "InvalidParameter", message: "bad duration" } }, 400),
    );

    const error = await rejection(
      createTask({ binding: arkBinding(), apiKey: API_KEY, request: VIDEO_REQUEST }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("InvalidParameter");
    expect(error.message).toContain("bad duration");
    expect(error.message).not.toContain(API_KEY);
    // A paid request is never retried.
    expect(stub.calls).toHaveLength(1);
  });

  it("warns that a timed-out create may already have been paid for", async () => {
    stubVideoFetch(timeoutRejection());

    const error = await rejection(
      createTask({ binding: arkBinding(), apiKey: "sk-x", request: VIDEO_REQUEST }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/may already have been created and paid/i);
    // No id exists at this point, so the remedy cannot be a command that needs one.
    expect(error.message).toMatch(/no task id is known/i);
    expect(error.message).toMatch(/console|usage/i);
    expect(error.message).not.toContain("video status");
  });

  it("keeps that warning when only the response body times out", async () => {
    // The create was accepted; losing the id is what makes a rerun pay twice.
    const truncated = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () =>
        Promise.reject(
          Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }),
        ),
    } as unknown as Response;
    stubVideoFetch(() => Promise.resolve(truncated));

    const error = await rejection(
      createTask({ binding: arkBinding(), apiKey: "sk-x", request: VIDEO_REQUEST }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/may already have been created and paid/i);
  });
});

describe("pollTask: one poll, read by the adapter", () => {
  it("polls the adapter's own poll path with a GET", async () => {
    const stub = stubVideoFetch(jsonResponse({ status: "running" }));

    const outcome = await pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "abc" });

    expect(outcome).toEqual({ state: "running" });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(
      `${ARK_BASE_URL}/api/v3/contents/generations/tasks/abc`,
    );
    expect(stub.calls[0]?.method).toBe("GET");
    expect(stub.calls[0]?.headers).toEqual({ authorization: "Bearer sk-x" });
    expect(stub.calls[0]?.body).toBeUndefined();
  });

  it("returns the adapter's outcome, so a finished task carries its result", async () => {
    stubVideoFetch(
      jsonResponse({
        status: "succeeded",
        content: { video_url: "https://cdn.example.com/clip.mp4" },
        model: "m",
      }),
    );

    const outcome = await pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "abc" });

    expect(outcome).toEqual({
      state: "succeeded",
      result: { url: "https://cdn.example.com/clip.mp4", model: "m" },
    });
  });

  it("surfaces the x-request-id header on both verbs", async () => {
    stubVideoFetch(
      jsonResponse({ id: "cgt-1" }, 200, REQUEST_ID),
      jsonResponse({ status: "running" }, 200, REQUEST_ID),
    );

    const created = await createTask({
      binding: arkBinding(),
      apiKey: "sk-x",
      request: VIDEO_REQUEST,
    });
    const polled = await pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "cgt-1" });

    expect(created.requestId).toBe(REQUEST_ID);
    expect(polled).toEqual({ state: "running", requestId: REQUEST_ID });
  });

  it("points at --provider when the poll answers 404", async () => {
    stubVideoFetch(new Response("", { status: 404 }));

    const error = await rejection(
      pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "gone" }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("gone");
    expect(error.message).toContain("ark.cn-beijing.volces.com");
    expect(error.message).toMatch(/--provider/);
    // A 404 is an unknown id on this host, not a task that failed.
    expect(error.message).toMatch(/not a failed task/i);
  });

  it("quotes the vendor when the poll 404 carries a body", async () => {
    stubVideoFetch(
      jsonResponse({ error: { code: "NotFound", message: `no such route: ${API_KEY}` } }, 404),
    );

    const error = await rejection(
      pollTask({ binding: arkBinding(), apiKey: API_KEY, taskId: "gone" }),
    );

    // A right host with a wrong path answers 404 too, and the two lines above
    // point at --provider, so the vendor's own line has to be there.
    expect(error.message).toContain("no such route");
    expect(error.message).toContain("gone");
    expect(error.message).toMatch(/--provider/);
    expect(error.message).not.toContain(API_KEY);
  });

  it("does not let a hostile task id drive the terminal in that 404 message", async () => {
    stubVideoFetch(new Response("", { status: 404 }));

    const error = await rejection(
      pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "\u001b[2Jgone\u0007" }),
    );

    expect(error.message).toContain("gone");
    // The message is deliberately two lines; every other control byte is gone.
    expect(error.message).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(error.message).not.toContain("[2J");
  });

  it("bounds a very long task id so it cannot flood the terminal", async () => {
    stubVideoFetch(new Response("", { status: 404 }));

    const error = await rejection(
      pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "x".repeat(20_000) }),
    );

    // The same 200-character cap a response body gets, plus the ellipsis.
    expect(error.message).toContain(`${"x".repeat(200)}...`);
    expect(error.message).not.toContain("x".repeat(201));
    expect(error.message.length).toBeLessThan(500);
  });

  it("redacts the API key out of a terminal task's vendor error text", async () => {
    // A 2xx poll never reaches errorForStatus, so this is the only path where the
    // vendor's failure line could carry a reflected key into an ApiError whose code
    // is published into the JSON envelope on disk.
    stubVideoFetch(
      jsonResponse({
        status: "failed",
        error: { code: `InvalidApiKey.${API_KEY}`, message: `bad key ${API_KEY}` },
      }),
    );

    const outcome = await pollTask({ binding: arkBinding(), apiKey: API_KEY, taskId: "cgt-1" });

    expect(outcome.state).toBe("failed");
    if (outcome.state !== "failed") throw new Error(`expected a failed outcome, got ${outcome.state}`);
    expect(outcome.failure.message).not.toContain(API_KEY);
    expect(outcome.failure.message).toContain("[redacted]");
    expect(outcome.failure.code ?? "").not.toContain(API_KEY);
    expect(outcome.failure.code ?? "").toContain("[redacted]");
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });

  it("redacts the API key out of an error the adapter throws for a poll", async () => {
    // `pollOutcome` throws for a status nobody anticipated, and that message is the
    // raw vendor string the pipeline publishes to stderr and into the envelope. It
    // is the same leak as the terminal-outcome case above, one field over.
    stubVideoFetch(jsonResponse({ status: `paused-${API_KEY}` }));

    const error = await rejection(
      pollTask({ binding: arkBinding(), apiKey: API_KEY, taskId: "cgt-1" }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/unknown status/);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("[redacted]");
    // The adapter raised it, so it stays terminal for the retry policy.
    expect((error as ApiError).status).toBeUndefined();
  });

  it("uses the plain timeout wording for a poll, which is not paid for", async () => {
    stubVideoFetch(timeoutRejection());

    const error = await rejection(
      pollTask({ binding: arkBinding(), apiKey: "sk-x", taskId: "abc" }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timeout/i);
    expect(error.message).toContain("60s");
    expect(error.message).not.toMatch(/paid/i);
  });
});
