import { ApiError, NO_RESPONSE_STATUS } from "./errors.js";
import { tomlKey } from "./toml.js";
import { getAdapter } from "./api/index.js";
import type {
  AsyncTaskAdapter,
  Dialect,
  ImageRequest,
  ParsedResponse,
  ProviderConfig,
  TaskAdapter,
  TaskBinding,
  TaskOutcome,
  VideoRequest,
} from "./types.js";

/** Error bodies are vendor/proxy output of unknown size; keep messages readable. */
const BODY_EXCERPT_LIMIT = 200;

/**
 * The OpenAI-compatible images path is not served on the legacy DashScope host,
 * which answers 404 with an empty body; Bailian serves it only on the caller's
 * workspace-scoped host. The dialect stays OpenAI-compatible, so the fix is a
 * `base_url` and the error has to say so. The origin alone is right: the
 * dialect's path carries the version segment (`/compatible-mode/v1/...`).
 */
const QWEN_WORKSPACE_BASE_URL = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com";

/**
 * How long one create or one poll request may take. Deliberately not
 * `binding.timeout_ms`: that value is the whole poll budget (default 1800s), and
 * one hung request must not be able to consume it.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

export interface CallApiParams {
  /** The resolved provider, task, model and timeout this request runs under. */
  binding: TaskBinding;
  apiKey: string;
  request: ImageRequest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes the API key from any text that is about to become an error message.
 * The key normally only travels in a header, but a proxy that reflects request
 * headers must not be able to leak it through a body excerpt.
 */
function redactorFor(apiKey: string): (text: string) => string {
  if (apiKey === "") return (text) => text;
  return (text) => text.split(apiKey).join("[redacted]");
}

/**
 * A hostile error body must not be able to drive the terminal: ANSI CSI and OSC
 * escape sequences are dropped whole, then every remaining control byte (C0,
 * DEL, C1) becomes a space.
 */
const ANSI_ESCAPE_SEQUENCE =
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
const CONTROL_BYTE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Collapses whitespace and strips escape and control bytes. Every string this
 * module echoes — a response body, a task id the user typed — goes through it,
 * so nothing untrusted can drive the terminal.
 */
