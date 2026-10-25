import { describe, expect, it } from "vitest";
import { ApiError, UsageError } from "../errors.js";
import type { ImageRequest } from "../types.js";
import { buildQwenRequest, parseQwenResponse, QwenDialect } from "./qwen.js";

function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    model: "qwen-image-3.0",
    prompt: "a red fox in the snow",
    images: [],
    n: 1,
    ...overrides,
  };
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

const arkOnlyFields: Array<[string, Partial<ImageRequest>]> = [
  ["output_format", { output_format: "png" }],
  ["optimize_prompt_mode", { optimize_prompt_mode: "fast" }],
  ["layer_decomposition", { layer_decomposition: true }],
  ["background", { background: "transparent" }],
];

describe("buildQwenRequest", () => {
  it("builds a flat text-to-image body without an image key", () => {
    const body = buildQwenRequest(request());

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      n: 1,
    });
    expect(body).not.toHaveProperty("image");
  });

  it("serializes a single reference image as a string", () => {
    const body = buildQwenRequest(request({ images: ["https://example.com/reference.png"] }));

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      image: "https://example.com/reference.png",
      n: 1,
    });
  });

  it("serializes multiple reference images as an ordered array", () => {
    const body = buildQwenRequest(
      request({
        images: ["https://example.com/first.png", "data:image/png;base64,AAAA"],
      }),
    );

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      image: ["https://example.com/first.png", "data:image/png;base64,AAAA"],
      n: 1,
    });
  });

  it("includes optional qwen fields only when they are set", () => {
    const body = buildQwenRequest(
      request({
        size: "2K",
        seed: 42,
        negative_prompt: "blurry, low quality",
        prompt_extend: false,
        prompt_extend_mode: "direct",
        enable_thinking: true,
        watermark: false,
      }),
    );

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      n: 1,
      size: "2K",
      seed: 42,
      negative_prompt: "blurry, low quality",
      prompt_extend: false,
      prompt_extend_mode: "direct",
      enable_thinking: true,
      watermark: false,
    });
  });

  it("keeps seed 0 and watermark false instead of treating them as absent", () => {
    const body = buildQwenRequest(request({ seed: 0, watermark: false }));

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      n: 1,
      seed: 0,
      watermark: false,
    });
  });

  it("does not leak unknown request keys into the vendor body", () => {
    const body = buildQwenRequest({ ...request(), surprise: "value" } as ImageRequest);

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      n: 1,
    });
  });

  for (const [field, overrides] of arkOnlyFields) {
    it(`rejects the ark-only ${field} field`, () => {
      const error = thrownBy(() => buildQwenRequest(request(overrides)));

      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain(field);
    });
  }

  it('rejects prompt_extend_mode "agent" for image-to-image', () => {
    const error = thrownBy(() =>
      buildQwenRequest(
        request({
          images: ["https://example.com/reference.png"],
          prompt_extend_mode: "agent",
        }),
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("agent");
    expect(error.message).toContain("图生图");
  });

  it('allows prompt_extend_mode "agent" for text-to-image', () => {
    const body = buildQwenRequest(request({ prompt_extend_mode: "agent" }));

    expect(body).toEqual({
      model: "qwen-image-3.0",
      prompt: "a red fox in the snow",
      n: 1,
      prompt_extend_mode: "agent",
    });
  });
});

describe("parseQwenResponse", () => {
  it("maps a successful response to images, usage, and no failures", () => {
    const parsed = parseQwenResponse({
      created: 1_710_000_000,
      data: [{ url: "https://example.com/result.png" }],
      usage: { image_count: 1, total_tokens: 120 },
    });

    expect(parsed).toEqual({
      images: [{ url: "https://example.com/result.png" }],
      failures: [],
      usage: { image_count: 1, total_tokens: 120 },
    });
  });

  it("passes the request id through when it is provided", () => {
    const parsed = parseQwenResponse(
      { data: [{ url: "https://example.com/result.png" }] },
      "req-123",
    );

    expect(parsed).toEqual({
      images: [{ url: "https://example.com/result.png" }],
      failures: [],
      requestId: "req-123",
    });
  });

  it("maps every data entry in order", () => {
    const parsed = parseQwenResponse({
      data: [
        { url: "https://example.com/first.png" },
        { url: "https://example.com/second.png" },
      ],
    });

    expect(parsed).toEqual({
      images: [
        { url: "https://example.com/first.png" },
        { url: "https://example.com/second.png" },
      ],
      failures: [],
    });
  });

  it("throws ApiError carrying the vendor code and message", () => {
    const error = thrownBy(() =>
      parseQwenResponse({
        request_id: "req-err",
        error: {
          code: "InvalidParameter.DataInspection",
          message: "输入图片内容审核未通过",
        },
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("InvalidParameter.DataInspection");
    expect(error.message).toContain("输入图片内容审核未通过");
  });

  it("throws ApiError when data is missing", () => {
    const error = thrownBy(() =>
      parseQwenResponse({ created: 1_710_000_000, usage: { image_count: 0 } }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("data");
  });

  it("throws ApiError when data is not an array", () => {
    const error = thrownBy(() =>
      parseQwenResponse({ data: "https://example.com/result.png" }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("data");
  });

  it("throws ApiError mentioning that no images were returned", () => {
    const error = thrownBy(() => parseQwenResponse({ created: 1_710_000_000, data: [] }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/no images/i);
  });

  it("throws ApiError when a data entry has no url", () => {
    const error = thrownBy(() => parseQwenResponse({ data: [{}] }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("url");
  });

  it("throws ApiError when the body is not an object", () => {
    const error = thrownBy(() => parseQwenResponse("not json"));

    expect(error).toBeInstanceOf(ApiError);
  });
});

describe("QwenDialect", () => {
  it("exposes buildRequest and parseResponse", () => {
    const req = request({ images: ["https://example.com/reference.png"] });

    expect(QwenDialect.buildRequest(req)).toEqual(buildQwenRequest(req));
    expect(
      QwenDialect.parseResponse(
        { data: [{ url: "https://example.com/result.png" }] },
        "req-123",
      ),
    ).toEqual({
      images: [{ url: "https://example.com/result.png" }],
      failures: [],
      requestId: "req-123",
    });
  });
});
