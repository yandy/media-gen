import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authPath,
  loadAuth,
  maskKey,
  removeApiKey,
  resolveApiKey,
  saveApiKey,
} from "../src/auth.js";
import { ConfigError } from "../src/errors.js";
import type { ProviderConfig } from "../src/types.js";

const originalEnv = {
  MEDIAGEN_CLI_CONFIG_DIR: process.env.MEDIAGEN_CLI_CONFIG_DIR,
  MEDIAGEN_CLI_STATE_DIR: process.env.MEDIAGEN_CLI_STATE_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  HOME: process.env.HOME,
};

let tempDir: string;

function qwen(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "dashscope",
    api_type: "openai",
    base_url: "https://dashscope.aliyuncs.com",
    api_key_env: "DASHSCOPE_API_KEY",
    ...overrides,
  };
}

function ark(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "volcengine",
    api_type: "ark",
    base_url: "https://ark.cn-beijing.volces.com",
    api_key_env: "ARK_API_KEY",
    ...overrides,
  };
}

function withoutApiKeyEnv(provider: ProviderConfig): ProviderConfig {
  const { api_key_env: _ignored, ...rest } = provider;
  return rest;
}

function proxy(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "my-proxy",
    api_type: "ark",
    base_url: "https://proxy.example.com",
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

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-cli-auth-"));
  process.env.MEDIAGEN_CLI_CONFIG_DIR = path.join(tempDir, "config");
  process.env.MEDIAGEN_CLI_STATE_DIR = path.join(tempDir, "state");
  fs.mkdirSync(path.join(tempDir, "state"), { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("authPath", () => {
  it("lives in the state directory, never next to the editable config", () => {
    expect(authPath()).toBe(path.join(tempDir, "state", "auth.json"));
    expect(authPath()).not.toContain(path.join(tempDir, "config"));
  });

  it("honors MEDIAGEN_CLI_STATE_DIR", () => {
    const state = path.join(tempDir, "elsewhere");
    process.env.MEDIAGEN_CLI_STATE_DIR = state;

    expect(authPath()).toBe(path.join(state, "auth.json"));
  });

  it("falls back to XDG_STATE_HOME", () => {
    delete process.env.MEDIAGEN_CLI_STATE_DIR;
    const xdgState = path.join(tempDir, "xdg-state");
    process.env.XDG_STATE_HOME = xdgState;

    expect(authPath()).toBe(path.join(xdgState, "mediagen", "auth.json"));
  });

  it("falls back to ~/.local/state", () => {
    delete process.env.MEDIAGEN_CLI_STATE_DIR;
    delete process.env.XDG_STATE_HOME;
    const home = path.join(tempDir, "home");
    process.env.HOME = home;

    expect(authPath()).toBe(
      path.join(home, ".local", "state", "mediagen", "auth.json"),
    );
  });
});

describe("loadAuth", () => {
  it("returns an empty store when the file is absent", () => {
    expect(fs.existsSync(authPath())).toBe(false);

    expect(loadAuth()).toEqual({ providers: {} });
  });

  it("reads stored providers", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ providers: { qwen: { api_key: "sk-stored" } } }));

    expect(loadAuth()).toEqual({ providers: { qwen: { api_key: "sk-stored" } } });
  });

  it("throws ConfigError naming the path for corrupt JSON", () => {
    fs.writeFileSync(authPath(), "{not json");

    const error = thrownBy(() => loadAuth());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(authPath());
  });

  it("never echoes auth.json contents when the JSON is malformed", () => {
    const secret = "sk-supersecretvalue-0123456789";
    // An unquoted value: V8 quotes a slice of the document around the token.
    fs.writeFileSync(authPath(), `{"providers":{"qwen":{"api_key": ${secret}}}}`);

    const error = thrownBy(() => loadAuth());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("invalid JSON");
    expect(error.message).toContain(authPath());
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(secret.slice(0, 10));
    expect(error.message).not.toContain("api_key");
    expect(error.message).toMatch(/mediagen login/);
  });

  it("keeps a numeric locator for a malformed auth.json", () => {
    fs.writeFileSync(authPath(), '{"providers": {"qwen": "x"},}');

    const error = thrownBy(() => loadAuth());

    expect(error.message).toContain("(position 28)");
    expect(error.message).not.toContain("providers");
  });

  it("names the errno code, and no file bytes, when auth.json cannot be read", () => {
    fs.mkdirSync(authPath(), { recursive: true });

    const error = thrownBy(() => loadAuth());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(authPath());
    expect(error.message).toMatch(/EISDIR/);
  });

  it("throws ConfigError naming the path when the JSON shape is wrong", () => {
    fs.writeFileSync(authPath(), "[]");

    const error = thrownBy(() => loadAuth());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(authPath());
  });

  it("throws ConfigError when a provider entry lacks a string api_key", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ providers: { qwen: { token: "x" } } }));

    const error = thrownBy(() => loadAuth());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("qwen");
    expect(error.message).toContain(authPath());
  });
});

