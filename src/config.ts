import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { ConfigError, malformedDocumentMessage, unreadableFileMessage, unwritableFileMessage } from "./errors.js";
import { SEED_CONFIG } from "./providers.js";
import { shellArg, tomlKey } from "./toml.js";
import { normalizeHttpBaseUrl } from "./util.js";
import type { Dialect, ProviderConfig } from "./types.js";

/** One entry from `[providers.<name>]` in config.toml, before validation. */
export interface ProviderOverride {
  api_type?: Dialect;
  base_url?: string;
  model?: string;
  api_key_env?: string;
}

export interface MediagenConfig {
  /** `""` when config.toml does not set it; resolveProvider() then explains. */
  default_provider: string;
  output_dir: string;
  providers: Record<string, ProviderOverride>;
}

const PROVIDER_STRING_FIELDS = ["base_url", "model", "api_key_env"] as const;

export function configDir(): string {
  const override = process.env.MEDIAGEN_CLI_CONFIG_DIR;
  if (override) return override;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) return path.join(xdgConfigHome, "mediagen-cli");

  return path.join(os.homedir(), ".config", "mediagen-cli");
}

export function configPath(): string {
  return path.join(configDir(), "config.toml");
}

/** The one message every command gives when nothing selects a provider. */
export function noProviderSelectedMessage(file: string = configPath()): string {
  return `no provider selected: set "default_provider" in ${file} or pass --provider <name>`;
}

/**
 * Replaces config.toml through a temporary file in the same directory, so a crash
 * or a full disk leaves the previous contents intact instead of a truncated file
 * that no command can repair (the seed only ever runs when the file is absent).
 */
export function writeConfigFile(text: string): string {
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(dir, `.config.toml.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: the temporary file may never have been created.
    }
    throw error;
  }

  return file;
}

/**
 * Writes the seed configuration when config.toml is absent, so that the first
 * run leaves the user something with comments to edit rather than a command
 * that fails on an empty store.
 *
 * Called from the bootstrap stage in `main()`, which runs before any command is
 * dispatched. A config dir that cannot be written is a hard failure: the user
 * gets a `ConfigError` naming the path and the way out, rather than every later
 * command failing for a reason that looks like "no providers configured".
 */
export function ensureConfigFile(): void {
  const file = configPath();
  if (fs.existsSync(file)) return;

  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    // "wx" fails instead of truncating, so a concurrent run that is already
    // writing a config is never clobbered by the seed.
    fs.writeFileSync(file, SEED_CONFIG, { flag: "wx" });
  } catch (error) {
    // Only losing the create race is success: "wx" fails with EEXIST when a
    // concurrent run wrote the file first. Any other failure (ENOSPC, EDQUOT,
    // EIO) may have left a truncated seed behind, and a truncated seed parses as
    // a valid config with no providers — the exact state that never repairs
    // itself, because the seed is only ever written when the file is absent.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST" && fs.existsSync(file)) return;
    try {
      fs.unlinkSync(file);
    } catch {
      // The file may never have been created.
    }
    throw new ConfigError(unwritableFileMessage(file, error));
  }
}

/**
 * The one place that decides config.toml exists and parses. `main()` calls it
 * before commander dispatches, so every command sees the same file: created when
 * absent, validated when present, and a `ConfigError` otherwise. Commands then
 * read it with `loadConfig()`, which never writes.
 */
export function prepareConfigFile(): void {
  ensureConfigFile();
  loadConfig();
}

export function loadConfig(): MediagenConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { default_provider: "", output_dir: process.cwd(), providers: {} };
  }

  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(unreadableFileMessage(file, error));
  }

  let parsed: TomlTable;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new ConfigError(malformedDocumentMessage(file, "TOML", error));
  }

  const providers: MediagenConfig["providers"] = Object.create(
    null,
  ) as MediagenConfig["providers"];
  const rawProviders = parsed.providers;
  if (rawProviders !== undefined) {
    if (!isTable(rawProviders)) {
      throw new ConfigError(`"providers" in ${file} must be a table`);
    }
    for (const [name, rawEntry] of Object.entries(rawProviders)) {
      if (!isTable(rawEntry)) {
        throw new ConfigError(`provider "${name}" in ${file} must be a table`);
      }
      providers[name] = readProviderOverride(name, file, rawEntry);
    }
  }

  return {
    default_provider: readOptionalString(parsed, "default_provider", file) ?? "",
    output_dir: readOptionalString(parsed, "output_dir", file) ?? process.cwd(),
    providers,
  };
}

/**
 * The single resolution path: a provider exists because config.toml declares it,
 * so `api_type`, `base_url` and `model` must all be written down. Only `path` is
 * filled in from the dialect, and `api_key_env` is never inferred — a key
 * belongs to the entry that names it.
 */
export function resolveProvider(name: string, config: MediagenConfig): ProviderConfig {
  const file = configPath();
  if (name === "") throw new ConfigError(noProviderSelectedMessage(file));

  const entry = config.providers[name];
  if (entry === undefined) {
    throw new ConfigError(
      `unknown provider "${name}": no [providers.${tomlKey(name)}] table in ${file}; ` +
        `add one by hand, or run "mediagen config add ${shellArg(name)} ` +
        `--api-type <qwen|ark> --base-url <url> --model <id>"`,
    );
  }

  const apiType = entry.api_type;
  const declaredBaseUrl = entry.base_url;
  const model = entry.model;

  const missing: string[] = [];
  if (apiType === undefined) missing.push("api_type");
  if (declaredBaseUrl === undefined) missing.push("base_url");
  if (model === undefined) missing.push("model");
  if (apiType === undefined || declaredBaseUrl === undefined || model === undefined) {
    throw new ConfigError(
      `provider "${name}" in ${file} is missing required field(s): ${missing.join(", ")}`,
    );
  }

  const baseUrl = resolveBaseUrl(name, apiType, file, declaredBaseUrl);

  const provider: ProviderConfig = {
    name,
    api_type: apiType,
    base_url: baseUrl,
    model,
  };
  if (entry.api_key_env !== undefined) provider.api_key_env = entry.api_key_env;
  return provider;
}

