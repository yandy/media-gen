import { getAdapter } from "./api/index.js";
import { resolveApiKey } from "./auth.js";
import { loadConfig, resolveSelection } from "./config.js";
import { downloadMedia } from "./download.js";
import { ApiError, NO_RESPONSE_STATUS, UsageError } from "./errors.js";
import {
  ensureOutDir,
  missingKeyError,
  normalizeBaseUrl,
  resolveOutDir,
} from "./generate.js";
import { createTask, pollTask, safeLine } from "./http.js";
import type {
  AsyncTaskAdapter,
  AsyncTaskResult,
  SavedFile,
  TaskBinding,
  TaskOutcome,
  VideoDeps,
  VideoRequest,
  VideoResult,
} from "./types.js";
import { nowStamp, toImageInput } from "./util.js";

/** Everything `video generate` may carry; `--n` and `--size` are image-only. */
export interface VideoOptions {
  provider?: string;
  model?: string;
  /** `collectImage` gathers repeats, so a second one must be rejected, never dropped. */
  image?: string[];
  resolution?: string;
  ratio?: string;
  duration?: number;
  seed?: number;
  watermark?: boolean;
  generateAudio?: boolean;
  outputFormat?: "mp4" | "mov";
  outDir?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Create the task and return its id instead of waiting; read by the pipeline. */
  noWait: boolean;
}

/**
 * The one closed ratio enum all video dialects share. It is not narrowed per
 * dialect and `adaptive` is neither filled in nor stripped: which mode forbids
 * or forces it (minimax rejects it for text-to-video, forces it for
 * image-to-video) is a model rule, and that layer is the vendor's.
 */
export const RATIOS: readonly string[] = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];

/**
 * Normalizes the tier to the internal lower-case shape, then checks it against
 * the dialect's own declaration. The model layer is never consulted: a tier the
 * dialect has is accepted here even when the selected *model* would not take
 * it, because there is no per-model capability table on purpose and the vendor
 * validates at create time, before charging.
 *
 * Lower case is the internal shape; the dialect translates the casing on the
 * wire (`768p` → `768P` for minimax).
 */
export function validateResolution(value: string, adapter: AsyncTaskAdapter): string {
  const tier = value.trim().toLowerCase();

  if (!adapter.resolutions.includes(tier)) {
    throw new UsageError(
      `invalid --resolution ${JSON.stringify(value)}: the ${adapter.dialect} dialect accepts ` +
        `${adapter.resolutions.join(", ")}; whether a model supports a tier is checked by the vendor`,
    );
  }

  return tier;
}

/** Format layer only: an integer of seconds. The per-model range is checked by the vendor. */
function validateDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(
      `invalid --duration ${JSON.stringify(value)}: expected a positive integer of seconds, ` +
        `e.g. --duration 5; the range a model allows is checked by the vendor`,
    );
  }
  return value;
}

/** Format layer only: a non-negative integer; -1 is one vendor's "you pick" sentinel, not a seed. */
function validateSeed(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`invalid --seed ${JSON.stringify(value)}: expected a non-negative integer`);
  }
  return value;
}

function validateRatio(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const ratio = value.trim();
  if (!RATIOS.includes(ratio)) {
    throw new UsageError(
      `invalid --ratio ${JSON.stringify(value)}: expected one of ${RATIOS.join(", ")}`,
    );
  }
  return ratio;
}

function validatePrompt(prompt: string): string {
  const text = prompt.trim();
  if (text === "") {
    throw new UsageError("a video prompt is required: pass the clip's description as the first argument");
  }
  return text;
}

/**
 * One image, the first frame. `--image` is collected rather than overwritten, so
 * a second path arrives here as a second element; dropping it silently would
 * let the user believe a last frame went to the vendor.
 */
function firstFrame(images: readonly string[]): string | undefined {
  if (images.length > 1) {
    throw new UsageError(
      `only one --image is supported, the clip's first frame; the second --image ` +
        `${JSON.stringify(images[1])} would be a last frame (last_frame), and first/last-frame mode ` +
        `is not implemented yet`,
    );
  }
  return images[0];
}

/**
 * Dialect layer for the flags that are dialect-specific: a dialect declares the
 * wire fields it accepts in `exclusiveFields`, and anything else it is handed
 * must fail here rather than be ignored by the create endpoint after it charged.
 * The wording mirrors the image path's message for the same mistake.
 */
