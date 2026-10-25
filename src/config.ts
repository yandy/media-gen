import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { ConfigError, malformedDocumentMessage, unreadableFileMessage } from "./errors.js";
import { BUILTIN_PROVIDERS, DIALECT_DEFAULT_PATHS } from "./providers.js";
import type { Dialect, ProviderConfig } from "./types.js";

export interface MediagenConfig {
  default_provider: string;
  output_dir: string;
  providers: Record<string, Partial<ProviderConfig> & { api_type: Dialect }>;
}

const PROVIDER_STRING_FIELDS = ["base_url", "model", "path", "api_key_env"] as const;

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

export function loadConfig(): MediagenConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { default_provider: "qwen", output_dir: process.cwd(), providers: {} };
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

  const providers: MediagenConfig["providers"] = {};
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
    default_provider: readOptionalString(parsed, "default_provider", file) ?? "qwen",
    output_dir: readOptionalString(parsed, "output_dir", file) ?? process.cwd(),
    providers,
  };
}

export function resolveProvider(name: string, config: MediagenConfig): ProviderConfig {
  const override = config.providers[name];
  const builtin = BUILTIN_PROVIDERS[name];

  if (builtin) {
    return { ...builtin, ...override, name, custom: false };
  }

  if (!override) {
    throw new ConfigError(
      `unknown provider "${name}": run "mediagen login" for a built-in provider, or add a [providers.${name}] table to ${configPath()}`,
    );
  }

  const apiType = override.api_type;
  const baseUrl = override.base_url;
  const model = override.model;
  if (!apiType || !baseUrl || !model) {
    const missing: string[] = [];
    if (!apiType) missing.push("api_type");
    if (!baseUrl) missing.push("base_url");
    if (!model) missing.push("model");
    throw new ConfigError(
      `provider "${name}" in config.toml is missing required field(s): ${missing.join(", ")}`,
    );
  }

  return {
    ...override,
    name,
    api_type: apiType,
    base_url: baseUrl,
    model,
    path: override.path ?? DIALECT_DEFAULT_PATHS[apiType],
    custom: true,
  };
}

function readProviderOverride(
  name: string,
  file: string,
  table: TomlTable,
): Partial<ProviderConfig> & { api_type: Dialect } {
  const override: Partial<ProviderConfig> = {};

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

  return override as Partial<ProviderConfig> & { api_type: Dialect };
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
