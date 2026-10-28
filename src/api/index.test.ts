import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import type { Dialect } from "../types.js";
import { ArkDialect, ArkVideoDialect } from "./ark.js";
import { adapterPath, getAdapter } from "./index.js";
import { QwenDialect } from "./qwen.js";

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the action to throw, but it returned normally");
}

describe("the dashscope dialect", () => {
  it("serves image from the native multimodal endpoint", () => {
    expect(getAdapter("dashscope", "image").createPath).toBe(
      "/api/v1/services/aigc/multimodal-generation/generation",
    );
  });

  it("has no video adapter", () => {
    expect(() => getAdapter("dashscope", "video")).toThrow(/no "video" adapter/);
  });
});

describe("getAdapter", () => {
  it("returns the dialect's image adapter", () => {
    expect(getAdapter("openai", "image")).toBe(QwenDialect);
    expect(getAdapter("ark", "image")).toBe(ArkDialect);
  });

  it("returns the dialect's video adapter", () => {
    expect(getAdapter("ark", "video")).toBe(ArkVideoDialect);
  });

  it("gives each image adapter a path that starts at the origin's version segment", () => {
    expect(getAdapter("ark", "image").createPath).toBe("/api/v3/images/generations");
    expect(getAdapter("openai", "image").createPath).toBe(
      "/compatible-mode/v1/images/generations",
    );
  });

  it("names the implemented tasks when the dialect has no adapter for the task", () => {
    const error = thrownBy(() => getAdapter("dashscope", "video"));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(
      'the "dashscope" dialect has no "video" adapter; implemented tasks: image',
    );
  });

  it("throws ConfigError naming the bad api_type and the allowed set", () => {
    const error = thrownBy(() => getAdapter("nope" as Dialect, "image"));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("nope");
    expect(error.message).toContain("openai");
    expect(error.message).toContain("ark");
  });

  for (const inheritedKey of ["toString", "__proto__", "constructor"]) {
    it(`does not resolve the inherited object key ${inheritedKey} to a dialect`, () => {
      const error = thrownBy(() => getAdapter(inheritedKey as Dialect, "image"));

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain(inheritedKey);
    });
  }
});

describe("adapterPath", () => {
  it("returns the path for an implemented dialect and task", () => {
    expect(adapterPath("ark", "image")).toBe("/api/v3/images/generations");
    expect(adapterPath("ark", "video")).toBe("/api/v3/contents/generations/tasks");
    expect(adapterPath("openai", "image")).toBe("/compatible-mode/v1/images/generations");
  });

  it("returns undefined instead of throwing, so a half-written config can still be shown", () => {
    expect(adapterPath("dashscope", "video")).toBeUndefined();
    expect(adapterPath("nope", "image")).toBeUndefined();
    expect(adapterPath("toString", "image")).toBeUndefined();
  });
});
