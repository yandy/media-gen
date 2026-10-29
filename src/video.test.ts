import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkVideoDialect } from "./api/ark.js";
import { MinimaxVideoDialect } from "./api/minimax.js";
import { writeConfigFile } from "./config.js";
import { ApiError, ConfigError, UsageError } from "./errors.js";
import type { VideoDeps } from "./types.js";
import {
  buildVideoRequest,
  runVideoGenerate,
  runVideoStatus,
  validateResolution,
} from "./video.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

const ARK_KEY = "sk-test-ark-key-0123456789";
const ARK_VIDEO_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";

const arkAdapter = ArkVideoDialect;

const minimaxAdapter = MinimaxVideoDialect;

const originalEnv = {
  MEDIAGEN_CLI_CONFIG_DIR: process.env.MEDIAGEN_CLI_CONFIG_DIR,
  MEDIAGEN_CLI_STATE_DIR: process.env.MEDIAGEN_CLI_STATE_DIR,
  ARK_API_KEY: process.env.ARK_API_KEY,
};

let tempDir: string;
let outDir: string;

/**
 * The config every test boots with. `videoTimeoutSeconds` overrides the video poll
 * budget (`timeout_seconds`), which is how a test gets a budget so small that the
 * first poll is also the last.
 */
function configText(videoTimeoutSeconds?: number): string {
  return [
    'default_provider = "volcengine"',
    `output_dir = ${JSON.stringify(outDir)}`,
    "",
    "[providers.volcengine]",
    'api_type = "ark"',
    'base_url = "https://ark.cn-beijing.volces.com"',
    'api_key_env = "ARK_API_KEY"',
    "",
    "[providers.volcengine.video]",
    'default = "doubao-seedance-2-5-260628"',
    'models = ["doubao-seedance-2-5-260628"]',
    ...(videoTimeoutSeconds === undefined ? [] : [`timeout_seconds = ${videoTimeoutSeconds}`]),
    "",
    // The same fixture serves the minimax pipeline: its own host, key and create path.
    "[providers.minimax]",
    'base_url = "https://api.minimax.io"',
    'api_key_env = "MINIMAX_API_KEY"',
    "",
    "[providers.minimax.video]",
    'api_type = "minimax"',
    'default = "MiniMax-H3"',
    'models = ["MiniMax-H3"]',
    ...(videoTimeoutSeconds === undefined ? [] : [`timeout_seconds = ${videoTimeoutSeconds}`]),
    "",
  ].join("\n");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-video-"));
  outDir = path.join(tempDir, "out");
  // The pipeline reads config, a key and an out-dir before it can spend money,
  // and these tests drive it directly, bypassing main()'s bootstrap.
  process.env.MEDIAGEN_CLI_CONFIG_DIR = path.join(tempDir, "config");
  process.env.MEDIAGEN_CLI_STATE_DIR = path.join(tempDir, "state");
  process.env.ARK_API_KEY = ARK_KEY;
  process.env.MINIMAX_API_KEY = "sk-test-minimax-key-0123456789";
  writeConfigFile(configText());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, init: { status?: number; requestId?: string } = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.requestId !== undefined) headers["x-request-id"] = init.requestId;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/** Distinctive bytes: if they reach the disk, the download path really ran. */
function videoBytes(): Response {
  return new Response(Buffer.from("\x00\x00\x00\x18ftypmp42"), {
    status: 200, headers: { "content-type": "video/mp4" },
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error("expected a rejection, but the promise resolved");
}

interface ScriptedCall { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

/**
 * The Nth call gets the Nth response; the last one repeats once it runs out.
 * `notes` collects everything written to stderr, which is where the task-id note
 * must go so stdout stays result-only. `timeline` interleaves those writes with the
 * requests in the order they happened — the only way to assert *when* the note was
 * written rather than only what it said.
 */
function scriptedFetch(responses: Response[]): {
  calls: ScriptedCall[];
  notes: string[];
  timeline: string[];
} {
  const calls: ScriptedCall[] = [];
  const notes: string[] = [];
  const timeline: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url, method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> }),
    });
    timeline.push(`${method} ${url}`);
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  }));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    const text = String(chunk);
    notes.push(text);
    timeline.push(`stderr ${text.trim()}`);
    return true;
  });
  return { calls, notes, timeline };
}

