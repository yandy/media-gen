import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configDir,
  configPath,
  ensureConfigFile,
  loadConfig,
  prepareConfigFile,
  resolveProvider,
  type MediagenConfig,
} from "./config.js";
import { ConfigError } from "./errors.js";

const originalEnv = {
  MEDIAGEN_CLI_CONFIG_DIR: process.env.MEDIAGEN_CLI_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  HOME: process.env.HOME,
};

let tempDir: string;

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(tempDir, "config.toml"), toml);
}

function emptyConfig(): MediagenConfig {
  return { default_provider: "dashscope", output_dir: process.cwd(), providers: {} };
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-cli-config-"));
  process.env.MEDIAGEN_CLI_CONFIG_DIR = tempDir;
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
  it("honors MEDIAGEN_CLI_CONFIG_DIR", () => {
    expect(configDir()).toBe(tempDir);
    expect(configPath()).toBe(path.join(tempDir, "config.toml"));
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    delete process.env.MEDIAGEN_CLI_CONFIG_DIR;
    const xdgHome = path.join(tempDir, "xdg");
    process.env.XDG_CONFIG_HOME = xdgHome;

    expect(configDir()).toBe(path.join(xdgHome, "mediagen-cli"));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.MEDIAGEN_CLI_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    const home = path.join(tempDir, "home");
    process.env.HOME = home;

    expect(configDir()).toBe(path.join(home, ".config", "mediagen-cli"));
  });
});

