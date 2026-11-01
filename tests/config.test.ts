import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configDir,
  configPath,
  DEFAULT_TIMEOUT_SECONDS,
  ensureConfigFile,
  loadConfig,
  MAX_TIMEOUT_SECONDS,
  prepareConfigFile,
  resolveSelection,
  stateDir,
  validateProviderShape,
  type TaskConfig,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

const originalEnv = {
  MEDIAGEN_CLI_CONFIG_DIR: process.env.MEDIAGEN_CLI_CONFIG_DIR,
  MEDIAGEN_CLI_STATE_DIR: process.env.MEDIAGEN_CLI_STATE_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  HOME: process.env.HOME,
};

let tempDir: string;

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(tempDir, "config.toml"), toml);
}

function emptyConfig(): TaskConfig {
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

    expect(configDir()).toBe(path.join(xdgHome, "mediagen"));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.MEDIAGEN_CLI_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    const home = path.join(tempDir, "home");
    process.env.HOME = home;

    expect(configDir()).toBe(path.join(home, ".config", "mediagen"));
  });

  it("names the config and state directories the same, so they cannot drift", () => {
    delete process.env.MEDIAGEN_CLI_CONFIG_DIR;
    delete process.env.MEDIAGEN_CLI_STATE_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, "xdg");
    process.env.XDG_STATE_HOME = path.join(tempDir, "xdg-state");

    expect(path.basename(configDir())).toBe(path.basename(stateDir()));
    expect(path.basename(configDir())).not.toMatch(/-cli$/);

    // The $HOME fallbacks are a second pair of literals: an edit that renames one
    // of them and not the other leaves two different directories behind.
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;

    expect(path.basename(configDir())).toBe(path.basename(stateDir()));
    expect(path.basename(configDir())).not.toMatch(/-cli$/);
  });
});

describe("loadConfig: the file itself", () => {
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
    expect(config.providers.qwen.tasks).toEqual({});
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
      '[providers.my-proxy]\napi_type = "gemini"\nbase_url = "https://proxy.example.com"\n\n[providers.my-proxy.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const error = thrownBy(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("my-proxy");
    expect(error.message).toContain("gemini");
  });
});

