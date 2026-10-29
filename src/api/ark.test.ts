import { describe, expect, it } from "vitest";
import { ApiError, UsageError } from "../errors.js";
import type { ImageRequest } from "../types.js";
import {
  ArkDialect,
  ArkVideoDialect,
  arkPollOutcome,
  arkPollPath,
  buildArkRequest,
  buildArkVideoRequest,
  parseArkResponse,
  taskIdFromArk,
} from "./ark.js";

function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    model: "doubao-seedream-5-0-flash-260915",
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

const qwenOnlyFields: Array<[string, Partial<ImageRequest>]> = [
  ["negative_prompt", { negative_prompt: "blurry, low quality" }],
  ["prompt_extend", { prompt_extend: false }],
  ["prompt_extend_mode", { prompt_extend_mode: "direct" }],
  ["enable_thinking", { enable_thinking: true }],
];

describe("buildArkRequest", () => {
  it("builds a flat text-to-image body without an image key", () => {
    const body = buildArkRequest(request());

    expect(body).toEqual({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "a red fox in the snow",
      response_format: "url",
    });
    expect(body).not.toHaveProperty("image");
  });

  it("always sets response_format to url", () => {
    expect(buildArkRequest(request()).response_format).toBe("url");
    expect(
      buildArkRequest(
        request({
          images: ["https://example.com/reference.png"],
          size: "2K",
          output_format: "png",
          optimize_prompt_mode: "standard",
          layer_decomposition: true,
          background: "transparent",
        }),
      ).response_format,
    ).toBe("url");
  });

  it("serializes a single reference image as a string", () => {
    const body = buildArkRequest(request({ images: ["https://example.com/reference.png"] }));

    expect(body).toEqual({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "a red fox in the snow",
      image: "https://example.com/reference.png",
      response_format: "url",
    });
  });

  it("serializes multiple reference images as an ordered copy", () => {
    const images = [
      "https://example.com/first.png",
      "data:image/png;base64,AAAA",
      "https://example.com/third.png",
    ];
    const body = buildArkRequest(request({ images }));

    expect(body).toEqual({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "a red fox in the snow",
      image: [
        "https://example.com/first.png",
        "data:image/png;base64,AAAA",
        "https://example.com/third.png",
      ],
      response_format: "url",
    });
    expect(body.image).not.toBe(images);
  });

  it("includes the optional ark fields only when they are set", () => {
    const body = buildArkRequest(
      request({
        size: "2K",
        seed: 0,
        watermark: false,
        output_format: "png",
        optimize_prompt_mode: "fast",
        layer_decomposition: true,
        background: "transparent",
      }),
    );

    expect(body).toEqual({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "a red fox in the snow",
      size: "2K",
      seed: 0,
      watermark: false,
      output_format: "png",
      optimize_prompt_options: { mode: "fast" },
      layer_decomposition: true,
      background: "transparent",
      response_format: "url",
    });
  });

  it("omits optimize_prompt_options and the other ark extras when unset", () => {
    const body = buildArkRequest(request({ size: "1024x1024" }));

    expect(body).toEqual({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "a red fox in the snow",
      size: "1024x1024",
      response_format: "url",
    });
    expect(body).not.toHaveProperty("optimize_prompt_options");
    expect(body).not.toHaveProperty("layer_decomposition");
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("output_format");
  });

  it("does not leak unknown request keys or the qwen-style n into the vendor body", () => {
    const body = buildArkRequest({ ...request({ n: 3 }), surprise: "value" } as ImageRequest);

    expect(body).toEqual({
      model: "doubao-seedream-5-0-flash-260915",
      prompt: "a red fox in the snow",
      response_format: "url",
    });
    expect(body).not.toHaveProperty("n");
  });

  for (const [field, overrides] of qwenOnlyFields) {
    it(`rejects the openai-dialect ${field} field`, () => {
      const error = thrownBy(() => buildArkRequest(request(overrides)));

      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain(field);
    });
  }
});