describe("loadConfig", () => {
  it("creates nothing on its own", () => {
    expect(fs.existsSync(configPath())).toBe(false);

    const config = loadConfig();

    expect(fs.existsSync(configPath())).toBe(false);
    expect(config.default_provider).toBe("");
    expect(config.providers).toEqual({});
  });

  it("never overwrites an existing config.toml", () => {
    writeConfig('default_provider = "mine"\n[providers.mine]\n');

    expect(loadConfig().default_provider).toBe("mine");
    expect(fs.readFileSync(configPath(), "utf8")).toBe(
      'default_provider = "mine"\n[providers.mine]\n',
    );
  });

  it("leaves default_provider empty when config.toml does not set it", () => {
    writeConfig('[providers.qwen]\nbase_url = "https://x"\n');

    const config = loadConfig();

    expect(config.default_provider).toBe("");
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
    const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-cli-cwd-")));
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

describe("prepareConfigFile", () => {
  it("writes the seed config and reads it back", () => {
    expect(fs.existsSync(configPath())).toBe(false);

    prepareConfigFile();

    expect(fs.existsSync(configPath())).toBe(true);
    const config = loadConfig();
    expect(config.default_provider).toBe("volcengine");
    expect(Object.keys(config.providers).sort()).toEqual(["dashscope", "volcengine"]);
    expect(config.providers.volcengine).toEqual({
      api_type: "ark",
      base_url: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-seedream-5-0-flash-260915",
      api_key_env: "ARK_API_KEY",
    });
  });

  it("seeds a layout where only qwen needs an edit", () => {
    ensureConfigFile();
    const text = fs.readFileSync(configPath(), "utf8");

    expect(text).toContain('default_provider = "volcengine"');
    expect(text).toContain('base_url = "https://ark.cn-beijing.volces.com/api/v3"');
    expect(text).toContain(
      'base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"',
    );
    expect(text).not.toMatch(/^path\s*=/m);
    expect(text).not.toMatch(/^output_dir\s*=/m);
  });

  it("validates an existing file and leaves its bytes alone", () => {
    writeConfig('default_provider = "mine"\n');

    prepareConfigFile();

    expect(fs.readFileSync(configPath(), "utf8")).toBe('default_provider = "mine"\n');
  });
});

describe("ensureConfigFile", () => {
  it("throws a ConfigError naming the path and the remedy when the seed cannot be written", () => {
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "");
    const blockedDir = path.join(blocker, "config");
    process.env.MEDIAGEN_CLI_CONFIG_DIR = blockedDir;

    const error = thrownBy(() => ensureConfigFile());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(path.join(blockedDir, "config.toml"));
    expect(error.message).toMatch(/ENOTDIR|EACCES|EROFS|ENOSPC/);
    expect(error.message).toContain("MEDIAGEN_CLI_CONFIG_DIR");
  });

  it("does nothing when config.toml already exists", () => {
    writeConfig('default_provider = "mine"\n');

    ensureConfigFile();

    expect(fs.readFileSync(configPath(), "utf8")).toBe('default_provider = "mine"\n');
  });

  it("removes the truncated file and reports the errno when the write fails after the create", () => {
    const blockedDir = path.join(tempDir, "config");
    process.env.MEDIAGEN_CLI_CONFIG_DIR = blockedDir;
    const file = path.join(blockedDir, "config.toml");

    // A real ENOSPC/EDQUOT needs a full or quota-capped filesystem, so the one
    // failure shape that leaves a file behind is simulated: open succeeded, the
    // write threw. A truncated seed parses as a valid config with no providers,
    // which is the state this whole bootstrap change exists to eliminate.
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      realWrite(target, typeof data === "string" ? data.slice(0, 240) : data, options);
      const error = new Error("no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }) as typeof fs.writeFileSync);

    try {
      const error = thrownBy(() => ensureConfigFile());

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain(file);
      expect(error.message).toContain("ENOSPC");
    } finally {
      spy.mockRestore();
    }

    // The half-written seed must not survive: the next run would read it as
    // "no providers configured" and never rewrite it.
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("resolveProvider", () => {
  it("resolves a provider declared in config.toml without inventing a path", () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com/api/v3"\nmodel = "some-model"\n',
    );

    expect(resolveProvider("my-proxy", loadConfig())).toEqual({
      name: "my-proxy",
      api_type: "ark",
      base_url: "https://proxy.example.com/api/v3",
      model: "some-model",
    });
  });

  it("throws ConfigError naming the file when a provider omits api_type", () => {
    writeConfig('[providers.qwen]\nbase_url = "https://x"\nmodel = "m"\n');

    const error = thrownBy(() => resolveProvider("qwen", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("api_type");
    expect(error.message).toContain("config.toml");
  });

  it("throws ConfigError when default_provider is empty", () => {
    writeConfig("");

    const error = thrownBy(() => resolveProvider("", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("default_provider");
  });

  it("ignores a leftover path key, which no longer means anything", () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com/api/v3"\nmodel = "m"\npath = "/custom/images"\n',
    );

    expect(resolveProvider("my-proxy", loadConfig())).not.toHaveProperty("path");
  });

  it("throws ConfigError naming api_type when a provider omits it", () => {
    writeConfig(
      '[providers.my-proxy]\nbase_url = "https://proxy.example.com"\nmodel = "some-model"\n',
    );

    const error = thrownBy(() => resolveProvider("my-proxy", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("api_type");
  });

  it("names every missing field for an incomplete provider", () => {
    writeConfig("[providers.my-proxy]\n");

    const error = thrownBy(() => resolveProvider("my-proxy", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("api_type");
    expect(error.message).toContain("base_url");
    expect(error.message).toContain("model");
  });

  it("rejects a base_url that is not an absolute http(s) URL", () => {
    writeConfig(
      '[providers.qwen]\napi_type = "qwen"\nbase_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"\nmodel = "m"\n',
    );

    const error = thrownBy(() => resolveProvider("qwen", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("base_url");
    expect(error.message).toContain("workspace-id");
    expect(error.message).toContain("config.toml");
  });

  it("strips trailing slashes from base_url", () => {
    writeConfig(
      '[providers.p]\napi_type = "ark"\nbase_url = "https://proxy.example.com/api/v3/"\nmodel = "m"\n',
    );

    expect(resolveProvider("p", loadConfig()).base_url).toBe("https://proxy.example.com/api/v3");
  });

  it("rejects a base_url carrying a query string or fragment", () => {
    writeConfig(
      '[providers.p]\napi_type = "ark"\nbase_url = "https://proxy.example.com/api/v3?x=1"\nmodel = "m"\n',
    );

    expect(thrownBy(() => resolveProvider("p", loadConfig()))).toBeInstanceOf(ConfigError);
  });

  it("rejects an empty base_url", () => {
    writeConfig('[providers.p]\napi_type = "ark"\nbase_url = ""\nmodel = "m"\n');

    const error = thrownBy(() => resolveProvider("p", loadConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("base_url");
  });

  it("throws ConfigError pointing at config.toml for an unknown provider", () => {
    const error = thrownBy(() => resolveProvider("nope", emptyConfig()));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("config add");
    expect(error.message).toContain("config.toml");
  });
});