function oneLine(text: string): string {
  return text
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(CONTROL_BYTE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Caps the length so an HTML error page, a wall of JSON or a pasted id cannot
 * flood the terminal or an agent's context window.
 */
function capLength(line: string): string {
  return line.length > BODY_EXCERPT_LIMIT ? `${line.slice(0, BODY_EXCERPT_LIMIT)}...` : line;
}

function bodyExcerpt(text: string): string {
  const line = oneLine(text);
  return line === "" ? "empty body" : capLength(line);
}

/**
 * Bounds and sanitizes one untrusted line for the terminal: escape and control
 * bytes are stripped, whitespace collapsed and the length capped. Every string this
 * module echoes goes through it, and so does every vendor string another module
 * echoes back (a task id from a create response).
 */
export function safeLine(text: string): string {
  return capLength(oneLine(text));
}

/**
 * Builds an `ApiError` that carries where the failure came from: the HTTP status
 * when a response arrived, `NO_RESPONSE_STATUS` when none did. A retry policy
 * reads that field instead of matching message text.
 */
function httpError(message: string, status: number, code?: string): ApiError {
  return new ApiError(message, code, undefined, status);
}

/** Extracts the host for error messages without requiring a well-formed URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Vendor errors are uniformly shaped at the body level: `{ error: { code, message } }`. */
function vendorError(json: unknown): { code?: string; message: string } | undefined {
  if (!isRecord(json) || !isRecord(json.error)) return undefined;

  const message = typeof json.error.message === "string" ? json.error.message.trim() : "";
  if (message === "") return undefined;

  const code = vendorCode(json.error.code);
  return code === undefined ? { message } : { code, message };
}

/**
 * Vendors send the code as a string or as a number; both are kept, anything
 * else is dropped rather than stringified into the message.
 */
function vendorCode(code: unknown): string | undefined {
  if (typeof code === "string") return code === "" ? undefined : code;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  return undefined;
}

/**
 * Parses a response body, converting malformed JSON into a readable `ApiError`
 * carrying the status and a short body excerpt. A proxy's HTML error page or an
 * empty body must never escape as a raw `SyntaxError`.
 */
export function parseJsonOrThrow(text: string, status: number): unknown {
  return parseJson(text, status, (value) => value);
}

function parseJson(
  text: string,
  status: number,
  redact: (text: string) => string,
): unknown {
  if (text.trim() === "") {
    throw httpError(`API response with status ${status} has an empty body`, status);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(
      `API response with status ${status} is not valid JSON: ${redact(bodyExcerpt(text))}`,
      status,
    );
  }
}

/**
 * The remedy for a qwen-dialect 404 with no body: name the host that was
 * called, the host that serves the images API, and the file that sets it.
 */
function missingQwenEndpointMessage(
  provider: ProviderConfig,
  status: number,
  redact: (text: string) => string,
): string {
  const host = redact(hostOf(provider.base_url));
  return [
    `${provider.name} API request failed with status ${status}: this endpoint does not exist on ${host}.`,
    `The OpenAI-compatible images API is served only on your workspace-scoped Bailian host, ${QWEN_WORKSPACE_BASE_URL}.`,
    `Fix it by setting base_url = "${QWEN_WORKSPACE_BASE_URL}" under [providers.${tomlKey(provider.name)}] in config.toml — base_url is the origin, and the dialect appends the endpoint path, version segment included — then run the command again.`,
  ].join("\n");
}

function errorForStatus(
  text: string,
  status: number,
  provider: ProviderConfig,
  dialect: Dialect,
  adapter: TaskAdapter | AsyncTaskAdapter,
  redact: (text: string) => string,
): ApiError {
  if (status === 404 && text.trim() === "" && dialect === "openai") {
    return httpError(missingQwenEndpointMessage(provider, status, redact), status);
  }

  let json: unknown;
  try {
    json = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }

  const vendor = adapter.parseErrorBody?.(json) ?? vendorError(json);
  if (vendor !== undefined) {
    // The code is vendor/proxy output too: a proxy that reflects the request
    // headers would otherwise leak the key through `ApiError.code`.
    const code = vendor.code === undefined ? undefined : redact(vendor.code);
    const codeSuffix = code === undefined ? "" : ` (code: ${code})`;
    return httpError(
      `${provider.name} API request failed with status ${status}: ${redact(vendor.message)}${codeSuffix}`,
      status,
      code,
    );
  }

  return httpError(
    `${provider.name} API request failed with status ${status}: ${redact(bodyExcerpt(text))}`,
    status,
  );
}

async function readResponseText(
  response: Response,
  url: string,
  redact: (text: string) => string,
  timeoutSeconds: number,
  /** Replaces the generic timeout message, for a request whose timeout must say more. */
  timeoutMessage?: string,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw httpError(
        redact(
          timeoutMessage ??
            `API request timeout after ${timeoutSeconds}s while reading the response from ${redact(hostOf(url))}`,
        ),
        NO_RESPONSE_STATUS,
      );
    }
    throw httpError(
      `failed to read the API response from ${redact(hostOf(url))}: ${redact(errorMessage(error))}`,
      NO_RESPONSE_STATUS,
    );
  }
}

/**
 * A `Task` variable picks either half of the registry, and this transport is
 * the image round trip: it must not build an image body for a video binding.
 */
function isImageAdapter(
  adapter: TaskAdapter | AsyncTaskAdapter,
): adapter is TaskAdapter {
  return "parseResponse" in adapter;
}

/**
 * Sends one request through the (dialect, task) adapter the binding resolved. Transport
 * failures become `ApiError`s; build/parse errors from the adapter propagate
 * untouched because they already explain what the caller must change. Paid
 * requests are never retried.
 */