describe("parseArkResponse", () => {
  it("maps a successful response to images, usage, and no failures", () => {
    const parsed = parseArkResponse({
      model: "doubao-seedream-5-0-flash-260915",
      created: 1_710_000_000,
      data: [{ url: "https://example.com/result.png", size: "2048x2048" }],
      usage: { generated_images: 1 },
    });

    expect(parsed).toEqual({
      images: [{ url: "https://example.com/result.png", size: "2048x2048" }],
      failures: [],
      usage: { generated_images: 1 },
    });
  });

  it("passes the request id through when it is provided", () => {
    const parsed = parseArkResponse(
      { data: [{ url: "https://example.com/result.png" }] },
      "req-123",
    );

    expect(parsed).toEqual({
      images: [{ url: "https://example.com/result.png" }],
      failures: [],
      requestId: "req-123",
    });
  });

  it("returns a partial success without throwing when one item fails", () => {
    const parsed = parseArkResponse({
      model: "doubao-seedream-5-0-flash-260915",
      created: 1_710_000_000,
      data: [
        { url: "https://example.com/kept.png", size: "2048x2048" },
        {
          error: {
            code: "OutputImageSensitiveContentDetected",
            message: "The generated image was blocked by content moderation",
          },
        },
      ],
      usage: { generated_images: 1 },
    });

    expect(parsed).toEqual({
      images: [{ url: "https://example.com/kept.png", size: "2048x2048" }],
      failures: [
        {
          code: "OutputImageSensitiveContentDetected",
          message: "The generated image was blocked by content moderation",
        },
      ],
      usage: { generated_images: 1 },
    });
  });

  it("preserves per-layer metadata into the image result", () => {
    const parsed = parseArkResponse({
      data: [
        {
          url: "https://example.com/layer-0.png",
          size: "2048x2048",
          output_format: "png",
          z_index: 0,
          bounding_box: {
            absolute: [0, 0, 1024, 1024],
            normalized: [0, 0, 0.5, 0.5],
          },
          name: "background",
          description: "transparent background layer",
        },
      ],
    });

    expect(parsed).toEqual({
      images: [
        {
          url: "https://example.com/layer-0.png",
          size: "2048x2048",
          outputFormat: "png",
          zIndex: 0,
          boundingBox: {
            absolute: [0, 0, 1024, 1024],
            normalized: [0, 0, 0.5, 0.5],
          },
          name: "background",
          description: "transparent background layer",
        },
      ],
      failures: [],
    });
  });

  it("throws ApiError carrying the first failure code when every item fails", () => {
    const error = thrownBy(() =>
      parseArkResponse({
        data: [
          {
            error: {
              code: "OutputImageSensitiveContentDetected",
              message: "first item was blocked",
            },
          },
          {
            error: {
              code: "InvalidParameter",
              message: "second item was rejected",
            },
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("OutputImageSensitiveContentDetected");
    expect(error.message).toContain("first item was blocked");
  });

  it("defaults a failure with no code or message instead of throwing a parse error", () => {
    const error = thrownBy(() => parseArkResponse({ data: [{ error: {} }] }));

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("UnknownError");
    expect(error.message).not.toBe("");
  });

  it("throws ApiError carrying the vendor code for a body-level error", () => {
    const error = thrownBy(() =>
      parseArkResponse({
        error: { code: "AuthenticationError", message: "invalid api key" },
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("AuthenticationError");
    expect(error.message).toContain("invalid api key");
  });

  it("throws ApiError when data is missing", () => {
    const error = thrownBy(() => parseArkResponse({ created: 1_710_000_000 }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("data");
  });

  it("throws ApiError when data is not an array", () => {
    const error = thrownBy(() => parseArkResponse({ data: "https://example.com/result.png" }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("data");
  });

  it("throws ApiError mentioning that no images were returned", () => {
    const error = thrownBy(() => parseArkResponse({ created: 1_710_000_000, data: [] }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/no images/i);
  });

  it("throws ApiError when an item has neither a url nor an error", () => {
    const error = thrownBy(() => parseArkResponse({ data: [{}] }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("url");
  });

  it("throws ApiError when an item error is not an object", () => {
    const error = thrownBy(() => parseArkResponse({ data: [{ error: "blocked" }] }));

    expect(error).toBeInstanceOf(ApiError);
  });

  it("throws ApiError when the body is not an object", () => {
    const error = thrownBy(() => parseArkResponse("not json"));

    expect(error).toBeInstanceOf(ApiError);
  });
});

describe("ArkDialect", () => {
  it("exposes buildRequest and parseResponse", () => {
    const req = request({ images: ["https://example.com/reference.png"] });

    expect(ArkDialect.buildRequest(req)).toEqual(buildArkRequest(req));
    expect(
      ArkDialect.parseResponse({ data: [{ url: "https://example.com/result.png" }] }, "req-123"),
    ).toEqual({
      images: [{ url: "https://example.com/result.png" }],
      failures: [],
      requestId: "req-123",
    });
  });
});

describe("ark video request", () => {
  it("sends a text item alone for text-to-video", () => {
    const body = buildArkVideoRequest({ model: "doubao-seedance-1-0-pro-250528", prompt: "a cat" });
    expect(body).toEqual({ model: "doubao-seedance-1-0-pro-250528", content: [{ type: "text", text: "a cat" }] });
  });

  it("appends the first frame after the text with role first_frame", () => {
    const body = buildArkVideoRequest({ model: "m", prompt: "p", first_frame: "https://x/a.png" });
    expect(body.content).toEqual([
      { type: "text", text: "p" },
      { type: "image_url", image_url: { url: "https://x/a.png" }, role: "first_frame" },
    ]);
  });

  it("places every scalar and omits the ones the caller did not set", () => {
    const body = buildArkVideoRequest({
      model: "m", prompt: "p", resolution: "720p", ratio: "16:9", duration: 5,
      seed: 11, watermark: true, generate_audio: false, output_format: "mov",
    });
    expect(body).toMatchObject({
      resolution: "720p", ratio: "16:9", duration: 5, seed: 11,
      watermark: true, generate_audio: false, output_format: "mov",
    });
    expect(Object.keys(body).sort()).toEqual(
      ["content", "duration", "generate_audio", "model", "output_format", "ratio", "resolution", "seed", "watermark"],
    );
  });
});

describe("ark video task id and polling", () => {
  it("reads the id from the top-level id field", () => {
    expect(taskIdFromArk({ id: "cgt-1" })).toBe("cgt-1");
  });

  it.each([[null], [{}], [{ id: "" }], [{ id: 7 }]])("rejects the malformed create body %j", (body) => {
    expect(() => taskIdFromArk(body)).toThrow(ApiError);
  });

  it("polls the same collection with the id appended", () => {
    expect(arkPollPath("cgt-1")).toBe("/api/v3/contents/generations/tasks/cgt-1");
    expect(arkPollPath("a/b")).toBe("/api/v3/contents/generations/tasks/a%2Fb");
  });

  it.each([["queued", "pending"], ["running", "running"]])("maps %s to %s", (status, state) => {
    expect(arkPollOutcome({ status }).state).toBe(state);
  });

  it("turns succeeded into a result with the flat response fields", () => {
    const outcome = arkPollOutcome({
      status: "succeeded",
      model: "doubao-seedance-2-0-260128",
      content: { video_url: "https://x/v.mp4" },
      duration: 5, resolution: "720p", ratio: "16:9", output_format: "mp4",
      usage: { completion_tokens: 108900 },
    });
    expect(outcome).toEqual({ state: "succeeded", result: {
      url: "https://x/v.mp4", model: "doubao-seedance-2-0-260128", duration: 5,
      resolution: "720p", ratio: "16:9", format: "mp4", usage: { completion_tokens: 108900 },
    }});
  });

  it("reports failed with the vendor code", () => {
    const outcome = arkPollOutcome({ status: "failed", error: { code: "OutputVideoSensitiveContentDetected", message: "blocked" } });
    expect(outcome).toEqual({ state: "failed", failure: { code: "OutputVideoSensitiveContentDetected", message: "blocked" } });
  });

  it.each(["cancelled", "expired"])("reports %s as a terminal failure naming it", (status) => {
    const outcome = arkPollOutcome({ status });
    // ark sends no error object for these, so the fallback message must still
    // say which terminal state the task ended in.
    expect(outcome).toEqual({ state: status, failure: { message: `ark task ${status}` } });
  });

  it("falls back to the status when a failed task carries no error object", () => {
    expect(arkPollOutcome({ status: "failed" })).toEqual({
      state: "failed",
      failure: { message: "ark task failed" },
    });
  });

  it("falls back to the status when the vendor error message is blank", () => {
    expect(
      arkPollOutcome({
        status: "failed",
        error: { code: "OutputVideoSensitiveContentDetected", message: "   " },
      }),
    ).toEqual({
      state: "failed",
      failure: { code: "OutputVideoSensitiveContentDetected", message: "ark task failed" },
    });
  });

  it("rejects succeeded without a video url, and an unknown status without looping", () => {
    expect(() => arkPollOutcome({ status: "succeeded", content: {} })).toThrow(ApiError);
    expect(() => arkPollOutcome({ status: "paused" })).toThrow(/paused/);
  });

  it("declares the resolutions and the exclusive flags of the ark dialect", () => {
    expect(ArkVideoDialect.resolutions).toEqual(["480p", "720p", "1080p", "4k"]);
    expect(ArkVideoDialect.exclusiveFields).toEqual([
      "generate_audio",
      "output_format",
      "watermark",
      "seed",
    ]);
    expect(ArkVideoDialect.createPath).toBe("/api/v3/contents/generations/tasks");
  });
});
