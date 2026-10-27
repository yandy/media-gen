import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { ConfigError, malformedDocumentMessage, unreadableFileMessage, unwritableFileMessage } from "./errors.js";
import { SEED_CONFIG } from "./providers.js";
import { shellArg, tomlKey } from "./toml.js";
import { normalizeHttpBaseUrl } from "./util.js";
import { adapterPath, getAdapter } from "./api/index.js";
import type { Dialect, ProviderConfig, Task, TaskBinding } from "./types.js";


export function configDir(): string {
  const override = process.env.MEDIAGEN_CLI_CONFIG_DIR;
  if (override) return override;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) return path.join(xdgConfigHome, "mediagen-cli");

  return path.join(os.homedir(), ".config", "mediagen-cli");
}

/**
 * Where non-editable state lives — today the API key store. Deliberately not
 * `~/.config`: that directory is the one people sync, share and commit, and a
 * 0600 secret sitting next to an editable config is how keys leak into git.
 * XDG_STATE_HOME is defined as machine-local state that should not be synced,
 * which is exactly what a device-bound credential is.
 */
export function stateDir(): string {
  const override = process.env.MEDIAGEN_CLI_STATE_DIR;
  if (override) return override;

  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) return path.join(xdgStateHome, "mediagen-cli");

  return path.join(os.homedir(), ".local", "state", "mediagen-cli");
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

/**
 * config.toml has no flag parser in front of it, so base_url is validated here,
 * before anything is spent. The qwen example is the workspace-scoped host: the
 * public host answers the images endpoint with a 404.
 */
function resolveBaseUrl(name: string, apiType: Dialect, file: string, value: string): string {
  const normalized = normalizeHttpBaseUrl(value);
  if (normalized !== undefined) return normalized;

  const table = `[providers.${tomlKey(name)}] in ${file}`;
  // The seed ships this placeholder, so it is the likeliest bad value in the
  // file and deserves its own sentence: "expected X, like X" would only repeat
  // the user's own text back at them without naming what to do.
  if (value.includes("<")) {
    throw new ConfigError(
      `base_url under ${table} still contains the placeholder ${JSON.stringify(value)}: ` +
        `replace <workspace-id> with your Bailian workspace id, e.g. ` +
        `"https://abc123.cn-beijing.maas.aliyuncs.com"`,
    );
  }

  const example =
    apiType === "qwen"
      ? "https://abc123.cn-beijing.maas.aliyuncs.com"
      : "https://ark.cn-beijing.volces.com";
  throw new ConfigError(
    `provider "${name}" has invalid base_url ${JSON.stringify(value)} under ${table}: ` +
      `expected an absolute http(s) origin — a gateway prefix is allowed, a version ` +
      `segment is not — without credentials, query or fragment, e.g. ${example}`,
  );
}

function readOptionalString(table: TomlTable, key: string, file: string): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`"${key}" in ${file} must be a string`);
  }
  return value;
}

/**
 * The API prefix a base_url still carries, but only on a vendor's own host. A
 * proxy may legitimately live under `/v1` (or anything else), so the check stays
 * off every host the vendor does not own.
 */
export interface OriginIssue {
  /** The sub-path the value still carries. */
  prefix: string;
  /** The bare origin of that host. */
  origin: string;
}

/**
 * A sub-path on the vendor's own host. The adapter appends its own path to
 * base_url, so anything here would be doubled — unless the task declares `path`,
 * which is the sanctioned escape hatch for a host that does not mirror the
 * vendor's layout. Shared by the file and `--base-url`, so a flag cannot skip a
 * check the file would fail.
 */
export function vendorPathIssue(value: string): OriginIssue | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!isVendorHost(url.hostname)) return undefined;
  if (url.pathname === "" || url.pathname === "/") return undefined;
  return { prefix: url.pathname, origin: `${url.protocol}//${url.host}` };
}

/**
 * What a `path` override should say when base_url already carries a prefix: the
 * adapter's path minus the vendor's own `<api>/<version>` root (two segments in
 * both dialects, `/api/v3` and `/compatible-mode/v1`). Only ever used to suggest a
 * value in an error message; the request itself still uses `createPath`.
 */
function pathAfterVendorRoot(createPath: string | undefined): string | undefined {
  if (createPath === undefined) return undefined;
  const segments = createPath.split("/");
  if (segments.length < 5) return undefined;
  return `/${segments.slice(3).join("/")}`;
}

function isVendorHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "ark.cn-beijing.volces.com" ||
    host === "dashscope.aliyuncs.com" ||
    host.endsWith(".maas.aliyuncs.com")
  );
}

