import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authPath } from "./auth.js";
import { configDir } from "./config.js";

/**
 * The isolation itself is the thing under test: if vitest.sandbox.ts stops
 * running, every other test file silently starts reading the developer's real
 * ~/.config/mediagen again.
 */
describe("test sandbox", () => {
  it("points config lookups at a throwaway directory", () => {
    expect(configDir().startsWith(os.tmpdir())).toBe(true);
    expect(configDir()).not.toBe(path.join(os.userInfo().homedir, ".config", "mediagen"));
  });

  it("puts the API key store in a throwaway state directory", () => {
    expect(authPath().startsWith(os.tmpdir())).toBe(true);
    expect(path.dirname(authPath())).not.toBe(configDir());
  });

  it("redirects HOME, so os.homedir() never names the real home", () => {
    expect(os.homedir()).not.toBe(os.userInfo().homedir);
  });
});
