import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configDir,
  configPath,
  loadConfig,
  resolveProvider,
  type MediaConfig,
} from "./config.js";
import { ConfigError } from "./errors.js";

const originalEnv = {
  MEDIA_CLI_CONFIG_DIR: process.env.MEDIA_CLI_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  HOME: process.env.HOME,
};

let tempDir: string;

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(tempDir, "config.toml"), toml);
}

function emptyConfig(): MediaConfig {
  return { default_provider: "qwen", output_dir: process.cwd(), providers: {} };
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-cli-config-"));
  process.env.MEDIA_CLI_CONFIG_DIR = tempDir;
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

describe("configDir", () => {
  it("honors MEDIA_CLI_CONFIG_DIR", () => {
    expect(configDir()).toBe(tempDir);
    expect(configPath()).toBe(path.join(tempDir, "config.toml"));
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    delete process.env.MEDIA_CLI_CONFIG_DIR;
    const xdgHome = path.join(tempDir, "xdg");
    process.env.XDG_CONFIG_HOME = xdgHome;

    expect(configDir()).toBe(path.join(xdgHome, "media-cli"));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.MEDIA_CLI_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    const home = path.join(tempDir, "home");
    process.env.HOME = home;

    expect(configDir()).toBe(path.join(home, ".config", "media-cli"));
  });
});

describe("loadConfig", () => {
  it("returns the documented defaults when the config file is missing", () => {
    expect(fs.existsSync(configPath())).toBe(false);

    expect(loadConfig()).toEqual({
      default_provider: "qwen",
      output_dir: process.cwd(),
      providers: {},
    });
  });

  it("parses provider overrides and keeps default_provider at qwen", () => {
    writeConfig('[providers.qwen]\nbase_url = "https://x"\n');

    const config = loadConfig();

    expect(config.default_provider).toBe("qwen");
    expect(config.providers.qwen.base_url).toBe("https://x");
    expect(config.providers.qwen.model).toBeUndefined();
  });

  it("reads default_provider and output_dir from TOML", () => {
    writeConfig('default_provider = "ark"\noutput_dir = "/tmp/media-output"\n');

    const config = loadConfig();

    expect(config.default_provider).toBe("ark");
    expect(config.output_dir).toBe("/tmp/media-output");
    expect(config.providers).toEqual({});
  });

  it("computes the default output_dir at call time", () => {
    const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "media-cli-cwd-")));
    const originalCwd = process.cwd();
    try {
      process.chdir(otherDir);

      expect(loadConfig().output_dir).toBe(otherDir);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("wraps invalid TOML in a ConfigError naming the path", () => {
    writeConfig('[providers.qwen\nbase_url = "https://x"\n');

    const error = thrownBy(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(configPath());
  });

  it("never echoes config.toml contents when the TOML is malformed", () => {
    const secret = "sk-tomlsecretvalue-0123456789";
    // smol-toml quotes the source lines around the error in its message.
    writeConfig(`api_key = ${secret}\nbroken = \n`);

    const error = thrownBy(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("invalid TOML");
    expect(error.message).toContain(configPath());
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("api_key");
    expect(error.message).toMatch(/line \d+|position \d+/);
  });

  it("names the errno code, and no file bytes, when config.toml cannot be read", () => {
    fs.mkdirSync(configPath(), { recursive: true });

    const error = thrownBy(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(configPath());
    expect(error.message).toMatch(/EISDIR/);
  });

  it("rejects an unknown api_type at load time, naming provider and value", () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "openai"\nbase_url = "https://proxy.example.com"\nmodel = "some-model"\n',
    );

    const error = thrownBy(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("my-proxy");
    expect(error.message).toContain("openai");
  });
});

describe("resolveProvider", () => {
  it("returns the built-in qwen provider verbatim", () => {
    expect(resolveProvider("qwen", emptyConfig())).toEqual({
      name: "qwen",
      api_type: "qwen",
      base_url: "https://dashscope.aliyuncs.com",
      model: "qwen-image-3.0",
      path: "/compatible-mode/v1/images/generations",
      api_key_env: "DASHSCOPE_API_KEY",
      custom: false,
    });
  });

  it("returns the built-in ark provider verbatim", () => {
    expect(resolveProvider("ark", emptyConfig())).toEqual({
      name: "ark",
      api_type: "ark",
      base_url: "https://ark.cn-beijing.volces.com",
      model: "doubao-seedream-5-0-flash-260915",
      path: "/api/v3/images/generations",
      api_key_env: "ARK_API_KEY",
      custom: false,
    });
  });

  it("merges a base_url override over the built-in defaults", () => {
    writeConfig('[providers.qwen]\nbase_url = "https://mirror.example.com"\n');

    expect(resolveProvider("qwen", loadConfig())).toEqual({
      name: "qwen",
      api_type: "qwen",
      base_url: "https://mirror.example.com",
      model: "qwen-image-3.0",
      path: "/compatible-mode/v1/images/generations",
      api_key_env: "DASHSCOPE_API_KEY",
      custom: false,
    });
  });

  it("resolves a custom provider with the dialect default path", () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\nmodel = "some-model"\n',
    );

    expect(resolveProvider("my-proxy", loadConfig())).toEqual({
      name: "my-proxy",
      api_type: "ark",
      base_url: "https://proxy.example.com",
      model: "some-model",
      path: "/api/v3/images/generations",
      custom: true,
    });
  });

  it("lets config override the path of a custom provider", () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\nmodel = "some-model"\npath = "/custom/images"\n',
    );

    expect(resolveProvider("my-proxy", loadConfig()).path).toBe("/custom/images");
  });

  it("throws ConfigError naming api_type when a custom provider omits it", () => {
    writeConfig(
      '[providers.my-proxy]\nbase_url = "https://proxy.example.com"\nmodel = "some-model"\n',
    );

    const error = thrownBy(() => resolveProvider("my-proxy", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("api_type");
  });

  it("names every missing field for an incomplete custom provider", () => {
    writeConfig("[providers.my-proxy]\n");

    const error = thrownBy(() => resolveProvider("my-proxy", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("api_type");
    expect(error.message).toContain("base_url");
    expect(error.message).toContain("model");
  });

  it("throws ConfigError with login guidance for an unknown provider", () => {
    const error = thrownBy(() => resolveProvider("nope", emptyConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("media login");
    expect(error.message).toContain("config.toml");
  });
});
