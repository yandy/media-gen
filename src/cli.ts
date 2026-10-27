#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { parse as parseToml, type TomlTable } from "smol-toml";
import {
  authPath,
  maskKey,
  removeApiKey,
  resolveApiKey,
  saveApiKey,
  type ApiKeySource,
  type StoredKeySource,
} from "./auth.js";
import {
  configPath,
  loadConfig,
  noProviderSelectedMessage,
  prepareConfigFile,
  resolveProvider,
  writeConfigFile,
  type MediagenConfig,
  type ProviderOverride,
} from "./config.js";
import { ConfigError, UsageError } from "./errors.js";
import { runGenerate, type GenerateOptions } from "./generate.js";
import { renderError, renderHuman, renderJson, type RenderedOutput } from "./output.js";
import { shellArg, tomlBasicString, tomlKey } from "./toml.js";
import { dialectPath } from "./api/index.js";
import { normalizeHttpBaseUrl } from "./util.js";

/**
 * Everything the CLI needs from the outside world that tests must be able to
 * replace. `isTTY` is a function because a test decides it per invocation.
 */
export interface CliDeps {
  isTTY?: () => boolean;
  /** Reads one line of secret input without echoing it. */
  readSecret?: (prompt: string) => Promise<string>;
}

export interface ProgramOptions {
  deps?: CliDeps;
  /** Where commander writes help and usage errors; defaults to the process streams. */
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

/** Where a configuration value came from, for `config show`. */
type ValueSource = "config.toml" | "default";

interface ConfiguredValue {
  value: string;
  source: ValueSource;
}

interface KeyStatus {
  configured: boolean;
  source: StoredKeySource | "none";
  masked_key?: string;
}

interface ProviderView {
  name: string;
  api_type?: ConfiguredValue;
  base_url?: ConfiguredValue;
  model?: ConfiguredValue;
  api_key_env?: ConfiguredValue;
  /** base_url + the dialect endpoint: the URL a request would actually hit. */
  endpoint?: string;
  api_key: KeyStatus;
  missing?: string[];
}

interface LoginFlags {
  provider?: string;
  apiKey?: string;
  json?: boolean;
}

interface ConfigAddFlags {
  apiType?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  json?: boolean;
}

interface ProviderFlags {
  provider?: string;
  json?: boolean;
}

interface ImageFlags {
  provider?: string;
  model?: string;
  image?: string[];
  size?: string;
  n?: string;
  seed?: string;
  watermark?: string;
  negativePrompt?: string;
  promptExtend?: string;
  promptExtendMode?: string;
  enableThinking?: string;
  outputFormat?: string;
  optimizePrompt?: string;
  layerDecomposition?: string;
  background?: string;
  outDir?: string;
  json?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

const ROOT_HELP = `
Built for AI agents: explicit flags, no interactive prompts, machine-readable output.

Quickstart:
  mediagen config show                                    # any command creates config.toml on first use
  mediagen config add my-proxy --api-type qwen --base-url https://proxy.example.com --model qwen-image-3.0
  mediagen login --provider my-proxy --api-key sk-...      # store a key in auth.json
  mediagen image generate "a red fox in fresh snow" --provider my-proxy --out-dir ./out
  mediagen image edit "make the sky sunset orange" --image ./photo.jpg
  mediagen image generate "..." --json               # {"ok":..,"files":[..],"errors":[..]}

Subcommands:
  login / logout    store or remove a provider's API key in auth.json; provider
                    definitions live in config.toml
  auth status       which key each provider would use and where it came from (masked)
  config show       the resolved configuration, with a source note for each value
  config path       where config.toml lives
  config add        create a provider in config.toml (edit the file for anything else)

Exit codes: 0 success (including a partial success that saved at least one file),
1 an API/config/runtime failure, 2 a usage error.

Run "mediagen image generate --help" for the flag list, the model table and examples.`;

/** Shared body of the `image generate` / `image edit` help; examples match the command. */
function imageHelpText(command: "generate" | "edit"): string {
  const intro =
    command === "edit"
      ? "Edit images: identical to \"mediagen image generate\" except that at least one --image is required."
      : "Generate an image from a prompt. Add --image to switch to image-to-image editing.";

  const examples =
    command === "edit"
      ? `  # edit a local file (local paths are read and sent as base64 data URLs)
  mediagen image edit "make the sky sunset orange, keep the composition" --image ./photo.jpg --provider dashscope

  # combine several references
  mediagen image edit "put the character from the first image into the scene from the second" --image ./character.png --image ./scene.jpg --provider dashscope

  # ark layer decomposition: one paid request, several files back (base + layers)
  mediagen image edit "separate the sticker from its background" --image ./sticker.png --provider volcengine --layer-decomposition true --json

  # a third-party proxy declared as [providers.my-proxy] in config.toml
  mediagen image edit "remove the timestamp" --image ./shot.png --provider my-proxy --out-dir ./out`
      : `  # text to image
  mediagen image generate "a red fox in fresh snow, soft morning light" --provider dashscope --size 1024x1024 --out-dir ./out

  # image to image; "mediagen image edit" is the same command with --image required
  mediagen image generate "make the sky sunset orange, keep the composition" --image ./photo.jpg --provider dashscope

  # several references at once
  mediagen image generate "the character from the first image wearing the jacket from the second" --image ./character.png --image ./jacket.png --provider dashscope

  # four ark variants as JSON, for an agent to parse
  mediagen image generate "minimalist logo for a coffee roastery" --provider volcengine --model doubao-seedream-5-0-pro --n 4 --seed 42 --json

  # a third-party proxy declared as [providers.my-proxy] in config.toml
  mediagen image generate "product photo on a white background" --provider my-proxy --out-dir ./shots

  # a one-off test against a proxy, without touching config.toml
  mediagen image generate "colour test card" --provider dashscope --base-url https://proxy.example.com --api-key sk-...`;

  return `
${intro}

Models (--provider picks the endpoint declared in config.toml, --model the exact id):
  qwen-image-3.0              dashscope   best text rendering (CJK + Latin) and image editing
  doubao-seedream-5-0-flash   volcengine  fastest; use it for drafts and iteration
  doubao-seedream-5-0-pro     volcengine  highest quality; slower and more expensive
  The provider names above are the two the first run writes into config.toml.
  Snapshot ids roll forward, so override any of them with --model or in config.toml.

Sizes (--size, passed through to the vendor; omit it for the vendor default):
  tiers    1K | 1.5K | 2K | 3K | 4K     ark takes these (its default is 2K)
  pixels   WxH with a lowercase x, e.g. 2048x2048, 1536x2048, 1024x1024
  auto     qwen only; omitting --size lets qwen choose a resolution from the prompt

Images and count:
  --image <path-or-url>  repeatable; a local file becomes a data:<mime>;base64 URL
  --n <count>            1-6 images. ark fans out into one paid request per image
                         (seeds seed, seed+1, ...); qwen sends a single request.

Output:
  Files are written to --out-dir (default: config output_dir, else the current
  directory) as <provider>-<model>-<yyyyMMdd-HHmmss>-<index>.<ext>. Human mode prints
  one absolute path per line on stdout and warnings on stderr; --json prints a single
  object with ok, partial, files[], errors[], usage and request_id. Partial success
  exits 0 and lists each failure: the images on disk were already paid for, so do not
  retry the whole request.

Vendor-specific flags:
  qwen only  --negative-prompt --prompt-extend --prompt-extend-mode --enable-thinking
  ark only   --output-format --optimize-prompt --layer-decomposition --background
  A flag the selected dialect does not accept fails before any paid request is sent.
  Boolean flags take an explicit value: --watermark false, not --no-watermark.

Examples:
${examples}`;
}

const IMAGE_OPTION_HELP = {
  provider: "provider name declared in config.toml (default: config default_provider)",
  model: "model id (default: the provider's configured model)",
  image: "reference image, repeatable; local files are sent as data URLs",
  size: "1K|1.5K|2K|3K|4K, WxH pixels, or auto (qwen only)",
  n: "how many images, 1-6 (ark sends one paid request per image)",
  seed: "random seed; ark fan-out uses seed, seed+1, ...",
  watermark: "true|false (default: the vendor default, qwen false / ark true)",
  negativePrompt: "qwen only: what the image must not contain",
  promptExtend: "qwen only: true|false prompt rewriting",
  promptExtendMode: "qwen only: agent mode is text-to-image only",
  enableThinking: "qwen only: true|false",
  outputFormat: "ark only (default: the vendor default, jpeg)",
  optimizePrompt: "ark only; flash models accept standard only",
  layerDecomposition: "ark only: true|false, needs --image, returns several files",
  background: "ark only: transparent needs one input with an alpha channel",
  outDir: "where to write files (default: config output_dir, else cwd)",
  json: "print one JSON object instead of file paths",
  apiKey: "one-off API key; overrides env and auth.json",
  baseUrl: "one-off API base URL, e.g. a proxy",
} as const;

/** Adds the flags shared by `image generate` and `image edit`. */
function addImageOptions(command: Command): Command {
  return command
    .option("--provider <name>", IMAGE_OPTION_HELP.provider)
    .option("--model <id>", IMAGE_OPTION_HELP.model)
    .option("--image <path-or-url>", IMAGE_OPTION_HELP.image, collectImage)
    .option("--size <size>", IMAGE_OPTION_HELP.size)
    .option("--n <count>", IMAGE_OPTION_HELP.n)
    .option("--seed <seed>", IMAGE_OPTION_HELP.seed)
    .option("--watermark <bool>", IMAGE_OPTION_HELP.watermark)
    .option("--negative-prompt <text>", IMAGE_OPTION_HELP.negativePrompt)
    .option("--prompt-extend <bool>", IMAGE_OPTION_HELP.promptExtend)
    .option("--prompt-extend-mode <direct|agent>", IMAGE_OPTION_HELP.promptExtendMode)
    .option("--enable-thinking <bool>", IMAGE_OPTION_HELP.enableThinking)
    .option("--output-format <png|jpeg>", IMAGE_OPTION_HELP.outputFormat)
    .option("--optimize-prompt <standard|fast>", IMAGE_OPTION_HELP.optimizePrompt)
    .option("--layer-decomposition <bool>", IMAGE_OPTION_HELP.layerDecomposition)
    .option("--background <transparent|opaque>", IMAGE_OPTION_HELP.background)
    .option("--out-dir <dir>", IMAGE_OPTION_HELP.outDir)
    .option("--json", IMAGE_OPTION_HELP.json)
    .option("--api-key <key>", IMAGE_OPTION_HELP.apiKey)
    .option("--base-url <url>", IMAGE_OPTION_HELP.baseUrl);
}

function collectImage(value: string, previous: string[] | undefined): string[] {
  return previous === undefined ? [value] : [...previous, value];
}

/**
 * Assembles the whole command tree. `exitOverride()` and `configureOutput()`
 * must be set before any `.command()` call: commander copies both to a
 * subcommand when it is created, so setting them later would only affect the
 * root command.
 */
export function createProgram(options: ProgramOptions = {}): Command {
  const deps = options.deps ?? {};
  const program = new Command("mediagen");

  program
    .description(
      "Generate and edit images through Alibaba Bailian (qwen) and Volcengine Ark (doubao/seedream).",
    )
    .exitOverride()
    .configureOutput({
      writeOut: options.writeOut ?? ((text) => process.stdout.write(text)),
      writeErr: options.writeErr ?? ((text) => process.stderr.write(text)),
    })
    .addHelpText("after", ROOT_HELP);

  program
    .command("login")
    .description("Store an API key for a provider in auth.json (mode 600)")
    .option("--provider <name>", "provider name (default: config default_provider)")
    .option("--api-key <key>", "the key; omit to be prompted (needs a TTY)")
    .option("--json", "print a JSON result")
    .action(async (flags: LoginFlags) => {
      await runLogin(flags, deps);
    });

  program
    .command("logout")
    .description("Remove the stored API key for a provider")
    .option("--provider <name>", "provider name (default: config default_provider)")
    .option("--json", "print a JSON result")
    .action(async (flags: ProviderFlags) => {
      runLogout(flags);
    });

  const auth = program.command("auth").description("Inspect stored credentials");
  auth
    .command("status")
    .description("Show which API key each provider would use, and where it came from")
    .option("--json", "print a JSON result")
    .action(async (flags: { json?: boolean }) => {
      runAuthStatus(flags);
    });

  const config = program.command("config").description("Inspect the resolved configuration");
  config
    .command("show")
    .description("Print the effective configuration with a source note for each value")
    .option("--json", "print a JSON result")
    .action(async (flags: { json?: boolean }) => {
      runConfigShow(flags);
    });
  config
    .command("path")
    .description("Print the path of config.toml")
    .option("--json", "print a JSON result")
    .action(async (flags: { json?: boolean }) => {
      runConfigPath(flags);
    });
  config
    .command("add <name>")
    .description("Create a [providers.<name>] table in config.toml")
    .option("--api-type <dialect>", "protocol dialect: qwen or ark")
    .option("--base-url <url>", "the provider's API base URL")
    .option("--model <id>", "the model id this provider defaults to")
    .option("--api-key-env <VAR>", "environment variable holding this provider's key")
    .option("--json", "print a JSON result")
    .action(async (name: string, flags: ConfigAddFlags) => {
      runConfigAdd(name, flags);
    });

  const image = program.command("image").description("Generate and edit images");

  const generate = image
    .command("generate")
    .description("Generate an image from a prompt; add --image to edit")
    .argument("<prompt>", "what to draw; quote it and describe the subject, style and text");
  addImageOptions(generate).addHelpText("after", imageHelpText("generate"));
  generate.action(async (prompt: string, flags: ImageFlags) => {
    await runImage(prompt, flags, false);
  });

  const edit = image
    .command("edit")
    .description("Edit images: like generate, but --image is required")
    .argument("<prompt>", "the edit to perform; quote it and name what must stay unchanged");
  addImageOptions(edit).addHelpText("after", imageHelpText("edit"));
  edit.action(async (prompt: string, flags: ImageFlags) => {
    await runImage(prompt, flags, true);
  });

  return program;
}

/**
 * `--help` and `--version` must work when config.toml is broken or cannot be
 * created, so they skip the bootstrap. Commander's implicit `help` command is
 * exempt too: it is printed in the CLI's own command list, so a user whose config
 * is broken will reach for it. The scan stops at `--` so a prompt that happens to
 * read "--help" (`image generate -- --help`) is not mistaken for a request for
 * help.
 */
export function requestsHelpOrVersion(argv: string[]): boolean {
  // `help [command]` only exists as the first token; anything later is a value.
  if (argv[0] === "help") return true;

  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "-h" || arg === "--help" || arg === "-V" || arg === "--version") return true;
  }
  return false;
}

