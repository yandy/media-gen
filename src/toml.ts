/**
 * TOML key rendering for the few places that build config.toml text or name a
 * table in a message. Shared so that a message always spells a table the same way
 * `config add` writes it: a dotted name must come out quoted, or a user who
 * pastes the message ends up with a nested table instead of a provider.
 */

/** True for a name TOML accepts as a bare key (`a-b_c1`), so it needs no quotes. */
export function isBareTomlKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/** `name` as a TOML key: bare when possible, otherwise a basic string. */
export function tomlKey(name: string): string {
  return isBareTomlKey(name) ? name : tomlBasicString(name);
}

export function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * `value` as one POSIX shell argument, for the copy-pasteable commands in error
 * messages and hints. A provider name may contain anything, so an unquoted
 * interpolation would produce a command that does not run.
 */
export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