export async function callApi(params: CallApiParams): Promise<ParsedResponse> {
  const { binding, apiKey, request } = params;
  const provider = binding.provider;
  const timeoutSeconds = binding.timeout_ms / 1000;

  // Resolve the dialect and build the body before any network activity so an
  // invalid flag fails before a paid request is sent. Serializing here, outside
  // the transport try, keeps a payload that cannot be serialized from being
  // misreported as a network failure. This also throws for a dialect with no
  // adapter for the task, which is why it comes before the image check.
  const adapter = getAdapter(binding.dialect, binding.task);
  if (!isImageAdapter(adapter)) {
    throw new ApiError(
      `this request is for the image task; the binding is for the "${binding.task}" task`,
    );
  }
  const body = adapter.buildRequest(request);
  const payload = JSON.stringify(body);
  const redact = redactorFor(apiKey);

  // A task may declare its own path for a host that does not mirror the vendor.
  const url = `${provider.base_url}${binding.path ?? adapter.createPath}`;
  const signal = AbortSignal.timeout(binding.timeout_ms);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: payload,
      signal,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw httpError(
        `${provider.name} API request timeout after ${timeoutSeconds}s (${redact(url)})`,
        NO_RESPONSE_STATUS,
      );
    }
    throw httpError(
      `${provider.name} API request to ${redact(hostOf(url))} failed: ${redact(errorMessage(error))}`,
      NO_RESPONSE_STATUS,
    );
  }

  const text = await readResponseText(response, url, redact, timeoutSeconds);

  if (!response.ok) {
    throw errorForStatus(text, response.status, provider, binding.dialect, adapter, redact);
  }

  const json = parseJson(text, response.status, redact);
  const requestId = requestIdOf(response);

  const parsed = adapter.parseResponse(json, requestId);
  if (parsed.requestId === undefined && requestId !== undefined) {
    parsed.requestId = requestId;
  }
  return parsed;
}

export interface CreateTaskParams {
  /** The resolved provider, task and model this create runs under. */
  binding: TaskBinding;
  apiKey: string;
  request: VideoRequest;
}

export interface PollTaskParams {
  /** The resolved provider and task; the model is not sent when polling. */
  binding: TaskBinding;
  apiKey: string;
  taskId: string;
}

interface VideoRoundTripParams {
  binding: TaskBinding;
  /** The binding's video adapter, resolved by the caller before the fetch. */
  adapter: AsyncTaskAdapter;
  apiKey: string;
  method: "GET" | "POST";
  url: string;
  /** Serialized by the caller: a body that cannot be serialized is not a network failure. */
  body?: string;
  /**
   * Replaces the generic timeout message. Only a create needs one: a task that
   * timed out may already exist and be paid for, so it must not read as "retry".
   */
  timeoutMessage?: string;
  /**
   * Appended to every failure where the request left this process without a usable
   * answer, so a create cannot read as "nothing happened".
   */
  unresolvedNote?: string;
  /**
   * Replaces the generic message for a 404, which for a poll means "unknown id
   * here". It receives the response body: a proxy whose host is right and whose
   * path is wrong answers 404 too, and only the vendor's own line says so.
   */
  notFoundMessage?: (bodyText: string) => string;
}

interface VideoRoundTrip {
  json: unknown;
  requestId?: string;
}

/**
 * A create timeout is the dangerous one: the request may have reached the
 * server and been accepted. No id came back, so the remedy cannot be a command
 * that needs one: say the task may exist and send the user to the one place that
 * can find it, or the first instinct is to resubmit and pay twice.
 */
/**
 * The one sentence every create failure that *may* have been accepted must carry.
 * A timeout is not the only such failure: a reset socket, a body that would not read,
 * a 5xx from a gateway whose origin did accept the task, or a `2xx` whose id could not
 * be parsed all leave the same possibility behind. Without the sentence the message
 * reads as "nothing happened", and the first instinct is to submit again and pay twice.
 */
const UNRESOLVED_CREATE_NOTE =
  "the task may already have been created and paid for. No task id came back, so " +
  "check your provider's console or usage page for a recent task before submitting again.";

function createTimeoutMessage(provider: ProviderConfig): string {
  return (
    `${provider.name} create request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ` +
    UNRESOLVED_CREATE_NOTE
  );
}

/** The note as a suffix, or nothing. */
function unresolvedSuffix(note: string | undefined): string {
  return note === undefined ? "" : ` ${note}`;
}

/** Appends the note to an error without losing its type, code, task id or status. */
function withNote(error: unknown, note: string | undefined): unknown {
  if (note === undefined) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError) {
    return new ApiError(`${message} ${note}`, error.code, error.taskId, error.status);
  }
  return new ApiError(`${message} ${note}`);
}

