import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ConfigError, UsageError } from "./errors.js";
import { renderError, renderHuman, renderJson, renderVideoHuman, renderVideoJson } from "./output.js";
import type { ParsedResponse, SavedFile, VideoResult } from "./types.js";

const PARTIAL_NOTE = /2 file\(s\) written, 1 failed/;

function savedFile(index: number, overrides: Partial<SavedFile> = {}): SavedFile {
  return {
    path: `/tmp/out/media-${index}.png`,
    url: `https://cdn.example.com/${index}.png`,
    index,
    ...overrides,
  };
}

function response(overrides: Partial<ParsedResponse> = {}): ParsedResponse {
  return { images: [], failures: [], ...overrides };
}

function failure(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderHuman", () => {
  it("lists each saved path on its own stdout line and nothing else", () => {
    const saved = [savedFile(0), savedFile(1)];
    const res = response({
      images: [{ url: "https://cdn.example.com/0.png" }],
      usage: { image_count: 2 },
      requestId: "req-1",
    });

    const { stdout, stderr } = renderHuman(saved, res);

    expect(stdout.split("\n")).toEqual(["/tmp/out/media-0.png", "/tmp/out/media-1.png"]);
    expect(stderr).toBe("");
  });

  it("writes one warning line per failure to stderr", () => {
    const res = response({
      failures: [
        failure("DataInspectionFailed", "content rejected"),
        failure("Timeout", "download timed out"),
      ],
    });

    const { stdout, stderr } = renderHuman([savedFile(0)], res);

    expect(stdout).toBe("/tmp/out/media-0.png");
    expect(stderr.split("\n")).toContain("warning: DataInspectionFailed: content rejected");
    expect(stderr.split("\n")).toContain("warning: Timeout: download timed out");
  });

  it("states that files were written when only some images succeeded", () => {
    const saved = [savedFile(0), savedFile(1)];
    const res = response({
      failures: [failure("DataInspectionFailed", "content rejected")],
    });

    const { stdout, stderr } = renderHuman(saved, res);

    expect(stdout.split("\n")).toEqual(["/tmp/out/media-0.png", "/tmp/out/media-1.png"]);
    expect(stderr).toContain("warning: DataInspectionFailed: content rejected");
    expect(stderr).toMatch(PARTIAL_NOTE);
    expect(stderr).toContain("already on disk");
    expect(stderr.toLowerCase()).toContain("do not retry");
  });

  it("emits no success note when every image saved", () => {
    const { stderr } = renderHuman([savedFile(0)], response());
    expect(stderr).toBe("");
  });

  it("does not claim files were written when nothing was saved", () => {
    const res = response({ failures: [failure("DataInspectionFailed", "content rejected")] });

    const { stdout, stderr } = renderHuman([], res);

    expect(stdout).toBe("");
    expect(stderr).toBe("warning: DataInspectionFailed: content rejected");
    expect(stderr).not.toContain("written");
  });
});