/**
 * Runs the CLI and returns the exit code without ever calling `process.exit`,
 * so tests can drive it in-process and the bin wrapper owns the exit.
 *
 * The bootstrap stage runs before commander dispatches: config.toml is created
 * when absent and validated when present, so every command sees the same file
 * and a broken one is reported as a `ConfigError` before any command logic runs.
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  // Commander's own diagnostics are buffered so that a usage error can still be
  // reported as JSON when the caller asked for --json.
  const buffer: string[] = [];

  try {
    if (!requestsHelpOrVersion(argv)) prepareConfigFile();

    const program = createProgram({
      deps,
      writeOut: (text) => buffer.push(text),
      writeErr: (text) => buffer.push(text),
    });
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return reportCommanderError(error, buffer.join(""), argv.includes("--json"));
    }
    return reportError(error, argv.includes("--json"));
  }
}

/** Writes each non-empty stream of a rendered result, adding the trailing newline. */
function emit(rendered: RenderedOutput): void {
  if (rendered.stdout !== "") process.stdout.write(`${rendered.stdout}\n`);
  if (rendered.stderr !== "") process.stderr.write(`${rendered.stderr}\n`);
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function reportError(error: unknown, jsonMode: boolean): number {
  const rendered = renderError(error, jsonMode);
  emit(rendered);
  return rendered.exitCode;
}

/**
 * Commander throws instead of exiting because of `exitOverride()`. Help output is
 * a success; anything else is a usage error, which this CLI reports as exit 2.
 */
function reportCommanderError(error: CommanderError, text: string, jsonMode: boolean): number {
  if (error.exitCode === 0) {
    if (text !== "") process.stdout.write(text);
    return 0;
  }

  // A bare group command (`mediagen`, `mediagen image`, ...): show its help, then fail.
  if (error.code === "commander.help") {
    if (!jsonMode) {
      if (text !== "") process.stdout.write(text);
      return 2;
    }
    return reportError(
      new UsageError('missing command; run "mediagen --help" to list the commands'),
      true,
    );
  }

  const message = error.message.replace(/^error:\s*/, "").trim();
  if (jsonMode) return reportError(new UsageError(message), true);

  process.stderr.write(text.trim() === "" ? `${message}\n` : text);
  return 2;
}

async function runImage(prompt: string, flags: ImageFlags, edit: boolean): Promise<void> {
  const options = toGenerateOptions(flags, edit);
  const result = await runGenerate(prompt, options);

  if (flags.json === true) {
    writeLine(renderJson(result.saved, result.response));
    return;
  }
  emit(renderHuman(result.saved, result.response));
}

/** Converts the raw flag strings into `GenerateOptions`, so every failure is a UsageError. */
function toGenerateOptions(flags: ImageFlags, edit: boolean): GenerateOptions {
  return {
    provider: flags.provider,
    model: flags.model,
    images: flags.image ?? [],
    size: flags.size,
    n: parseInteger(flags.n, "--n"),
    seed: parseInteger(flags.seed, "--seed"),
    watermark: parseBool(flags.watermark, "--watermark"),
    negativePrompt: flags.negativePrompt,
    promptExtend: parseBool(flags.promptExtend, "--prompt-extend"),
    promptExtendMode: parseChoice(flags.promptExtendMode, ["direct", "agent"], "--prompt-extend-mode"),
    enableThinking: parseBool(flags.enableThinking, "--enable-thinking"),
    outputFormat: parseChoice(flags.outputFormat, ["png", "jpeg"], "--output-format"),
    optimizePrompt: parseChoice(flags.optimizePrompt, ["standard", "fast"], "--optimize-prompt"),
    layerDecomposition: parseBool(flags.layerDecomposition, "--layer-decomposition"),
    background: parseChoice(flags.background, ["transparent", "opaque"], "--background"),
    outDir: flags.outDir,
    apiKey: flags.apiKey,
    baseUrl: flags.baseUrl,
    edit,
  };
}

function parseBool(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new UsageError(`invalid ${flag} ${JSON.stringify(value)}: expected true or false`);
}

/**
 * Only plain decimal integers. `Number()` alone would accept `1e2`, `0x10` and
 * `1.0`, so `--n 1e2` would slip through as 100 images.
 */
const INTEGER_PATTERN = /^[+-]?\d+$/;

function parseInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new UsageError(`invalid ${flag} ${JSON.stringify(value)}: expected an integer`);
  }
  return Number(trimmed);
}

function parseChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const match = allowed.find((entry) => entry === normalized);
  if (match === undefined) {
    throw new UsageError(
      `invalid ${flag} ${JSON.stringify(value)}: expected one of ${allowed.join(", ")}`,
    );
  }
  return match;
}

async function runLogin(flags: LoginFlags, deps: CliDeps): Promise<void> {
  const config = loadConfig();
  const name = flags.provider ?? config.default_provider;
  assertKnownProvider(name, config);

  const key = await resolveLoginKey(name, flags.apiKey, deps);
  saveApiKey(name, key);

  const masked = maskKey(key);
  if (flags.json === true) {
    writeLine(
      JSON.stringify({
        ok: true,
        provider: name,
        masked_key: masked,
        auth_file: authPath(),
      }),
    );
    return;
  }

  writeLine(`saved API key ${masked} for provider "${name}" to ${authPath()}`);
}

/**
 * login stores keys but never creates a provider: a provider definition
 * (api_type/base_url/model) lives in config.toml, so an unknown name is a usage
 * error that points at the two ways to create one.
 */
function assertKnownProvider(name: string, config: MediagenConfig): void {
  if (name === "") throw new UsageError(noProviderSelectedMessage());
  if (!Object.hasOwn(config.providers, name)) {
    throw new UsageError(
      `unknown provider "${name}": login stores API keys but never creates providers; ` +
        `add a [providers.${tomlKey(name)}] table to ${configPath()} first ` +
        `(or run "mediagen config add ${shellArg(name)} ...")`,
    );
  }
  // A provider that exists but cannot resolve is just as unusable as a missing
  // one, and storing a key for it would look like success and then fail later.
  try {
    resolveProvider(name, config);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function resolveLoginKey(
  provider: string,
  flagKey: string | undefined,
  deps: CliDeps,
): Promise<string> {
  const fromFlag = flagKey?.trim();
  if (fromFlag !== undefined && fromFlag !== "") return fromFlag;

  const isTTY = deps.isTTY ?? (() => Boolean(process.stdin.isTTY));
  if (!isTTY()) {
    throw new UsageError(
      `no API key for provider "${provider}": pass --api-key <key>; ` +
        "reading the key interactively needs a TTY on stdin",
    );
  }

  const readSecret = deps.readSecret ?? readSecretFromTerminal;
  const key = (await readSecret(`API key for provider "${provider}" (input is hidden): `)).trim();
  if (key === "") throw new UsageError("the API key was empty; nothing was saved");
  return key;
}

/**
 * Reads one line from the terminal without echoing it: readline thinks it has a
 * terminal, but its output stream discards everything, so the keystrokes stay
 * invisible while editing (backspace) still works.
 */
function readSecretFromTerminal(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(promptText);

    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });

    const finish = (action: () => void): void => {
      rl.close();
      process.stderr.write("\n");
      action();
    };

    rl.on("SIGINT", () => {
      finish(() => reject(new UsageError("login cancelled")));
    });
    rl.question("", (answer) => {
      finish(() => resolve(answer));
    });
  });
}

