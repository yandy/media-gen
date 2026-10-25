import { ApiError } from "./errors.js";
import { getDialect } from "./api/index.js";
import type {
  ImageRequest,
  ParsedResponse,
  ProviderConfig,
} from "./types.js";

/** Image generation legitimately takes 10-120s, so allow generous headroom. */
const REQUEST_TIMEOUT_MS = 300_000;

/** Error bodies are vendor/proxy output of unknown size; keep messages readable. */
const BODY_EXCERPT_LIMIT = 200;

/**
 * The OpenAI-compatible images path is not served on the legacy DashScope host,
 * which answers 404 with an empty body; Bailian serves it only on the caller's
 * workspace-scoped host. The dialect stays OpenAI-compatible, so the fix is a
 * `base_url` and the error has to say so.
 */
const QWEN_WORKSPACE_BASE_URL = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com";

export interface CallImageApiParams {
  provider: ProviderConfig;
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
 * Collapses whitespace, strips escape and control bytes, and caps the length so
 * an HTML error page or a wall of JSON cannot flood the terminal or an agent's
 * context window.
 */
function bodyExcerpt(text: string): string {
  const oneLine = text
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(CONTROL_BYTE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine === "") return "empty body";
  return oneLine.length > BODY_EXCERPT_LIMIT
    ? `${oneLine.slice(0, BODY_EXCERPT_LIMIT)}...`
    : oneLine;
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
    throw new ApiError(`API response with status ${status} has an empty body`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      `API response with status ${status} is not valid JSON: ${redact(bodyExcerpt(text))}`,
    );
  }
}

/**
 * The remedy for a qwen-dialect 404 with no body: name the host that was
 * called, the host that serves the images API, and the command that sets it.
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
    `Fix it with: mediagen login --provider ${provider.name} --base-url ${QWEN_WORKSPACE_BASE_URL}`,
    `or base_url = "${QWEN_WORKSPACE_BASE_URL}" under [providers.${provider.name}] in config.toml, then run the command again.`,
  ].join("\n");
}

function errorForStatus(
  text: string,
  status: number,
  provider: ProviderConfig,
  redact: (text: string) => string,
): ApiError {
  if (status === 404 && text.trim() === "" && provider.api_type === "qwen") {
    return new ApiError(missingQwenEndpointMessage(provider, status, redact));
  }

  let json: unknown;
  try {
    json = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }

  const vendor = vendorError(json);
  if (vendor !== undefined) {
    // The code is vendor/proxy output too: a proxy that reflects the request
    // headers would otherwise leak the key through `ApiError.code`.
    const code = vendor.code === undefined ? undefined : redact(vendor.code);
    const codeSuffix = code === undefined ? "" : ` (code: ${code})`;
    return new ApiError(
      `${provider.name} API request failed with status ${status}: ${redact(vendor.message)}${codeSuffix}`,
      code,
    );
  }

  return new ApiError(
    `${provider.name} API request failed with status ${status}: ${redact(bodyExcerpt(text))}`,
  );
}

async function readResponseText(
  response: Response,
  url: string,
  redact: (text: string) => string,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ApiError(
        `API request timeout after ${REQUEST_TIMEOUT_MS / 1000}s while reading the response from ${redact(hostOf(url))}`,
      );
    }
    throw new ApiError(
      `failed to read the API response from ${redact(hostOf(url))}: ${redact(errorMessage(error))}`,
    );
  }
}

/**
 * Sends one image request through the provider's dialect adapter. Transport
 * failures become `ApiError`s; build/parse errors from the adapter propagate
 * untouched because they already explain what the caller must change. Paid
 * requests are never retried.
 */
export async function callImageApi(params: CallImageApiParams): Promise<ParsedResponse> {
  const { provider, apiKey, request } = params;

  // Resolve the dialect and build the body before any network activity so an
  // invalid flag fails before a paid request is sent. Serializing here, outside
  // the transport try, keeps a payload that cannot be serialized from being
  // misreported as a network failure.
  const dialect = getDialect(provider.api_type);
  const body = dialect.buildRequest(request);
  const payload = JSON.stringify(body);
  const redact = redactorFor(apiKey);

  const url = `${provider.base_url}${provider.path}`;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

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
      throw new ApiError(
        `${provider.name} API request timeout after ${REQUEST_TIMEOUT_MS / 1000}s (${redact(url)})`,
      );
    }
    throw new ApiError(
      `${provider.name} API request to ${redact(hostOf(url))} failed: ${redact(errorMessage(error))}`,
    );
  }

  const text = await readResponseText(response, url, redact);

  if (!response.ok) {
    throw errorForStatus(text, response.status, provider, redact);
  }

  const json = parseJson(text, response.status, redact);
  const headerRequestId = response.headers.get("x-request-id");
  const requestId = headerRequestId === null || headerRequestId === "" ? undefined : headerRequestId;

  const parsed = dialect.parseResponse(json, requestId);
  if (parsed.requestId === undefined && requestId !== undefined) {
    parsed.requestId = requestId;
  }
  return parsed;
}
