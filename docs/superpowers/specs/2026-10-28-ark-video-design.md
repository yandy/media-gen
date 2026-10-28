# 视频生成（第一期）：异步任务接口、ark 方言、`video generate` / `video status`

日期：2026-10-28
状态：待评审
承接：`2026-10-28-dashscope-native-dialect-design.md` §4.7（异步扩展点）

## 问题

三个图像方言都通了（`openai` / `dashscope` / `ark`），`[providers.x.video]` 能解析、能校验、
`timeout_seconds` 已经有 1800 的默认值，但 `getAdapter()` 一到 `video` 就抛
`the "ark" dialect has no "video" adapter yet`。种子配置里 `[providers.volcengine.video]`
是写着的，于是 `config show` 会把一个永远用不起来的任务打印出来。

视频与图像有一个不能靠改文案绕过的差别：**它是异步的，而付费发生在建任务那一刻。**
一次 `ark` 图像请求是一个 HTTP 往返；一次视频请求是「建任务（付费）→ 轮询 1–5 分钟 →
下载」，成片 URL 24 小时有效，task id 7 天可查。进程如果在轮询中途死掉（本地超时、Ctrl-C、
agent 的 shell 超时），钱已经花了，而用户看到的是一个「失败」，最自然的反应是**再跑一次、
再付一次**。本仓库最在意的那类事故（"paid requests are never retried"）在这里有了一个新的、
更贵的入口。

## 目标

- `mediagen video generate` 用 ark 方言跑通**文生视频**与**首帧图生视频**，成片落盘、打印路径。
- 异步能力作为一个**并列于图像的接口**接进注册表，图像路径的行为零变化（只有几处把
  「ark 无 video 适配器」写成预期的断言要反转，见「测试」）。
- **中断不等于重复付费**：`--no-wait` 建完即返回 task id，`video status <id>` 只查一次并
  在成功时下载。轮询预算耗尽时的报错必须带 task id 并说明「任务已付费，别再提交」。
- 所有能在本地判定的错误仍然发生在第一个 `fetch` 之前（flag、provider、task、model、
  `--image` 数量、枚举值、密钥、输出目录）。
- 视频的 JSON 输出带 `task_id` 与 `status`，让 agent 不需要解析 stderr。

## 非目标

- **dashscope 视频（wan 系列）不在本期**。它同一个端点下有三代互不兼容的请求词汇
  （legacy 的 `parameters.size` / wan2.7 的 `media[]` / wan3.0 的全素材 `media[]`），
  需要一层「按模型分派请求体」的能力层，属于独立一轮。
- **MiniMax H3、openai(Sora) 式视频都不在本期。** MiniMax 的 v2 API 与 ark 同构
  （create → query 两步、`content[]` + `role`、状态词表几乎一致），是本接口要能容纳的
  下一个方言，但字典里现在没有 `minimax`，加它要同时改 `Dialect`、配置解析、`config add`
  的取值与全部文案，不与本期混在一起。
- **首尾帧、参考图/参考视频/参考音频**不做。`--image` 只表示首帧，第二张明确报错并说明
  首尾帧尚未支持。
- 视频编辑 / 延长 / 续写、回声（`callback_url`）、draft 样片模式、`tools`、`priority`、
  `safety_identifier` 不做。
- 不做 per-model 能力表：`resolution` / `duration` 的合法取值随 ark 模型变化，
  交给服务端强校验（ark 文档明说 body 参数是强校验，取值不符会在**创建时**报错，
  不会静默忽略，也还没到计费那一步）。
- 不做 `video list`、不做取消任务、不做流式下载。
- 不改图像命令的任何 flag、输出格式或退出码。

## 已核实的事实（官方文档，2026-10-28）

### ark 建任务

`POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`

```json
{"model":"doubao-seedance-1-0-pro-250528",
 "content":[{"type":"text","text":"小猫对着镜头打哈欠"},
            {"type":"image_url","image_url":{"url":"https://…/a.png"},"role":"first_frame"}],
 "resolution":"720p","ratio":"16:9","duration":5,"seed":11,
 "camera_fixed":false,"watermark":true}
```

- 响应只有任务 id：`{"id":"cgt-20261028…"}`。**没有状态字段。**
- 图片的 `role`：首帧可写 `first_frame` 或省略；首尾帧两张时 `role` 必填
  （`first_frame` / `last_frame`，可相同）；参考图每张必须 `reference_image`。
  首帧、首尾帧、全模态参考三种场景**互斥**。
- 图片输入接受公网 URL / `data:image/<fmt>;base64,…` / `asset://<ID>`。
  现有 `toImageInput()` 产出的 data URL 可直接用。请求体 ≤ 64MB。