function isDialect(value: unknown): value is Dialect {
  return value === "qwen" || value === "ark";
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Task-scoped providers: the shape config.toml uses.
//
// A provider is the ledger — protocol, host, credentials. Each task it serves
// hangs off it by name (`[providers.x.image]`, `[providers.x.video]`) and owns
// its models, default model and behavior knobs. The endpoint path belongs to
// the (dialect, task) adapter, so one provider serves every task from one
// origin.
// ---------------------------------------------------------------------------

/** One task a provider serves: its models, its default, and how long requests may run. */
export interface TaskBlock {
  default?: string;
  models?: string[];
  timeout_seconds?: number;
  /**
   * Overrides the adapter's endpoint path for this provider. Only for hosts that
   * do not mirror the vendor's layout (a gateway with its own prefix); the
   * adapter's `createPath` stays the default and the single source of truth.
   */
  path?: string;
}

/** One `[providers.<name>]` table, before any value is validated. */
export interface ProviderEntry {
  api_type?: Dialect;
  base_url?: string;
  api_key_env?: string;
  tasks: Partial<Record<Task, TaskBlock>>;
}

export interface TaskConfig {
  /** `""` when config.toml does not set it; resolveSelection() then explains. */
  default_provider: string;
  output_dir: string;
  providers: Record<string, ProviderEntry>;
}

export interface SelectionRequest {
  provider?: string;
  model?: string;
  task: Task;
}

/** The task types a provider table may declare. */
export const KNOWN_TASKS: readonly Task[] = ["image", "video"];

/** Per-task request budget; video polls for far longer than an image takes to render. */
export const DEFAULT_TIMEOUT_SECONDS: Record<Task, number> = { image: 300, video: 1800 };

/** Upper bound on `timeout_seconds`: a day, so a typo cannot hang a run for weeks. */
export const MAX_TIMEOUT_SECONDS = 86_400;

const PROVIDER_ENTRY_FIELDS = ["api_type", "base_url", "api_key_env"] as const;
const TASK_BLOCK_FIELDS = ["default", "models", "timeout_seconds", "path"] as const;

/**
 * Reads config.toml. The file is the only source of truth; nothing is built in. Structure is validated for
 * every provider here; values are only checked once a provider and task are
 * actually selected, so one half-filled entry cannot block the others.
 */
export function loadConfig(): TaskConfig {
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

  const providers: Record<string, ProviderEntry> = Object.create(null) as Record<
    string,
    ProviderEntry
  >;
  const rawProviders = parsed.providers;
  if (rawProviders !== undefined) {
    if (!isTable(rawProviders)) {
      throw new ConfigError(`"providers" in ${file} must be a table`);
    }
    for (const [name, rawEntry] of Object.entries(rawProviders)) {
      if (!isTable(rawEntry)) {
        throw new ConfigError(`provider "${name}" in ${file} must be a table`);
      }
      providers[name] = readProviderEntry(name, file, rawEntry);
    }
  }

  return {
    default_provider: readOptionalString(parsed, "default_provider", file) ?? "",
    output_dir: readOptionalString(parsed, "output_dir", file) ?? process.cwd(),
    providers,
  };
}

/**
 * One provider table. Unknown keys are errors, not silence: `model` instead of
 * `models`, or a stray `api_key`, would otherwise look like a working config
 * while doing nothing.
 */
function readProviderEntry(name: string, file: string, table: TomlTable): ProviderEntry {
  const entry: ProviderEntry = { tasks: {} };

  for (const [key, value] of Object.entries(table)) {
    if (key === "api_type") {
      if (!isDialect(value)) {
        throw new ConfigError(
          `provider "${name}" in ${file} has invalid api_type ${JSON.stringify(value)}; expected "qwen" or "ark"`,
        );
      }
      entry.api_type = value;
      continue;
    }

    if (key === "base_url" || key === "api_key_env") {
      if (typeof value !== "string") {
        throw new ConfigError(
          `provider "${name}" in ${file} has invalid ${key}: expected a string`,
        );
      }
      entry[key] = value;
      continue;
    }

    if (isTask(key)) {
      if (!isTable(value)) {
        throw new ConfigError(
          `provider "${name}" in ${file} has invalid [providers.${tomlKey(name)}.${key}]: expected a table`,
        );
      }
      entry.tasks[key] = readTaskBlock(name, key, file, value);
      continue;
    }

    // A provider table holds three fields and task tables. A key that looks
    // like a pluralised task (`images`, `videos`) is a typo at the level that
    // matters; anything else is just an unknown key.
    const singular = key.endsWith("s") ? key.slice(0, -1) : undefined;
    if (singular !== undefined && isTask(singular)) {
      throw new ConfigError(
        `unknown task "${key}" under [providers.${tomlKey(name)}]; ` +
          `expected ${KNOWN_TASKS.join(", ")}`,
      );
    }

    throw new ConfigError(
      `unknown key "${key}" under [providers.${tomlKey(name)}]; ` +
        `expected ${[...PROVIDER_ENTRY_FIELDS, ...KNOWN_TASKS].join(", ")}`,
    );
  }

  return entry;
}

function readTaskBlock(
  name: string,
  task: Task,
  file: string,
  table: TomlTable,
): TaskBlock {
  const block: TaskBlock = {};
  const where = `[providers.${tomlKey(name)}.${task}]`;

  for (const [key, value] of Object.entries(table)) {
    if (key === "default") {
      if (typeof value !== "string") {
        throw new ConfigError(`default under ${where} must be a string (${file})`);
      }
      block.default = value;
      continue;
    }

    if (key === "models") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new ConfigError(
          `models under ${where} must be an array of strings (${file})`,
        );
      }
      block.models = value as string[];
      continue;
    }

    if (key === "path") {
      if (typeof value !== "string" || !value.startsWith("/") || /[?#]/.test(value)) {
        throw new ConfigError(
          `path under ${where} must start with "/" and carry no query or fragment (${file})`,
        );
      }
      block.path = value;
      continue;
    }

    if (key === "timeout_seconds") {
      if (typeof value !== "number") {
        throw new ConfigError(`timeout_seconds under ${where} must be a number (${file})`);
      }
      block.timeout_seconds = value;
      continue;
    }

    throw new ConfigError(
      `unknown key "${key}" under ${where}; expected ${TASK_BLOCK_FIELDS.join(", ")}`,
    );
  }

  return block;
}