/**
 * No sleeping plus a fake clock; `step` is how far each `now()` advances (default 0:
 * never over budget). `sleeps` records every wait the loop asked for, which is the
 * only way to pin the poll schedule without a real clock.
 */
function deps(options: { step?: number } = {}): VideoDeps & { sleeps: number[] } {
  let clock = 0;
  const step = options.step ?? 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => (clock += step),
  };
}

describe("validateResolution", () => {
  it("normalizes the resolution case and rejects a tier the dialect does not have", () => {
    expect(validateResolution("720P", arkAdapter)).toBe("720p");
    expect(() => validateResolution("768p", arkAdapter)).toThrow(/768p/);
    expect(validateResolution("2K", minimaxAdapter)).toBe("2k");
    expect(() => validateResolution("1080p", minimaxAdapter)).toThrow(/1080p/);
  });

  it("rejects a resolution that is a bare number or a pixel pair", () => {
    expect(() => validateResolution("720", arkAdapter)).toThrow(UsageError);
    expect(() => validateResolution("1024x1024", arkAdapter)).toThrow(UsageError);
  });

  it("names the dialect the adapter carries, and the tiers it accepts", () => {
    expect(() => validateResolution("768p", arkAdapter)).toThrow(
      /the ark dialect accepts 480p, 720p, 1080p, 4k; whether a model supports a tier is checked by the vendor/,
    );
  });
});

