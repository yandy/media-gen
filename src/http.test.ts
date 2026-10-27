import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, UsageError } from "./errors.js";
import { callImageApi, parseJsonOrThrow } from "./http.js";
import type { ImageRequest, ProviderConfig } from "./types.js";

const API_KEY = "sk-test-secret-key-0123456789";
const QWEN_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const QWEN_URL = `https://dashscope.example.com${QWEN_PATH}`;
const REQUEST_ID = "req-0001";
const REQUEST_TIMEOUT_MS = 300_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "qwen",
    api_type: "qwen",
    base_url: "https://dashscope.example.com",
    model: "qwen-image-3.0",
    path: QWEN_PATH,
    ...overrides,
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

describe("callImageApi", () => {
  it("POSTs the joined URL with bearer auth and the body built by the adapter", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/cat.png" }] }, 200, REQUEST_ID),
    );

    const parsed = await callImageApi({
      provider: provider(),
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

  it("surfaces the x-request-id header into ParsedResponse.requestId", async () => {
    stubFetch(() =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/cat.png" }] }, 200, REQUEST_ID),
    );

    const parsed = await callImageApi({
      provider: provider(),
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

    const parsed = await callImageApi({
      provider: provider(),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(requestedTimeoutMs).toBe(REQUEST_TIMEOUT_MS);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timeout/i);
  });

  it("wraps a network failure in an ApiError naming the host and the reason", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    const error = await rejection(
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timeout/i);
    expect(error.message).toContain("dashscope.example.com");
  });

  it("lets a UsageError from buildRequest propagate unchanged without calling fetch", async () => {
    const fetchMock = stubFetch(() => jsonResponse({}, 200));

    const error = await rejection(
      callImageApi({
        provider: provider(),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
        callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
        callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
        callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
      callImageApi({ provider: provider(), apiKey: API_KEY, request }),
    );

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/BigInt/);
    expect(error.message).not.toMatch(/failed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("callImageApi: a 404 with an empty body", () => {
  function arkProvider(): ProviderConfig {
    return provider({
      name: "ark",
      api_type: "ark",
      base_url: "https://ark.cn-beijing.volces.com",
      model: "doubao-seedream-5-0-flash-260915",
      path: "/api/v3/images/generations",
    });
  }

  it("tells a qwen caller which host serves the images API and how to set it", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callImageApi({
        provider: provider({ base_url: "https://dashscope.aliyuncs.com" }),
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
    expect(error.message).not.toContain(API_KEY);
  });

  it("reports the workspace host for a hand-declared qwen entry too", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callImageApi({
        provider: provider({ name: "my-qwen", base_url: "https://relay.example.com" }),
        apiKey: API_KEY,
        request: imageRequest(),
      }),
    );

    expect(error.message).toContain("relay.example.com");
    expect(error.message).toContain("[providers.my-qwen]");
    expect(error.message).toContain("maas.aliyuncs.com");
  });

  it("leaves an ark 404 on the normal path", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    const error = await rejection(
      callImageApi({ provider: arkProvider(), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("maas.aliyuncs.com");
    expect(error.message).not.toContain("--base-url");
  });

  it("keeps the vendor message for a qwen 404 that carries a body", async () => {
    stubFetch(() => jsonResponse({ error: { code: "ModelNotFound", message: "no such model" } }, 404));

    const error = await rejection(
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
    );

    expect(error.message).toContain("no such model");
    expect(error.message).not.toContain("maas.aliyuncs.com");
    expect((error as ApiError).code).toBe("ModelNotFound");
  });

  it("does not turn another empty-body status into the endpoint remedy", async () => {
    stubFetch(() => new Response("", { status: 503 }));

    const error = await rejection(
      callImageApi({ provider: provider(), apiKey: API_KEY, request: imageRequest() }),
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