/**
 * A poll 404 is not a failed task: it is an id this host has never heard of,
 * which is what a wrong `--provider` looks like. Saying so turns "the task
 * failed" into one flag to check. A 404 whose body carries the vendor's own
 * explanation is quoted too: a proxy with the right host and a wrong `path`
 * answers the same way, and `--provider` is not the remedy for that.
 */
function unknownTaskMessage(
  provider: ProviderConfig,
  taskId: string,
  host: string,
): (bodyText: string) => string {
  return (bodyText) => {
    const lines = [
      // The id is echoed back, so it is treated like any other untrusted text and
      // bounded like a body: pasting tens of KB must not flood the terminal.
      `${provider.name} API request failed with status 404: no task "${safeLine(taskId)}" exists on ${host}.`,
      "That is not a failed task: a task id is readable only on the provider that created it, " +
        "so check --provider and that the id is complete.",
    ];
    if (oneLine(bodyText) !== "") lines.push(`The response said: ${bodyExcerpt(bodyText)}`);
    return lines.join("\n");
  };
}

function requestIdOf(response: Response): string | undefined {
  const header = response.headers.get("x-request-id");
  return header === null || header === "" ? undefined : header;
}

/**
 * One create or poll round trip: bearer auth, the single-request timeout, and
 * the same error parsing and redaction the image path uses. Both verbs share it
 * because they must fail, and stay silent about the key, in exactly one way.
 */
async function sendVideoRequest(params: VideoRoundTripParams): Promise<VideoRoundTrip> {
  const { binding, adapter, apiKey, method, url, body, timeoutMessage, notFoundMessage, unresolvedNote } =
    params;
  const provider = binding.provider;
  const redact = redactorFor(apiKey);
  const timeoutSeconds = REQUEST_TIMEOUT_MS / 1000;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw httpError(
        redact(
          timeoutMessage ??
            `${provider.name} API request timeout after ${timeoutSeconds}s (${url})`,
        ),
        NO_RESPONSE_STATUS,
      );
    }
    throw httpError(
      `${provider.name} API request to ${redact(hostOf(url))} failed: ` +
        `${redact(errorMessage(error))}${unresolvedSuffix(unresolvedNote)}`,
      NO_RESPONSE_STATUS,
    );
  }

  let text: string;
  try {
    text = await readResponseText(
      response,
      url,
      redact,
      timeoutSeconds,
      // A create whose body could not be read may already be accepted and paid
      // for, so the dangerous wording has to survive a read timeout too.
      timeoutMessage,
    );
  } catch (error) {
    // Headers arrived, so the request was definitely delivered.
    throw withNote(error, unresolvedNote);
  }

  if (!response.ok) {
    if (response.status === 404 && notFoundMessage !== undefined) {
      throw httpError(redact(notFoundMessage(text)), response.status);
    }
    // A 5xx (or a gateway timeout) says the request reached something; only a 4xx
    // says it was rejected outright, so only those are safe to read as "nothing ran".
    const note = response.status >= 500 ? unresolvedNote : undefined;
    throw withNote(
      errorForStatus(text, response.status, provider, binding.dialect, adapter, redact),
      note,
    );
  }

  // A 2xx body that will not parse still came from a server that accepted the
  // request, so for a create it carries the same "may already be paid for" risk.
  let json: unknown;
  try {
    json = parseJson(text, response.status, redact);
  } catch (error) {
    throw withNote(error, unresolvedNote);
  }

  return {
    json,
    requestId: requestIdOf(response),
  };
}

/**
 * Redacts the text of an `ApiError` an adapter raised while reading a paid
 * response, before it leaves the transport. `pollOutcome` throws for a status
 * nobody anticipated, and that message is the raw vendor string; `video.ts`
 * publishes it to stderr and into the JSON envelope's `message`, so a body that
 * reflected the request's `Authorization` header would carry the key out. The
 * type, `code`, `taskId` and `status` survive, because a retry policy classifies
 * on those fields rather than on the text.
 */
function redactedApiError(error: unknown, redact: (text: string) => string): unknown {
  if (!(error instanceof ApiError)) return error;

  const message = redact(error.message);
  const code = error.code === undefined ? undefined : redact(error.code);
  if (message === error.message && code === error.code) return error;
  return new ApiError(message, code, error.taskId, error.status);
}

