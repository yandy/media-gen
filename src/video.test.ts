import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArkVideoDialect } from "./api/ark.js";
import { UsageError } from "./errors.js";
import type { AsyncTaskAdapter } from "./types.js";
import { buildVideoRequest, validateResolution } from "./video.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

const arkAdapter = ArkVideoDialect;

/**
 * Stand-in for `MinimaxVideoDialect`, which does not exist yet: the same shape,
 * its own tiers, and none of ark's exclusive fields. Task 8 deletes it and
 * imports the real adapter instead.
 */
const minimaxAdapter: AsyncTaskAdapter = {
  ...arkAdapter,
  dialect: "minimax",
  createPath: "/v2/video_generation",
  resolutions: ["480p", "768p", "2k"],
  exclusiveFields: [],
};

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-video-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("validateResolution", () => {
  it("normalizes the resolution case and rejects a tier the dialect does not have", () => {
    expect(validateResolution("720P", "ark", arkAdapter)).toBe("720p");
    expect(() => validateResolution("768p", "ark", arkAdapter)).toThrow(/768p/);
    expect(validateResolution("2K", "minimax", minimaxAdapter)).toBe("2k");
    expect(() => validateResolution("1080p", "minimax", minimaxAdapter)).toThrow(/1080p/);
  });

  it("rejects a resolution that is a bare number or a pixel pair", () => {
    expect(() => validateResolution("720", "ark", arkAdapter)).toThrow(UsageError);
    expect(() => validateResolution("1024x1024", "ark", arkAdapter)).toThrow(UsageError);
  });

  it("names the dialect and the tiers it accepts, and says who checks the model", () => {
    expect(() => validateResolution("768p", "ark", arkAdapter)).toThrow(
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

  it("copies only the flags the caller set, so the wire body stays clean", () => {
    expect(buildVideoRequest("a cat", { noWait: false }, "m", arkAdapter)).toEqual({
      model: "m",
      prompt: "a cat",
    });
  });
});