describe("buildVideoRequest", () => {
  it("rejects a second --image, naming the unsupported mode", () => {
    // `--image` is collected, not overwritten: silently dropping the second path
    // would make the user believe a last frame went to the vendor.
    const call = (): unknown =>
      buildVideoRequest("p", { image: ["a.png", "b.png"], noWait: false }, "m", arkAdapter);
    expect(call).toThrow(/one --image/);
    expect(call).toThrow(/last_frame|首尾帧/i);
  });

  it("quotes the rejected second --image, like every other rejection", () => {
    const call = (): unknown =>
      buildVideoRequest("p", { image: ["a.png", "b.png"], noWait: false }, "m", arkAdapter);
    expect(call).toThrow(/"b\.png"/);
  });

  it("names --image when the frame path cannot be read", () => {
    const missing = path.join(tempDir, "missing.png");
    const call = (): unknown =>
      buildVideoRequest("p", { image: [missing], noWait: false }, "m", arkAdapter);
    expect(call).toThrow(UsageError);
    expect(call).toThrow(/--image/);
    expect(call).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("rejects an empty prompt before anything is built", () => {
    expect(() => buildVideoRequest("   ", { noWait: false }, "m", arkAdapter)).toThrow(UsageError);
  });

  it("rejects a ratio outside the shared enum", () => {
    expect(() => buildVideoRequest("p", { ratio: "5:4", noWait: false }, "m", arkAdapter)).toThrow(UsageError);
  });

  it("rejects a non-positive or non-integer duration and a negative seed", () => {
    expect(() => buildVideoRequest("p", { duration: 0, noWait: false }, "m", arkAdapter)).toThrow(UsageError);
    expect(() => buildVideoRequest("p", { duration: 4.5, noWait: false }, "m", arkAdapter)).toThrow(UsageError);
    expect(() => buildVideoRequest("p", { seed: -1, noWait: false }, "m", arkAdapter)).toThrow(UsageError);
  });

  it("rejects a flag the dialect does not accept", () => {
    expect(() => buildVideoRequest("p", { generateAudio: true, noWait: false }, "m", minimaxAdapter))
      .toThrow(/"generate_audio".*minimax/);
  });

  it("rejects watermark on a dialect that does not take it", () => {
    expect(() => buildVideoRequest("p", { watermark: true, noWait: false }, "m", minimaxAdapter))
      .toThrow(/"watermark".*minimax/);
    expect(buildVideoRequest("p", { watermark: true, noWait: false }, "m", arkAdapter).watermark).toBe(
      true,
    );
  });

  it("rejects seed on a dialect that does not take one", () => {
    // Without this, --seed would be accepted, validated and never sent: the user pays
    // twice for two runs they believe differ.
    expect(() => buildVideoRequest("p", { seed: 42, noWait: false }, "m", minimaxAdapter)).toThrow(
      /"seed".*minimax/,
    );
    expect(buildVideoRequest("p", { seed: 42, noWait: false }, "m", arkAdapter).seed).toBe(42);
  });

  it("declares exactly the fields its buildRequest actually serializes", () => {
    // `seed` escaped this once: the gate never asked about it, so it was validated and
    // then dropped. The two lists must agree for every dialect-specific field.
    const adapters = [arkAdapter, minimaxAdapter];
    const fields = ["generate_audio", "output_format", "watermark", "seed"] as const;

    for (const adapter of adapters) {
      for (const field of fields) {
        let serialized = false;
        try {
          const body = adapter.buildRequest({ model: "m", prompt: "p", [field]: field === "seed" ? 1 : field === "generate_audio" || field === "watermark" ? true : "mov" } as never);
          serialized = body !== null && typeof body === "object" && field in (body as Record<string, unknown>);
        } catch {
          serialized = false;
        }
        const declared = (adapter.exclusiveFields ?? []).includes(field);
        expect({ dialect: adapter.dialect, field, declared, serialized }).toEqual({
          dialect: adapter.dialect,
          field,
          declared,
          serialized: declared,
        });
      }
    }
  });

  it("keeps a dialect's own exclusive flag on the dialect that declares it", () => {
    const request = buildVideoRequest(
      "p",
      { generateAudio: true, outputFormat: "mov", noWait: false },
      "m",
      arkAdapter,
    );
    expect(request.generate_audio).toBe(true);
    expect(request.output_format).toBe("mov");
  });

  it("passes the frame through toImageInput so a local file becomes a data URL", () => {
    const frame = path.join(tempDir, "frame.png");
    fs.writeFileSync(frame, PNG_BYTES);
    const req = buildVideoRequest("p", { image: [frame], noWait: false }, "m", arkAdapter);
    expect(req.first_frame).toMatch(/^data:image\/png;base64,/);
  });

  it("puts the normalized resolution, the ratio and a false watermark in the body", () => {
    const request = buildVideoRequest(
      "p",
      { resolution: "720P", ratio: "adaptive", watermark: false, noWait: false },
      "m",
      arkAdapter,
    );
    expect(request.resolution).toBe("720p");
    expect(request.ratio).toBe("adaptive");
    expect(request.watermark).toBe(false);
  });

  it("copies only the flags the caller set, so the wire body stays clean", () => {
    expect(buildVideoRequest("a cat", { noWait: false }, "m", arkAdapter)).toEqual({
      model: "m",
      prompt: "a cat",
    });
  });
});

describe("runVideoGenerate", () => {
  it("creates, polls queued then running then succeeded, and downloads one file", async () => {
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "queued" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "succeeded", content: { video_url: "https://cdn/v.mp4" }, model: "m", duration: 5, resolution: "720p" }),
      videoBytes(),
    ]);
    const result = await runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps());
    expect(result.taskId).toBe("cgt-1");
    expect(stub.calls[0].url).toBe(ARK_VIDEO_URL);
    expect(result.status).toBe("succeeded");
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].path).toMatch(/-0\.mp4$/);
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);   // the paid request goes out once
  });

  it("keeps the create's request id when a poll carries a different one", async () => {
    // The create is the request that was charged, so it owns the id; preferring the
    // poll's would silently attribute the run to a request nobody paid for.
    scriptedFetch([
      jsonResponse({ id: "cgt-1" }, { requestId: "req-create" }),
      jsonResponse(
        { status: "succeeded", content: { video_url: "https://cdn/v.mp4" } },
        { requestId: "req-poll" },
      ),
      videoBytes(),
    ]);
    const result = await runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps());
    expect(result.requestId).toBe("req-create");
    expect(result.taskId).toBe("cgt-1");
  });

  it("writes the task id to stderr before the first poll so an interrupt is recoverable", async () => {
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "succeeded", content: { video_url: "https://cdn/v.mp4" } }),
      videoBytes(),
    ]);
    await runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps());
    expect(stub.notes[0]).toContain("cgt-1");
    expect(stub.notes[0]).toMatch(/resume with/);
    // Content alone would pass for a note written after the last poll: the timeline
    // pins the order — create, note, first poll.
    expect(stub.timeline[0]).toMatch(/^POST /);
    expect(stub.timeline[1]).toMatch(/^stderr note: task cgt-1 was created/);
    expect(stub.timeline[2]).toMatch(/^GET /);
    const noteAt = stub.timeline.findIndex((entry) => entry.startsWith("stderr "));
    const firstPollAt = stub.timeline.findIndex((entry) => entry.startsWith("GET "));
    expect(noteAt).toBeLessThan(firstPollAt);
  });

  it("waits on the poll schedule: 2s, then x1.5, capped at 10s", async () => {
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "queued" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "succeeded", content: { video_url: "https://cdn/v.mp4" } }),
      videoBytes(),
    ]);
    const clock = deps();
    await runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, clock);
    // One wait before each of the six polls; the cap is what keeps a long queue from
    // spending its budget on requests.
    expect(clock.sleeps).toEqual([2_000, 3_000, 4_500, 6_750, 10_000, 10_000]);
    expect(stub.calls.filter((c) => c.method === "GET" && c.url.startsWith(ARK_VIDEO_URL))).toHaveLength(6);
  });

  it("stops when the budget is spent and reports it as paid-but-unfinished", async () => {
    // The clock jumps 16 minutes per now(): the second poll's budget check is past the 1800s budget.
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "running" }),
    ]);
    const error = await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps({ step: 16 * 60_000 })));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("TaskNotFinished");
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect(error.message).toContain("cgt-1");
    expect(error.message).toMatch(/do not (submit|resubmit|re-run)/i);
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("polls once even when the whole budget is one second", async () => {
    // timeout_seconds = 1 is legal and the first wait comes before the first poll,
    // so without this the run would pay for a task and never ask its state.
    writeConfigFile(configText(1));
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "running" }),
    ]);
    const error = await rejection(
      runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps({ step: 1_000 })),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("TaskNotFinished");
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect(error.message).toContain("cgt-1");
    // Exactly one poll: the budget may end the run, but only after the state was asked.
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("does not poll at all with --no-wait", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" })]);
    const result = await runVideoGenerate("a cat", { provider: "volcengine", noWait: true }, deps());
    expect(result.status).toBe("pending");
    expect(result.saved).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  it.each(["failed", "cancelled", "expired"])("reports %s as an error", async (status) => {
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status, error: { code: "X", message: "nope" } }),
    ]);
    const error = await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps()));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect((error as ApiError).code).toBe("X");
    // The vendor's own line is the only thing that says why, so it has to survive.
    expect(error.message).toContain("nope");
    expect(error.message).toContain(status);
    expect(error.message).toContain("cgt-1");
    expect(stub.calls).toHaveLength(2);   // create + the one poll that ended the task
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("retries a transient 5xx while polling, then gives up after five in a row", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" }), ...Array.from({ length: 5 }, () => new Response("", { status: 502 }))]);
    const error = await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps()));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/502/);
    // The status survives the wrapper: it is the field a caller classifies on.
    expect((error as ApiError).status).toBe(502);
    // Giving up on the polls says nothing about the task: it is paid for, so the
    // error still has to name it and say how to resume it.
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect(error.message).toContain("cgt-1");
    expect(error.message).toMatch(/video status cgt-1/);
    expect((error as ApiError).code).toBe("PollFailed");
    // The counter reached exactly five: create + five polls, and no sixth.
    expect(stub.calls).toHaveLength(6);
    expect(stub.calls.filter((c) => c.method === "GET")).toHaveLength(5);
    expect(error.message).toMatch(/5 failures in a row/);
  });

  it("does not retry a 401 while polling", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" }), new Response("", { status: 401 }), new Response("", { status: 401 })]);
    await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps()));
    expect(stub.calls).toHaveLength(2);   // create + one poll
  });

  it("propagates an unknown status instead of polling until the budget dies", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" }), jsonResponse({ status: "paused" }), jsonResponse({ status: "running" })]);
    const error = await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps()));
    expect(error.message).toMatch(/paused/);
    expect(stub.calls).toHaveLength(2);
    // The state is unknown but the task is paid for: the wrapped error carries the id
    // and the resume hint instead of leaving the id 30 minutes of scrollback behind.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect(error.message).toMatch(/video status cgt-1/);
  });

  it("keeps the task id on a poll whose 200 body will not parse", async () => {
    // A proxy's HTML page served as 200 is terminal, and it says nothing about a task
    // that is paid for and still running.
    const stub = scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const error = await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps()));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect(error.message).toContain("cgt-1");
    expect(error.message).toMatch(/video status cgt-1/);
    // The 200 the proxy answered with is carried through the wrapper too.
    expect((error as ApiError).status).toBe(200);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("sends the create to --base-url's origin when one is given", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" })]);
    await runVideoGenerate("a cat", { provider: "volcengine", baseUrl: "https://proxy.example.com", noWait: true }, deps());
    expect(stub.calls[0].url).toBe("https://proxy.example.com/api/v3/contents/generations/tasks");
  });

  it("creates nothing when the output directory cannot be made", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" })]);
    // A regular file in the way makes mkdir fail with ENOTDIR on every platform.
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const error = await rejection(
      runVideoGenerate("a cat", { provider: "volcengine", outDir: path.join(blocker, "out"), noWait: false }, deps()),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(path.join(blocker, "out"));
    expect(stub.calls).toHaveLength(0);
  });

  it("creates nothing when no API key can be resolved", async () => {
    const stub = scriptedFetch([jsonResponse({ id: "cgt-1" })]);
    const error = await rejection(
      runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps(), {}),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/no API key found for provider "volcengine"/);
    expect(stub.calls).toHaveLength(0);
  });

  it("names the task id when the finished clip cannot be saved", async () => {
    // The task is paid for; re-running generate would pay twice, so the failure
    // has to hand back the one thing that resumes it.
    scriptedFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "succeeded", content: { video_url: "https://cdn/v.mp4" } }),
      new Response("", { status: 500 }),
    ]);
    const error = await rejection(runVideoGenerate("a cat", { provider: "volcengine", noWait: false }, deps()));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect(error.message).toContain("cgt-1");
    expect(error.message).toContain("status 500");
  });
});