function runLogout(flags: ProviderFlags): void {
  const config = loadConfig();
  const name = flags.provider ?? config.default_provider;
  if (name === "") throw new UsageError(noProviderSelectedMessage());
  const removed = removeApiKey(name);

  if (flags.json === true) {
    writeLine(JSON.stringify({ ok: true, provider: name, removed }));
    return;
  }
  writeLine(
    removed
      ? `removed the API key for provider "${name}" from ${authPath()}`
      : `no API key stored for provider "${name}"; nothing to do`,
  );
}

function runAuthStatus(flags: { json?: boolean }): void {
  const config = loadConfig();
  const entries: (KeyStatus & { name: string })[] = [];
  const details: string[] = [];

  for (const [name, override] of Object.entries(config.providers)) {
    const apiKeyEnv = override.api_key_env;
    const resolved = resolveApiKey({ name, api_key_env: apiKeyEnv }, undefined, process.env);

    const entry: KeyStatus & { name: string } = {
      name,
      configured: resolved !== null,
      source: resolved?.source ?? "none",
    };
    if (resolved !== null) {
      entry.masked_key = maskKey(resolved.key);
      details.push(`${entry.masked_key} (${describeKeySource(apiKeyEnv, resolved.source)})`);
    } else {
      details.push(`not configured (${missingKeyHint(name, apiKeyEnv)})`);
    }
    entries.push(entry);
  }

  if (flags.json === true) {
    writeLine(JSON.stringify({ providers: entries }));
    return;
  }

  const width = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
  const lines = entries.map((entry, index) => `${entry.name.padEnd(width)}  ${details[index]}`);
  lines.push(`auth file: ${authPath()}`);
  writeLine(lines.join("\n"));
}