- 参数可用性随模型变化：`camera_fixed` / `frames` 仅 1.0 系列；
  `generate_audio` 2.0/2.5；`output_format` / `draft` / `tools` / `priority` /
  `omni_reference_task_type` 仅 2.5；`resolution` 的可选值与 `duration` 的区间
  每个模型都不同（1.0 pro：`480p/720p/1080p`，默认 `1080p`，duration 2–12；
  2.0：含 `4k`，duration 4–15 或 `-1`；2.5：无 `4k`，duration 4–30 或 `-1`，默认 `-1`）。
- 文档自身有一处不一致：`seed` 的「模型支持」只列了 1.0 系列，但查询响应里 2.0 也回
  `seed`。这进一步支持「取值交给服务端校验」而不是本地建表。

### ark 查询任务

`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`

- `status`：`queued` | `running` | `cancelled` | `succeeded` | `failed` | `expired`
  （`expired` = 超过 `execution_expires_after`，默认 48 小时）。
- 成片：`content.video_url`（24 小时有效；Seedance 2.5 另有 100 次下载上限）。
- 失败：顶层 `error: {code, message}`，成功时为 `null`。
- 其他回显：`resolution`、`ratio`、`duration`、`framespersecond`、`seed`、
  `generate_audio`、`output_format`；用量是 token（`usage.completion_tokens`）。

### 为什么本接口要容纳 MiniMax（但本期不实现）

`POST /v2/video_generation` → `GET /v2/query/video_generation/{task_id}`，请求体是
`content[]` + `type`/`role`（与 ark 同义），成片在 `task.content.url`，状态
`queued/running/succeeded/failed/cancelled`，错误体 `{type:"error",error:{type,message}}`。
只有两点与 ark 不同：**轮询前缀与建任务前缀不同**（`/v2/query/...` vs `/v2/video_generation`），
以及结果全嵌在 `task` 里。这两点正好决定了下面两个接口形状。

## 方案（已选定 A）

**A. 并列的异步接口（选定）。** 图像继续用 `TaskAdapter`，视频用新的 `AsyncTaskAdapter`，
注册表两个槽，`getAdapter` 用重载区分。图像适配器、`generate.ts` 与图像信封的渲染
都不动；图像测试也不动（除了三处把「ark 无 video 适配器」写成预期的断言，见「测试」一节）。

**B. 把 `TaskAdapter` 整体泛型化。** `TaskAdapter<Req, Res>` + `ParsedResponse` 泛化成
`items[]`。概念更统一，但要动 3 个图像适配器、`generate.ts`、`output.ts` 以及所有断言
`response.images` 的测试；收益只是「少一个接口」，风险全落在与视频无关的图像路径上。

**C. 为 ark 写死一条快路径。** 在 `ark.ts` 里加 `createArkVideo/pollArkVideo`，
不抽象适配器。今天最快，但轮询引擎下一轮要重写，`config show` 的端点也会失去唯一真相。

否决 B、C 的理由就是本轮的目标：加视频，不是重构图像。而 A 的代价只有一处联合类型。

**对 A 的三条约束**（不加就白选）：

1. `pollPath` 必须是**函数**，不能是「`createPath` 拼后缀」。MiniMax 的轮询前缀与建任务
   前缀完全不同；写成拼接，下一个方言就得改接口。
2. `taskIdFrom` 与 `pollOutcome` 必须**按方言自己解析**：ark 的 id 在顶层 `id`、结果平铺；
   MiniMax 的 id 是 `task_id`、结果全嵌在 `task` 里。
3. 终止态语义一次定清（`failed` / `cancelled` / `expired` / 状态缺失 / 成功但没 URL），
   不能只在 ark 一处硬编码。

## 决定的形状

### 4.1 两个接口并列，注册表两个槽

`src/types.ts`

