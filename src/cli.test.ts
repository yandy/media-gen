import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authPath, loadAuth } from "./auth.js";
import { createProgram, main, requestsHelpOrVersion, type CliDeps } from "./cli.js";
import { configPath, loadConfig } from "./config.js";
import { SEED_CONFIG } from "./providers.js";

const API_KEY = "sk-test1234567890";
/** maskKey() shows the first four and last four characters only. */
const MASKED_KEY = "sk-t…7890";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations";
const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

/**
 * The documented provider shape with usable base URLs. Tests that exercise the
 * seed delete this file first: the bootstrap only ever writes a config that is
 * absent, and the seeded qwen entry is a placeholder a user must edit.
 */
const FIXTURE_CONFIG = `default_provider = "dashscope"

[providers.dashscope]
api_type = "qwen"
base_url = "https://dashscope.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.dashscope.image]
default = "qwen-image-3.0"
models = ["qwen-image-3.0"]

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]
default = "doubao-seedream-5-0-flash-260915"
models = ["doubao-seedream-5-0-flash-260915"]
`;

const TRACKED_ENV = [
  "MEDIAGEN_CLI_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "MEDIAGEN_CLI_STATE_DIR",
  "DASHSCOPE_API_KEY",
  "ARK_API_KEY",
  "MY_PROXY_KEY",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of TRACKED_ENV) originalEnv[key] = process.env[key];

let tempDir: string;
let configHome: string;
let outDir: string;
let outChunks: string[] = [];
let errChunks: string[] = [];

/** Collects writes instead of letting them reach the terminal. */
function writer(sink: string[]): typeof process.stdout.write {
  return ((chunk: unknown): boolean => {
    sink.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-cli-"));
  configHome = path.join(tempDir, "config");
  outDir = path.join(tempDir, "out");
  fs.mkdirSync(configHome, { recursive: true });
  fs.writeFileSync(path.join(configHome, "config.toml"), FIXTURE_CONFIG);

  process.env.MEDIAGEN_CLI_CONFIG_DIR = configHome;
  process.env.MEDIAGEN_CLI_STATE_DIR = path.join(tempDir, "state");
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.ARK_API_KEY;

  outChunks = [];
  errChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(writer(outChunks));
  vi.spyOn(process.stderr, "write").mockImplementation(writer(errChunks));
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process and captures everything it wrote. */
async function run(argv: string[], deps: CliDeps = {}): Promise<RunResult> {
  outChunks.length = 0;
  errChunks.length = 0;
  const code = await main(argv, deps);
  return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

function forbidFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("fetch must not be called in this test");
    }),
  );
}

interface ApiCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Routes POSTs to the API handler and every other request to the download handler. */
function stubFetch(
  apiHandler: (call: ApiCall, index: number) => Response,
  downloadHandler: (url: string) => Response = () =>
    new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
): { calls: ApiCall[]; downloads: string[] } {
  const calls: ApiCall[] = [];
  const downloads: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        downloads.push(url);
        return downloadHandler(url);
      }

      const call: ApiCall = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      };
      const index = calls.length;
      calls.push(call);
      return apiHandler(call, index);
    }),
  );

  return { calls, downloads };
}

function apiResponse(data: unknown[]): Response {
  return new Response(JSON.stringify({ created: 1_700_000_000, data }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req-1" },
  });
}

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(configHome, "config.toml"), toml);
}

function readConfig(): string {
  return fs.readFileSync(path.join(configHome, "config.toml"), "utf8");
}

function writeImage(name: string): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, PNG_BYTES);
  return file;
}