/**
 * `auth.json` is keyed by provider name, and `resolveApiKey()` needs nothing but
 * that name and the entry's own `api_key_env`. An incomplete config.toml entry
 * can therefore still be reported instead of failing the whole command.
 */
function describeKeySource(apiKeyEnv: string | undefined, source: StoredKeySource): string {
  if (source === "env") return `env ${apiKeyEnv ?? "environment variable"}`;
  return `auth.json: ${authPath()}`;
}

function missingKeyHint(name: string, apiKeyEnv: string | undefined): string {
  const hints = [`run "mediagen login --provider ${shellArg(name)}"`];
  if (apiKeyEnv !== undefined) hints.push(`set ${apiKeyEnv}`);
  hints.push("pass --api-key");
  return hints.join(", ");
}

function runConfigPath(flags: { json?: boolean }): void {
  if (flags.json === true) {
    writeLine(JSON.stringify({ config_path: configPath(), auth_path: authPath() }));
    return;
  }
  writeLine(configPath());
}

/**
 * Creates one `[providers.<name>]` table. This is the only place the CLI creates
 * a provider, and it writes every required field at once: a table that exists but
 * is missing `base_url` or `model` cannot be produced from the command line.
 * Anything else — changing a value, removing an entry — is a text edit by hand.
 */