```ts
/** 图像：一次 HTTP 往返出结果。原有形状，不改。 */
export interface TaskAdapter {
  createPath: string;
  buildRequest(req: ImageRequest): unknown;
  parseResponse(json: unknown, requestId?: string): ParsedResponse;
  parseErrorBody?(json: unknown): { code?: string; message: string } | undefined;
}

/** 一次视频任务的产物，取自最后一次轮询响应。 */
export interface AsyncTaskResult {
  url: string;
  /** 服务端回显的实际模型 id；文件名用它，避免 `video status` 写出别人的模型名。 */
  model?: string;
  duration?: number;
  resolution?: string;
  ratio?: string;
  format?: string;
  usage?: Record<string, unknown>;
  requestId?: string;
}

/** 一次任务查询的结局。pending/running 之外都是终态。 */
export type TaskOutcome =
  | { state: "pending" | "running" }
  | { state: "succeeded"; result: AsyncTaskResult }
  | { state: "failed" | "cancelled" | "expired"; failure: { code?: string; message: string } };

/** 视频：建任务 → 轮询 → 取结果。 */
export interface AsyncTaskAdapter {
  createPath: string;
  buildRequest(req: VideoRequest): unknown;
  /** 额外请求头；ark 不需要，dashscope 将来的 X-DashScope-Async。 */
  buildHeaders?(): Record<string, string>;
  /** ark: json.id；MiniMax: json.task_id。 */
  taskIdFrom(json: unknown): string;
  /** ark: {createPath}/{id}；MiniMax 是另一个前缀，所以这是函数而不是后缀规则。 */
  pollPath(id: string): string;
  /** 一次轮询响应 → 明确结局，或「还没完」。 */
  pollOutcome(json: unknown): TaskOutcome;
  parseErrorBody?(json: unknown): { code?: string; message: string } | undefined;
}

export type DialectAdapters = {
  image?: TaskAdapter;
  video?: AsyncTaskAdapter;
};
```

`getAdapter` 用重载保持调用点不变：

```ts
export function getAdapter(apiType: Dialect, task: "image"): TaskAdapter;
export function getAdapter(apiType: Dialect, task: "video"): AsyncTaskAdapter;
/** 任务来自变量时（resolveSelection、callApi）走这一条。 */
export function getAdapter(apiType: Dialect, task: Task): TaskAdapter | AsyncTaskAdapter;
```

第三条重载是必需的，不是便利：`resolveSelection()` 与 `callApi()` 传的是 `Task` 变量，
没有它就得在调用点断言。

`adapterPath()` 语义不变（两个接口都有 `createPath`），所以 `config show` 与
`resolveSelection()` 的「该任务有没有适配器」检查自动跟着生效。

### 4.2 视频的请求模型

`VideoRequest` 沿用 `ImageRequest` 的 snake_case 命名（线上字段名即内部字段名）：

```ts
export interface VideoRequest {
  model: string;
  prompt: string;
  first_frame?: string;      // URL 或 data URL；只收 1 张
  resolution?: string;       // 已归一化为小写，如 "720p"
  ratio?: string;            // "16:9" | "4:3" | … | "adaptive"
  duration?: number;         // 秒，正整数
  seed?: number;
  watermark?: boolean;
  generate_audio?: boolean;  // ark 2.0/2.5；服务端校验
  output_format?: "mp4" | "mov"; // ark 2.5；服务端校验
}
```

`duration` / `resolution` 的**默认值归适配器所有**（ark 可省、MiniMax 必填），
CLI 不替它们补值——否则换方言就得改 CLI。

### 4.3 轮询引擎

新文件 `src/video.ts`，对外一个入口：

```ts
export async function runVideoGenerate(
  prompt: string, opts: VideoOptions, deps?: VideoDeps,
): Promise<VideoResult>;
```

- **节奏**：建任务成功后先等 2s，之后每次 ×1.5 递增、封顶 10s（`2, 3, 4.5, 6.75, 10, 10…`）。
  ark 文档的 SDK 示例用 10s 固定间隔；先快后慢能让 30s 出片的快手模型不必干等，
  又不会在长排队时打满 RPM。
- **预算**：`binding.timeout_ms`（默认 1800s）。**预算耗尽不是失败**，是「已付费、还没出片」：
  报 `ApiError`，消息里带 task id 与 `mediagen video status <id>`，并明确写
  「任务已付费，不要重新提交」。
- **可注入**：`VideoDeps { sleep(ms): Promise<void>; now(): number }`，默认真实实现。
  测试传 `sleep: async () => {}` + 假时钟，因此超时路径不需要真等 30 分钟。
- **一次视频**：`TaskOutcome.succeeded` 给一个 `AsyncTaskResult`，所以下载走一次
  `downloadMedia`，`saved[].index` 恒为 0。
- **task id 立刻落到终端，不等结局**：`createTask` 成功后马上往 **stderr** 写一行
  `note: task <id> created and paid for; if this process is interrupted, resume with "mediagen video status <id>"`。
  否则「默认阻塞」这条路就是开篇那个漏洞：进程被 Ctrl-C 或 agent 的 shell 超时杀掉时，
  id 只存在于内存里，用户手里什么都没有，只能重跑、再付一次。stdout 仍只放结果
  （`--json` 时也写 stderr，agent 读 stdout 不受影响），因此不需要信号处理。