function rejectUndeclaredFlags(opts: VideoOptions, adapter: AsyncTaskAdapter): void {
  const declared = adapter.exclusiveFields ?? [];

  if (opts.generateAudio !== undefined && !declared.includes("generate_audio")) {
    throw undeclaredFlag("--generate-audio", "generate_audio", adapter);
  }
  if (opts.outputFormat !== undefined && !declared.includes("output_format")) {
    throw undeclaredFlag("--output-format", "output_format", adapter);
  }
}

function undeclaredFlag(
  flag: string,
  field: keyof VideoRequest,
  adapter: AsyncTaskAdapter,
): UsageError {
  return new UsageError(
    `option "${field}" (${flag}) is not supported by the ${adapter.dialect} dialect; ` +
      `remove ${flag}, or select a provider whose dialect accepts it`,
  );
}

/**
 * The whole local half of a video request: every check that can fail without
 * spending money, then the body itself. Pure — no network, no config, no file
 * writes; the only I/O is reading the frame path the caller gave.
 *
 * The adapter's `buildRequest` is not called here — `createTask` serializes the
 * body — so the dialect layer has to live here: `resolutions` and
 * `exclusiveFields` are the only local gate before the paid create.
 */
export function buildVideoRequest(
  prompt: string,
  opts: VideoOptions,
  model: string,
  adapter: AsyncTaskAdapter,
): VideoRequest {
  // Layer 1, format: legal shapes only, nothing vendor-specific.
  const text = validatePrompt(prompt);
  const duration = validateDuration(opts.duration);
  const seed = validateSeed(opts.seed);
  const ratio = validateRatio(opts.ratio);
  const frame = firstFrame(opts.image ?? []);

  // Layer 2, dialect: what the selected protocol declares it accepts. Layer 3,
  // the model, is the vendor's and is never answered here.
  rejectUndeclaredFlags(opts, adapter);
  const resolution =
    opts.resolution === undefined ? undefined : validateResolution(opts.resolution, adapter);

  const request: VideoRequest = { model, prompt: text };
  if (resolution !== undefined) request.resolution = resolution;
  if (ratio !== undefined) request.ratio = ratio;
  if (duration !== undefined) request.duration = duration;
  if (seed !== undefined) request.seed = seed;
  if (opts.watermark !== undefined) request.watermark = opts.watermark;
  if (opts.generateAudio !== undefined) request.generate_audio = opts.generateAudio;
  if (opts.outputFormat !== undefined) request.output_format = opts.outputFormat;

  // The frame is read last: every flag above refuses for free, and a missing
  // file must not be reported in place of a flag the user has to fix first.
  if (frame !== undefined) request.first_frame = readFrame(frame);

  return request;
}

/**
 * `toImageInput` is shared with the image path and none of its messages name a
 * flag, so the video path re-labels the failure as `--image` while keeping the
 * original cause's text and the exit-code-2 `UsageError` type.
 */
function readFrame(value: string): string {
  try {
    return toImageInput(value);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(`invalid --image ${JSON.stringify(value)}: ${error.message}`);
  }
}

/**
 * The poll schedule. The first wait is short so a fast model does not idle, and the
 * curve flattens at `POLL_MAX_MS` so a long queue does not spend the budget on
 * requests. Both vendors recommend roughly ten seconds; polling faster than that
 * for the whole run would just burn rate limit.
 */
export const POLL_INITIAL_MS = 2_000;
export const POLL_FACTOR = 1.5;
export const POLL_MAX_MS = 10_000;
/**
 * A poll is a GET, so a transient failure may be retried; five in a row is an
 * outage or a broken key, and waiting out the rest of a 30-minute budget for it
 * would only delay the report.
 */
export const POLL_MAX_CONSECUTIVE_FAILURES = 5;

/** The production clock; tests inject one that never sleeps. */
const REAL_DEPS: VideoDeps = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
};

function nextDelay(delay: number): number {
  return Math.min(Math.round(delay * POLL_FACTOR), POLL_MAX_MS);
}

/**
 * One video task from a prompt to a file on disk: create, wait, download.
 *
 * The order mirrors `runGenerate`: every check that can fail for free runs before
 * the first `fetch`, so a missing key or an unwritable `--out-dir` costs nothing.
 * The create is sent exactly once on every path — a video task is the one request
 * in this CLI that is not idempotent, so a retry there is a second charge.
 */