describe("runVideoStatus", () => {
  it("asks exactly once, downloads nothing and creates no directory while running", async () => {
    const stub = scriptedFetch([jsonResponse({ status: "running" })]);
    const untouched = path.join(tempDir, "never-created");

    const result = await runVideoStatus("cgt-1", { provider: "volcengine", outDir: untouched });

    expect(result).toMatchObject({ taskId: "cgt-1", status: "running", saved: [] });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("GET");
    // Nothing was written, so the out-dir must not appear as a side effect of asking.
    expect(fs.existsSync(untouched)).toBe(false);
  });

  it("downloads the clip and names the file after the model the server reported", async () => {
    scriptedFetch([
      // A model id config.toml has never heard of: the echo is not validated against
      // `models`, so this is the only way the assertion below can tell the two sources
      // apart. With the echo equal to the configured default it would pass either way.
      jsonResponse({
        status: "succeeded",
        model: "doubao-seedance-9-9-999999",
        content: { video_url: "https://cdn/v.mp4" },
        duration: 5,
      }),
      videoBytes(),
    ]);

    // The binding's model is whatever config.toml defaults to — the id decides which
    // task ran, so the name on disk must follow the server's echo, not the config.
    const result = await runVideoStatus("cgt-1", { provider: "volcengine" });

    expect(result.status).toBe("succeeded");
    expect(result.saved).toHaveLength(1);
    expect(path.basename(result.saved[0].path)).toContain("doubao-seedance-9-9-999999");
  });

  it("does not retry a transient poll failure: one request, one error", async () => {
    const stub = scriptedFetch([new Response("", { status: 502 })]);

    const error = await rejection(runVideoStatus("cgt-1", { provider: "volcengine" }));

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).taskId).toBe("cgt-1");
    expect((error as ApiError).status).toBe(502);
    expect(error.message).toMatch(/502/);
    expect(stub.calls).toHaveLength(1);
  });

  it.each(["failed", "cancelled", "expired"])(
    "raises a terminal %s with the task id",
    async (status) => {
      scriptedFetch([jsonResponse({ status, error: { code: "X", message: "vendor says no" } })]);

      const error = await rejection(runVideoStatus("cgt-1", { provider: "volcengine" }));

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).taskId).toBe("cgt-1");
      expect(error.message).toContain("vendor says no");
    },
  );

  it("rejects an empty task id without asking the provider", async () => {
    const stub = scriptedFetch([jsonResponse({ status: "running" })]);

    const error = await rejection(runVideoStatus("   ", { provider: "volcengine" }));

    expect(error).toBeInstanceOf(UsageError);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a task id it cannot look up without inventing a state", async () => {
    scriptedFetch([new Response("", { status: 404 })]);

    const error = await rejection(runVideoStatus("cgt-1", { provider: "volcengine" }));

    expect(error.message).toMatch(/--provider/);
  });
});