describe("renderJson", () => {
  it("returns exactly the documented keys with mapped values", () => {
    const saved = [
      savedFile(0, {
        meta: { url: "https://cdn.example.com/0.png", size: "1024x1024" },
      }),
      savedFile(1),
    ];
    const res = response({
      images: [{ url: "https://cdn.example.com/0.png" }, { url: "https://cdn.example.com/1.png" }],
      failures: [failure("DataInspectionFailed", "content rejected")],
      usage: { input_tokens: 10, output_tokens: 20 },
      requestId: "req-123",
    });

    const parsed = JSON.parse(renderJson(saved, res));

    expect(Object.keys(parsed).sort()).toEqual([
      "errors",
      "files",
      "ok",
      "partial",
      "request_id",
      "usage",
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.partial).toBe(true);
    expect(parsed.files).toEqual([
      {
        path: "/tmp/out/media-0.png",
        index: 0,
        size: "1024x1024",
        url: "https://cdn.example.com/0.png",
      },
      { path: "/tmp/out/media-1.png", index: 1, url: "https://cdn.example.com/1.png" },
    ]);
    expect(parsed.errors).toEqual([{ code: "DataInspectionFailed", message: "content rejected" }]);
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(parsed.request_id).toBe("req-123");
  });

  it("omits usage and request_id when absent instead of emitting null", () => {
    const parsed = JSON.parse(renderJson([savedFile(0)], response()));

    expect(Object.keys(parsed).sort()).toEqual(["errors", "files", "ok", "partial"]);
    expect("usage" in parsed).toBe(false);
    expect("request_id" in parsed).toBe(false);
    expect(parsed.ok).toBe(true);
    expect(parsed.partial).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  it("includes request_id alone when only it is present", () => {
    const parsed = JSON.parse(renderJson([savedFile(0)], response({ requestId: "req-only" })));

    expect(Object.keys(parsed).sort()).toEqual(["errors", "files", "ok", "partial", "request_id"]);
    expect("usage" in parsed).toBe(false);
    expect(parsed.request_id).toBe("req-only");
  });

  it("omits size from a file entry when its meta has no size", () => {
    const saved = [savedFile(0, { meta: { url: "https://cdn.example.com/0.png" } })];

    const [entry] = JSON.parse(renderJson(saved, response())).files;

    expect("size" in entry).toBe(false);
    expect(entry).toEqual({
      path: "/tmp/out/media-0.png",
      index: 0,
      url: "https://cdn.example.com/0.png",
    });
  });

  it("is ok and partial for two saved plus one failure", () => {
    const res = response({ failures: [failure("DataInspectionFailed", "content rejected")] });

    const parsed = JSON.parse(renderJson([savedFile(0), savedFile(1)], res));

    expect(parsed.ok).toBe(true);
    expect(parsed.partial).toBe(true);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.errors).toHaveLength(1);
  });

  it("is not ok and not partial when nothing was saved", () => {
    const res = response({ failures: [failure("DataInspectionFailed", "content rejected")] });

    const parsed = JSON.parse(renderJson([], res));

    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(false);
    expect(parsed.files).toEqual([]);
    expect(parsed.errors).toEqual([{ code: "DataInspectionFailed", message: "content rejected" }]);
  });

  it("is not partial for two saved with no failures", () => {
    const parsed = JSON.parse(renderJson([savedFile(0), savedFile(1)], response()));

    expect(parsed.ok).toBe(true);
    expect(parsed.partial).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  it("does not leak unknown response or file fields", () => {
    const saved = [{ ...savedFile(0), apiKey: "sk-secret-value" } as unknown as SavedFile];
    const res = {
      ...response(),
      api_key: "sk-secret-value",
      request_body: { prompt: "secret prompt" },
    } as unknown as ParsedResponse;

    const out = renderJson(saved, res);

    expect(out).not.toContain("sk-secret-value");
    expect(out).not.toContain("secret prompt");
    expect(out).not.toContain("api_key");
    expect(out).not.toContain("request_body");
  });
});

function savedVideo(overrides: Partial<SavedFile> = {}): SavedFile {
  return {
    path: "/tmp/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4",
    url: "https://cdn.example.com/v.mp4",
    index: 0,
    meta: { url: "https://cdn.example.com/v.mp4", duration: 5, resolution: "720p" },
    ...overrides,
  };
}

function videoResult(overrides: Partial<VideoResult> = {}): VideoResult {
  return {
    saved: [],
    taskId: "cgt-1",
    status: "succeeded",
    response: { url: "https://cdn.example.com/v.mp4", duration: 5, resolution: "720p" },
    ...overrides,
  };
}

describe("renderVideoJson", () => {
  it("carries task_id, status and the per-file metadata the task reported", () => {
    const payload = JSON.parse(
      renderVideoJson(videoResult({ saved: [savedVideo()], requestId: "req-1", usage: { completion_tokens: 108900 } })),
    );

    expect(payload).toEqual({
      ok: true,
      task_id: "cgt-1",
      status: "succeeded",
      files: [
        {
          path: "/tmp/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4",
          index: 0,
          url: "https://cdn.example.com/v.mp4",
          duration: 5,
          resolution: "720p",
        },
      ],
      errors: [],
      usage: { completion_tokens: 108900 },
      request_id: "req-1",
    });
    expect(payload).not.toHaveProperty("partial");
  });

  it("stays ok with no files while the task is still running", () => {
    const payload = JSON.parse(renderVideoJson(videoResult({ status: "running", response: undefined })));

    expect(payload).toEqual({ ok: true, task_id: "cgt-1", status: "running", files: [], errors: [] });
  });

  it("omits optional fields rather than writing nulls", () => {
    const payload = JSON.parse(renderVideoJson(videoResult({ saved: [savedVideo({ meta: undefined })] })));

    expect(payload.files[0]).toEqual({
      path: "/tmp/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4",
      index: 0,
      url: "https://cdn.example.com/v.mp4",
    });
    expect(payload).not.toHaveProperty("usage");
    expect(payload).not.toHaveProperty("request_id");
  });
});

describe("renderVideoHuman", () => {
  it("prints the saved path, and the task id when there is no file yet", () => {
    const saved = renderVideoHuman(videoResult({ saved: [savedVideo()] }));
    expect(saved).toEqual({
      stdout: "/tmp/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4",
      stderr: "",
    });

    const running = renderVideoHuman(videoResult({ status: "running", response: undefined }));
    expect(running).toEqual({ stdout: "cgt-1", stderr: "" });
  });
});

describe("renderError", () => {
  it("publishes the task id of a paid-but-unfinished task in the JSON envelope", () => {
    const rendered = renderError(new ApiError("task cgt-1 is still running", "TaskNotFinished", "cgt-1"), true);

    expect(JSON.parse(rendered.stdout)).toEqual({
      error: { message: "task cgt-1 is still running", code: "TaskNotFinished", task_id: "cgt-1" },
    });
    expect(rendered.exitCode).toBe(1);
  });

  it("leaves the error envelope alone for an error that carries no task id", () => {
    const rendered = renderError(new ApiError("boom", "X"), true);

    expect(JSON.parse(rendered.stdout)).toEqual({ error: { message: "boom", code: "X" } });
  });

  it("maps UsageError to exit 2 with the message on stderr in human mode", () => {
    const result = renderError(new UsageError("bad flag: --nope"), false);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("bad flag: --nope");
  });

  it("maps UsageError to exit 2 with a JSON payload on stdout", () => {
    const result = renderError(new UsageError("bad flag: --nope"), true);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ error: { message: "bad flag: --nope" } });
  });

  it("maps a generic Error to exit 1 with JSON on stdout and no code", () => {
    const result = renderError(new Error("boom"), true);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({ error: { message: "boom" } });
    expect("code" in parsed.error).toBe(false);
  });

  it("maps a generic Error to exit 1 with the message on stderr in human mode", () => {
    const result = renderError(new Error("boom"), false);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("boom");
  });

  it("maps non-usage errors to exit 1", () => {
    expect(renderError(new ConfigError("no provider"), false).exitCode).toBe(1);
  });

  it("includes the vendor code for ApiError in JSON mode", () => {
    const result = renderError(new ApiError("content rejected", "DataInspectionFailed"), true);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      error: { message: "content rejected", code: "DataInspectionFailed" },
    });
  });

  it("omits code for an ApiError without a code", () => {
    const parsed = JSON.parse(renderError(new ApiError("network failed"), true).stdout);

    expect(parsed).toEqual({ error: { message: "network failed" } });
    expect("code" in parsed.error).toBe(false);
  });

  it("renders a thrown string readably", () => {
    const human = renderError("something broke", false);
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe("something broke");

    const json = JSON.parse(renderError("something broke", true).stdout);
    expect(json.error.message).toBe("something broke");
  });

  it("renders thrown undefined, null, and objects readably", () => {
    for (const thrown of [undefined, null, {}, { message: "object message" }]) {
      for (const json of [false, true]) {
        const result = renderError(thrown, json);
        const message = json ? JSON.parse(result.stdout).error.message : result.stderr;

        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toBe("undefined");
        expect(message).not.toBe("null");
        expect(message).not.toBe("[object Object]");
        expect(result.exitCode).toBe(1);
      }
    }
  });

  it("renders error bodies without writing to stdio or exiting", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    renderHuman([savedFile(0)], response({ failures: [failure("X", "y")] }));
    renderJson([savedFile(0)], response());
    renderError(new Error("boom"), false);
    renderError(new UsageError("bad"), true);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