- **轮询可以重试，建任务不可以**：GET 不花钱且幂等，所以网络错误、`429`、`5xx`
  在预算内重试（沿用同一条退避曲线），连续失败 **5** 次则终止并报出最后一次的原因；
  `401`/`403`/`404` 与其他 4xx 立即终止（那是密钥、配置或 task id 错，重试只会拖 30 分钟）。
  这与「付费请求永不重试」不矛盾：重试的是查询，不是付费。
- **建任务超时是最危险的一种失败**：请求可能已经到了服务端并创建成功。
  这类错误的文案必须写「创建请求超时，任务**可能**已创建并计费；先查 `video status`，
  不要直接重跑」。

### 4.4 传输层：`http.ts` 增加两个动作

`callApi()` 是「build → POST → 解析」，视频需要「POST 只拿 id」与「GET 只拿状态」，
但它们必须共用现有的错误/脱敏/超时逻辑（`errorForStatus`、`redactorFor`、`parseJson`、
ANSI 清洗），这些是模块私有函数。因此传输层留在 `http.ts`：

```ts
export async function createTask(params: {binding; apiKey; request}): Promise<{taskId: string; requestId?: string}>;
export async function pollTask(params: {binding; apiKey; taskId}): Promise<TaskOutcome & {requestId?: string}>;
```

- 两个函数自己用 `getAdapter(binding.dialect, "video")` 取适配器：`pollTask` 需要它是因为
  轮询路径是 `adapter.pollPath(id)`，不能靠后缀猜。
- URL：建任务用 `binding.path ?? adapter.createPath`；轮询用
  `binding.path !== undefined ? `${binding.path}/${encodeURIComponent(id)}` : adapter.pollPath(id)`。
  即 **`path` 同时覆盖建任务与轮询**，语义是「这台主机的布局与厂商一致，只是前缀不同」。
  需要独立轮询前缀的方言（dashscope 的 `/api/v1/tasks/{id}`、MiniMax 的
  `/v2/query/video_generation/{id}`）**不能**用 `path` 表达，它们要 `poll_path`（见「留给实现者」）。
- **三个时间常量，不许复用**：`REQUEST_TIMEOUT_MS = 60s`（单次 create / 单次 poll 的
  `AbortSignal`，一个挂住不返回的请求不能吃掉整个预算）、`binding.timeout_ms`
  （默认 1800s，**只**做轮询总预算记账）、下载超时（图像 120s / 视频 600s，独立、
  不计入预算——成片 URL 24 小时有效，1799s 才出片不该因下载慢而报「已付费」）。
- `Authorization: Bearer` + 适配器的 `buildHeaders()`；轮询也要带同样的头。
- 非 2xx 走与图像完全相同的 `errorForStatus`（`parseErrorBody` 钩子已在用）。

### 4.5 命令面

```
mediagen video generate <prompt> [--image <首帧>] [--resolution <r>] [--ratio <r>]
                               [--duration <秒>] [--seed <n>] [--watermark <bool>]
                               [--generate-audio <bool>] [--output-format mp4|mov]
                               [--provider <p>] [--model <id>] [--out-dir <d>]
                               [--api-key <k>] [--base-url <url>] [--no-wait] [--json]

mediagen video status <task-id> [--provider <p>] [--model <id>] [--out-dir <d>]
                                [--api-key <k>] [--base-url <url>] [--json]
```

- **`video status` 是独立子命令，而不是给 `generate` 加 `--task-id`。** 理由：`<prompt>`
  保持必填，commander 不必处理「有时又要有时不要」的位置参数；查询是只读操作，
  天然没有重复付费风险；两个动词各自有明确的退出码语义。
- **`video status` 只查一次**：`pending`/`running` → 打印状态、exit 0（不是错误）；
  `succeeded` → 下载并打印路径；`failed`/`cancelled`/`expired` → exit 1。
  人类想等结果就再跑一次；agent 想等就轮询这个命令。这样「阻塞」与「不阻塞」两端都有了，
  不需要再加 `--wait`。
- **`--no-wait`**：建完任务立刻返回 `task_id`，不轮询、不下载，exit 0。
- **`--image` 只收 1 张**：第 2 张报 `UsageError`，点名首尾帧尚未支持。
- **拒绝图像专属 flag**：`--n`、`--size` 不在 video 命令上声明，commander 直接报未知选项
  （exit 2，未发出任何请求）。`--n` 另有一条专门文案（它是最容易被误用的那个）。
- `video status` 的 provider 解析复用 `resolveSelection({provider, task:"video"})`；
  模型只用于拿到 binding（轮询不需要模型），默认模型即可。

### 4.6 本地校验（全部先于第一个 `fetch`）

