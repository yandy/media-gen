import { ConfigError } from "../errors.js";
import type { Dialect, DialectAdapter } from "../types.js";
import { ArkDialect } from "./ark.js";
import { QwenDialect } from "./qwen.js";

const DIALECTS: Record<Dialect, DialectAdapter> = {
  qwen: QwenDialect,
  ark: ArkDialect,
};

/**
 * Resolve the wire-format adapter for a provider's `api_type`. The lookup is
 * checked at runtime because `config.toml` is user-supplied and may carry any
 * string in an `api_type` field.
 */
/**
 * The dialect's endpoint file name, or undefined for an api_type no adapter
 * claims. Callers that must not throw — `config show` on a half-written file —
 * use this instead of getDialect().
 */
export function dialectPath(apiType: string): string | undefined {
  return Object.hasOwn(DIALECTS, apiType) ? DIALECTS[apiType as Dialect].path : undefined;
}

export function getDialect(apiType: Dialect): DialectAdapter {
  if (!Object.hasOwn(DIALECTS, apiType)) {
    const allowed = Object.keys(DIALECTS).join(", ");
    throw new ConfigError(
      `unknown api_type "${String(apiType)}"; expected one of: ${allowed}`,
    );
  }
  return DIALECTS[apiType];
}
