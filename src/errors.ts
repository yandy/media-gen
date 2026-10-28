/** Configuration is missing, unreadable, or references an unknown provider. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The user invoked the CLI with invalid arguments or an unsupported combination. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The `status` of a failure that never produced a response: a connection error or
 * a request that timed out. Zero, because no HTTP response carries it, and it is a
 * number so a retry policy can decide by reading one field for every failure it
 * sees rather than by matching message text.
 */
export const NO_RESPONSE_STATUS = 0;

/**
 * A vendor API call failed. `code` carries the vendor error code when available;
 * `taskId` and `status` are what a paid async task needs to be recoverable — the id
 * that resumes it and the HTTP status a retry policy classifies on.
 */
export class ApiError extends Error {
  readonly code?: string;
  /** The task this failure is about, when one exists: what `video status` resumes. */
  readonly taskId?: string;
  /** The HTTP status, or `NO_RESPONSE_STATUS` when the request got no response at all. */
  readonly status?: number;

  constructor(message: string, code?: string, taskId?: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.taskId = taskId;
    this.status = status;
  }
}

/** The format of a document that failed to parse; it decides the remedy text. */
export type DocumentFormat = "JSON" | "TOML";

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fieldsOf(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
}

/**
 * The only part of a parser diagnostic that is safe to keep: numeric
 * coordinates. `smol-toml` attaches `line`/`column`; V8 embeds the position in
 * its message text.
 */
function parseLocator(error: unknown): string {
  const fields = fieldsOf(error);
  const line = fields?.line;
  const column = fields?.column;
  if (typeof line === "number" && typeof column === "number") {
    return ` (line ${line}, column ${column})`;
  }

  const position = /position (\d+)/.exec(textOf(error))?.[1];
  return position === undefined ? "" : ` (position ${position})`;
}

/**
 * Builds the message for a document that failed to parse without echoing a
 * single byte of it. V8's `JSON.parse` quotes the slice around the offending
 * token (`..."api_key": sk-v..."...`) and `smol-toml` quotes whole source lines,
 * and both of these files can hold credentials, so only the path and the
 * parser's numeric coordinates survive.
 */
export function malformedDocumentMessage(
  file: string,
  format: DocumentFormat,
  error: unknown,
): string {
  const remedy =
    format === "JSON"
      ? 'Repair it, or delete it and run "mediagen login --provider <name> --api-key ..." to write a fresh one.'
      : "Repair it by hand; mediagen reads these settings from no other file.";
  return (
    `invalid ${format} in ${file}${parseLocator(error)}: the parser message is suppressed because ` +
    `it quotes the document, which may hold an API key. ${remedy}`
  );
}

/**
 * Builds the message for a file that could not be read: the errno code
 * (EACCES, EISDIR, ...) is kept and the raw `fs` text is dropped, so no file
 * error in the CLI can carry document bytes.
 */
export function unreadableFileMessage(file: string, error: unknown): string {
  const code = fieldsOf(error)?.code;
  return `cannot read ${file} (${typeof code === "string" ? code : "unreadable"}): check that it is a readable file`;
}

/**
 * Builds the message for a config file that could not be created. The path is
 * part of the message on purpose: when the bootstrap fails, `config path` fails
 * with it, so this is the only place the user learns where the file should live.
 * The errno code is kept and the raw `fs` text dropped, matching
 * `unreadableFileMessage`.
 */
export function unwritableFileMessage(file: string, error: unknown): string {
  const code = fieldsOf(error)?.code;
  return (
    `cannot create ${file} (${typeof code === "string" ? code : "unwritable"}): ` +
    'point MEDIAGEN_CLI_CONFIG_DIR at a writable directory, or fix the permissions on the directory that holds this file'
  );
}