| flag | 规则 | 越界时 |
|---|---|---|
| `--resolution` | 大小写归一化后 ∈ `480p \| 720p \| 1080p \| 4k` | `UsageError`：列出全部取值，说明「哪个模型支持哪一档由厂商校验」 |
| `--ratio` | ∈ `16:9 \| 4:3 \| 1:1 \| 3:4 \| 9:16 \| 21:9 \| adaptive` | `UsageError` |
| `--duration` | 正整数 | `UsageError`（`-1` 智能时长本期不开放，实际也过不了 commander 的负号解析） |
| `--seed` | 非负整数 | `UsageError` |
| `--watermark` / `--generate-audio` | 显式 `true`/`false` | `UsageError`（沿用图像约定，不用 `--no-watermark`） |
| `--output-format` | `mp4 \| mov` | `UsageError` |
| `--image` | ≤ 1 | 第 2 张：`UsageError`「首尾帧（`first_frame` + `last_frame`）尚未支持」 |

模型的合法取值**不在本地校验**：`models = [...]` 白名单已经由 `resolveSelection()` 拦住
「这个 id 属于哪个 provider/任务」，而同一 id 的分辨率档位属于厂商能力，交给服务端强校验
（失败发生在建任务时，未计费）。这与图像 `--size` 只做格式检查的哲学一致。

### 4.7 下载：媒体类型从「图像专用」变成参数

`src/download.ts` 现在是图像专用的：`KNOWN_IMAGE_EXTENSIONS`、
`CONTENT_TYPE_EXTENSIONS` 只有 `image/*`、兜底扩展名硬编码 `png`。

- `inferExtension(result, contentType, kind)`：`kind: "image" | "video"`。
  视频的已知扩展名 `mp4/mov/webm/mkv`，`video/*` 的 content-type 映射，兜底 `mp4`。
- `SavedFile.meta` 现在是 `ImageResult`，视频的 `resolution`/`format` 对不上，所以把它放宽成
  `SavedMedia = ImageResult | VideoResult`（`VideoResult` 只多带 `duration`/`resolution`/
  `format`）。读取方只有两处：`output.ts` 的图像信封（读 `meta.size`，加类型守卫即可）与
  新增的视频信封（读 `meta.duration`）。这也是 4.1 里 `AsyncTaskResult` 不必与
  `SavedFile` 同构的原因：前者是协议层的产物，后者是磁盘上的产物。
- 超时按类型：图像保持 120s；视频 600s（几十到上百 MB 的片子，120s 在慢链路上会假失败）。
- 「厂商返回值插进文件名」的既有防御（`SAFE_EXTENSION`）对视频同样生效。
- 仍然整包进内存再原子写：本轮视频上限（ark 单文件 ≤200MB）在 Node 默认堆内可接受，
  而且「要么没有文件、要么完整文件」比流式更符合本仓库的失败语义。
  流式下载列入「留给实现者」。

### 4.8 输出

- 文件名：`<provider>-<slug(model)>-<yyyyMMdd-HHmmss>-<index>.<ext>`，后缀来自 4.7 的推断
  （`…-0.mp4`）。这里的 model **优先用服务端回显的 `AsyncTaskResult.model`**，回落 `binding.model`：
  `video status <id>` 只拿默认模型去凑 binding（轮询不需要模型），如果照 binding 写文件名，
  会用 1.0 的 id 给一个 2.5 生成的片子命名——一个关于文件内容的错误陈述。ark 的查询响应
  是带 `model` 的，所以这条能落地。（`--no-wait` 不写文件，不涉及。）
- 人类模式：成功时 stdout 一行绝对路径；`--no-wait` 时 stdout 一行 task id
  （它**就是**这一行的结果），stderr 一行
  `note: task <id> was created and paid for; fetch it later with "mediagen video status <id>"`。
- JSON：视频自己的信封（`partial` 对视频没有意义，不写）：

```json
{"ok":true,"task_id":"cgt-20261028…","status":"succeeded",
 "files":[{"path":"/abs/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4","index":0,"url":"https://…","duration":5,"resolution":"720p"}],
 "errors":[],"usage":{"completion_tokens":108900},"request_id":"…"}
```

- **`ok` 的语义在视频里刻意与图像不同：`ok` 恒等于「命令本身成功」，等于 exit code 是否为 0。**
  图像信封是 `ok = saved.length > 0`，但视频有「建了任务、还没出片」这种**成功且无文件**的
  状态。若在那里写 `ok: false`，只看 `ok` 判成败的 agent 就会重跑——正中重复付费。
  所以 `--no-wait` 与 `status: "running"` 都是 `ok: true, files: []`；
  「有没有文件」看 `status` 和 `files`，「要不要重跑」看 `status`。这条差异必须写进
  README 与 SKILL.md，否则读者会把两个信封当成同一个契约。
