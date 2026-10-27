import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";
import { ConfigError, malformedDocumentMessage, unreadableFileMessage } from "./errors.js";
import type { ProviderConfig } from "./types.js";

export interface AuthFile {
  providers: Record<string, { api_key: string }>;
}

/** Where a resolved API key came from, highest precedence first. */
export type ApiKeySource = "flag" | "env" | "auth";

/** Every source except a per-invocation flag: what a stored key can come from. */
export type StoredKeySource = Exclude<ApiKeySource, "flag">;

export interface ResolvedApiKey {
  key: string;
  source: ApiKeySource;
}

export interface StoredApiKey {
  key: string;
  source: StoredKeySource;
}

export function authPath(): string {
  return path.join(configDir(), "auth.json");
}

export function loadAuth(): AuthFile {
  const file = authPath();

  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { providers: {} };
    throw new ConfigError(unreadableFileMessage(file, error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(malformedDocumentMessage(file, "JSON", error));
  }

  return normalizeAuth(parsed, file);
}

export function saveApiKey(providerName: string, apiKey: string): void {
  const auth = loadAuth();
  auth.providers[providerName] = { api_key: apiKey };
  writeAuth(auth);
}

export function removeApiKey(providerName: string): boolean {
  const auth = loadAuth();
  if (!Object.prototype.hasOwnProperty.call(auth.providers, providerName)) return false;

  delete auth.providers[providerName];
  writeAuth(auth);
  return true;
}

export function maskKey(key: string): string {
  if (key.length < 12) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Resolve the API key for `provider`, highest precedence first:
 * `--api-key` flag > the provider's own `api_key_env` > auth.json.
 *
 * A key belongs to a provider instance, never to a dialect: nothing here knows
 * which environment variable a `qwen` or `ark` provider "usually" uses, so two
 * entries of the same dialect can never pick up each other's credentials.
 * Returns `null` when no source is configured; the caller decides the message.
 */
export function resolveApiKey(
  provider: Pick<ProviderConfig, "name" | "api_key_env">,
  flagKey: undefined,
  env?: NodeJS.ProcessEnv,
): StoredApiKey | null;
export function resolveApiKey(
  provider: Pick<ProviderConfig, "name" | "api_key_env">,
  flagKey: string | undefined,
  env?: NodeJS.ProcessEnv,
): ResolvedApiKey | null;
export function resolveApiKey(
  provider: Pick<ProviderConfig, "name" | "api_key_env">,
  flagKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApiKey | null {
  if (flagKey) return { key: flagKey, source: "flag" };

  const configuredEnv = provider.api_key_env;
  if (configuredEnv) {
    const value = env[configuredEnv];
    if (value) return { key: value, source: "env" };
  }

  const stored = loadAuth().providers[provider.name]?.api_key;
  if (stored) return { key: stored, source: "auth" };

  return null;
}

function writeAuth(auth: AuthFile): void {
  const file = authPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(dir, `.auth.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: the temporary file may never have been created.
    }
    throw error;
  }

  // writeFileSync's mode is filtered by the umask, so enforce it on the final file.
  fs.chmodSync(file, 0o600);
}

function normalizeAuth(parsed: unknown, file: string): AuthFile {
  if (!isRecord(parsed)) {
    throw new ConfigError(`auth file ${file} must contain a JSON object`);
  }

  const rawProviders = parsed.providers;
  if (rawProviders === undefined) return { providers: {} };
  if (!isRecord(rawProviders)) {
    throw new ConfigError(`"providers" in ${file} must be an object`);
  }

  const providers: AuthFile["providers"] = {};
  for (const [name, entry] of Object.entries(rawProviders)) {
    if (!isRecord(entry) || typeof entry.api_key !== "string") {
      throw new ConfigError(`provider "${name}" in ${file} must have a string "api_key"`);
    }
    providers[name] = { api_key: entry.api_key };
  }

  return { providers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
