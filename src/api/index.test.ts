import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import type { Dialect } from "../types.js";
import { ArkDialect } from "./ark.js";
import { getDialect } from "./index.js";
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

describe("getDialect", () => {
  it("returns the qwen adapter for api_type qwen", () => {
    expect(getDialect("qwen")).toBe(QwenDialect);
  });

  it("returns the ark adapter for api_type ark", () => {
    expect(getDialect("ark")).toBe(ArkDialect);
  });

  it("throws ConfigError naming the bad value and the allowed set", () => {
    const error = thrownBy(() => getDialect("nope" as Dialect));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("nope");
    expect(error.message).toContain("qwen");
    expect(error.message).toContain("ark");
  });

  for (const inheritedKey of ["toString", "__proto__", "constructor"]) {
    it(`does not resolve the inherited object key ${inheritedKey} to an adapter`, () => {
      const error = thrownBy(() => getDialect(inheritedKey as Dialect));

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain(inheritedKey);
    });
  }
});
