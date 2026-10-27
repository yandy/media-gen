import { ConfigError } from "../errors.js";
import type { Dialect, DialectAdapters, Task, TaskAdapter } from "../types.js";
import { ArkDialect } from "./ark.js";
import { QwenDialect } from "./qwen.js";

/**
 * One adapter per (dialect, task). Adding a task type to a dialect is a new row
 * here, never a new dialect: the dialect is the protocol, the task is the
 * endpoint. `config.toml` is user-supplied, so every lookup is checked at
 * runtime against the keys that actually exist.
 */
const DIALECTS: Record<Dialect, DialectAdapters> = {
  openai: { image: QwenDialect },
  // Registered before its adapters exist so that `config.toml` naming it gets
  // "no image adapter yet" rather than "unknown api_type".
  dashscope: {},
  ark: { image: ArkDialect },
};

/**
 * The adapter's path for a dialect and task, or undefined when either is
 * unknown or the task has no endpoint yet. Callers that must not throw —
 * `config show` on a half-written file, or a provider whose only table is
 * video — use this instead of getAdapter().
 */
export function adapterPath(apiType: string, task: Task): string | undefined {
  if (!Object.hasOwn(DIALECTS, apiType)) return undefined;
  return DIALECTS[apiType as Dialect][task]?.createPath;
}

export function getAdapter(apiType: Dialect, task: Task): TaskAdapter {
  if (!Object.hasOwn(DIALECTS, apiType)) {
    const allowed = Object.keys(DIALECTS).join(", ");
    throw new ConfigError(
      `unknown api_type "${String(apiType)}"; expected one of: ${allowed}`,
    );
  }

  const adapters = DIALECTS[apiType];
  const adapter = adapters[task];
  if (adapter === undefined) {
    // Naming the tasks that do exist turns "video is missing" into a one-line
    // diagnosis instead of a hunt through the source.
    throw new ConfigError(
      `the "${apiType}" dialect has no "${task}" adapter yet; ` +
        `implemented tasks: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return adapter;
}