- **失败信封必须带机器可读的 `task_id`，且区分「还没完」与「真失败」**：
  预算耗尽（或轮询途中预算用完）抛的 `ApiError` 带 code `TaskNotFinished`，
  `ApiError` 新增可选字段 `taskId`，`renderError()` 在 JSON 模式下把它写成
  `{"error":{"message":…,"code":"TaskNotFinished","task_id":"cgt-…"}}`；
  人类模式把 task id 与续查命令写进 message。只把 id 塞进 message（靠正则捞）不满足
  目标里那句「agent 不必解析 stderr」。`renderError` 的这条例外只对带 `taskId` 的
  `ApiError` 生效，其余错误输出形状不变。

## 代码改动

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 新增 `VideoRequest`、`AsyncTaskResult`、`TaskOutcome`、`AsyncTaskAdapter`；`SavedFile.meta` 放宽为 `SavedMedia`；`DialectAdapters` 改为两个具名槽（不再是 `Partial<Record<Task,…>>`） |
| `src/errors.ts` | `ApiError` 新增可选 `taskId`（「已付费、还没出片」这类错误要能被 JSON 层读出来） |
| `src/api/ark.ts` | 新增 `buildArkVideoRequest`、`taskIdFromArkTask`、`arkPollPath`、`arkPollOutcome`、`ArkVideoDialect`；复用现有 `parseErrorBody` 语义（ark 的 `{error:{code,message}}` 走 http 的回落，不新增钩子） |
| `src/api/index.ts` | `DIALECTS` 的 `ark` 槽加 `video`；`getAdapter` 三个重载（`image` / `video` / 变量）；`adapterPath` 不变 |
| `src/http.ts` | 新增 `createTask()` / `pollTask()`，共用现有的脱敏、错误体解析、超时与 ANSI 清洗 |
| `src/video.ts`（新） | `runVideoGenerate()`、`runVideoStatus()`、轮询节奏与预算、`VideoOptions`/`VideoResult`/`VideoDeps`、视频 flag 校验 |
| `src/download.ts` | `inferExtension(result, contentType, kind)`、`downloadMedia()`；视频扩展名表与 600s 超时；`downloadImage` 保留为 `kind:"image"` 的薄包装（图像调用点与测试不动） |
| `src/output.ts` | 新增 `renderVideoJson()` / `renderVideoHuman()`；`renderJson`/`renderHuman`（图像）不动；`renderError` 仅在 `ApiError.taskId` 存在时多写 `task_id` |
| `src/cli.ts` | `video` 命令组（`generate` / `status`）与 `VIDEO_OPTION_HELP`、`videoHelpText()`；根 help 的 Quickstart 加一条视频示例；`config show` 对 ark video 现在会打印端点（无需改代码） |
| `src/providers.ts` | 种子：`[providers.volcengine.video]` 的模型改为带日期的快照 id（`doubao-seedance-1-0-pro-250528`，ark 文档示例里的那个），并加一行注释说明第二个模型该怎么加；注释里「video 尚无适配器」的说法删掉 |
| `README.md` / `README.zh-CN.md` | Commands 表加 `video generate` / `video status`；新增「Video」一节（异步语义、`--no-wait`、续查、预算、成本提醒）；模型表加 seedance；「`video` tables parse and are validated, but no dialect has a video adapter yet」这句删掉，改成「dashscope 视频尚未实现」；JSON 信封示例加视频版 |
| `skills/mediagen/SKILL.md` | 何时该用视频而不是图像；长耗时任务该怎么配合 `--no-wait` + `video status` |

## 测试（全部离线，`fetch` 全程 stub）

- `src/api/ark.test.ts`：`buildArkVideoRequest` 的文生 / 首帧（`role: first_frame` 且图在
  文本之后）、`resolution`/`ratio`/`duration`/`seed`/`watermark`/`generate_audio`/
  `output_format` 逐个落位、未给的字段不出现、未知字段不外泄；
  `taskIdFrom`（缺 `id`、`id` 非字符串、空串 → `ApiError`）；`arkPollPath`；
  `pollOutcome` 覆盖 `queued`/`running`/`succeeded`/`failed`/`cancelled`/`expired`/
  未知状态/`succeeded` 但缺 `content.video_url`。
- `src/api/index.test.ts`：`getAdapter("ark","video")` 返回异步适配器；
  `getAdapter("dashscope","video")` 仍报「该方言尚无 video 适配器，现有：image」；
  `adapterPath("ark","video")` 是建任务路径。