describe("mediagen --help", () => {
  it("lists every command group and exits 0", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of ["image", "login", "logout", "auth", "config"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("mediagen image generate --help");
  });

  it("createProgram() returns a fresh commander program", () => {
    const program = createProgram();

    expect(program.name()).toBe("mediagen");
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["login", "logout", "auth", "config", "image"]));
    expect(createProgram()).not.toBe(program);
  });

  it("names both media kinds in its one-line description", async () => {
    const result = await run(["--help"]);

    expect(result.stdout).toMatch(/images \(Bailian qwen/);
    expect(result.stdout).toMatch(/generate video/);
  });

  it("carries no behavioural rule block: those live in the skill", async () => {
    const result = await run(["--help"]);

    expect(result.stdout).not.toContain("Working as an agent");
  });

  it("exits 2 on an unknown command", async () => {
    const result = await run(["nope"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });
});

describe("image help text", () => {
  const IMAGE_FLAGS = [
    "--provider <name>",
    "--model <id>",
    "--image <path-or-url>",
    "--size <size>",
    "--n <count>",
    "--seed <seed>",
    "--watermark <bool>",
    "--negative-prompt <text>",
    "--prompt-extend <bool>",
    "--prompt-extend-mode <direct|agent>",
    "--enable-thinking <bool>",
    "--output-format <png|jpeg>",
    "--optimize-prompt <standard|fast>",
    "--layer-decomposition <bool>",
    "--background <transparent|opaque>",
    "--out-dir <dir>",
    "--json",
    "--api-key <key>",
    "--base-url <url>",
  ];

  it("mediagen image generate --help lists every flag from the spec table", async () => {
    const result = await run(["image", "generate", "--help"]);

    expect(result.code).toBe(0);
    for (const flag of IMAGE_FLAGS) {
      expect(result.stdout, `missing flag ${flag}`).toContain(flag);
    }
  });

  it("mediagen image generate --help documents --n as 1-6 with the ark fan-out warning", async () => {
    const result = await run(["image", "generate", "--help"]);

    expect(result.stdout).toContain("1-6");
    expect(result.stdout).toMatch(/one paid request per image/);
    expect(result.stdout).toMatch(/single request/);
  });

  it("mediagen image generate --help carries the model table and the size reference", async () => {
    const result = await run(["image", "generate", "--help"]);

    for (const model of [
      "qwen-image-3.0",
      "doubao-seedream-5-0-flash",
      "doubao-seedream-5-0-pro",
    ]) {
      expect(result.stdout, `missing model ${model}`).toContain(model);
    }
    for (const size of ["1K", "1.5K", "2K", "3K", "4K", "auto"]) {
      expect(result.stdout, `missing size ${size}`).toContain(size);
    }
    expect(result.stdout).toMatch(/WxH/i);
  });

  it("mediagen image generate --help carries at least four copy-pasteable examples", async () => {
    const result = await run(["image", "generate", "--help"]);

    const examples = result.stdout
      .split("\n")
      .filter((line) => line.trimStart().startsWith("mediagen image"));
    expect(examples.length).toBeGreaterThanOrEqual(4);
    expect(result.stdout).toContain("mediagen image edit");
    expect(result.stdout).toContain("--provider my-proxy");
  });

  it("mediagen image edit --help states that --image is required", async () => {
    const result = await run(["image", "edit", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/at least one --image/);
    expect(result.stdout).toContain("--image <path-or-url>");
    expect(result.stdout).toContain("mediagen image edit");
  });

  it("mediagen image with no subcommand shows help and exits 2", async () => {
    const result = await run(["image"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("generate");
    expect(result.stdout).toContain("edit");
  });
});

describe("login help text", () => {
  it("says where a key comes from and which entry owns it", async () => {
    const result = await run(["login", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--api-key");
    expect(result.stdout).toContain("api_key_env");
    expect(result.stdout).toContain("auth.json");
    expect(result.stdout).toMatch(/no\s+protocol-level default/);
    expect(result.stdout).toMatch(/masked/);
  });
});

describe("config bootstrap", () => {
  it("creates config.toml before a command that does not read it runs", async () => {
    fs.rmSync(configPath(), { force: true });
    expect(fs.existsSync(configPath())).toBe(false);

    const result = await run(["config", "path"]);

    expect(result.code).toBe(0);
    expect(fs.existsSync(configPath())).toBe(true);
  });

  it("fails before dispatch when config.toml is malformed, even for config path", async () => {
    writeConfig('[providers.qwen\nbase_url = "https://x"\n');

    const result = await run(["config", "path"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid TOML");
    expect(result.stderr).toContain(configPath());
  });

  it("still serves --help when config.toml is malformed", async () => {
    writeConfig('[providers.qwen\nbase_url = "https://x"\n');

    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Quickstart");
  });

  it("still serves a subcommand's --help when config.toml is malformed", async () => {
    writeConfig('[providers.qwen\nbase_url = "https://x"\n');

    const result = await run(["image", "generate", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Models");
  });

  it("still serves the implicit help command when config.toml is malformed", async () => {
    writeConfig('[providers.qwen\nbase_url = "https://x"\n');

    const result = await run(["help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: mediagen");
  });
});

describe("requestsHelpOrVersion", () => {
  it("treats the help and version flags as exempt", () => {
    expect(requestsHelpOrVersion(["--help"])).toBe(true);
    expect(requestsHelpOrVersion(["-h"])).toBe(true);
    expect(requestsHelpOrVersion(["image", "generate", "--help"])).toBe(true);
    expect(requestsHelpOrVersion(["--version"])).toBe(true);
    expect(requestsHelpOrVersion(["-V"])).toBe(true);
  });

  it("does not treat a prompt after -- as a help request", () => {
    expect(requestsHelpOrVersion(["image", "generate", "--", "--help"])).toBe(false);
  });

  it("treats commander's implicit help command as exempt", () => {
    expect(requestsHelpOrVersion(["help"])).toBe(true);
    expect(requestsHelpOrVersion(["help", "image", "generate"])).toBe(true);
  });

  it("is false for ordinary commands", () => {
    expect(requestsHelpOrVersion(["config", "show"])).toBe(false);
    expect(requestsHelpOrVersion([])).toBe(false);
  });
});

describe("mediagen config path", () => {
  it("prints only the config path", async () => {
    const result = await run(["config", "path"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${configPath()}\n`);
    expect(result.stderr).toBe("");
  });

  it("prints both paths as JSON with --json", async () => {
    const result = await run(["config", "path", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      config_path: configPath(),
      auth_path: authPath(),
    });
  });
});

describe("help examples name providers that exist", () => {
  /** Every provider name the seed mentions, including its commented examples. */
  function knownNames(): Set<string> {
    const names = new Set<string>();
    for (const match of SEED_CONFIG.matchAll(/^\s*#?\s*\[providers\.([^\].]+)\]/gm)) {
      names.add(match[1] ?? "");
    }
    return names;
  }

  it("uses no provider name outside the seed in either help text", async () => {
    const known = knownNames();
    for (const argv of [["image", "generate", "--help"], ["image", "edit", "--help"]]) {
      const result = await run(argv);
      const exampleLines = result.stdout
        .split("\n")
        .filter((line) => line.trimStart().startsWith("mediagen "));
      const referenced = exampleLines
        .flatMap((line) => [...line.matchAll(/--provider ('[^']+'|\S+)/g)])
        .map((match) => (match[1] ?? "").replace(/^'|'$/g, ""));
      expect(referenced.length).toBeGreaterThan(0);
      for (const name of referenced) expect(known).toContain(name);
    }
  });
});

describe("config show: deprecated aliases and missing protocols", () => {
  it("marks a provider-declared qwen as the deprecated alias of openai", async () => {
    writeConfig(
      '[providers.legacy]\napi_type = "qwen"\nbase_url = "https://gw.example.com"\n\n[providers.legacy.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/api_type: openai \(config\.toml\); declared as the deprecated alias "qwen"/);
  });

  it("marks a task-declared qwen the same way", async () => {
    writeConfig(
      '[providers.legacy]\nbase_url = "https://gw.example.com"\n\n[providers.legacy.image]\napi_type = "qwen"\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/api_type: openai \(config\.toml\); declared as the deprecated alias "qwen"/);
  });

  it("reports api_type as missing when neither the account nor a task declares one", async () => {
    writeConfig(
      '[providers.half]\nbase_url = "https://gw.example.com"\n\n[providers.half.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("missing: api_type");
  });

  it("says so when config add translated the deprecated alias", async () => {
    const result = await run([
      "config", "add",
      "oldname",
      "--api-type", "qwen",
      "--base-url", "https://gw.example.com",
      "--model", "m",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('api_type "qwen" is a deprecated alias');
    expect(result.stderr).toContain('writing api_type = "openai"');
  });
});

describe("mediagen config add: where the protocol is written", () => {
  it("writes api_type into the task table, not the provider table", async () => {
    const result = await run([
      "config",
      "add",
      "gw",
      "--api-type",
      "dashscope",
      "--base-url",
      "https://gw.example.com",
      "--model",
      "qwen-image-2.0-pro",
    ]);

    expect(result.code).toBe(0);
    const text = readConfig();
    const providerTable = text.slice(
      text.indexOf("[providers.gw]"),
      text.indexOf("[providers.gw.image]"),
    );
    expect(providerTable).not.toContain("api_type");
    expect(text).toContain('api_type = "dashscope"');
    expect(loadConfig().providers.gw?.tasks.image?.api_type).toBe("dashscope");
  });
});

describe("mediagen config show", () => {
  it("never writes the file it reads", async () => {
    writeConfig('default_provider = "mine"\n');
    const before = fs.readFileSync(configPath(), "utf8");
    const mtimeBefore = fs.statSync(configPath()).mtimeMs;

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(fs.statSync(configPath()).mtimeMs).toBe(mtimeBefore);
    expect(result.stdout).toContain("(loaded)");
  });

  it("prints the seeded configuration with a source note for each value", async () => {
    fs.rmSync(configPath(), { force: true });

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(configPath());
    expect(result.stdout).toMatch(/default_provider:\s+volcengine \(config\.toml\)/);
    expect(result.stdout).toMatch(/output_dir:\s+\S+ \(default/);
    expect(result.stdout).toContain("https://dashscope.aliyuncs.com (config.toml)");
    expect(result.stdout).toContain("https://ark.cn-beijing.volces.com (config.toml)");
    expect(result.stdout).toContain(`${ARK_URL} (computed)`);
    expect(result.stdout).toMatch(/not set/);
  });

  it("never prints an API key in full and names its source", async () => {
    process.env.DASHSCOPE_API_KEY = API_KEY;

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(MASKED_KEY);
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stdout).toMatch(/env DASHSCOPE_API_KEY/);
  });

  it("marks values that come from config.toml", async () => {
    writeConfig(`
# a comment that must survive
default_provider = "volcengine"
output_dir = "./shots"

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.volcengine.image]
default = "doubao-seedream-5-0-pro-260628"
models = ["doubao-seedream-5-0-pro-260628"]

[providers.my-proxy]
api_type = "ark"
base_url = "https://proxy.example.com"
api_key_env = "MY_PROXY_KEY"

[providers.my-proxy.image]
default = "some-model"
models = ["some-model"]
`);

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/default_provider:\s+volcengine \(config\.toml\)/);
    expect(result.stdout).toMatch(/output_dir:\s+\.\/shots \(config\.toml\)/);
    expect(result.stdout).toContain("doubao-seedream-5-0-pro-260628 (config.toml)");
    expect(result.stdout).toContain("my-proxy");
    expect(result.stdout).toContain("https://proxy.example.com (config.toml)");
  });

  it("shows the protocol each task resolved to, with the provider default as fallback", async () => {
    writeConfig(
      '[providers.gw]\napi_type = "openai"\nbase_url = "https://gw.example.com"\n\n[providers.gw.image]\napi_type = "ark"\ndefault = "m"\nmodels = ["m"]\n\n[providers.gw.video]\ndefault = "v"\nmodels = ["v"]\n',
    );

    const result = await run(["config", "show", "--json"]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const gw = (payload.providers as Record<string, unknown>[]).find((entry) => entry.name === "gw");
    const tasks = gw?.tasks as Record<string, unknown>[];
    const image = tasks.find((task) => task.task === "image");
    const video = tasks.find((task) => task.task === "video");
    expect(image?.api_type).toEqual({ value: "ark", source: "config.toml" });
    expect(image?.endpoint).toBe("https://gw.example.com/api/v3/images/generations");
    expect(video?.api_type).toEqual({
      value: "openai",
      source: "default",
      note: "provider default",
    });
  });

  it("emits the resolved config as JSON with masked keys", async () => {
    process.env.ARK_API_KEY = API_KEY;
    writeConfig(
      '[providers.dashscope]\napi_type = "qwen"\nbase_url = "https://x"\napi_key_env = "DASHSCOPE_API_KEY"\n\n[providers.dashscope.image]\ndefault = "my-qwen"\nmodels = ["my-qwen"]\n\n[providers.volcengine]\napi_type = "ark"\nbase_url = "https://ark.cn-beijing.volces.com"\napi_key_env = "ARK_API_KEY"\n\n[providers.volcengine.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["config", "show", "--json"]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.config_file).toEqual({ path: configPath(), exists: true });
    expect(payload.default_provider).toEqual({ value: "", source: "default" });

    const providers = payload.providers as Record<string, unknown>[];
    const dashscope = providers.find((entry) => entry.name === "dashscope");
    const dashscopeImage = (dashscope?.tasks as Record<string, unknown>[]).find(
      (task) => task.task === "image",
    );
    expect(dashscopeImage?.default).toEqual({ value: "my-qwen", source: "config.toml" });
    expect(dashscope?.api_key).toEqual({ configured: false, source: "none" });

    const volcengine = providers.find((entry) => entry.name === "volcengine");
    expect(volcengine?.api_key).toEqual({
      configured: true,
      source: "env",
      masked_key: MASKED_KEY,
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("prints the endpoint a request will actually hit", async () => {
    writeConfig(
      '[providers.p]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\n\n[providers.p.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "endpoint: https://proxy.example.com/api/v3/images/generations (computed)",
    );
    expect(result.stdout).not.toContain("path:");
  });

  it("omits the endpoint line when base_url cannot be parsed", async () => {
    writeConfig(
      '[providers.good]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\n\n[providers.good.image]\ndefault = "m"\nmodels = ["m"]\n\n[providers.broken]\napi_type = "ark"\nbase_url = "not-a-url"\n\n[providers.broken.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["config", "show", "--json"]);

    expect(result.code).toBe(0);
    const providers = JSON.parse(result.stdout).providers as Record<string, unknown>[];
    const good = providers.find((p) => p.name === "good");
    const broken = providers.find((p) => p.name === "broken");
    expect((good?.tasks as Record<string, unknown>[])[0]?.endpoint).toBe(
      "https://proxy.example.com/api/v3/images/generations",
    );
    // A base_url that cannot be parsed gets no endpoint at all, rather than a throw.
    expect((broken?.tasks as Record<string, unknown>[])[0]).not.toHaveProperty("endpoint");
  });

  it("reports an incomplete provider instead of failing", async () => {
    writeConfig('[providers.half-baked]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\n');

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("half-baked");
    // The provider has no task table, so nothing but api_type/base_url can be missing.
    expect(result.stdout).toContain("half-baked");
  });
});

describe("mediagen config add", () => {
  it("creates a provider table that config show can then resolve", async () => {
    const result = await run([
      "config", "add", "my-proxy",
      "--api-type", "qwen",
      "--base-url", "https://proxy.example.com",
      "--model", "qwen-image-3.0",
      "--api-key-env", "MY_PROXY_KEY",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("my-proxy");
    const text = readConfig();
    expect(text).toContain("[providers.my-proxy]");
    expect(text).toContain('api_key_env = "MY_PROXY_KEY"');
    // The seed survives the append.
    expect(text).toContain("[providers.dashscope]");
  });

  it("quotes a provider name that is not a bare TOML key", async () => {
    const result = await run([
      "config", "add", "my.proxy",
      "--api-type", "ark",
      "--base-url", "https://p.example.com",
      "--model", "m",
    ]);

    expect(result.code).toBe(0);
    expect(readConfig()).toContain('[providers."my.proxy"]');
    const shown = await run(["config", "show", "--json"]);
    expect(shown.code).toBe(0);
    const names = (JSON.parse(shown.stdout) as { providers: { name: string }[] }).providers.map(
      (entry) => entry.name,
    );
    expect(names).toContain("my.proxy");
  });

  it("tells the user to add a model instead of a second provider", async () => {
    const result = await run([
      "config", "add", "dashscope",
      "--api-type", "qwen",
      "--base-url", "https://dashscope.aliyuncs.com",
      "--model", "qwen-image-3.0",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("models = [");
  });

  it("refuses a name that already exists", async () => {
    const result = await run([
      "config", "add", "dashscope",
      "--api-type", "qwen",
      "--base-url", "https://x.example.com",
      "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("dashscope");
  });

  it("requires --api-type, --base-url and --model", async () => {
    const result = await run(["config", "add", "my-proxy", "--api-type", "qwen"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--base-url");
  });

  it("rejects a --base-url that is not an http(s) URL and writes nothing", async () => {
    await run(["config", "show"]);
    const before = readConfig();

    const result = await run([
      "config", "add", "my-proxy",
      "--api-type", "qwen",
      "--base-url", "proxy.example.com",
      "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(readConfig()).toBe(before);
  });

  it("keeps every comment and setting already in config.toml", async () => {
    writeConfig(
      '# keep me\ndefault_provider = "dashscope"\n\n[providers.dashscope]\napi_type = "qwen"\nbase_url = "https://x"\n\n[providers.dashscope.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run([
      "config", "add", "p2",
      "--api-type", "ark",
      "--base-url", "https://p2.example.com",
      "--model", "m2",
    ]);

    expect(result.code).toBe(0);
    const text = readConfig();
    expect(text).toContain("# keep me");
    expect(text).toContain('default_provider = "dashscope"');
    expect(text).toContain("[providers.p2]");
  });
});

describe("mediagen config add: value hygiene", () => {
  const add = (
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => run(["config", "add", ...args]);

  it("strips a trailing slash from --base-url", async () => {
    const result = await add([
      "p1", "--api-type", "qwen", "--base-url", "https://k.example.com/", "--model", "m",
    ]);

    expect(result.code).toBe(0);
    expect(readConfig()).toContain('base_url = "https://k.example.com"');
  });

  it("trims a padded --base-url instead of persisting the spaces", async () => {
    const result = await add([
      "p1", "--api-type", "qwen", "--base-url", "  https://k.example.com  ", "--model", "m",
    ]);

    expect(result.code).toBe(0);
    expect(readConfig()).toContain('base_url = "https://k.example.com"');
  });

  it("rejects a blank --api-key-env", async () => {
    const result = await add([
      "p1", "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m",
      "--api-key-env", "   ",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--api-key-env");
    // The bootstrap creates the seed config before dispatch; a rejected command
    // must still not add a provider table to it.
    expect(fs.existsSync(configPath())).toBe(true);
    expect(readConfig()).not.toContain("[providers.p1]");
  });

  it("rejects a --base-url carrying a query string", async () => {
    const result = await add([
      "p1", "--api-type", "qwen", "--base-url", "https://k.example.com/v1?x=1", "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--base-url");
    expect(fs.existsSync(configPath())).toBe(true);
    expect(readConfig()).not.toContain("[providers.p1]");
  });

  it("rejects a blank provider name", async () => {
    const result = await add([
      "", "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("name");
    // The bootstrap leaves the seed untouched; no nameless table is appended.
    expect(readConfig()).toContain("[providers.dashscope]");
  });

  it("leaves no temporary file behind", async () => {
    await add(["p1", "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m"]);

    expect(fs.readdirSync(configHome)).toEqual(["config.toml"]);
  });
});

describe("mediagen config add: protecting the file", () => {
  it("refuses a config.toml it cannot append to faithfully, and changes nothing", async () => {
    // An inline `providers` table cannot later be extended by a [providers.<name>]
    // header: TOML forbids redefining it. The rewrite must refuse, not mangle.
    writeConfig(
      'providers = { old = { api_type = "ark", base_url = "https://o.example.com" } }\n',
    );
    const before = readConfig();

    const result = await run([
      "config", "add", "brandnew",
      "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("by hand");
    expect(readConfig()).toBe(before);
  });

  it("preserves every existing byte, datetimes included", async () => {
    const original = [
      "# keep me",
      'default_provider = "dashscope"',
      "since = 1979-05-27T07:32:00Z",
      "offset = 1979-05-27T07:32:00-07:00",
      "",
      "[providers.dashscope]",
      'api_type = "qwen"',
      'base_url = "https://x"',
      "",
      "[providers.dashscope.image]",
      'default = "m"',
      'models = ["m"]',
      "",
    ].join("\n");
    writeConfig(original);

    const result = await run([
      "config", "add", "p2",
      "--api-type", "ark", "--base-url", "https://p2.example.com", "--model", "m2",
    ]);

    expect(result.code).toBe(0);
    expect(readConfig().startsWith(original)).toBe(true);
    expect(readConfig()).toContain("[providers.p2]");
  });
});

describe("mediagen config: unwritable config dir", () => {
  it("fails with the path and the remedy instead of pretending there is no config", async () => {
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "");
    const blockedDir = path.join(blocker, "config");
    process.env.MEDIAGEN_CLI_CONFIG_DIR = blockedDir;

    const result = await run(["config", "show"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(path.join(blockedDir, "config.toml"));
    expect(result.stderr).toContain("MEDIAGEN_CLI_CONFIG_DIR");
    expect(result.stderr).not.toContain("none; run");
  });

  it("keeps the --json error machine-readable", async () => {
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "");
    const blockedDir = path.join(blocker, "config");
    process.env.MEDIAGEN_CLI_CONFIG_DIR = blockedDir;

    const result = await run(["config", "show", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { error: { message: string } };
    expect(parsed.error.message).toContain(path.join(blockedDir, "config.toml"));
  });
});

describe("mediagen with no default provider", () => {
  it("tells login to set default_provider rather than naming an empty provider", async () => {
    writeConfig('[providers.p1]\napi_type = "qwen"\nbase_url = "https://k.example.com"\n\n[providers.p1.image]\ndefault = "m"\nmodels = ["m"]\n');

    const result = await run(["login", "--api-key", API_KEY]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("default_provider");
    expect(result.stderr).not.toContain('[providers.]');
  });

  it("tells logout the same thing", async () => {
    writeConfig('[providers.p1]\napi_type = "qwen"\nbase_url = "https://k.example.com"\n\n[providers.p1.image]\ndefault = "m"\nmodels = ["m"]\n');

    const result = await run(["logout"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("default_provider");
  });
});

describe("mediagen config add: prototype-safe names", () => {
  it("lists a provider named __proto__ instead of hiding it", async () => {
    const result = await run([
      "config", "add", "__proto__",
      "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m",
    ]);
    expect(result.code).toBe(0);

    const shown = await run(["config", "show", "--json"]);
    const names = (JSON.parse(shown.stdout) as { providers: { name: string }[] }).providers.map(
      (entry) => entry.name,
    );
    expect(names).toContain("__proto__");
  });
});

describe("remedy messages", () => {
  it("quotes a dotted provider name as a TOML key so the remedy can be pasted", async () => {
    const result = await run(["login", "--provider", "my.proxy", "--api-key", API_KEY]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('[providers."my.proxy"]');
  });

  it("quotes a provider name that needs it when naming a command to run", async () => {
    const result = await run([
      "config", "add", 'we"ird',
      "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`--provider 'we"ird'`);
  });

  it("wraps an unwritable config dir instead of leaking the raw fs error", async () => {
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "");
    const blockedDir = path.join(blocker, "config");
    process.env.MEDIAGEN_CLI_CONFIG_DIR = blockedDir;

    const result = await run([
      "config", "add", "p1",
      "--api-type", "qwen", "--base-url", "https://k.example.com", "--model", "m",
    ]);

    expect(result.code).toBe(1);
    // Wrapped in a ConfigError naming the file and the errno code, not a raw
    // "open '/…' " dump with syscall details.
    expect(result.stderr).toContain("cannot create");
    expect(result.stderr).toContain(path.join(blockedDir, "config.toml"));
    expect(result.stderr).toMatch(/ENOTDIR|EACCES|EROFS/);
    expect(result.stderr).not.toContain("syscall");
  });
});

describe("mediagen login: provider must be usable", () => {
  it("refuses to store a key for an entry that cannot resolve", async () => {
    // A hand-edited entry with no api_type: storing a key would look like success
    // and then every generate would fail.
    writeConfig('[providers.legacy]\nbase_url = "https://x"\n\n[providers.legacy.image]\ndefault = "m"\nmodels = ["m"]\n');

    const result = await run(["login", "--provider", "legacy", "--api-key", API_KEY]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("api_type");
    expect(fs.existsSync(authPath())).toBe(false);
  });
});

describe("mediagen auth status", () => {
  it("reports every provider as unconfigured with no auth file", async () => {
    const result = await run(["auth", "status"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dashscope");
    expect(result.stdout).toContain("volcengine");
    expect(result.stdout).toMatch(/not configured|no API key/i);
    expect(result.stdout).toContain("mediagen login");
  });

  it("emits a providers array with name/configured/source and exits 0", async () => {
    const result = await run(["auth", "status", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      providers: [
        { name: "dashscope", configured: false, source: "none" },
        { name: "volcengine", configured: false, source: "none" },
      ],
    });
  });

  it("reports the masked key and its source after login", async () => {
    expect((await run(["login", "--provider", "dashscope", "--api-key", API_KEY])).code).toBe(0);
    process.env.ARK_API_KEY = API_KEY;

    const human = await run(["auth", "status"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(MASKED_KEY);
    expect(human.stdout).not.toContain(API_KEY);
    expect(human.stdout).toMatch(/auth\.json/);
    expect(human.stdout).toMatch(/env ARK_API_KEY/);

    const json = await run(["auth", "status", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({
      providers: [
        { name: "dashscope", configured: true, source: "auth", masked_key: MASKED_KEY },
        { name: "volcengine", configured: true, source: "env", masked_key: MASKED_KEY },
      ],
    });
    expect(json.stdout).not.toContain(API_KEY);
  });

  it("lists every provider declared in config.toml", async () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\napi_key_env = "MY_PROXY_KEY"\n\n[providers.my-proxy.image]\ndefault = "m"\nmodels = ["m"]\n',
    );
    process.env.MY_PROXY_KEY = API_KEY;

    const result = await run(["auth", "status", "--json"]);
    const payload = JSON.parse(result.stdout) as {
      providers: { name: string; source: string }[];
    };

    expect(payload.providers.map((entry) => entry.name)).toContain("my-proxy");
    expect(payload.providers.find((entry) => entry.name === "my-proxy")?.source).toBe("env");
  });
});

describe("mediagen login", () => {
  it("stores the key with --api-key and prints only the masked key", async () => {
    const result = await run(["login", "--provider", "dashscope", "--api-key", API_KEY]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers.dashscope?.api_key).toBe(API_KEY);
    expect(result.stdout).toContain(MASKED_KEY);
    expect(result.stdout).toContain(authPath());
    expect(`${result.stdout}${result.stderr}`).not.toContain(API_KEY);
  });

  it("defaults the provider to config.default_provider", async () => {
    writeConfig(
      'default_provider = "volcengine"\n\n[providers.volcengine]\napi_type = "ark"\nbase_url = "https://ark.cn-beijing.volces.com"\n\n[providers.volcengine.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["login", "--api-key", API_KEY]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers.volcengine?.api_key).toBe(API_KEY);
  });

  it("emits JSON with --json", async () => {
    const result = await run(["login", "--provider", "volcengine", "--api-key", API_KEY, "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      provider: "volcengine",
      masked_key: MASKED_KEY,
      auth_file: authPath(),
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("reads the key without echoing it when stdin is a TTY", async () => {
    const readSecret = vi.fn(async () => API_KEY);

    const result = await run(["login", "--provider", "dashscope"], {
      isTTY: () => true,
      readSecret,
    });

    expect(result.code).toBe(0);
    expect(readSecret).toHaveBeenCalledOnce();
    expect(loadAuth().providers.dashscope?.api_key).toBe(API_KEY);
    expect(`${result.stdout}${result.stderr}`).not.toContain(API_KEY);
  });

  it("prefers --api-key over the interactive prompt", async () => {
    const readSecret = vi.fn(async () => "sk-should-not-be-used");

    const result = await run(["login", "--provider", "dashscope", "--api-key", API_KEY], {
      isTTY: () => true,
      readSecret,
    });

    expect(result.code).toBe(0);
    expect(readSecret).not.toHaveBeenCalled();
    expect(loadAuth().providers.dashscope?.api_key).toBe(API_KEY);
  });

  it("fails with a usage error when there is no TTY and no --api-key", async () => {
    const result = await run(["login", "--provider", "dashscope"], { isTTY: () => false });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--api-key");
    expect(fs.existsSync(authPath())).toBe(false);
  });

  it("rejects an empty key read from the terminal", async () => {
    const result = await run(["login", "--provider", "dashscope"], {
      isTTY: () => true,
      readSecret: async () => "   ",
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/empty|no API key/i);
    expect(fs.existsSync(authPath())).toBe(false);
  });

  it("points at config.toml for a provider that is not configured", async () => {
    const result = await run(["login", "--provider", "unknown", "--api-key", API_KEY]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("config.toml");
    expect(result.stderr).toContain(configPath());
    expect(result.stderr).toContain("[providers.unknown]");
    expect(fs.existsSync(authPath())).toBe(false);
  });

  it("accepts a provider defined in config.toml", async () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\n\n[providers.my-proxy.image]\ndefault = "m"\nmodels = ["m"]\n',
    );

    const result = await run(["login", "--provider", "my-proxy", "--api-key", API_KEY]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers["my-proxy"]?.api_key).toBe(API_KEY);
  });

  it("rejects --base-url: endpoints are configured in config.toml", async () => {
    const result = await run([
      "login",
      "--provider", "dashscope",
      "--base-url", "https://x.example.com",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--base-url");
  });
});

describe("mediagen logout", () => {
  it("removes the stored key", async () => {
    await run(["login", "--provider", "dashscope", "--api-key", API_KEY]);

    const result = await run(["logout", "--provider", "dashscope"]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers.dashscope).toBeUndefined();
    expect(result.stdout).toContain("dashscope");
    expect(`${result.stdout}${result.stderr}`).not.toContain(API_KEY);
  });

  it("is a no-op that still exits 0 when nothing is stored", async () => {
    const result = await run(["logout", "--provider", "dashscope", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, provider: "dashscope", removed: false });
  });

  it("defaults the provider to config.default_provider", async () => {
    writeConfig(
      'default_provider = "volcengine"\n\n[providers.volcengine]\napi_type = "ark"\nbase_url = "https://ark.cn-beijing.volces.com"\n\n[providers.volcengine.image]\ndefault = "m"\nmodels = ["m"]\n',
    );
    await run(["login", "--provider", "volcengine", "--api-key", API_KEY]);

    const result = await run(["logout"]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers.volcengine).toBeUndefined();
  });
});

describe("mediagen image generate", () => {
  it("refuses to send a request while a base_url placeholder is unedited", async () => {
    writeConfig(
      '[providers.aliyun]\nbase_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"\napi_key_env = "DASHSCOPE_API_KEY"\n\n[providers.aliyun.image]\napi_type = "openai"\ndefault = "qwen-image-3.0"\nmodels = ["qwen-image-3.0"]\n',
    );
    process.env.DASHSCOPE_API_KEY = API_KEY;
    const { calls } = stubFetch(() => apiResponse([{ url: "https://cdn.example.com/a.png" }]));

    const result = await run(["image", "generate", "a red fox", "--provider", "aliyun"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("workspace-id");
    expect(calls).toHaveLength(0);
  });

  it("passes every qwen flag through to the request body", async () => {
    const { calls, downloads } = stubFetch(() =>
      apiResponse([{ url: "https://cdn.example.com/a.png" }, { url: "https://cdn.example.com/b.png" }]),
    );

    const result = await run([
      "image", "generate", "a red fox",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--model", "qwen-image-3.0",
      "--size", "1024x1024",
      "--n", "2",
      "--seed", "42",
      "--watermark", "false",
      "--negative-prompt", "blurry",
      "--prompt-extend", "true",
      "--prompt-extend-mode", "direct",
      "--enable-thinking", "false",
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(QWEN_URL);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0].body).toMatchObject({
      model: "qwen-image-3.0",
      prompt: "a red fox",
      n: 2,
      size: "1024x1024",
      seed: 42,
      watermark: false,
      negative_prompt: "blurry",
      prompt_extend: true,
      prompt_extend_mode: "direct",
      enable_thinking: false,
    });
    expect(calls[0].body.image).toBeUndefined();
    expect(downloads).toEqual([
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.png",
    ]);

    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
    for (const line of result.stdout.trim().split("\n")) {
      expect(line.startsWith(outDir)).toBe(true);
      expect(fs.existsSync(line)).toBe(true);
    }
  });

  it("passes every ark flag through and fans out --n into seeded requests", async () => {
    const { calls } = stubFetch((_call, index) =>
      apiResponse([{ url: `https://cdn.example.com/${index}.png` }]),
    );

    const result = await run([
      "image", "generate", "a logo",
      "--provider", "volcengine",
      "--api-key", API_KEY,
      "--size", "2K",
      "--n", "3",
      "--seed", "7",
      "--watermark", "true",
      "--output-format", "png",
      "--optimize-prompt", "fast",
      "--background", "transparent",
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(ARK_URL);
    expect(calls.map((call) => call.body.seed)).toEqual([7, 8, 9]);
    // ark serves one image per request, so the fan-out sub-requests carry no n.
    expect(calls.map((call) => call.body.n)).toEqual([undefined, undefined, undefined]);
    for (const call of calls) {
      expect(call.body).toMatchObject({
        size: "2K",
        watermark: true,
        output_format: "png",
        optimize_prompt_options: { mode: "fast" },
        background: "transparent",
        response_format: "url",
      });
    }
    expect(result.stdout.trim().split("\n")).toHaveLength(3);
  });

  it("honours --base-url as a one-off provider override", async () => {
    const { calls } = stubFetch(() => apiResponse([{ url: "https://cdn.example.com/a.png" }]));

    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--base-url", "https://proxy.example.com/",
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(calls[0].url).toBe("https://proxy.example.com/compatible-mode/v1/images/generations");
  });

  it("emits the JSON envelope with --json", async () => {
    stubFetch(() => apiResponse([{ url: "https://cdn.example.com/a.png" }]));

    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--out-dir", outDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.partial).toBe(false);
    expect(payload.request_id).toBe("req-1");
    expect(payload.files).toHaveLength(1);
  });

  it("keeps a partial success at exit code 0 and warns on stderr", async () => {
    stubFetch(
      () => apiResponse([{ url: "https://cdn.example.com/a.png" }, { url: "https://cdn.example.com/b.png" }]),
      (url) =>
        url.endsWith("b.png")
          ? new Response("gone", { status: 404 })
          : new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    );

    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--n", "2",
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).toContain("do not retry");
  });

  it("exits 2 when --layer-decomposition is used with a qwen provider", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--layer-decomposition", "true",
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("layer_decomposition");
    expect(result.stderr).toMatch(/ark-only/);
    expect(result.stdout).toBe("");
  });

  it("exits 2 when --layer-decomposition is rejected by a qwen provider in JSON mode", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--layer-decomposition", "true",
      "--json",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { error: { message: string } };
    expect(payload.error.message).toContain("layer_decomposition");
  });

  it("exits 1 with a login hint when no API key can be resolved", async () => {
    const result = await run(["image", "generate", "x", "--provider", "dashscope", "--out-dir", outDir]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mediagen login");
    expect(result.stderr).toContain("DASHSCOPE_API_KEY");
    expect(result.stderr).not.toMatch(/at .*cli\.ts/);
  });

  it("exits 2 for an invalid --size", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--size", "banana",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--size");
  });

  it("exits 2 for a non-integer --n", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--n", "many",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--n");
  });

  it.each(["7", "500", "1e2", "0x10", "1.0", "++3", "  "])(
    "exits 2 for the --n %s without sending a request",
    async (value) => {
      const result = await run([
        "image", "generate", "x",
        "--provider", "dashscope",
        "--api-key", API_KEY,
        "--n", value,
      ]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--n");
    },
  );

  it("names the 1-6 limit for an --n above it", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "volcengine",
      "--api-key", API_KEY,
      "--n", "500",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("6");
    expect(result.stderr).toContain("1-6");
  });

  it("exits 2 for an exponent-form --seed", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--seed", "1e2",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--seed");
  });

  it("exits 2 for a boolean flag without true/false", async () => {
    const result = await run([
      "image", "generate", "x",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--watermark", "maybe",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--watermark");
    expect(result.stderr).toMatch(/true or false/);
  });

  it("exits 2 for an unknown flag, as JSON when --json is given", async () => {
    const human = await run(["image", "generate", "x", "--nope"]);
    expect(human.code).toBe(2);
    expect(human.stderr).toContain("unknown option");

    const json = await run(["image", "generate", "x", "--nope", "--json"]);
    expect(json.code).toBe(2);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({ error: { message: "unknown option '--nope'" } });
  });

  it("exits 2 when the prompt argument is missing", async () => {
    const result = await run(["image", "generate"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("prompt");
  });

  it("exits 1 for an unknown provider, naming config.toml", async () => {
    const result = await run(["image", "generate", "x", "--provider", "nope", "--api-key", API_KEY]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown provider");
    expect(result.stderr).toContain("config.toml");
  });
});

describe("mediagen image edit", () => {
  it("exits 2 with a message about --image when no image is given", async () => {
    const result = await run(["image", "edit", "x", "--provider", "dashscope", "--api-key", API_KEY]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--image");
  });

  it("sends a local file as a data URL", async () => {
    const file = writeImage("photo.png");
    const { calls } = stubFetch(() => apiResponse([{ url: "https://cdn.example.com/a.png" }]));

    const result = await run([
      "image", "edit", "make the sky orange",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--image", file,
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].body.image).startsWith("data:image/png;base64,")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("accepts several --image references", async () => {
    const first = writeImage("one.png");
    const second = writeImage("two.png");
    const { calls } = stubFetch(() => apiResponse([{ url: "https://cdn.example.com/a.png" }]));

    const result = await run([
      "image", "edit", "combine them",
      "--provider", "dashscope",
      "--api-key", API_KEY,
      "--image", first,
      "--image", second,
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(calls[0].body.image).toHaveLength(2);
  });

  it("accepts a remote --image URL unchanged", async () => {
    const { calls } = stubFetch(() => apiResponse([{ url: "https://cdn.example.com/a.png" }]));

    const result = await run([
      "image", "edit", "brighten it",
      "--provider", "volcengine",
      "--api-key", API_KEY,
      "--image", "https://example.com/input.jpg",
      "--layer-decomposition", "true",
      "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(calls[0].body.image).toBe("https://example.com/input.jpg");
    expect(calls[0].body.layer_decomposition).toBe(true);
  });
});

describe("task-scoped CLI surface", () => {
  const VIDEO_ONLY = `default_provider = "volcengine"

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"

[providers.volcengine.video]
default = "doubao-seedance-1-0-pro"
models = ["doubao-seedance-1-0-pro"]
`;

  it("writes a provider table plus one image task table", async () => {
    const result = await run([
      "config", "add", "my-proxy",
      "--api-type", "qwen",
      "--base-url", "https://proxy.example.com",
      "--model", "qwen-image-3.0",
    ]);

    expect(result.code).toBe(0);
    // --api-type qwen is the deprecated alias; the file records the real name.
    expect(loadConfig().providers["my-proxy"].tasks.image).toEqual({
      api_type: "openai",
      default: "qwen-image-3.0",
      models: ["qwen-image-3.0"],
    });
    // The provider table holds no model: that is what makes a second model cheap.
    expect(readConfig()).not.toMatch(/^model\s*=/m);
  });

  it("writes a video task table when --task video is given", async () => {
    const result = await run([
      "config", "add", "vid",
      "--api-type", "ark",
      "--base-url", "https://ark.cn-beijing.volces.com",
      "--task", "video",
      "--model", "doubao-seedance-1-0-pro",
    ]);

    expect(result.code).toBe(0);
    expect(loadConfig().providers.vid.tasks.video).toEqual({
      api_type: "ark",
      default: "doubao-seedance-1-0-pro",
      models: ["doubao-seedance-1-0-pro"],
    });
  });

  it("rejects an unknown --task before writing anything", async () => {
    const before = readConfig();

    const result = await run([
      "config", "add", "bad",
      "--api-type", "ark",
      "--base-url", "https://ark.cn-beijing.volces.com",
      "--task", "audio",
      "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--task");
    expect(readConfig()).toBe(before);
  });

  it("does not confuse an unfinished base_url with a missing adapter", async () => {
    // A hand-written `<workspace-id>` host cannot produce an endpoint — but the
    // openai dialect *does* serve images, and a missing-adapter note there would
    // send the user hunting for a code change.
    writeConfig(
      '[providers.aliyun]\nbase_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"\napi_key_env = "DASHSCOPE_API_KEY"\n\n[providers.aliyun.image]\napi_type = "openai"\ndefault = "qwen-image-3.0"\nmodels = ["qwen-image-3.0"]\n\n[providers.aliyun.video]\napi_type = "dashscope"\ndefault = "qwen-video"\nmodels = ["qwen-video"]\n',
    );

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("endpoint: (base_url is not a URL yet)");
    // The dashscope dialect has no video task, and the note says so rather than
    // promising one later.
    expect(result.stdout).toContain("(the dashscope dialect has no video task)");
    expect(result.stdout).not.toContain("no adapter yet");
  });

  it("prints a task's path override and the URL it produces", async () => {
    writeConfig(`[providers.ark-plan]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.ark-plan.image]
default = "m"
models = ["m"]
path = "/images/generations"
`);

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("path: /images/generations (config.toml)");
    expect(result.stdout).toContain(
      "endpoint: https://ark.cn-beijing.volces.com/api/plan/v3/images/generations (computed)",
    );
  });

  it("names a missing api_type instead of blaming the adapter", async () => {
    writeConfig(`[providers.no-type]
base_url = "https://proxy.example.com"

[providers.no-type.image]
default = "m"
models = ["m"]
`);

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("endpoint: (api_type is not set)");
  });

  it("refuses to print a URL the validator would reject", async () => {
    writeConfig(`[providers.bad-host]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/v3"

[providers.bad-host.image]
default = "m"
models = ["m"]
`);

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    // The doubled path is exactly what resolution refuses; showing it would mislead.
    expect(result.stdout).not.toContain("/api/v3/api/v3");
    expect(result.stdout).toContain("endpoint: (base_url carries a path; declare path = ... or use the origin)");
  });

  it("does not warn about a missing adapter for a task the dialect implements", async () => {
    const result = await run([
      "config", "add", "vid",
      "--api-type", "ark",
      "--base-url", "https://ark.cn-beijing.volces.com",
      "--task", "video",
      "--model", "doubao-seedance-1-0-pro",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('no "video" adapter');
  });

  it("says a dialect has no such task, without promising one later", async () => {
    // adapterPath() misses for dashscope video, so the note branch is still live
    // even now that the other two dialects have video adapters.
    const result = await run([
      "config", "add", "ds-vid",
      "--api-type", "dashscope",
      "--base-url", "https://dashscope.aliyuncs.com",
      "--task", "video",
      "--model", "wan2.5-t2v-preview",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'note: the "dashscope" dialect has no "video" task; the table is stored, and ' +
        '"config show" will say the same',
    );
  });

  it("shows the endpoint of a task that has an adapter", async () => {
    writeConfig(VIDEO_ONLY);

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("video:");
    expect(result.stdout).toContain(
      "endpoint: https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    );
    expect(result.stdout).not.toContain("(no adapter yet)");
    expect(result.stdout).toMatch(/timeout_seconds: 1800 \(default\)/);
  });

  it("logs in to a provider that only declares a video task", async () => {
    writeConfig(VIDEO_ONLY);

    const result = await run(["login", "--provider", "volcengine", "--api-key", "sk-video-only"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("volcengine");
  });

  it("tells the user how to set base_url now that it is an origin", async () => {
    const before = readConfig();

    const result = await run([
      "config", "add", "trap",
      "--api-type", "ark",
      "--base-url", "https://ark.cn-beijing.volces.com/api/v3",
      "--model", "m",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('it points at the sub-path "/api/v3"');
    expect(result.stderr).toContain("set base_url to the origin");
    expect(readConfig()).toBe(before);
  });
});

const VIDEO_CONFIG = `default_provider = "volcengine"

[providers.volcengine]
base_url = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"

[providers.volcengine.video]
api_type = "ark"
default = "doubao-seedance-1-0-pro-250528"
models = ["doubao-seedance-1-0-pro-250528"]
`;

const VIDEO_CREATE_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
const VIDEO_KEY = "sk-video-0123456789";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mp4Response(): Response {
  return new Response(Buffer.from("\x00\x00\x00\x18ftypmp42"), {
    status: 200,
    headers: { "content-type": "video/mp4" },
  });
}

/**
 * Serves a scripted list of responses in order. An exhausted script answers 400
 * instead of repeating the last response: video polling sleeps between attempts, so
 * a script left on "running" would stall this suite for the whole 1800s budget.
 */
function stubVideoFetch(responses: Response[]): { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const queue = [...responses];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      const next = queue.shift();
      if (next === undefined) {
        return new Response(
          JSON.stringify({ error: { code: "TestScriptExhausted", message: "no scripted response left" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return next;
    }),
  );

  return { calls };
}

describe("video generate", () => {
  beforeEach(() => {
    writeConfig(VIDEO_CONFIG);
  });

  it("creates the task, downloads the video and prints its path on stdout", async () => {
    const stub = stubVideoFetch([
      jsonResponse({ id: "cgt-1" }),
      jsonResponse({ status: "succeeded", content: { video_url: "https://cdn.example.com/v.mp4" } }),
      mp4Response(),
    ]);

    const result = await run([
      "video", "generate", "a fox in snow",
      "--provider", "volcengine", "--api-key", VIDEO_KEY, "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    // Exact: a note leaking onto stdout, or a second line of any kind, must fail here.
    expect(result.stdout.trim()).toMatch(/^\/.*volcengine-doubao-seedance-1-0-pro-250528-.*-0\.mp4$/);
    expect(result.stdout).not.toContain("note:");
    expect(result.stderr).toContain("cgt-1");
    expect(stub.calls[0]).toEqual({ url: VIDEO_CREATE_URL, method: "POST" });
  });

  it("reports a task it did not wait for as ok, with the id and no files", async () => {
    stubVideoFetch([jsonResponse({ id: "cgt-1" })]);

    const result = await run([
      "video", "generate", "a fox in snow", "--provider", "volcengine",
      "--api-key", VIDEO_KEY, "--no-wait", "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, task_id: "cgt-1", status: "pending", files: [], errors: [],
    });
    expect(result.stderr).toContain("mediagen video status cgt-1");
  });

  it("prints the task id on stdout when it did not wait", async () => {
    stubVideoFetch([jsonResponse({ id: "cgt-1" })]);

    const result = await run([
      "video", "generate", "a fox in snow", "--provider", "volcengine",
      "--api-key", VIDEO_KEY, "--no-wait",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("cgt-1");
  });

  it("rejects --n and --size before any request", async () => {
    const result = await run(["video", "generate", "p", "--n", "2"]);
    expect(result.code).toBe(2);

    const sized = await run(["video", "generate", "p", "--size", "2K"]);
    expect(sized.code).toBe(2);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a second --image instead of silently dropping it", async () => {
    const result = await run([
      "video", "generate", "p", "--provider", "volcengine", "--api-key", VIDEO_KEY,
      "--image", writeImage("a.png"), "--image", writeImage("b.png"),
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/one --image/);
    expect(result.stderr).toMatch(/last_frame|首尾帧/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("fails on an unwritable --out-dir before creating the paid task", async () => {
    // A regular file in the parent position makes mkdir fail at once (ENOTDIR).
    // /proc or a chmod-based path would block or misbehave under the sandbox.
    const blocker = path.join(tempDir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const target = path.join(blocker, "out");

    const result = await run([
      "video", "generate", "p", "--provider", "volcengine",
      "--api-key", VIDEO_KEY, "--out-dir", target,
    ]);

    // Same class as the image path's: a UsageError, so exit 2, and nothing was spent.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(target);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt before any request", async () => {
    const result = await run(["video", "generate", "   ", "--provider", "volcengine", "--api-key", VIDEO_KEY]);

    expect(result.code).toBe(2);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("names both video dialects and the async contract in its help", async () => {
    const help = (await run(["video", "generate", "--help"])).stdout;

    expect(help).toContain("doubao-seedance-1-0-pro-250528");
    expect(help).toContain("--no-wait");
    // Both dialects are registered now, so both may be named.
    expect(help).toContain("MiniMax-H3");
    // --seed is ark-only, so the variant advice must say so.
    expect(help).toContain("Ark-only flags");
    expect(help).toContain("--seed");
    expect(help).toContain("video status");

    // The root help is where someone decides whether to run this at all, so the
    // fact that creating a task is what costs money belongs there too.
    const root = (await run(["--help"])).stdout;
    expect(root).toContain("video generate");
    expect(root).toContain("pay for a video task");
    expect(root).toContain("mediagen video generate --help");
  });
});

describe("video status", () => {
  beforeEach(() => {
    writeConfig(VIDEO_CONFIG);
  });

  it("asks once and reports a running task as a success with no files", async () => {
    const stub = stubVideoFetch([jsonResponse({ status: "running" })]);

    const result = await run([
      "video", "status", "cgt-1", "--provider", "volcengine",
      "--api-key", VIDEO_KEY, "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, task_id: "cgt-1", status: "running", files: [], errors: [],
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("GET");
    expect(stub.calls[0].url).toBe(`${VIDEO_CREATE_URL}/cgt-1`);
  });

  it("downloads the clip when the task has finished", async () => {
    stubVideoFetch([
      jsonResponse({ status: "succeeded", model: "doubao-seedance-1-0-pro-250528", content: { video_url: "https://cdn.example.com/v.mp4" } }),
      mp4Response(),
    ]);

    const result = await run([
      "video", "status", "cgt-1", "--provider", "volcengine",
      "--api-key", VIDEO_KEY, "--out-dir", outDir,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/volcengine-doubao-seedance-1-0-pro-250528-.*-0\.mp4$/);
  });

  it("names the model the server reported, not the one the config defaults to", async () => {
    stubVideoFetch([
      jsonResponse({ status: "succeeded", model: "doubao-seedance-2-5-260628", content: { video_url: "https://cdn.example.com/v.mp4" } }),
      mp4Response(),
    ]);

    const result = await run([
      "video", "status", "cgt-1", "--provider", "volcengine",
      "--api-key", VIDEO_KEY, "--out-dir", outDir,
    ]);

    expect(result.stdout).toContain("doubao-seedance-2-5-260628");
  });

  it("exits 1 and keeps the vendor's message when the task failed", async () => {
    stubVideoFetch([
      jsonResponse({ status: "failed", error: { code: "OutputVideoSensitiveContentDetected", message: "blocked by policy" } }),
    ]);

    const result = await run([
      "video", "status", "cgt-1", "--provider", "volcengine", "--api-key", VIDEO_KEY,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("blocked by policy");
    expect(result.stderr).toContain("cgt-1");
  });

  it("rejects an empty task id without a request", async () => {
    const result = await run(["video", "status", "", "--provider", "volcengine", "--api-key", VIDEO_KEY]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("task id is required");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("says it asks once and spends nothing", async () => {
    const help = (await run(["video", "status", "--help"])).stdout;

    expect(help).toContain("asks once");
    expect(help).toContain("nothing is billed");
    // Both claims were wrong once; pin the corrected wording.
    expect(help).toContain("the only one that cannot spend money");
    expect(help).toContain("is not sent");
  });
});

describe("the minimax dialect in config and on the video command", () => {
  it("stores a minimax video table and shows its endpoint", async () => {
    const added = await run([
      "config", "add", "mm",
      "--api-type", "minimax",
      "--base-url", "https://api.minimax.io",
      "--task", "video",
      "--model", "MiniMax-H3",
    ]);

    expect(added.code).toBe(0);
    expect(loadConfig().providers.mm.tasks.video).toEqual({
      api_type: "minimax",
      default: "MiniMax-H3",
      models: ["MiniMax-H3"],
    });

    const shown = await run(["config", "show"]);
    expect(shown.stdout).toContain("endpoint: https://api.minimax.io/v2/video_generation");

    // `config add --help` is where a user learns minimax is a legal value.
    const help = (await run(["config", "add", "--help"])).stdout;
    expect(help).toContain("minimax");
  });

  it("points at --provider when a minimax provider is asked for another host's task", async () => {
    writeConfig(`default_provider = "mm"

[providers.mm]
base_url = "https://api.minimax.io"
api_key_env = "MINIMAX_API_KEY"

[providers.mm.video]
api_type = "minimax"
default = "MiniMax-H3"
models = ["MiniMax-H3"]
`);
    stubVideoFetch([new Response("", { status: 404 })]);

    const result = await run(["video", "status", "cgt-ark-task", "--provider", "mm", "--api-key", "sk-mm-1"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--provider");
    expect(result.stderr).toContain("cgt-ark-task");
  });
});
