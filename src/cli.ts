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
} from "./auth.js";
import { configPath, loadConfig, type MediaConfig } from "./config.js";
import { UsageError } from "./errors.js";
import { runGenerate, type GenerateOptions } from "./generate.js";
import { renderError, renderHuman, renderJson, type RenderedOutput } from "./output.js";
import { BUILTIN_PROVIDERS, DIALECT_DEFAULT_PATHS } from "./providers.js";
import type { Dialect, ProviderConfig } from "./types.js";

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
type ValueSource = "built-in" | "config.toml" | "default";

interface ConfiguredValue {
  value: string;
  source: ValueSource;
}

interface KeyStatus {
  configured: boolean;
  source: ApiKeySource | "none";
  masked_key?: string;
}

interface ProviderView {
  name: string;
  custom: boolean;
  api_type?: ConfiguredValue;
  base_url?: ConfiguredValue;
  model?: ConfiguredValue;
  path?: ConfiguredValue;
  api_key_env?: ConfiguredValue;
  api_key: KeyStatus;
  missing?: string[];
}

interface LoginFlags {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
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
  media login --provider qwen --api-key sk-...    # store a key in auth.json
  media login --provider qwen --base-url https://proxy.example.com  # endpoint only; key from env
  media image generate "a red fox in fresh snow" --out-dir ./out
  media image edit "make the sky sunset orange" --image ./photo.jpg
  media image generate "..." --json               # {"ok":..,"files":[..],"errors":[..]}

Subcommands:
  login / logout    store or remove an API key, or set a base_url override; provider
                    definitions live in config.toml
  auth status       which key each provider would use and where it came from (masked)
  config show       the resolved configuration, with a source note per value
  config path       where config.toml lives

Exit codes: 0 success (including a partial success that saved at least one file),
1 an API/config/runtime failure, 2 a usage error.

Run "media image generate --help" for the flag list, the model table and examples.`;

/** Shared body of the `image generate` / `image edit` help; examples match the command. */
function imageHelpText(command: "generate" | "edit"): string {
  const intro =
    command === "edit"
      ? "Edit images: identical to \"media image generate\" except that at least one --image is required."
      : "Generate an image from a prompt. Add --image to switch to image-to-image editing.";

  const examples =
    command === "edit"
      ? `  # edit a local file (local paths are read and sent as base64 data URLs)
  media image edit "make the sky sunset orange, keep the composition" --image ./photo.jpg --provider qwen

  # combine several references
  media image edit "put the character from the first image into the scene from the second" --image ./character.png --image ./scene.jpg --provider qwen

  # ark layer decomposition: one paid request, several files back (base + layers)
  media image edit "separate the sticker from its background" --image ./sticker.png --provider ark --layer-decomposition true --json

  # a third-party proxy declared as [providers.my-proxy] in config.toml
  media image edit "remove the timestamp" --image ./shot.png --provider my-proxy --out-dir ./out`
      : `  # text to image
  media image generate "a red fox in fresh snow, soft morning light" --provider qwen --size 1024x1024 --out-dir ./out

  # image to image; "media image edit" is the same command with --image required
  media image generate "make the sky sunset orange, keep the composition" --image ./photo.jpg --provider qwen

  # several references at once
  media image generate "the character from the first image wearing the jacket from the second" --image ./character.png --image ./jacket.png --provider qwen

  # four ark variants as JSON, for an agent to parse
  media image generate "minimalist logo for a coffee roastery" --provider ark --model doubao-seedream-5-0-pro --n 4 --seed 42 --json

  # a third-party proxy declared as [providers.my-proxy] in config.toml
  media image generate "product photo on a white background" --provider my-proxy --out-dir ./shots

  # a one-off test against a proxy, without touching config.toml
  media image generate "colour test card" --provider qwen --base-url https://proxy.example.com --api-key sk-...`;