function runConfigAdd(name: string, flags: ConfigAddFlags): void {
  const provider = name.trim();
  if (provider === "") throw new UsageError("a provider name is required");

  const apiType = parseChoice(flags.apiType, ["qwen", "ark"], "--api-type");
  if (apiType === undefined) {
    throw new UsageError('--api-type is required: "qwen" or "ark"');
  }
  if (flags.baseUrl === undefined) throw new UsageError("--base-url is required");

  const model = (flags.model ?? "").trim();
  if (model === "") throw new UsageError("--model is required");
  // A blank optional field would be written out as an empty string, so it is
  // either sane or absent.
  const apiKeyEnv = flags.apiKeyEnv?.trim();
  if (flags.apiKeyEnv !== undefined && apiKeyEnv === "") {
    throw new UsageError("--api-key-env must not be empty");
  }

  const file = configPath();
  // The bootstrap in main() already created and validated this file, so the
  // append below sees exactly what the user will edit.
  const config = loadConfig();
  if (Object.hasOwn(config.providers, provider)) {
    // True whether the name is a real entry or a table that already nests one
    // (`[providers.a.b]`), which appending would also redefine.
    throw new UsageError(
      `a [providers.${tomlKey(provider)}] section already exists in ${file}; edit it by hand instead`,
    );
  }

  const fields: Record<string, string> = {
    api_type: apiType,
    base_url: normalizeBaseUrl(flags.baseUrl),
    model,
  };
  if (apiKeyEnv !== undefined) fields.api_key_env = apiKeyEnv;

  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const beforeTable = before.trim() === "" ? undefined : parseToml(before);
  const after = appendProviderTable(before, provider, fields);
  assertFaithfulRewrite(beforeTable, after, provider, fields, file);
  try {
    writeConfigFile(after);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot write ${file}: ${reason}`);
  }

  if (flags.json === true) {
    writeLine(JSON.stringify({ ok: true, provider, config_file: file, fields }));
    return;
  }

  const loginHint = `mediagen login --provider ${shellArg(provider)} --api-key ...`;
  const keyRoute =
    apiKeyEnv === undefined
      ? `run "${loginHint}" to store its key`
      : `set ${shellArg(apiKeyEnv)}, or run "${loginHint}"`;
  writeLine([`added provider "${provider}" to ${file}`, keyRoute].join("\n"));
}

function runConfigShow(flags: { json?: boolean }): void {
  const config = loadConfig();
  const file = configPath();
  const exists = fs.existsSync(file);
  // loadConfig() above already validated the file, so this parse cannot fail.
  const declared: TomlTable = exists ? parseToml(fs.readFileSync(file, "utf8")) : {};

  const defaultProvider = configuredValue(
    config.default_provider,
    declared.default_provider,
  );
  const outputDir = configuredValue(config.output_dir, declared.output_dir);
  const views = Object.entries(config.providers).map(([name, override]) => ({
    name,
    apiKeyEnv: override.api_key_env,
    view: buildProviderView(name, override),
  }));

  if (flags.json === true) {
    writeLine(
      JSON.stringify({
        config_file: { path: file, exists },
        default_provider: defaultProvider,
        output_dir: outputDir,
        providers: views.map(({ view }) => view),
      }),
    );
    return;
  }

  const lines = [
    `config file: ${file} (loaded)`,
    `default_provider: ${
      defaultProvider.value === "" ? `(not set) (${defaultProvider.source})` : show(defaultProvider)
    }`,
    `output_dir: ${outputDir.value} (${
      outputDir.source === "default" ? "default: current directory" : outputDir.source
    })`,
    "",
    "providers:",
  ];

  if (views.length === 0) {
    lines.push(
      "  (none; run \"mediagen config add <name> --api-type <qwen|ark> --base-url <url> --model <id>\")",
    );
  }

  for (const { name, apiKeyEnv, view } of views) {
    lines.push(`  ${view.name} (dialect ${view.api_type?.value ?? "unknown"})`);
    for (const field of ["api_type", "base_url", "model", "api_key_env"] as const) {
      const value = view[field];
      if (value !== undefined) lines.push(`    ${field}: ${show(value)}`);
    }
    if (view.endpoint !== undefined) lines.push(`    endpoint: ${view.endpoint} (computed)`);
    if (view.missing !== undefined && view.missing.length > 0) {
      lines.push(`    missing: ${view.missing.join(", ")} (required in ${file})`);
    }
    lines.push(
      view.api_key.configured && view.api_key.source !== "none"
        ? `    api_key: ${view.api_key.masked_key} (${describeKeySource(apiKeyEnv, view.api_key.source)})`
        : `    api_key: not set (${missingKeyHint(name, apiKeyEnv)})`,
    );
  }

  writeLine(lines.join("\n"));
}

function show(value: ConfiguredValue): string {
  return `${value.value} (${value.source})`;
}

/** A top-level value came from config.toml when the file declares the key. */
function configuredValue(value: string, declared: unknown): ConfiguredValue {
  return declared === undefined ? { value, source: "default" } : { value, source: "config.toml" };
}

function buildProviderView(name: string, entry: ProviderOverride): ProviderView {
  const field = (
    key: "api_type" | "base_url" | "model" | "api_key_env",
  ): ConfiguredValue | undefined => {
    const value = entry[key];
    return value === undefined ? undefined : { value, source: "config.toml" };
  };

  const missing: string[] = [];
  const fields: Partial<
    Record<"api_type" | "base_url" | "model" | "api_key_env", ConfiguredValue>
  > = {};

  for (const key of ["api_type", "base_url", "model", "api_key_env"] as const) {
    const value = field(key);
    if (value === undefined) {
      // api_key_env is optional everywhere; the rest are required, and missing
      // them is exactly what resolveProvider() will complain about.
      if (key !== "api_key_env") missing.push(key);
      continue;
    }
    fields[key] = value;
  }

  const view: ProviderView = {
    name,
    ...fields,
    api_key: keyStatus(name, entry.api_key_env),
  };

  // The dialect owns the endpoint, so this is the URL a request would hit. A
  // base_url that cannot be parsed gets no endpoint line rather than a throw:
  // config show has to survive a half-written file.
  const endpointPath = fields.api_type === undefined ? undefined : dialectPath(fields.api_type.value);
  const base = fields.base_url === undefined ? undefined : normalizeHttpBaseUrl(fields.base_url.value);
  if (endpointPath !== undefined && base !== undefined) view.endpoint = `${base}${endpointPath}`;
  if (missing.length > 0) view.missing = missing;
  return view;
}

function keyStatus(name: string, apiKeyEnv: string | undefined): KeyStatus {
  const resolved = resolveApiKey({ name, api_key_env: apiKeyEnv }, undefined, process.env);
  if (resolved === null) return { configured: false, source: "none" };
  return { configured: true, source: resolved.source, masked_key: maskKey(resolved.key) };
}

function normalizeBaseUrl(value: string): string {
  // normalizeHttpBaseUrl() trims, so whatever passes validation is exactly what
  // gets persisted and concatenated with the dialect endpoint.
  const normalized = normalizeHttpBaseUrl(value);
  if (normalized === undefined) {
    throw new UsageError(
      `invalid --base-url ${JSON.stringify(value)}: expected an absolute http(s) URL without query or fragment`,
    );
  }
  return normalized;
}

/** Appends a complete `[providers.<name>]` table; the caller checked it is absent. */
function appendProviderTable(text: string, name: string, fields: Record<string, string>): string {
  const lines = [`[providers.${tomlKey(name)}]`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key} = ${tomlBasicString(value)}`);
  }
  const base = text.trim() === "" ? "" : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
  return `${base}${lines.join("\n")}\n`;
}