describe("prepareConfigFile", () => {
  it("writes the seed config and reads it back", () => {
    expect(fs.existsSync(configPath())).toBe(false);

    prepareConfigFile();

    expect(fs.existsSync(configPath())).toBe(true);
    const config = loadConfig();
    expect(config.default_provider).toBe("volcengine");
    expect(Object.keys(config.providers).sort()).toEqual(["aliyun", "minimax", "volcengine"]);
    expect(config.providers.volcengine).toEqual({
      base_url: "https://ark.cn-beijing.volces.com",
      api_key_env: "ARK_API_KEY",
      tasks: {
        // Two models on one provider is the point of the shape: no second entry.
        // The protocol is declared per task, so the account table holds none.
        image: {
          api_type: "ark",
          default: "doubao-seedream-5-0-flash-260915",
          models: ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"],
        },
        video: {
          api_type: "ark",
          default: "doubao-seedance-1-0-pro-250528",
          models: ["doubao-seedance-1-0-pro-250528"],
        },
      },
    });
  });

  it("seeds a layout that runs as written", () => {
    ensureConfigFile();
    const text = fs.readFileSync(configPath(), "utf8");

    expect(text).toContain('default_provider = "volcengine"');
    expect(text).toMatch(/^base_url\s*=\s*"https:\/\/ark\.cn-beijing\.volces\.com"$/m);
    // Alibaba is the native protocol on the public host: no placeholder to finish.
    expect(text).toMatch(/^base_url\s*=\s*"https:\/\/dashscope\.aliyuncs\.com"$/m);
    expect(text).not.toContain("<workspace-id>");
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

const TASK_CONFIG = `default_provider = "volcengine"

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]
default = "doubao-seedream-5-0-flash-260915"
models = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]

[providers.volcengine.video]
default = "doubao-seedance-1-0-pro"
models = ["doubao-seedance-1-0-pro"]

[providers.dashscope]
api_type = "qwen"
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"

[providers.dashscope.image]
default = "qwen-image-3.0"
models = ["qwen-image-3.0"]
`;

function taskConfig(toml: string = TASK_CONFIG): TaskConfig {
  writeConfig(toml);
  return loadConfig();
}

describe("loadConfig", () => {
  it("parses providers, tasks and models", () => {
    const config = taskConfig();

    expect(config.providers.volcengine.tasks.image).toEqual({
      default: "doubao-seedream-5-0-flash-260915",
      models: ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"],
    });
    expect(config.providers.volcengine.tasks.video?.default).toBe("doubao-seedance-1-0-pro");
    expect(config.providers.dashscope.api_key_env).toBeUndefined();
  });

  it("rejects a model on the provider table as an unknown key", () => {
    writeConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
model = "doubao-seedream-5-0-flash-260915"
`);

    // Models live on a task table now; there is no special-cased history here.
    expect(() => loadConfig()).toThrow(
      'unknown key "model" under [providers.volcengine]; ' +
        "expected api_type, base_url, api_key_env, image, video",
    );
  });

  it("reads a task's path override", () => {
    const config = taskConfig(`[providers.ark-plan]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.ark-plan.image]
default = "m"
models = ["m"]
path = "/images/generations"
`);

    expect(config.providers["ark-plan"].tasks.image?.path).toBe("/images/generations");
  });

  it("strips a trailing slash from a path, but leaves a bare slash alone", () => {
    const config = taskConfig(`[providers.ark-plan]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.ark-plan.image]
default = "m"
models = ["m"]
path = "/images/generations/"

[providers.ark-plan.video]
default = "m"
models = ["m"]
path = "/"
`);

    // A trailing slash would yield `/images/generations//{id}` once the id is
    // appended, so it is gone by the time the value is used.
    expect(config.providers["ark-plan"].tasks.image?.path).toBe("/images/generations");
    expect(config.providers["ark-plan"].tasks.video?.path).toBe("/");
  });

  it("rejects a path that is not absolute or carries a query", () => {
    for (const bad of ["images/generations", "/images/generations?x=1", "/a#b", ""]) {
      writeConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "m"
models = ["m"]
path = ${JSON.stringify(bad)}
`);

      expect(() => loadConfig()).toThrow(
        "path under [providers.p.image] must start with \"/\" and carry no query or fragment",
      );
    }
  });

  it("rejects an unknown key in a task table", () => {
    writeConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.volcengine.image]
model = "doubao-seedream-5-0-pro"
`);

    expect(() => loadConfig()).toThrow(
      'unknown key "model" under [providers.volcengine.image]; expected default, models, timeout_seconds',
    );
  });

  it("rejects an unknown key in a provider table", () => {
    writeConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
api_key = "sk-leaked"

[providers.volcengine.image]
default = "m"
models = ["m"]
`);

    expect(() => loadConfig()).toThrow(
      'unknown key "api_key" under [providers.volcengine]; expected api_type, base_url, api_key_env, image, video',
    );
  });

  it("lets a structural error in one provider block every command", () => {
    writeConfig(`${TASK_CONFIG}
[providers.broken]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.broken.image]
modles = ["typo"]
`);

    // The selected provider is fine, but the file is not: structure is checked
    // for every provider, exactly so one bad table cannot hide behind another.
    expect(() => loadConfig()).toThrow(/unknown key "modles"/);
  });

  it("names the known tasks when a task table is misspelled", () => {
    writeConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.volcengine.images]
default = "m"
models = ["m"]
`);

    expect(() => loadConfig()).toThrow(
      'unknown task "images" under [providers.volcengine]; expected image, video',
    );
  });

  it("rejects a timeout_seconds that is not a number", () => {
    writeConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "m"
models = ["m"]
timeout_seconds = "300"
`);

    expect(() => loadConfig()).toThrow(
      "timeout_seconds under [providers.p.image] must be a number",
    );
  });

  it("rejects models that is not an array of strings", () => {
    writeConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.volcengine.image]
models = "doubao-seedream-5-0-pro"
`);

    expect(() => loadConfig()).toThrow(
      /models under \[providers\.volcengine\.image\] must be an array of strings/,
    );
  });
});