/**
 * A provider is usable without picking a task: this is the task-free half of
 * resolution, used by `login` (a key belongs to the provider, not to a task).
 */
export function validateProviderShape(name: string, config: TaskConfig): ProviderConfig {
  const file = configPath();
  if (name === "") throw new ConfigError(noProviderSelectedMessage(file));

  const entry = config.providers[name];
  if (entry === undefined) {
    throw new ConfigError(
      `unknown provider "${name}": no [providers.${tomlKey(name)}] table in ${file}; ` +
        `add one by hand, or run "mediagen config add ${shellArg(name)} ` +
        `--api-type <qwen|ark> --base-url <origin> --model <id>"`,
    );
  }

  const missing: string[] = [];
  if (entry.api_type === undefined) missing.push("api_type");
  if (entry.base_url === undefined) missing.push("base_url");
  if (entry.api_type === undefined || entry.base_url === undefined) {
    throw new ConfigError(
      `provider "${name}" is missing required field(s): ${missing.join(", ")}; ` +
        `fix [providers.${tomlKey(name)}] in ${file}`,
    );
  }

  if (taskNames(entry).length === 0) {
    throw new ConfigError(
      `provider "${name}" declares no task tables; expected ${KNOWN_TASKS.join(", ")}`,
    );
  }

  const provider: ProviderConfig = {
    name,
    api_type: entry.api_type,
    base_url: resolveBaseUrl(name, entry.api_type, file, entry.base_url),
  };
  if (entry.api_key_env !== undefined) provider.api_key_env = entry.api_key_env;
  return provider;
}

/**
 * The one resolution path for a run: provider, task, model, timeout. Every
 * check that can fail without spending money happens here, in this order, so
 * `--model <video model>` on `image generate` never reaches the network.
 */