  return `
${intro}

Models (--provider picks the vendor dialect, --model the exact id):
  qwen-image-3.0              qwen  best text rendering (CJK + Latin) and image editing
  doubao-seedream-5-0-flash   ark   fastest; use it for drafts and iteration
  doubao-seedream-5-0-pro     ark   highest quality; slower and more expensive
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
  provider: "provider name: qwen, ark, or a [providers.<name>] from config.toml",
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
  const program = new Command("media");

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
    .description("Store an API key for a provider in auth.json (mode 600), or set only its base_url")
    .option("--provider <name>", "provider name (default: config default_provider)")
    .option("--api-key <key>", "the key; omit to be prompted (needs a TTY), or omit with --base-url to change only the endpoint")
    .option("--base-url <url>", "point this provider's base_url at a URL in config.toml; alone it stores no key")
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
    .description("Print the effective configuration with a source note per value")
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
 * Runs the CLI and returns the exit code without ever calling `process.exit`,
 * so tests can drive it in-process and the bin wrapper owns the exit.
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  // Commander's own diagnostics are buffered so that a usage error can still be
  // reported as JSON when the caller asked for --json.
  const buffer: string[] = [];

  try {
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

  // A bare group command (`media`, `media image`, ...): show its help, then fail.
  if (error.code === "commander.help") {
    if (!jsonMode) {
      if (text !== "") process.stdout.write(text);
      return 2;
    }
    return reportError(
      new UsageError('missing command; run "media --help" to list the commands'),
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
  // Validated before anything is written, so a bad URL cannot leave a half-updated config.
  const baseUrl = flags.baseUrl === undefined ? undefined : normalizeBaseUrl(flags.baseUrl);

  // `--base-url` on its own is a pure endpoint override: it rewrites config.toml
  // and must neither read nor store a key, because the third-party-proxy case is
  // "point the built-in provider elsewhere, the key comes from the environment".
  if (baseUrl !== undefined && (flags.apiKey?.trim() ?? "") === "") {
    runBaseUrlOnlyLogin(name, baseUrl, config, flags.json === true);
    return;
  }

  const key = await resolveLoginKey(name, flags.apiKey, deps);
  // Rewrite the config before storing the key: a refused rewrite must leave no
  // half-configured provider with a fresh key attached to it.
  const configFile = baseUrl === undefined ? undefined : setProviderBaseUrl(name, baseUrl);
  saveApiKey(name, key);

  const masked = maskKey(key);
  if (flags.json === true) {
    const payload: Record<string, unknown> = {
      ok: true,
      provider: name,
      masked_key: masked,
      auth_file: authPath(),
    };
    if (baseUrl !== undefined) payload.base_url = baseUrl;
    if (configFile !== undefined) payload.config_file = configFile;
    writeLine(JSON.stringify(payload));
    return;
  }

  const lines = [`saved API key ${masked} for provider "${name}" to ${authPath()}`];
  if (baseUrl !== undefined && configFile !== undefined) {
    lines.push(`set base_url for provider "${name}" to ${baseUrl} in ${configFile}`);
  }
  writeLine(lines.join("\n"));
}

/**
 * `media login --provider P --base-url U` with no `--api-key`: writes only
 * base_url to config.toml and tells the user where the key has to come from,
 * since nothing was stored and no prompt was shown.
 */
function runBaseUrlOnlyLogin(
  name: string,
  baseUrl: string,
  config: MediaConfig,
  json: boolean,
): void {
  const configFile = setProviderBaseUrl(name, baseUrl);

  if (json) {
    writeLine(
      JSON.stringify({
        ok: true,
        provider: name,
        base_url: baseUrl,
        config_file: configFile,
        api_key_stored: false,
      }),
    );
    return;
  }

  writeLine(
    [
      `set base_url for provider "${name}" to ${baseUrl} in ${configFile}`,
      `no API key was stored: ${keyRouteHint(name, config)}`,
    ].join("\n"),
  );
}

/** How provider `name` gets its key now that login stored none. */
function keyRouteHint(name: string, config: MediaConfig): string {
  const keyEnv = envVarFor(buildProbe(name, config.providers[name]));
  const route =
    keyEnv === undefined
      ? `declare api_key_env under [providers.${tomlKey(name)}] in ${configPath()} and set that variable`
      : `set the ${keyEnv} environment variable`;
  return `${route}, or run "media login --provider ${name} --api-key ..." to store one`;
}

/**
 * login stores keys and base_url overrides but never creates a provider: a
 * provider definition (api_type/base_url/model) lives in config.toml, so an
 * unknown name is a usage error that points at the file.
 */
function assertKnownProvider(name: string, config: MediaConfig): void {
  if (Object.hasOwn(BUILTIN_PROVIDERS, name) || Object.hasOwn(config.providers, name)) return;
  throw new UsageError(
    `unknown provider "${name}": login stores API keys but never creates providers; ` +
      `add a [providers.${name}] table to ${configPath()} first`,
  );
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

  for (const provider of providerProbes(config)) {
    const resolved = resolveApiKey(provider, undefined, process.env);

    const entry: KeyStatus & { name: string } = {
      name: provider.name,
      configured: resolved !== null,
      source: resolved?.source ?? "none",
    };
    if (resolved !== null) {
      entry.masked_key = maskKey(resolved.key);
      details.push(`${entry.masked_key} (${describeKeySource(provider, resolved.source)})`);
    } else {
      details.push(`not configured (${missingKeyHint(provider)})`);
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
 * resolveApiKey() only reads `name` and `api_key_env`, so a probe can stand in
 * for a provider whose config.toml entry is incomplete: `auth status` and
 * `config show` must report such a provider instead of failing.
 */
function providerProbes(config: MediaConfig): ProviderConfig[] {
  const names = [
    ...Object.keys(BUILTIN_PROVIDERS),
    ...Object.keys(config.providers).filter((name) => !Object.hasOwn(BUILTIN_PROVIDERS, name)),
  ];
  return names.map((name) => buildProbe(name, config.providers[name]));
}

function buildProbe(name: string, override?: Partial<ProviderConfig>): ProviderConfig {
  const builtin = Object.hasOwn(BUILTIN_PROVIDERS, name) ? BUILTIN_PROVIDERS[name] : undefined;
  const probe: ProviderConfig = {
    name,
    api_type: (override?.api_type ?? builtin?.api_type ?? "qwen") as Dialect,
    base_url: override?.base_url ?? builtin?.base_url ?? "",
    model: override?.model ?? builtin?.model ?? "",
    path: override?.path ?? builtin?.path ?? "",
    custom: builtin === undefined,
  };

  const keyEnv = override?.api_key_env ?? builtin?.api_key_env;
  if (keyEnv !== undefined) probe.api_key_env = keyEnv;
  return probe;
}

function envVarFor(provider: ProviderConfig): string | undefined {
  if (provider.api_key_env !== undefined) return provider.api_key_env;
  const builtin = Object.hasOwn(BUILTIN_PROVIDERS, provider.name)
    ? BUILTIN_PROVIDERS[provider.name]
    : undefined;
  return builtin?.api_key_env;
}

function describeKeySource(provider: ProviderConfig, source: ApiKeySource): string {
  if (source === "flag") return "--api-key";
  if (source === "env") return `env ${envVarFor(provider) ?? "environment variable"}`;
  return `auth.json: ${authPath()}`;
}

function missingKeyHint(provider: ProviderConfig): string {
  const hints = [`run "media login --provider ${provider.name}"`];
  const keyEnv = envVarFor(provider);
  if (keyEnv !== undefined) hints.push(`set ${keyEnv}`);
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

function runConfigShow(flags: { json?: boolean }): void {
  const config = loadConfig();
  const file = configPath();
  const exists = fs.existsSync(file);
  // loadConfig() above already validated the file, so this parse cannot fail.
  const declared: TomlTable = exists ? parseToml(fs.readFileSync(file, "utf8")) : {};

  const defaultProvider = configuredValue(config.default_provider, declared.default_provider);
  const outputDir = configuredValue(config.output_dir, declared.output_dir);
  const views = providerProbes(config).map((probe) => ({
    probe,
    view: buildProviderView(probe, config),
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
    `config file: ${file} (${exists ? "loaded" : "not found; using built-in defaults"})`,
    `default_provider: ${show(defaultProvider)}`,
    `output_dir: ${outputDir.value} (${
      outputDir.source === "default" ? "default: current directory" : outputDir.source
    })`,
    "",
    "providers:",
  ];

  for (const { probe, view } of views) {
    lines.push(
      `  ${view.name} (${view.custom ? "custom" : "built-in"}, dialect ${
        view.api_type?.value ?? "unknown"
      })`,
    );
    for (const field of ["api_type", "base_url", "model", "path", "api_key_env"] as const) {
      const value = view[field];
      if (value !== undefined) lines.push(`    ${field}: ${show(value)}`);
    }
    if (view.missing !== undefined && view.missing.length > 0) {
      lines.push(`    missing: ${view.missing.join(", ")} (required in ${file})`);
    }
    lines.push(
      view.api_key.configured && view.api_key.source !== "none"
        ? `    api_key: ${view.api_key.masked_key} (${describeKeySource(probe, view.api_key.source)})`
        : `    api_key: not set (${missingKeyHint(probe)})`,
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

function buildProviderView(probe: ProviderConfig, config: MediaConfig): ProviderView {
  const override: Partial<ProviderConfig> | undefined = config.providers[probe.name];
  const builtin = Object.hasOwn(BUILTIN_PROVIDERS, probe.name)
    ? BUILTIN_PROVIDERS[probe.name]
    : undefined;

  const field = (
    key: "api_type" | "base_url" | "model" | "path" | "api_key_env",
  ): ConfiguredValue | undefined => {
    const fromConfig = override?.[key];
    if (fromConfig !== undefined) return { value: fromConfig, source: "config.toml" };
    const fromBuiltin = builtin?.[key];
    if (fromBuiltin !== undefined) return { value: fromBuiltin, source: "built-in" };
    return undefined;
  };

  const missing: string[] = [];
  const fields: Partial<
    Record<"api_type" | "base_url" | "model" | "path" | "api_key_env", ConfiguredValue>
  > = {};

  for (const key of ["api_type", "base_url", "model", "path", "api_key_env"] as const) {
    const value = field(key);
    if (value === undefined) {
      // api_key_env and path are optional everywhere; the rest are required for
      // a custom provider, which is what resolveProvider() will complain about.
      if (key !== "api_key_env" && key !== "path" && builtin === undefined) missing.push(key);
      continue;
    }
    fields[key] = value;
  }

  // resolveProvider() fills a missing path with the dialect default, so
  // config show reports the path a request will actually use.
  const apiType = fields.api_type?.value;
  if (fields.path === undefined && (apiType === "qwen" || apiType === "ark")) {
    fields.path = { value: DIALECT_DEFAULT_PATHS[apiType], source: "default" };
  }

  const view: ProviderView = {
    name: probe.name,
    custom: builtin === undefined,
    ...fields,
    api_key: keyStatus(probe),
  };
  if (missing.length > 0) view.missing = missing;
  return view;
}

function keyStatus(probe: ProviderConfig): KeyStatus {
  const resolved = resolveApiKey(probe, undefined, process.env);
  if (resolved === null) return { configured: false, source: "none" };
  return { configured: true, source: resolved.source, masked_key: maskKey(resolved.key) };
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(
      `invalid --base-url ${JSON.stringify(value)}: expected an absolute http(s) URL`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(
      `invalid --base-url ${JSON.stringify(value)}: expected an absolute http(s) URL`,
    );
  }
  // Trailing slashes would double up with the provider path.
  return value.replace(/\/+$/, "");
}

/**
 * Sets `base_url` for one provider in config.toml by editing the text in place,
 * so comments, key order and unrelated settings all survive. The rewrite is
 * verified by re-parsing before it touches the file: if anything else changed,
 * the user is told to edit config.toml by hand rather than losing settings.
 */
function setProviderBaseUrl(name: string, baseUrl: string): string {
  const file = configPath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const beforeTable = before.trim() === "" ? undefined : parseToml(before);

  const after = applyBaseUrl(before, name, baseUrl);
  assertFaithfulRewrite(beforeTable, after, name, baseUrl, file);

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, after);
  return file;
}

function applyBaseUrl(text: string, name: string, baseUrl: string): string {
  const assignment = `base_url = ${tomlBasicString(baseUrl)}`;
  const lines = text.split("\n");
  const header = providerHeaderPattern(name);
  const headerIndex = lines.findIndex((line) => header.test(line));

  if (headerIndex === -1) {
    const section = [`[providers.${tomlKey(name)}]`, assignment];
    if (text.trim() === "") return `${section.join("\n")}\n`;
    const base = text.endsWith("\n") ? text : `${text}\n`;
    return `${base}\n${section.join("\n")}\n`;
  }

  // The section runs up to the next table header, so a stray top-level key
  // after it is never mistaken for a provider setting.
  const nextHeader = lines.findIndex(
    (line, index) => index > headerIndex && /^\s*\[/.test(line),
  );
  const end = nextHeader === -1 ? lines.length : nextHeader;

  for (let index = headerIndex + 1; index < end; index += 1) {
    if (/^\s*base_url\s*=/.test(lines[index])) {
      lines[index] = replaceAssignment(lines[index], assignment);
      return lines.join("\n");
    }
  }

  lines.splice(headerIndex + 1, 0, assignment);
  return lines.join("\n");
}

/** Keeps an inline comment on the line whose value is being replaced. */
function replaceAssignment(line: string, assignment: string): string {
  const commentStart = findCommentStart(line);
  if (commentStart === -1) return assignment;
  return `${assignment}  ${line.slice(commentStart)}`;
}

/** Index of a `#` that begins an inline comment: outside a string, preceded by whitespace. */
function findCommentStart(line: string): number {
  let quote: string | null = null;
  let index = 0;

  while (index < line.length) {
    const char = line[index];

    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return index;
    }

    index += 1;
  }