- `src/video.test.ts`（新）：每个 flag 的校验与文案；校验失败时**未发生 fetch**；
  成功路径（create → pending → running → succeeded → 下载，文件名以 `.mp4` 结尾）；
  `failed`/`cancelled`/`expired` 各报对应 code；**预算耗尽**的消息含 task id 与
  「不要重新提交」；`--no-wait` 只发一次请求、不轮询、不下载；
  `runVideoStatus` 的四种状态（running 不下载、succeeded 下载、failed 报错、未知 id）；
  非 2xx 的错误体带 vendor code；错误消息里不含 API key。
- `src/download.test.ts`：视频扩展名三级推断（URL 后缀 / `video/*` content-type / 兜底
  `mp4`）；`mov` 保持 `mov`；视频超时常量；文件名格式。
- `src/output.test.ts`：视频 JSON 信封（`ok` / `task_id` / `status` / `files[].duration`），
  `--no-wait` 的 `files: []`；人类模式的 task id 行与 stderr 提示。
- `src/cli.test.ts`：`video generate --help` 含模型表与「一次一个视频」；
  `video generate --n 2` 与 `video generate --size 2K` 报未知选项（exit 2，未 fetch）；
  `video status` 在无 `--provider` 且无 `default_provider` 时给出既有文案；
  `config show` 对 ark video 打印 `endpoint:` 而不是 `no adapter yet`；
  `--json` 下的用法错误仍是 JSON。
- `src/smoke.test.ts`：端到端视频（stub fetch）跑通并打印路径。
- `src/config.test.ts`：补一条「ark 的 video 表现在能解析出 binding」；其余用例不动。

### 必须反转的现有断言

仓库里有几处用例把「ark 没有 video 适配器」写成了预期，本轮它们必须反过来，
否则新行为会被当成回归。这是本轮唯一允许改到图像以外断言的改动，已逐条点出：

| 位置 | 现在断言 | 改成 |
|---|---|---|
| `src/api/index.test.ts` | `getAdapter("ark","video")` 抛 `no video adapter yet` | 返回 `ArkVideoDialect` |
| `src/config.test.ts`（video 任务解析） | `resolveSelection({task:"video"…})` 抛「无适配器」 | 解析出 `binding`，`dialect === "ark"` |
| `src/cli.test.ts:1652` | `config show` 里 `(no adapter yet)` 恰好出现 1 次 | 改为 0 次（两个任务都有端点） |
| `src/cli.test.ts:1728` | 同上，`toContain("(no adapter yet)")` | 改为 `toContain("endpoint: https://ark…/api/v3/contents/generations/tasks")` |
| `src/cli.test.ts:1619-1620` | `config add --task video --api-type ark` 打 note | note 不再出现（有适配器了） |

**种子 model 改名会打到这些地方**（`doubao-seedance-1-0-pro` →
`doubao-seedance-1-0-pro-250528`）：`src/config.test.ts:208-209, 309-310, 334, 504-507,
732-733`、`src/cli.test.ts:1584-1585, 1613, 1619-1620, 1714`、`src/smoke.test.ts:319`。
它们都是字面量替换，没有逻辑改动。

## 怎么验（人工，一次性）

自动化测试全离线，所以合并前要真跑一次最便宜的组合：

```bash
mediagen video generate "一只猫在窗台上伸懒腰，晨光" --provider volcengine \
  --model doubao-seedance-1-0-pro-250528 --resolution 480p --duration 4
mediagen video status <上一步打印的 task_id> --provider volcengine
```

注意 Seedance 2.0/2.5 需要账户余额 > 200 元或资源包，1.0 pro 没有这条限制，所以冒烟用 1.0。

## 否决的方案

- **阻塞到底、不给 task id**（最小实现）。进程被 agent 的 shell 超时杀掉就是「已付费 +
  看起来失败 + 用户重跑」。本仓库的核心不变量正好被这条路径绕过。
- **给 `generate` 加 `--task-id`，prompt 变成可选位置参数。** commander 对「有时必填」的
  位置参数只能靠 `[prompt]` + 手工校验，且同一命令既写又读，退出码语义会打架。
- **`video status` 默认阻塞到出片。** 那它和 `video generate` 的区别只剩「没有 prompt」，
  而 agent 需要的恰恰是「一次调用、立刻返回状态」。
- **本期一并加 `poll_path` 配置键。** ark 的轮询路径就是建任务路径 + `/{id}`，`path` 覆盖
  时拼 `{path}/{id}` 即可；而真正需要独立轮询路径的方言（dashscope、MiniMax）本期不来。
  现在加等于为一个还没到的需求多一个必须解释的键。
- **给 `resolution`/`duration` 建 per-model 能力表。** 服务端强校验会在建任务时报错、不计费；
  本地建表要随厂商每次上新模型而维护，收益是「错误信息早 200ms」。