/**
 * Confirms the rewritten TOML still parses, carries every field the rewrite
 * meant to write, and still contains every value the user had. A partial rewrite
 * that silently dropped a setting is worse than no rewrite, so the user is told
 * to edit the file instead.
 */
function assertFaithfulRewrite(
  before: TomlTable | undefined,
  after: string,
  name: string,
  expected: Record<string, string>,
  file: string,
): void {
  function fail(): never {
    throw new UsageError(
      `cannot safely rewrite ${file} for provider "${name}"; edit ${file} by hand instead`,
    );
  }

  let parsed: TomlTable;
  try {
    parsed = parseToml(after);
  } catch {
    fail();
  }

  const table = tableAt(parsed, ["providers", name]);
  for (const [key, value] of Object.entries(expected)) {
    if (table?.[key] !== value) fail();
  }
  // A brand new provider table is an addition, so nothing needs exempting.
  if (before !== undefined && !isPreserved(before, parsed, [])) fail();
}

function tableAt(table: TomlTable, keys: string[]): TomlTable | undefined {
  let current: unknown = table;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? (current as TomlTable) : undefined;
}

/**
 * True when every leaf of `before` is present and unchanged in `after`. The
 * `exempt` path names the one value the rewrite is allowed to replace; anything
 * `after` adds (a brand new provider section, for instance) is fine.
 *
 * TOML datetimes parse into `TomlDate` objects, so two parses of the same
 * document never share a reference and a Date is also `isRecord()`-shaped with
 * no enumerable keys: compare datetimes by time value first, or the check is
 * blind to them in both directions.
 */