  return -1;
}

function providerHeaderPattern(name: string): RegExp {
  const forms = [`"${escapeRegex(name)}"`, `'${escapeRegex(name)}'`];
  if (isBareTomlKey(name)) forms.unshift(escapeRegex(name));
  return new RegExp(`^\\s*\\[\\s*providers\\s*\\.\\s*(?:${forms.join("|")})\\s*]\\s*(?:#.*)?$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBareTomlKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function tomlKey(name: string): string {
  return isBareTomlKey(name) ? name : tomlBasicString(name);
}

function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Confirms the rewritten TOML still parses, carries the new base_url, and still
 * contains every value the user had. A partial rewrite that silently dropped a
 * setting is worse than no rewrite, so the user is told to edit the file instead.
 */
function assertFaithfulRewrite(
  before: TomlTable | undefined,
  after: string,
  name: string,
  baseUrl: string,
  file: string,
): void {
  function fail(): never {
    throw new UsageError(
      `cannot safely rewrite ${file} to set base_url for provider "${name}"; ` +
        `edit ${file} by hand and set base_url = ${tomlBasicString(baseUrl)} ` +
        `under [providers.${tomlKey(name)}]`,
    );
  }

  let parsed: TomlTable;
  try {
    parsed = parseToml(after);
  } catch {
    fail();
  }

  if (tableAt(parsed, ["providers", name])?.base_url !== baseUrl) fail();
  if (before !== undefined && !isPreserved(before, parsed, ["providers", name, "base_url"])) {
    fail();
  }
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
 * false for every symlinked invocation — the `media` shim npm creates for
 * `bin.media`, `npx`, `node_modules/.bin/media` — which made the packaged binary
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