- **流式下载到临时文件再改名。** 更省内存，但要么接受失败时留下 `.part` 文件，要么多一套
  清理逻辑；本轮 ark 的单文件上限（200MB）在内存里完全可行。
- **把 `video` 做成 `image` 的 `--video` flag。** 异步语义、输出信封、退出码、flag 集
  全都不同，塞进一个命令会让 image 的 help 与校验分支失控。

## 留给实现者

- `--duration -1`（ark 的智能时长）与 `--seed -1`：commander 会把负数当成选项，
  要么用 `--duration=-1` 的写法并显式支持，要么维持现状。本期维持现状。
- `video status --wait`：引擎已经支持，加它只是多一个 flag + 一条测试。
- 独立轮询路径的配置键：dashscope / MiniMax 落地时需要它（形如
  `poll_path = "/api/v1/tasks/{id}"`，`{id}` 占位）。
- 流式下载 + `.part` 临时文件。
- `video list` / 取消任务 / `callback_url` 回环。
- 首尾帧与参考素材：`--last-frame` 在 ark 侧就是多一个
  `{type:"image_url", image_url:{url}, role:"last_frame"}`，接口不用动。
- MiniMax H3 方言：本接口的形状已经容得下（`taskIdFrom` 取 `task_id`、`pollPath` 是另一个
  前缀、`pollOutcome` 读 `task.status` 与 `task.content.url`），但除了适配器，还要在
  `Dialect` 联合类型、`config.ts` 的方言解析、`config add --api-type` 的取值与全部错误
  文案里加一个 `minimax`。

## 评审后的修订（builder check，2026-10-28）

设计文档写完后让一个独立评审者（无对话上下文，只读文档与源码）提了一轮问题，
下面八条是本轮吸收的。它们都是「不回答就得猜、猜错会重新设计」的点，
结论已写进上文对应的节，这里只留判断与理由。

1. **task id 不等结局就要落到终端**（§4.3）。原文档只规定了成功与 `--no-wait` 两种输出，
   恰好漏掉「默认阻塞中进程被杀」这条——而它正是本文开篇要防的漏洞。
   结论：`createTask` 成功后立刻往 stderr 写一行带 task id 的 note，不需要信号处理。
2. **失败信封必须带机器可读的 `task_id` 与稳定 code**（§4.8）。原文档说
   `renderError` 不变，但目标里写着「agent 不必解析 stderr」——两者矛盾。
   结论：`ApiError` 加可选 `taskId`，预算耗尽用 `TaskNotFinished`，`renderError` 只在这种情况下
   多写一个字段。
3. **轮询可重试，建任务不可**（§4.3）。原文档字面上是「一次非 2xx 就终止」，
   那一次网络抖动就会把一个已付费、服务端正常跑着的任务变成 CLI 的失败。
   结论：GET 在预算内重试（网络错误/429/5xx，连续 5 次为限），4xx 立即终止。
4. **`AsyncTaskResult` 原来没定义**（§4.1）。已补完整定义，并明确它与
   `SavedFile.meta`不是同一个东西（协议层产物 vs 磁盘产物），`SavedFile.meta` 因而放宽为
   `SavedMedia`（§4.7）。
5. **`path` 与 `pollPath` 的优先级原来自相矛盾**（§4.4 说拼 `{path}/{id}`，§4.1 又要求轮询
   走适配器）。结论：`path` 同时覆盖建任务与轮询（网关镜像厂商布局的前提），
   而确实需要独立前缀的方言（dashscope / MiniMax）必须用 `poll_path`，本期不加。
6. **`timeout_ms` 原来同时当三个超时**（§4.4）。结论：拆成三个常量：单次请求 60s、
   轮询总预算 `timeout_ms`、下载 600s（不计入预算）。否则一个挂住的请求会吃掉全部预算，
   而下载慢会把「已出片」误报成「已付费未出片」。
7. **`ok` 的语义**（§4.8）。结论：视频的 `ok` 恒等于 exit code 是否为 0
   （「建了任务、还在跑」是 `ok: true, files: []`），因为 `ok: false` 会让只看这个字段的
   agent 重跑。这是与图像信封的**刻意差异**，必须写进 README 与 SKILL.md。
8. **`video status` 的文件名会写错 model**（§4.8）。结论：文件名优先用服务端回显的
   `AsyncTaskResult.model`（ark 的查询响应里有它），回落 `binding.model`。

另有两处文档内部不一致也当轮改掉：`getAdapter` 需要第三个「传变量」的重载（§4.1）；
「现有测试零改动」是过强的说法，已逐条列出必须反转的断言与种子改名会打到的字面量（「测试」）。