export function resolveSelection(request: SelectionRequest, config: TaskConfig): TaskBinding {
  const name = selectProviderName(request, config);
  const entry = config.providers[name];
  const where = `[providers.${tomlKey(name)}.${request.task}]`;

  if (entry === undefined) {
    // Unknown provider and "declares no task" are different mistakes; let the
    // shape check name the first one.
    validateProviderShape(name, config);
  }

  const block = entry?.tasks[request.task];
  if (block === undefined) {
    // Shape first: "this provider has no video table" is the useful answer even
    // when the provider's base_url is still a placeholder.
    const declared = entry === undefined ? [] : taskNames(entry);
    throw new ConfigError(
      `provider "${name}" declares no "${request.task}" models; ` +
        `declared tasks: ${declared.length === 0 ? "(none)" : declared.join(", ")}`,
    );
  }

  const provider = validateProviderShape(name, config);

  // A sub-path on the vendor's own host doubles once the adapter appends its own
  // path. An explicit `path` on the task is the sanctioned way to say "my host
  // really does live under this prefix".
  if (block.path === undefined) {
    const issue = vendorPathIssue(provider.base_url);
    if (issue !== undefined) {
      const defaultPath = adapterPath(provider.api_type, request.task);
      throw new ConfigError(
        `provider "${name}" has base_url ${JSON.stringify(provider.base_url)} in ${configPath()}: ` +
          `it points at the sub-path "${issue.prefix}", and the ${provider.api_type} dialect ` +
          `appends its own path to base_url. Set base_url to the origin (e.g. "${issue.origin}"), ` +
          `or keep the prefix and declare path = ` +
          `${JSON.stringify(pathAfterVendorRoot(defaultPath) ?? "/<path from the prefix>")} ` +
          `under ${where}`,
      );
    }
  }

  const models = block.models;
  if (models === undefined) {
    throw new ConfigError(`${where} is missing required field(s): models`);
  }
  if (models.length === 0) {
    throw new ConfigError(`models must not be empty under ${where}`);
  }

  const model = request.model ?? block.default;
  if (model === undefined) {
    throw new ConfigError(
      `${where} sets no default model; pass --model <id> or add default = "<id>"`,
    );
  }

  if (!models.includes(model)) {
    // The id may be real, just declared for another task: saying so is the
    // difference between "add this line" and "why is my video model rejected".
    const otherTask = KNOWN_TASKS.find(
      (task) => task !== request.task && entry?.tasks[task]?.models?.includes(model) === true,
    );
    if (otherTask !== undefined) {
      throw new ConfigError(
        `model "${model}" is declared for task "${otherTask}", not "${request.task}"; ` +
          `run the command that matches its task, or add it under ${where}`,
      );
    }
    if (block.default === model) {
      throw new ConfigError(`default "${model}" is not listed in models under ${where}`);
    }
    throw new ConfigError(
      `unknown model "${model}" for provider "${name}" (task ${request.task}) in ${configPath()}; ` +
        `add it to models = [...] under ${where}`,
    );
  }

  // Resolved for its side effect: a task the dialect has no endpoint for must
  // fail here, before the timeout and long before the network.
  getAdapter(provider.api_type, request.task);

  const seconds = block.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS[request.task];
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new ConfigError(
      `timeout_seconds must be an integer in 1..${MAX_TIMEOUT_SECONDS} under ${where}, ` +
        `got ${Number.isNaN(seconds) ? "NaN" : String(seconds)}`,
    );
  }

  const binding: TaskBinding = {
    provider,
    task: request.task,
    model,
    timeout_ms: seconds * 1000,
  };
  if (block.path !== undefined) binding.path = block.path;
  return binding;
}

/**
 * `--provider` wins; otherwise `--model` picks the provider that declares it,
 * which is what "just run my model" means to a user. The lookup reads the raw
 * tables, so an unrelated provider with an unedited placeholder host cannot
 * break it.
 */
function selectProviderName(request: SelectionRequest, config: TaskConfig): string {
  if (request.provider !== undefined) return request.provider;

  if (request.model !== undefined) {
    const hits = Object.entries(config.providers)
      .filter(([, entry]) => entry.tasks[request.task]?.models?.includes(request.model as string))
      .map(([name]) => name);

    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new ConfigError(
        `model "${request.model}" is declared by providers ${hits
          .map((name) => `"${name}"`)
          .join(", ")}; pass --provider`,
      );
    }

    // The id may be real, just declared for another task: say so, the way the
    // --provider path already does, instead of only listing this task's models.
    const otherTask = KNOWN_TASKS.find(
      (task) => task !== request.task && knownModels(task, config).includes(request.model as string),
    );
    if (otherTask !== undefined) {
      throw new ConfigError(
        `model "${request.model}" is declared for task "${otherTask}", not "${request.task}"; ` +
          `run the command that matches its task`,
      );
    }

    const known = knownModels(request.task, config);
    throw new ConfigError(
      `unknown model "${request.model}": no provider declares it for task "${request.task}"; ` +
        `known models for task "${request.task}": ${known.length === 0 ? "(none)" : known.join(", ")}`,
    );
  }

  return config.default_provider;
}

function knownModels(task: Task, config: TaskConfig): string[] {
  const seen: string[] = [];
  for (const entry of Object.values(config.providers)) {
    for (const model of entry.tasks[task]?.models ?? []) {
      if (!seen.includes(model)) seen.push(model);
    }
  }
  return seen;
}

/** The task tables a provider actually declares, in config order. */
function taskNames(entry: ProviderEntry): Task[] {
  return KNOWN_TASKS.filter((task) => entry.tasks[task] !== undefined);
}

function isTask(value: string): value is Task {
  return KNOWN_TASKS.includes(value as Task);
}