function isPreserved(before: unknown, after: unknown, exempt: string[]): boolean {
  if (before instanceof Date || after instanceof Date) {
    return sameInstant(before, after);
  }

  if (isRecord(before)) {
    if (!isRecord(after)) return false;
    for (const [key, value] of Object.entries(before)) {
      if (exempt.length === 1 && exempt[0] === key) continue;
      if (!(key in after)) return false;
      const nested = exempt.length > 1 && exempt[0] === key ? exempt.slice(1) : [];
      if (!isPreserved(value, after[key], nested)) return false;
    }
    return true;
  }

  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length !== before.length) return false;
    return before.every((entry, index) => isPreserved(entry, after[index], []));
  }

  return before === after;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compares two TOML datetimes by the instant they name, not by reference. */
function sameInstant(before: unknown, after: unknown): boolean {
  if (!(before instanceof Date) || !(after instanceof Date)) return false;
  const left = before.getTime();
  const right = after.getTime();
  // A datetime no Date can represent is NaN on both sides of an unchanged file.
  return Number.isNaN(left) ? Number.isNaN(right) : left === right;
}

/**
 * The canonical `file://` URL of a module path, or `undefined` when there is no
 * such path (`node -e`, a REPL) or it cannot be resolved.
 *
 * Both sides of the guard below go through `realpathSync` because Node resolves the
 * *main* module through `realpath` too (that is what `--preserve-symlinks-main`
 * disables). Comparing a realpath'd `import.meta.url` against the raw `argv[1]` is
 * false for every symlinked invocation — the `mediagen` shim npm creates for
 * `bin.mediagen`, `npx`, `node_modules/.bin/mediagen` — which made the packaged binary
 * print nothing and exit 0, the worst failure mode for an agent-facing CLI.
 * Resolving both sides keeps `--preserve-symlinks-main` working as well.
 */
function realHref(modulePath: string | undefined): string | undefined {
  if (modulePath === undefined) return undefined;
  try {
    return pathToFileURL(fs.realpathSync(modulePath)).href;
  } catch {
    return undefined;
  }
}

/** This module's canonical URL, or `undefined` if a loader gave it a non-`file:` one. */
function selfHref(moduleUrl: string): string | undefined {
  try {
    return realHref(fileURLToPath(moduleUrl));
  } catch {
    return undefined;
  }
}

const thisModule = selfHref(import.meta.url);
const invokedAsScript = thisModule !== undefined && thisModule === realHref(process.argv[1]);

if (invokedAsScript) {
  process.exit(await main(process.argv.slice(2)));
}