export async function runVideoGenerate(
  prompt: string,
  opts: VideoOptions,
  deps: VideoDeps = REAL_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VideoResult> {
  const baseUrl = opts.baseUrl === undefined ? undefined : normalizeBaseUrl(opts.baseUrl);

  const config = loadConfig();
  // The file's values are validated before `--base-url` may override one of them:
  // a one-off flag must not be able to hide a broken config.toml.
  const selection = resolveSelection(
    { provider: opts.provider, model: opts.model, task: "video" },
    config,
  );
  const binding: TaskBinding =
    baseUrl === undefined
      ? selection
      : { ...selection, provider: { ...selection.provider, base_url: baseUrl } };

  const adapter = getAdapter(binding.dialect, "video");
  const request = buildVideoRequest(prompt, opts, binding.model, adapter);

  const auth = resolveApiKey(binding.provider, opts.apiKey, env);
  if (auth === null) throw missingKeyError(binding.provider);

  const outDir = resolveOutDir(opts.outDir, config.output_dir);
  // Before the create: an out-dir that cannot be written must not be discovered
  // after the money is spent.
  ensureOutDir(outDir);

  const created = await createTask({ binding, apiKey: auth.key, request });
  noteTaskCreated(created.taskId, opts.noWait);

  if (opts.noWait) {
    const pending: VideoResult = {
      saved: [],
      taskId: created.taskId,
      status: "pending",
      response: undefined,
    };
    if (created.requestId !== undefined) pending.requestId = created.requestId;
    return pending;
  }

  const waited = await waitForTask(binding, auth.key, created.taskId, deps);
  const media = waited.result;
  const saved = await saveVideo(media, {
    outDir,
    provider: binding.provider.name,
    // The model the server echoed, not the one we asked for: `video status` builds
    // a binding from the default model, and naming a 2.5 clip after 1.0 would be a
    // false statement about its contents.
    model: media.model ?? binding.model,
    taskId: created.taskId,
  });

  const result: VideoResult = {
    saved: [saved],
    taskId: created.taskId,
    status: "succeeded",
    response: media,
  };
  if (media.usage !== undefined) result.usage = media.usage;
  // The create's id wins: that is the request which was charged, and the image path
  // likewise keeps the first id it sees.
  const requestId = created.requestId ?? waited.requestId;
  if (requestId !== undefined) result.requestId = requestId;
  return result;
}

export interface VideoStatusOptions {
  provider?: string;
  model?: string;
  outDir?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * One look at a task that was created earlier — the way back into a paid task whose
 * run was interrupted, and the only command that does not create anything.
 *
 * It polls exactly once and never loops: waiting is the caller's decision, so a
 * `running` answer is a normal result (exit 0) rather than a reason to block. No
 * budget and no retry live here either; one request either answers or fails.
 */
export async function runVideoStatus(
  taskId: string,
  opts: VideoStatusOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VideoResult> {
  const baseUrl = opts.baseUrl === undefined ? undefined : normalizeBaseUrl(opts.baseUrl);

  const config = loadConfig();
  const selection = resolveSelection(
    { provider: opts.provider, model: opts.model, task: "video" },
    config,
  );
  const binding: TaskBinding =
    baseUrl === undefined
      ? selection
      : { ...selection, provider: { ...selection.provider, base_url: baseUrl } };

  // Resolved for its side effect: a dialect with no video adapter must say so here,
  // before a request goes to a host that cannot answer it.
  getAdapter(binding.dialect, "video");

  const auth = resolveApiKey(binding.provider, opts.apiKey, env);
  if (auth === null) throw missingKeyError(binding.provider);

  const outcome = await pollTask({ binding, apiKey: auth.key, taskId });

  if (outcome.state === "failed" || outcome.state === "cancelled" || outcome.state === "expired") {
    throw taskEndedError(binding, taskId, outcome);
  }

  if (outcome.state !== "succeeded") {
    const unfinished: VideoResult = {
      saved: [],
      taskId,
      status: outcome.state,
      response: undefined,
    };
    if (outcome.requestId !== undefined) unfinished.requestId = outcome.requestId;
    return unfinished;
  }

  const outDir = resolveOutDir(opts.outDir, config.output_dir);
  ensureOutDir(outDir);

  const media = outcome.result;
  const saved = await saveVideo(media, {
    outDir,
    provider: binding.provider.name,
    model: media.model ?? binding.model,
    taskId,
  });

  const result: VideoResult = {
    saved: [saved],
    taskId,
    status: "succeeded",
    response: media,
  };
  if (media.usage !== undefined) result.usage = media.usage;
  if (outcome.requestId !== undefined) result.requestId = outcome.requestId;
  return result;
}

/**
 * The id reaches the terminal before the first poll, not with the result: if the
 * process is killed while waiting, this line is the only thing that makes the paid
 * task recoverable. stderr, because stdout carries results only.
 */
function noteTaskCreated(taskId: string, noWait: boolean): void {
  const id = safeLine(taskId);
  const remedy = noWait
    ? `fetch it later with "mediagen video status ${id}"`
    : `if this process is interrupted, resume with "mediagen video status ${id}"`;
  process.stderr.write(`note: task ${id} was created and paid for; ${remedy}\n`);
}

interface WaitedTask {
  result: AsyncTaskResult;
  requestId?: string;
}

/**
 * Polls until the task reaches a terminal state or the budget runs out.
 *
 * `binding.timeout_ms` is the budget and nothing else: not one request's deadline
 * (that lives in `pollTask`) and not the download's. A transient poll failure is
 * retried on the same backoff curve as a wait — a GET costs nothing, so it is the
 * create that may never be retried.
 *
 * The budget is checked only *after* a poll, never before the first one:
 * `timeout_seconds` may legally be 1, and a run that created and paid for a task
 * without ever asking its state would report "unfinished" about a task nobody
 * queried. A budget that expires right after that first poll still reports
 * `TaskNotFinished`, now backed by a state the vendor really answered.
 */
async function waitForTask(
  binding: TaskBinding,
  apiKey: string,
  taskId: string,
  deps: VideoDeps,
): Promise<WaitedTask> {
  const deadline = deps.now() + binding.timeout_ms;
  let delay = POLL_INITIAL_MS;
  let failures = 0;

  for (;;) {
    await deps.sleep(delay);

    let polled: TaskOutcome & { requestId?: string };
    try {
      polled = await pollTask({ binding, apiKey, taskId });
    } catch (error) {
      if (!isTransientPollFailure(error)) throw stoppedPollingError(taskId, error);
      failures += 1;
      if (failures >= POLL_MAX_CONSECUTIVE_FAILURES) throw gaveUpPollingError(binding, taskId, error);
      if (deps.now() >= deadline) throw notFinishedError(binding, taskId);
      delay = nextDelay(delay);
      continue;
    }

    failures = 0;
    // The intersection above cannot be narrowed by discriminant; the plain union can.
    const outcome: TaskOutcome = polled;
    switch (outcome.state) {
      case "succeeded":
        return polled.requestId === undefined
          ? { result: outcome.result }
          : { result: outcome.result, requestId: polled.requestId };
      case "pending":
      case "running":
        break;
      default:
        throw taskEndedError(binding, taskId, outcome);
    }

    if (deps.now() >= deadline) throw notFinishedError(binding, taskId);
    delay = nextDelay(delay);
  }
}

/**
 * Whether a failed poll may be tried again. The decision reads the HTTP status the
 * error carries, never its message text: `429` and `5xx` and a request that got no
 * response at all are worth another try inside the budget. Any other status — 401,
 * 403, 404, a 400 — is the key, the config or the task id, and retrying it only
 * delays the report; so is an error with no status at all, which the adapter raised
 * because it could not read the body.
 */
function isTransientPollFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  const status = error.status;
  // No status means the adapter rejected the body, not the transport: an unknown
  // task status must surface at once instead of being polled until the budget dies.
  if (status === undefined) return false;
  return status === NO_RESPONSE_STATUS || status === 429 || status >= 500;
}

/**
 * The one sentence that stops a run from paying twice. Every error that ends polling
 * without knowing the task's state — the budget, five failures in a row, a failure
 * not worth retrying — ends with it, because the task behind them is already created
 * and charged.
 */
function resumeHint(id: string): string {
  return (
    `The task was created and paid for, so do not resubmit it: run ` +
    `"mediagen video status ${id}", which checks it and downloads the clip once it is ready.`
  );
}

/**
 * The cause's HTTP status, carried onto a wrapped poll error: `status` is the field
 * `errors.ts` documents for classification, so dropping it here would leave a
 * surfaced failure unclassifiable by a later reader.
 */
function causeStatus(cause: unknown): number | undefined {
  return cause instanceof ApiError ? cause.status : undefined;
}

/**
 * The budget ran out with the task still running. Not a failed task: it is paid for
 * and still going, so the wording has to make resubmitting — and paying twice — the
 * obviously wrong move, and hand back the id that resumes it.
 */
function notFinishedError(binding: TaskBinding, taskId: string): ApiError {
  const id = safeLine(taskId);
  return new ApiError(
    `task ${id} has not finished after the ${binding.timeout_ms / 1000}s poll budget ` +
      "(raise timeout_seconds on this provider's video task to wait longer). " +
      resumeHint(id),
    "TaskNotFinished",
    taskId,
  );
}

/**
 * Polling stopped because the polls kept failing, which says nothing about the task:
 * it may well be running. The reason is kept — it names the status that kept failing,
 * bounded and sanitized by `safeLine` like every other echoed string — and the id
 * travels along for the same reason as above.
 */
function gaveUpPollingError(binding: TaskBinding, taskId: string, cause: unknown): ApiError {
  const id = safeLine(taskId);
  const reason = safeLine(cause instanceof Error ? cause.message : String(cause));
  const code = cause instanceof ApiError && cause.code !== undefined ? cause.code : "PollFailed";
  return new ApiError(
    `polling task ${id} gave up after ${POLL_MAX_CONSECUTIVE_FAILURES} failures in a row: ` +
      `${reason}. ${resumeHint(id)}`,
    code,
    taskId,
    causeStatus(cause),
  );
}

/**
 * Polling stopped on a failure that is not worth another try, which says nothing
 * about the task: the adapter refused a status nobody anticipated, or a proxy served
 * a body that is not JSON as a `200`. The task is paid for and may still be running,
 * so the failure's own line survives and the id and the resume hint travel with it —
 * rethrowing it bare left the id behind, 30 minutes of scrollback above the report.
 */
function stoppedPollingError(taskId: string, cause: unknown): ApiError {
  const id = safeLine(taskId);
  const reason = safeLine(cause instanceof Error ? cause.message : String(cause));
  const code = cause instanceof ApiError && cause.code !== undefined ? cause.code : "PollFailed";
  return new ApiError(
    `polling task ${id} stopped before its state was known: ${reason}. ${resumeHint(id)}`,
    code,
    taskId,
    causeStatus(cause),
  );
}

/**
 * A terminal task state. The vendor's own line is kept because it is the only place
 * that says why, and the id travels on the error so the caller's envelope can name
 * the task without anyone parsing the message.
 */
function taskEndedError(
  binding: TaskBinding,
  taskId: string,
  outcome: Extract<TaskOutcome, { state: "failed" | "cancelled" | "expired" }>,
): ApiError {
  const id = safeLine(taskId);
  return new ApiError(
    `${binding.provider.name} video task ${id} ${outcome.state}: ${safeLine(outcome.failure.message)}`,
    outcome.failure.code,
    taskId,
  );
}

/**
 * One task, one clip, so the index is always 0. A failed download is not a failed
 * task: the clip exists at the vendor for 24 hours and the task is already paid for,
 * so the error carries the id that fetches it again instead of inviting a rerun.
 */
async function saveVideo(
  media: AsyncTaskResult,
  params: { outDir: string; provider: string; model: string; taskId: string },
): Promise<SavedFile> {
  try {
    return await downloadMedia(media, {
      kind: "video",
      outDir: params.outDir,
      provider: params.provider,
      model: params.model,
      stamp: nowStamp(),
      index: 0,
    });
  } catch (error) {
    const cause = safeLine(error instanceof Error ? error.message : String(error));
    const id = safeLine(params.taskId);
    const code = error instanceof ApiError && error.code !== undefined ? error.code : "DownloadError";
    throw new ApiError(
      `task ${id} succeeded but its video could not be saved: ${cause}. ` +
        `The task is paid for, so do not generate it again: "mediagen video status ${id}" ` +
        "downloads the clip without paying twice.",
      code,
      params.taskId,
    );
  }
}
