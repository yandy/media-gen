import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "./errors.js";
import { isUrl, nowStamp, slugModel, toImageInput } from "./util.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

let tempDir: string;

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the action to throw, but it returned normally");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-util-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("isUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isUrl("https://x/y.png")).toBe(true);
    expect(isUrl("http://x/y.png")).toBe(true);
    expect(isUrl("HTTPS://X/Y.PNG")).toBe(true);
  });

  it("rejects local paths, data URLs, and other schemes", () => {
    expect(isUrl("./x.png")).toBe(false);
    expect(isUrl("/tmp/x.png")).toBe(false);
    expect(isUrl("data:image/png;base64,AA")).toBe(false);
    expect(isUrl("ftp://x/y.png")).toBe(false);
  });
});

describe("toImageInput", () => {
  it("passes URLs through untouched", () => {
    expect(toImageInput("https://x/y.png")).toBe("https://x/y.png");
    expect(toImageInput("http://x/y.png")).toBe("http://x/y.png");
  });

  it("passes data URLs through untouched", () => {
    const dataUrl = "data:image/png;base64,AA";
    expect(toImageInput(dataUrl)).toBe(dataUrl);
  });

  it("encodes a local png as a data URL with matching bytes", () => {
    const file = path.join(tempDir, "photo.png");
    fs.writeFileSync(file, PNG_BYTES);

    const result = toImageInput(file);

    expect(result.startsWith("data:image/png;base64,")).toBe(true);
    const base64 = result.slice("data:image/png;base64,".length);
    expect(Buffer.from(base64, "base64")).toEqual(PNG_BYTES);
  });

  it("maps extensions case-insensitively", () => {
    const file = path.join(tempDir, "PHOTO.JPEG");
    fs.writeFileSync(file, PNG_BYTES);

    expect(toImageInput(file).startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("throws a UsageError naming the path when the file is missing", () => {
    const file = path.join(tempDir, "does-not-exist.png");

    const error = thrownBy(() => toImageInput(file));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(file);
  });

  it("throws a UsageError naming the path and extension when unsupported", () => {
    const file = path.join(tempDir, "notes.txt");
    fs.writeFileSync(file, "hello");

    const error = thrownBy(() => toImageInput(file));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain(file);
    expect(error.message).toContain(".txt");
  });
});

describe("nowStamp", () => {
  it("formats local time as yyyyMMdd-HHmmss with zero padding", () => {
    expect(nowStamp(new Date(2026, 9, 24, 15, 4, 5))).toBe("20261024-150405");
    expect(nowStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
  });

  it("defaults to the current time", () => {
    expect(nowStamp()).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe("slugModel", () => {
  it("leaves an already-slugged model untouched", () => {
    expect(slugModel("doubao-seedream-5-0-flash-260915")).toBe(
      "doubao-seedream-5-0-flash-260915",
    );
  });

  it("lowercases and collapses non-alphanumerics to single dashes", () => {
    expect(slugModel("Qwen Image 3.0")).toBe("qwen-image-3-0");
    expect(slugModel("__Qwen//Image..3.0__")).toBe("qwen-image-3-0");
  });
});
