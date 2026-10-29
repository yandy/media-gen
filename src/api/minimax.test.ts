import { describe, expect, it } from "vitest";
import { ApiError, UsageError } from "../errors.js";
import type { VideoRequest } from "../types.js";
import {
  MinimaxVideoDialect,
  buildMinimaxVideoRequest,
  minimaxPollOutcome,
  minimaxPollPath,
  parseMinimaxError,
  taskIdFromMinimax,
} from "./minimax.js";

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the action to throw, but it returned normally");
}

describe("minimax video request", () => {
  it("sends the text alone and fills the two fields the vendor requires", () => {
    const body = buildMinimaxVideoRequest({ model: "MiniMax-H3", prompt: "a cat" });

    // `resolution` and `duration` are required by this API and optional in the CLI,
    // so the adapter — not the caller — decides what they fall back to.
    expect(body).toEqual({
      model: "MiniMax-H3",
      content: [{ type: "text", text: "a cat" }],
      resolution: "768P",
      duration: 5,
    });
  });

  it("appends the first frame after the text, with the role ark also uses", () => {
    const body = buildMinimaxVideoRequest({
      model: "MiniMax-H3",
      prompt: "p",
      first_frame: "data:image/png;base64,AA",
    });

    expect(body.content).toEqual([
      { type: "text", text: "p" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" }, role: "first_frame" },
    ]);
  });

  it("upper-cases the resolution on the wire and keeps what the caller set", () => {
    expect(buildMinimaxVideoRequest({ model: "m", prompt: "p", resolution: "2k" }).resolution).toBe("2K");
    expect(buildMinimaxVideoRequest({ model: "m", prompt: "p", resolution: "768p" }).resolution).toBe("768P");

    const body = buildMinimaxVideoRequest({ model: "m", prompt: "p", duration: 10, ratio: "9:16" });
    expect(body).toMatchObject({ duration: 10, ratio: "9:16" });
  });

  it("omits ratio rather than inventing one", () => {
    // On a first-frame task the vendor derives it from the image; on a text task it
    // requires a concrete value. Either way the CLI must not pick one silently.
    expect(buildMinimaxVideoRequest({ model: "m", prompt: "p" })).not.toHaveProperty("ratio");
  });

  const rejected: [string, Partial<VideoRequest>][] = [
    ["watermark", { watermark: true }],
    ["generate_audio", { generate_audio: true }],
    ["output_format", { output_format: "mov" }],
  ];

  it.each(rejected)("rejects %s, which this dialect does not accept", (field, extra) => {
    const error = thrownBy(() => buildMinimaxVideoRequest({ model: "m", prompt: "p", ...extra }));

      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain(field);
      expect(error.message).toContain("minimax");
    },
  );
});

describe("minimax task id and polling", () => {
  it("reads the id from task_id", () => {
    expect(taskIdFromMinimax({ task_id: "424010985738629" })).toBe("424010985738629");
  });

  it.each([[null], [{}], [{ task_id: "" }], [{ id: "x" }]])("rejects the malformed create body %j", (body) => {
    expect(() => taskIdFromMinimax(body)).toThrow(ApiError);
  });

  it("queries under its own prefix, which the create path does not share", () => {
    expect(MinimaxVideoDialect.createPath).toBe("/v2/video_generation");
    expect(minimaxPollPath("abc")).toBe("/v2/query/video_generation/abc");
    expect(minimaxPollPath("a/b")).toBe("/v2/query/video_generation/a%2Fb");
  });

  it("maps queued to pending, because that is the engine's word for it", () => {
    expect(minimaxPollOutcome({ task: { status: "queued" } })).toEqual({ state: "pending" });
    expect(minimaxPollOutcome({ task: { status: "running" } })).toEqual({ state: "running" });
  });

  it("reads the result out of the nested task object", () => {
    const outcome = minimaxPollOutcome({
      task: {
        status: "succeeded",
        model: "MiniMax-H3",
        content: { url: "https://cdn/v.mp4" },
        duration: 5,
        resolution: "2K",
        ratio: "16:9",
        usage: { total_seconds: 5 },
      },
    });

    expect(outcome).toEqual({
      state: "succeeded",
      result: {
        url: "https://cdn/v.mp4",
        model: "MiniMax-H3",
        duration: 5,
        resolution: "2K",
        ratio: "16:9",
        usage: { total_seconds: 5 },
      },
    });
  });

  it("reports a failed task with the vendor's category as the code", () => {
    const outcome = minimaxPollOutcome({
      task: { status: "failed", error: { type: "server_error", message: "internal error (1000)" } },
    });

    expect(outcome).toEqual({
      state: "failed",
      failure: { code: "server_error", message: "internal error (1000)" },
    });
  });

  it("reports a cancelled task", () => {
    expect(minimaxPollOutcome({ task: { status: "cancelled" } }).state).toBe("cancelled");
  });

  it("rejects a succeeded task without a url, an unknown status, and a missing task", () => {
    expect(() => minimaxPollOutcome({ task: { status: "succeeded", content: {} } })).toThrow(
      /content\.url/,
    );
    expect(() => minimaxPollOutcome({ task: { status: "paused" } })).toThrow(/paused/);
    expect(() => minimaxPollOutcome({ status: "running" })).toThrow(/task object/);
  });
});

describe("the minimax error envelope", () => {
  it("reads the category and the message from {type:'error', error:{…}}", () => {
    expect(
      parseMinimaxError({ type: "error", error: { type: "bad_request_error", message: "invalid params (2013)" } }),
    ).toEqual({ code: "bad_request_error", message: "invalid params (2013)" });
  });

  it("ignores anything that is not that envelope", () => {
    expect(parseMinimaxError({ error: { code: "X", message: "y" } })).toBeUndefined();
    expect(parseMinimaxError({ type: "error", error: { type: "t", message: "  " } })).toBeUndefined();
    expect(parseMinimaxError({})).toBeUndefined();
  });
});

describe("the minimax dialect", () => {
  it("carries its own name, tiers and exclusive fields", () => {
    expect(MinimaxVideoDialect.dialect).toBe("minimax");
    expect(MinimaxVideoDialect.resolutions).toEqual(["480p", "768p", "2k"]);
    // `exclusiveFields` lists the dialect-specific fields this dialect *accepts*.
    // This one accepts none of them, so the validator rejects ark's flags for it.
    expect(MinimaxVideoDialect.exclusiveFields).toEqual([]);
  });
});
