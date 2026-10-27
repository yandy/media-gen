import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authPath, loadAuth } from "./auth.js";
import { createProgram, main, type CliDeps } from "./cli.js";
import { configPath } from "./config.js";

const API_KEY = "sk-test1234567890";
/** maskKey() shows the first four and last four characters only. */
const MASKED_KEY = "sk-t…7890";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations";
const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

const TRACKED_ENV = [
  "MEDIAGEN_CLI_CONFIG_DIR",
  "XDG_CONFIG_HOME",
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

  process.env.MEDIAGEN_CLI_CONFIG_DIR = configHome;
  delete process.env.XDG_CONFIG_HOME;
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

describe("mediagen config show", () => {
  it("prints the built-in defaults with a source note for each value", async () => {
    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(configPath());
    expect(result.stdout).toMatch(/default_provider:\s+dashscope \(config\.toml\)/);
    expect(result.stdout).toMatch(/output_dir:\s+\S+ \(default/);
    expect(result.stdout).toContain("https://dashscope.aliyuncs.com (config.toml)");
    expect(result.stdout).toContain("https://ark.cn-beijing.volces.com (config.toml)");
    expect(result.stdout).toContain("/compatible-mode/v1/images/generations (default)");
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
model = "doubao-seedream-5-0-pro-260628"

[providers.my-proxy]
api_type = "ark"
base_url = "https://proxy.example.com"
model = "some-model"
api_key_env = "MY_PROXY_KEY"
`);

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/default_provider:\s+volcengine \(config\.toml\)/);
    expect(result.stdout).toMatch(/output_dir:\s+\.\/shots \(config\.toml\)/);
    expect(result.stdout).toContain("doubao-seedream-5-0-pro-260628 (config.toml)");
    expect(result.stdout).toContain("my-proxy");
    expect(result.stdout).toContain("https://proxy.example.com (config.toml)");
  });

  it("emits the resolved config as JSON with masked keys", async () => {
    process.env.ARK_API_KEY = API_KEY;
    writeConfig(
      '[providers.dashscope]\napi_type = "qwen"\nbase_url = "https://x"\nmodel = "my-qwen"\napi_key_env = "DASHSCOPE_API_KEY"\n\n[providers.volcengine]\napi_type = "ark"\nbase_url = "https://ark.cn-beijing.volces.com"\nmodel = "m"\napi_key_env = "ARK_API_KEY"\n',
    );

    const result = await run(["config", "show", "--json"]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.config_file).toEqual({ path: configPath(), exists: true });
    expect(payload.default_provider).toEqual({ value: "", source: "default" });

    const providers = payload.providers as Record<string, unknown>[];
    const dashscope = providers.find((entry) => entry.name === "dashscope");
    expect(dashscope?.model).toEqual({ value: "my-qwen", source: "config.toml" });
    expect(dashscope?.api_key).toEqual({ configured: false, source: "none" });

    const volcengine = providers.find((entry) => entry.name === "volcengine");
    expect(volcengine?.api_key).toEqual({
      configured: true,
      source: "env",
      masked_key: MASKED_KEY,
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("reports an incomplete custom provider instead of failing", async () => {
    writeConfig('[providers.half-baked]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\n');

    const result = await run(["config", "show"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("half-baked");
    expect(result.stdout).toMatch(/missing:\s+model/);
    expect(result.stdout).toContain("/api/v3/images/generations (default)");
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

  it("lists custom providers from config.toml", async () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\nmodel = "m"\napi_key_env = "MY_PROXY_KEY"\n',
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
      'default_provider = "volcengine"\n\n[providers.volcengine]\napi_type = "ark"\nbase_url = "https://ark.cn-beijing.volces.com"\nmodel = "m"\n',
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

  it("accepts a custom provider defined in config.toml", async () => {
    writeConfig(
      '[providers.my-proxy]\napi_type = "ark"\nbase_url = "https://proxy.example.com"\nmodel = "m"\n',
    );

    const result = await run(["login", "--provider", "my-proxy", "--api-key", API_KEY]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers["my-proxy"]?.api_key).toBe(API_KEY);
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
      'default_provider = "volcengine"\n\n[providers.volcengine]\napi_type = "ark"\nbase_url = "https://ark.cn-beijing.volces.com"\nmodel = "m"\n',
    );
    await run(["login", "--provider", "volcengine", "--api-key", API_KEY]);

    const result = await run(["logout"]);

    expect(result.code).toBe(0);
    expect(loadAuth().providers.volcengine).toBeUndefined();
  });
});

describe("mediagen image generate", () => {
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