/**
 * The same pipeline through the other dialect. Everything ark-specific about the wire
 * (top-level `id`, `content.video_url`) differs here (`task_id`, `task.content.url`),
 * so this is the test that proves the seam is a seam and not an ark-shaped hole.
 */
describe("runVideoGenerate over the minimax dialect", () => {
  const MINIMAX_CREATE_URL = "https://api.minimax.io/v2/video_generation";
  const MINIMAX_POLL_URL = "https://api.minimax.io/v2/query/video_generation/cgt-mm-1";

  it("creates, polls and downloads through the nested minimax envelope", async () => {
    const stub = scriptedFetch([
      jsonResponse({ task_id: "cgt-mm-1" }),
      jsonResponse({ task: { status: "queued" } }),
      jsonResponse({
        task: {
          status: "succeeded",
          model: "MiniMax-H3",
          content: { url: "https://cdn/v.mp4" },
          duration: 5,
          resolution: "768P",
        },
      }),
      videoBytes(),
    ]);

    const result = await runVideoGenerate(
      "a cat",
      { provider: "minimax", noWait: false },
      deps(),
      { MINIMAX_API_KEY: "sk-mm-1" },
    );

    expect(result.status).toBe("succeeded");
    expect(result.saved).toHaveLength(1);
    expect(path.basename(result.saved[0].path)).toMatch(/^minimax-minimax-h3-.*-0\.mp4$/);
    expect(stub.calls[0]).toMatchObject({ url: MINIMAX_CREATE_URL, method: "POST" });
    expect(stub.calls[1]).toMatchObject({ url: MINIMAX_POLL_URL, method: "GET" });
    // The create body filled the two fields this vendor requires and defaulted neither
    // silently: 768P and 5 s are the adapter's documented defaults.
    expect(stub.calls[0].body).toMatchObject({ resolution: "768P", duration: 5 });
  });

  it("stops at the budget with the task id, exactly like ark", async () => {
    const stub = scriptedFetch([jsonResponse({ task_id: "cgt-mm-1" }), jsonResponse({ task: { status: "running" } })]);

    const error = await rejection(
      runVideoGenerate(
        "a cat",
        { provider: "minimax", noWait: false },
        deps({ step: 16 * 60_000 }),
        { MINIMAX_API_KEY: "sk-mm-1" },
      ),
    );

    expect((error as ApiError).code).toBe("TaskNotFinished");
    expect((error as ApiError).taskId).toBe("cgt-mm-1");
    expect(stub.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("returns the task id without polling under --no-wait", async () => {
    const stub = scriptedFetch([jsonResponse({ task_id: "cgt-mm-1" })]);

    const result = await runVideoGenerate(
      "a cat",
      { provider: "minimax", noWait: true },
      deps(),
      { MINIMAX_API_KEY: "sk-mm-1" },
    );

    expect(result).toMatchObject({ taskId: "cgt-mm-1", status: "pending", saved: [] });
    expect(stub.calls).toHaveLength(1);
  });
});

