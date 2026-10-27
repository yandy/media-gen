import { describe, expect, it } from "vitest";
import { buildDashscopeRequest, parseDashscopeResponse, toDashscopeSize } from "./dashscope.js";
import type { ImageRequest } from "../types.js";

function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { model: "qwen-image-2.0-pro", prompt: "a red fox", images: [], n: 1, ...overrides };
}

describe("buildDashscopeRequest", () => {
  it("wraps the prompt in input.messages and keeps n in parameters", () => {
    expect(buildDashscopeRequest(request())).toEqual({
      model: "qwen-image-2.0-pro",
      input: { messages: [{ role: "user", content: [{ text: "a red fox" }] }] },
      parameters: { n: 1 },
    });
  });

  it("puts input images before the text, in order", () => {
    const body = buildDashscopeRequest(
      request({ images: ["https://a/1.png", "data:image/png;base64,AAA"] }),
    ) as { input: { messages: { content: unknown[] }[] } };
    expect(body.input.messages[0]?.content).toEqual([
      { image: "https://a/1.png" },
      { image: "data:image/png;base64,AAA" },
      { text: "a red fox" },
    ]);
  });

  it("translates the CLI WxH separator to the wire's asterisk", () => {
    expect(toDashscopeSize("2048x1024")).toBe("2048*1024");
  });

  it("rejects a size tier at the wire boundary", () => {
    expect(() => toDashscopeSize("2K")).toThrow(/WxH/);
  });

  it("puts only the options the caller set into parameters", () => {
    const body = buildDashscopeRequest(
      request({
        size: "1024x1024",
        negative_prompt: "blur",
        prompt_extend: false,
        watermark: true,
        seed: 7,
      }),
    ) as { parameters: unknown };
    expect(body.parameters).toEqual({
      size: "1024*1024",
      n: 1,
      negative_prompt: "blur",
      prompt_extend: false,
      watermark: true,
      seed: 7,
    });
  });

  it("rejects ark-only options", () => {
    expect(() => buildDashscopeRequest(request({ output_format: "png" }))).toThrow(/ark-only/);
  });

  it("rejects openai-only options", () => {
    expect(() => buildDashscopeRequest(request({ enable_thinking: true }))).toThrow(
      /openai dialect/,
    );
  });
});

function success(): unknown {
  return {
    output: {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: [{ image: "https://cdn/1.png" }] },
        },
      ],
    },
    usage: { image_count: 1, width: 2048, height: 2048 },
    request_id: "req-1",
  };
}

describe("parseDashscopeResponse", () => {
  it("reads images out of output.choices[].message.content[]", () => {
    const parsed = parseDashscopeResponse(success(), "req-1");
    expect(parsed.images).toEqual([{ url: "https://cdn/1.png" }]);
    expect(parsed.failures).toEqual([]);
    expect(parsed.usage).toEqual({ image_count: 1, width: 2048, height: 2048 });
    expect(parsed.requestId).toBe("req-1");
  });

  it("collects several images across content items and skips text items", () => {
    const parsed = parseDashscopeResponse({
      output: {
        choices: [
          {
            message: {
              content: [
                { image: "https://cdn/1.png" },
                { text: "interleaved" },
                { image: "https://cdn/2.png" },
              ],
            },
          },
        ],
      },
    });
    expect(parsed.images.map((image) => image.url)).toEqual([
      "https://cdn/1.png",
      "https://cdn/2.png",
    ]);
  });

  it("takes request_id from the body when no header id is given", () => {
    expect(parseDashscopeResponse(success()).requestId).toBe("req-1");
  });

  it("explains a missing output object", () => {
    expect(() => parseDashscopeResponse({})).toThrow(
      /output\.choices\[\]\.message\.content\[\]\.image/,
    );
  });

  it("says the upstream produced no image when content is empty", () => {
    expect(() =>
      parseDashscopeResponse({ output: { choices: [{ message: { content: [] } }] } }),
    ).toThrow(/no images/);
  });

  it("turns a top-level code/message into an ApiError carrying the code", () => {
    expect(() =>
      parseDashscopeResponse({ request_id: "r", code: "InvalidParameter", message: "n must be 1" }),
    ).toThrowError(expect.objectContaining({ code: "InvalidParameter", message: "n must be 1" }));
  });
});