describe("saveApiKey", () => {
  it("writes auth.json with mode 0600 and stores the key", () => {
    saveApiKey("qwen", "sk-qwen-1234");

    expect(fs.statSync(authPath()).mode & 0o777).toBe(0o600);
    expect(loadAuth().providers.qwen).toEqual({ api_key: "sk-qwen-1234" });
  });

  it("creates the state dir with mode 0700 and the key file with 0600", () => {
    const nested = path.join(tempDir, "nested", "state");
    process.env.MEDIAGEN_CLI_STATE_DIR = nested;

    saveApiKey("qwen", "sk-qwen-1234");

    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(nested, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("preserves keys for other providers", () => {
    saveApiKey("qwen", "sk-qwen-1234");
    saveApiKey("ark", "sk-ark-5678");

    expect(loadAuth().providers).toEqual({
      qwen: { api_key: "sk-qwen-1234" },
      ark: { api_key: "sk-ark-5678" },
    });
  });

  it("overwrites the key for the same provider", () => {
    saveApiKey("qwen", "sk-old-0000");
    saveApiKey("qwen", "sk-new-1111");

    expect(loadAuth().providers).toEqual({ qwen: { api_key: "sk-new-1111" } });
  });

  it("leaves no temporary files behind", () => {
    saveApiKey("qwen", "sk-qwen-1234");

    expect(fs.readdirSync(path.dirname(authPath()))).toEqual(["auth.json"]);
  });
});

describe("removeApiKey", () => {
  it("returns true when a key was removed and false the second time", () => {
    saveApiKey("qwen", "sk-qwen-1234");
    saveApiKey("ark", "sk-ark-5678");

    expect(removeApiKey("qwen")).toBe(true);
    expect(loadAuth().providers).toEqual({ ark: { api_key: "sk-ark-5678" } });

    expect(removeApiKey("qwen")).toBe(false);
  });

  it("returns false for an absent file without throwing", () => {
    expect(fs.existsSync(authPath())).toBe(false);

    expect(removeApiKey("qwen")).toBe(false);
  });
});

describe("maskKey", () => {
  it("shows the first four and last four characters separated by an ellipsis", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-1…cdef");
    expect(maskKey("123456789012")).toBe("1234…9012");
  });

  it("never returns the full key", () => {
    const keys = [
      "a",
      "short",
      "12345678901",
      "123456789012",
      "sk-1234567890abcdef",
      "x".repeat(200),
    ];

    for (const key of keys) {
      expect(maskKey(key)).not.toBe(key);
    }
  });

  it("collapses keys shorter than 12 characters to ***", () => {
    expect(maskKey("short")).toBe("***");
    expect(maskKey("12345678901")).toBe("***");
    expect(maskKey("")).toBe("***");
  });
});

describe("resolveApiKey", () => {
  it("prefers the flag key over env and auth", () => {
    saveApiKey("dashscope", "sk-auth-aaaa");

    const resolved = resolveApiKey(qwen(), "sk-flag-cccc", { DASHSCOPE_API_KEY: "sk-env-bbbb" });

    expect(resolved).toEqual({ key: "sk-flag-cccc", source: "flag" });
  });

  it("treats an empty flag key as absent", () => {
    const resolved = resolveApiKey(qwen(), "", { DASHSCOPE_API_KEY: "sk-env-bbbb" });

    expect(resolved).toEqual({ key: "sk-env-bbbb", source: "env" });
  });

  it("reads the provider's configured api_key_env", () => {
    const resolved = resolveApiKey(proxy({ api_key_env: "MY_PROXY_KEY" }), undefined, {
      MY_PROXY_KEY: "sk-custom-dddd",
    });

    expect(resolved).toEqual({ key: "sk-custom-dddd", source: "env" });
  });

  it("never reads a built-in env var for a provider that declares no api_key_env", () => {
    const legacy = withoutApiKeyEnv(qwen({ name: "qwen" }));

    const resolved = resolveApiKey(legacy, undefined, { DASHSCOPE_API_KEY: "sk-qwen-builtin" });

    expect(resolved).toBeNull();
  });

  it("still falls back to auth.json when the provider names no api_key_env", () => {
    saveApiKey("dashscope", "sk-auth-aaaa");

    const resolved = resolveApiKey(withoutApiKeyEnv(qwen()), undefined, {});

    expect(resolved).toEqual({ key: "sk-auth-aaaa", source: "auth" });
  });

  it("prefers env over auth.json", () => {
    saveApiKey("dashscope", "sk-auth-aaaa");

    const resolved = resolveApiKey(qwen(), undefined, { DASHSCOPE_API_KEY: "sk-env-bbbb" });

    expect(resolved).toEqual({ key: "sk-env-bbbb", source: "env" });
  });

  it("falls back to auth.json when no flag or env key is available", () => {
    saveApiKey("dashscope", "sk-auth-aaaa");

    const resolved = resolveApiKey(qwen(), undefined, {});

    expect(resolved).toEqual({ key: "sk-auth-aaaa", source: "auth" });
  });

  it("treats an empty env value as absent", () => {
    saveApiKey("dashscope", "sk-auth-aaaa");

    const resolved = resolveApiKey(qwen(), undefined, { DASHSCOPE_API_KEY: "" });

    expect(resolved).toEqual({ key: "sk-auth-aaaa", source: "auth" });
  });

  it("returns null when nothing is available", () => {
    expect(resolveApiKey(qwen(), undefined, {})).toBeNull();
    expect(resolveApiKey(proxy(), undefined, {})).toBeNull();
  });
});