describe("resolveSelection", () => {
  it("uses the task default when --model is absent", () => {
    const binding = resolveSelection({ provider: "volcengine", task: "image" }, taskConfig());

    expect(binding.model).toBe("doubao-seedream-5-0-flash-260915");
    expect(binding.task).toBe("image");
    expect(binding.provider.base_url).toBe("https://ark.cn-beijing.volces.com");
  });

  it("lets --model override the default", () => {
    const binding = resolveSelection(
      { provider: "volcengine", task: "image", model: "doubao-seedream-5-0-pro" },
      taskConfig(),
    );

    expect(binding.model).toBe("doubao-seedream-5-0-pro");
  });

  it("rejects a model the task does not declare", () => {
    expect(() =>
      resolveSelection({ provider: "volcengine", task: "image", model: "nope" }, taskConfig()),
    ).toThrow(
      /unknown model "nope".*add it to models .*\[providers\.volcengine\.image\]/,
    );
  });

  it("rejects a video model on the image task", () => {
    expect(() =>
      resolveSelection(
        { provider: "volcengine", task: "image", model: "doubao-seedance-1-0-pro" },
        taskConfig(),
      ),
    ).toThrow('model "doubao-seedance-1-0-pro" is declared for task "video", not "image"');
  });

  it("rejects a task the provider does not declare", () => {
    expect(() => resolveSelection({ provider: "dashscope", task: "video" }, taskConfig())).toThrow(
      'provider "dashscope" declares no "video" models; declared tasks: image',
    );
  });

  it("rejects a task the dialect has no adapter for", () => {
    writeConfig(`[providers.gw]
base_url = "https://gw.example.com"

[providers.gw.video]
api_type = "dashscope"
default = "v"
models = ["v"]
`);
    expect(() => resolveSelection({ provider: "gw", task: "video" }, loadConfig()))
      .toThrow('the "dashscope" dialect has no "video" adapter; implemented tasks: image');
  });

  it("rejects an empty models list", () => {
    const config = taskConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "m"
models = []
`);

    expect(() => resolveSelection({ provider: "p", task: "image" }, config)).toThrow(
      'models must not be empty under [providers.p.image]',
    );
  });

  it("rejects a default that is not in models", () => {
    const config = taskConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "absent"
models = ["present"]
`);

    expect(() => resolveSelection({ provider: "p", task: "image" }, config)).toThrow(
      'default "absent" is not listed in models under [providers.p.image]',
    );
  });

  for (const bad of ["0", "-1", "1.5", "999999"]) {
    it(`rejects timeout_seconds = ${bad}`, () => {
      const config = taskConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "m"
models = ["m"]
timeout_seconds = ${bad}
`);

      expect(() => resolveSelection({ provider: "p", task: "image" }, config)).toThrow(
        `timeout_seconds must be an integer in 1..${MAX_TIMEOUT_SECONDS}`,
      );
    });
  }

  it("names NaN as NaN instead of null in the timeout error", () => {
    const config = taskConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "m"
models = ["m"]
timeout_seconds = nan
`);

    // JSON.stringify(NaN) is "null", which names nothing the user can find.
    expect(() => resolveSelection({ provider: "p", task: "image" }, config)).toThrow(/got NaN/);
  });

  it("defaults the timeout to 300s for image", () => {
    const binding = resolveSelection({ provider: "volcengine", task: "image" }, taskConfig());

    expect(binding.timeout_ms).toBe(DEFAULT_TIMEOUT_SECONDS.image * 1000);
    expect(binding.timeout_ms).toBe(300_000);
  });

  it("honours an explicit timeout_seconds", () => {
    const config = taskConfig(`[providers.p]
api_type = "ark"
base_url = "https://proxy.example.com"

[providers.p.image]
default = "m"
models = ["m"]
timeout_seconds = 42
`);

    expect(resolveSelection({ provider: "p", task: "image" }, config).timeout_ms).toBe(42_000);
  });

  it("rejects any sub-path under a vendor's own host unless the task declares path", () => {
    const config = taskConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.volcengine.image]
default = "m"
models = ["m"]
`);

    const error = thrownBy(() => resolveSelection({ provider: "volcengine", task: "image" }, config));

    expect(error.message).toContain("Set base_url to the origin");
    expect(error.message).toContain('declare path = "/images/generations"');
  });

  it("allows a vendor sub-path when the task declares path, and uses it", () => {
    const config = taskConfig(`[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.volcengine.image]
default = "m"
models = ["m"]
path = "/images/generations"
`);

    const binding = resolveSelection({ provider: "volcengine", task: "image" }, config);

    expect(binding.provider.base_url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
    expect(binding.path).toBe("/images/generations");
  });

  it("rejects a qwen sub-path under the workspace host too", () => {
    const config = taskConfig(`[providers.dashscope]
api_type = "qwen"
base_url = "https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"

[providers.dashscope.image]
default = "m"
models = ["m"]
`);

    expect(() => resolveSelection({ provider: "dashscope", task: "image" }, config)).toThrow(
      "Set base_url to the origin",
    );
  });

  it("describes base_url as an origin when it cannot be parsed at all", () => {
    const config = taskConfig(`[providers.p]
api_type = "ark"
base_url = "ark.cn-beijing.volces.com"

[providers.p.image]
default = "m"
models = ["m"]
`);

    const error = thrownBy(() => resolveSelection({ provider: "p", task: "image" }, config));

    expect(error.message).toContain("origin");
    expect(error.message).not.toContain("ending at the version segment");
  });

  it("still allows a prefix on a custom host, which is not a vendor domain", () => {
    const config = taskConfig(`[providers.proxy]
api_type = "qwen"
base_url = "https://proxy.example.com/v1"

[providers.proxy.image]
default = "m"
models = ["m"]
`);

    const binding = resolveSelection({ provider: "proxy", task: "image" }, config);

    expect(binding.provider.base_url).toBe("https://proxy.example.com/v1");
  });

  it("keeps rejecting the seeded placeholder", () => {
    expect(() => resolveSelection({ provider: "dashscope", task: "image" }, taskConfig())).toThrow(
      /still contains the placeholder/,
    );
  });

  it("finds the provider from --model alone", () => {
    const binding = resolveSelection(
      { task: "image", model: "doubao-seedream-5-0-pro" },
      taskConfig(),
    );

    expect(binding.provider.name).toBe("volcengine");
    expect(binding.model).toBe("doubao-seedream-5-0-pro");
  });

  it("refuses --model declared by two providers", () => {
    const config = taskConfig(`[providers.a]
api_type = "ark"
base_url = "https://a.example.com"

[providers.a.image]
default = "shared"
models = ["shared"]

[providers.b]
api_type = "ark"
base_url = "https://b.example.com"

[providers.b.image]
default = "shared"
models = ["shared"]
`);

    expect(() => resolveSelection({ task: "image", model: "shared" }, config)).toThrow(
      'model "shared" is declared by providers "a", "b"; pass --provider',
    );
  });

  it("lists known models when --model matches nothing", () => {
    expect(() => resolveSelection({ task: "image", model: "nope" }, taskConfig())).toThrow(
      /known models for task "image": .*doubao-seedream-5-0-flash-260915/,
    );
  });

  it("says which task a --model id belongs to when it is not declared for this one", () => {
    expect(() =>
      resolveSelection({ task: "image", model: "doubao-seedance-1-0-pro" }, taskConfig()),
    ).toThrow('model "doubao-seedance-1-0-pro" is declared for task "video", not "image"');
  });

  it("ignores a second provider whose base_url is an unedited placeholder when resolving by --model", () => {
    // TASK_CONFIG's dashscope entry is exactly that placeholder, and volcengine
    // declares the model being looked up, so the lookup must not walk into it.
    const binding = resolveSelection(
      { task: "image", model: "doubao-seedream-5-0-pro" },
      taskConfig(),
    );

    expect(binding.provider.name).toBe("volcengine");
  });

  it("still reports the placeholder when that provider is the one selected", () => {
    expect(() => resolveSelection({ provider: "dashscope", task: "image" }, taskConfig())).toThrow(
      /still contains the placeholder/,
    );
  });
});

describe("validateProviderShape", () => {
  it("accepts a provider that declares only a video task", () => {
    const config = taskConfig(`[providers.v]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.v.video]
default = "vid"
models = ["vid"]
`);

    expect(validateProviderShape("v", config)).toEqual({
      name: "v",
      api_type: "ark",
      base_url: "https://ark.cn-beijing.volces.com",
    });
  });

  it("rejects a provider with no task table", () => {
    const config = taskConfig(`[providers.empty]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
`);

    expect(() => validateProviderShape("empty", config)).toThrow(
      'provider "empty" declares no task tables; expected image, video',
    );
  });

  it("rejects a provider without api_type", () => {
    const config = taskConfig(`[providers.half]
base_url = "https://ark.cn-beijing.volces.com"

[providers.half.image]
default = "m"
models = ["m"]
`);

    expect(() => validateProviderShape("half", config)).toThrow(
      'provider "half" is missing required field(s): api_type',
    );
  });

  it("rejects an unknown provider by name", () => {
    expect(() => validateProviderShape("ghost", taskConfig())).toThrow(/unknown provider "ghost"/);
  });
});

describe("dialect vocabulary", () => {
  it("accepts api_type openai", () => {
    writeConfig(`[providers.p]
api_type = "openai"
base_url = "https://gw.example.com"

[providers.p.image]
models = ["m"]
`);
    const config = loadConfig();
    expect(config.providers.p?.api_type).toBe("openai");
    expect(config.providers.p?.api_type_alias).toBeUndefined();
  });

  it("normalizes the deprecated alias qwen to openai and marks it", () => {
    writeConfig(`[providers.p]
api_type = "qwen"
base_url = "https://gw.example.com"

[providers.p.image]
models = ["m"]
`);
    const config = loadConfig();
    expect(config.providers.p?.api_type).toBe("openai");
    expect(config.providers.p?.api_type_alias).toBe(true);
  });

  it("names every dialect in the invalid api_type message", () => {
    writeConfig(`[providers.p]
api_type = "nope"
base_url = "https://gw.example.com"

[providers.p.image]
models = ["m"]
`);
    const error = thrownBy(() => loadConfig());
    expect(error.message).toContain('"openai"');
    expect(error.message).toContain('"dashscope"');
    expect(error.message).toContain('"ark"');
    expect(error.message).toContain('"minimax"');
  });

  it("accepts minimax as a task protocol and resolves a video binding from it", () => {
    writeConfig(`default_provider = "mm"

[providers.mm]
base_url = "https://api.minimax.io"
api_key_env = "MINIMAX_API_KEY"

[providers.mm.video]
api_type = "minimax"
default = "MiniMax-H3"
models = ["MiniMax-H3", "MiniMax-H3-Max"]
`);

    const binding = resolveSelection({ task: "video" }, loadConfig());

    expect(binding.dialect).toBe("minimax");
    expect(binding.model).toBe("MiniMax-H3");
    expect(binding.provider.base_url).toBe("https://api.minimax.io");
  });

  it("refuses a sub-path on minimax's own host, like the other vendors", () => {
    writeConfig(`[providers.mm]
base_url = "https://api.minimax.io/v2"

[providers.mm.video]
api_type = "minimax"
default = "MiniMax-H3"
models = ["MiniMax-H3"]
`);

    const error = thrownBy(() => resolveSelection({ provider: "mm", task: "video" }, loadConfig()));

    expect(error.message).toContain('it points at the sub-path "/v2"');
    // A one-segment API root still yields a concrete suggestion, not the placeholder.
    expect(error.message).toContain('"/video_generation"');
  });
});

describe("per-task protocol", () => {
  it("lets a task declare its own protocol, overriding the provider default", () => {
    writeConfig(`
[providers.gw]
api_type = "openai"
base_url = "https://gw.example.com"

[providers.gw.image]
api_type = "ark"
default = "m"
models = ["m"]
`);
    const config = loadConfig();
    expect(resolveSelection({ provider: "gw", task: "image" }, config).dialect).toBe("ark");
  });

  it("falls back to the provider-level protocol when the task declares none", () => {
    writeConfig(`
[providers.gw]
base_url = "https://gw.example.com"

[providers.gw.image]
api_type = "ark"
default = "m"
models = ["m"]
`);
    const config = loadConfig();
    expect(resolveSelection({ provider: "gw", task: "image" }, config).dialect).toBe("ark");
  });

  it("resolves each task to its own protocol on one account", () => {
    writeConfig(`
[providers.gw]
base_url = "https://gw.example.com"

[providers.gw.image]
api_type = "dashscope"
default = "m"
models = ["m"]

[providers.gw.video]
api_type = "ark"
default = "v"
models = ["v"]
`);
    const config = loadConfig();
    expect(resolveSelection({ provider: "gw", task: "image" }, config).dialect).toBe("dashscope");
    // The video half keeps the task's own protocol instead of the provider's.
    const video = resolveSelection({ provider: "gw", task: "video" }, config);
    expect(video.dialect).toBe("ark");
    expect(video.model).toBe("v");
  });

  it("names the task table when no protocol is declared anywhere", () => {
    writeConfig(`
[providers.gw]
base_url = "https://gw.example.com"

[providers.gw.image]
models = ["m"]
`);
    const config = loadConfig();
    expect(thrownBy(() => resolveSelection({ provider: "gw", task: "image" }, config)).message)
      .toContain("[providers.gw.image]");
  });
});