/**
 * Runs an adapter callback and puts any `ApiError` it raises through the same
 * redactor every other error message passes. Anything else — a `UsageError` from
 * `buildRequest`, a `SyntaxError` — propagates untouched.
 */
function redacting<T>(action: () => T, redact: (text: string) => string): T {
  try {
    return action();
  } catch (error) {
    throw redactedApiError(error, redact);
  }
}

/**
 * Creates one async video task and returns its id. The request is built and
 * serialized before the fetch, so a request the adapter rejects never costs
 * money; the create itself is sent exactly once and never retried.
 */
export async function createTask(
  params: CreateTaskParams,
): Promise<{ taskId: string; requestId?: string }> {
  const { binding, apiKey, request } = params;
  const redact = redactorFor(apiKey);
  const adapter = getAdapter(binding.dialect, "video");
  // Built before the fetch so an rejected body costs nothing; `redacting` keeps
  // the error's type and only rewrites the text that could hold the key.
  const payload = redacting(() => JSON.stringify(adapter.buildRequest(request)), redact);
  const url = `${binding.provider.base_url}${binding.path ?? adapter.createPath}`;

  const { json, requestId } = await sendVideoRequest({
    binding,
    adapter,
    apiKey,
    method: "POST",
    url,
    body: payload,
    timeoutMessage: createTimeoutMessage(binding.provider),
    unresolvedNote: UNRESOLVED_CREATE_NOTE,
  });

  // The id is either usable as printed or not usable at all: a vendor string carrying
  // control bytes would clear the terminal, and one carrying megabytes would flood the
  // stdout an agent parses. Both channels (stderr note, stdout result) get the same
  // short, clean value from here on.
  let taskId: string;
  try {
    taskId = safeLine(redacting(() => adapter.taskIdFrom(json), redact));
  } catch (error) {
    // A 2xx we could read but an id we could not: the task exists and is billed, and
    // this is the failure most likely to happen in normal operation (a vendor renaming
    // the field, a proxy wrapping the body). Without the warning it reads as "nothing
    // was created", which is the one wrong conclusion at this point.
    throw withNote(error, UNRESOLVED_CREATE_NOTE);
  }
  return requestId === undefined ? { taskId } : { taskId, requestId };
}

/**
 * Redacts the vendor's failure text of one poll. This is the one place that both
 * holds the key and sees that text: the pipeline copies `failure.message` and
 * `failure.code` into an `ApiError`, and `ApiError.code` is published into the JSON
 * envelope, which can land on disk. A `2xx` poll body never reaches `errorForStatus`,
 * so without this a proxy that reflects the request headers would leak the key
 * through a task's own failure line. The status the adapter *throws* for goes
 * through `redacting` for the same reason.
 */
function redactedOutcome(outcome: TaskOutcome, redact: (text: string) => string): TaskOutcome {
  switch (outcome.state) {
    case "failed":
    case "cancelled":
    case "expired": {
      const failure: { code?: string; message: string } = {
        message: redact(outcome.failure.message),
      };
      if (outcome.failure.code !== undefined) failure.code = redact(outcome.failure.code);
      return { state: outcome.state, failure };
    }
    default:
      return outcome;
  }
}

/**
 * Reads one poll. The path comes from the adapter, never from a suffix rule: a
 * dialect's poll prefix can differ from its create path. A task's own `path`
 * covers both verbs, because it describes a host's layout, not one endpoint.
 */
export async function pollTask(
  params: PollTaskParams,
): Promise<TaskOutcome & { requestId?: string }> {
  const { binding, apiKey, taskId } = params;
  const provider = binding.provider;
  const adapter = getAdapter(binding.dialect, "video");
  const url =
    binding.path === undefined
      ? `${provider.base_url}${adapter.pollPath(taskId)}`
      : `${provider.base_url}${binding.path}/${encodeURIComponent(taskId)}`;

  const { json, requestId } = await sendVideoRequest({
    binding,
    adapter,
    apiKey,
    method: "GET",
    url,
    notFoundMessage: unknownTaskMessage(provider, taskId, hostOf(url)),
  });

  const redact = redactorFor(apiKey);
  const outcome = redactedOutcome(redacting(() => adapter.pollOutcome(json), redact), redact);
  return requestId === undefined ? outcome : { ...outcome, requestId };
}