/**
 * config.toml has no flag parser in front of it, so base_url is validated here,
 * before anything is spent. The qwen example is the workspace-scoped host: the
 * public host answers the images endpoint with a 404.
 */
function resolveBaseUrl(name: string, apiType: Dialect, file: string, value: string): string {
  const normalized = normalizeHttpBaseUrl(value);
  if (normalized !== undefined) return normalized;

  const example =
    apiType === "qwen"
      ? "https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 (replace <workspace-id>)"
      : "https://ark.cn-beijing.volces.com/api/v3";
  throw new ConfigError(
    `provider "${name}" in ${file} has invalid base_url ${JSON.stringify(value)}: ` +
      `expected an absolute http(s) URL ending at the version segment, like ${example}`,
  );
}

function readProviderOverride(
  name: string,
  file: string,
  table: TomlTable,
): ProviderOverride {
  const override: ProviderOverride = {};

  const apiType = table.api_type;
  if (apiType !== undefined) {
    if (!isDialect(apiType)) {
      throw new ConfigError(
        `provider "${name}" in ${file} has invalid api_type ${JSON.stringify(apiType)}; expected "qwen" or "ark"`,
      );
    }
    override.api_type = apiType;
  }

  for (const field of PROVIDER_STRING_FIELDS) {
    const value = table[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ConfigError(`provider "${name}" in ${file} has invalid ${field}: expected a string`);
    }
    override[field] = value;
  }

  return override;
}

function readOptionalString(table: TomlTable, key: string, file: string): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`"${key}" in ${file} must be a string`);
  }
  return value;
}

function isDialect(value: unknown): value is Dialect {
  return value === "qwen" || value === "ark";
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
