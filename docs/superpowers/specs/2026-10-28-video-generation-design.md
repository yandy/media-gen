# 视频生成（第一期）：异步任务接口、`ark` 与 `minimax` 两个方言、`video generate` / `video status`

日期：2026-10-28
状态：待评审
承接：`2026-10-28-dashscope-native-dialect-design.md` §4.7（异步扩展点）

## 问题

三个图像方言都通了（`openai` / `dashscope` / `ark`），`[providers.x.video]` 能解析、能校验、
`timeout_seconds` 已经有 1800 的默认值，但 `getAdapter()` 一到 `video` 就抛
`the "ark" dialect has no "video" adapter yet`。种子配置里 `[providers.volcengine.video]`
是写着的，于是 `config show` 会把一个永远用不起来的任务打印出来。

视频与图像有一个不能靠改文案绕过的差别：**它是异步的，而付费发生在建任务那一刻。**
一次图像请求是一个 HTTP 往返；一次视频请求是「建任务（付费）→ 轮询 1–5 分钟 → 下载」，
成片 URL 24 小时有效，task id 可查数天到 24 小时不等。进程如果在轮询中途死掉（本地超时、
Ctrl-C、agent 的 shell 超时），钱已经花了，而用户看到的是一个「失败」，最自然的反应是
**再跑一次、再付一次**。本仓库最在意的那类事故（"paid requests are never retried"）
在这里有了一个新的、更贵的入口。

## 目标

- `mediagen video generate` 跑通**文生视频**与**首帧图生视频**，成片落盘、打印路径，
  两个方言同时支持：`ark`（Volcengine Ark）与 `minimax`（MiniMax H3）。
- 异步能力作为一个**并列于图像的接口**接进注册表；图像路径的行为零变化
  （只有几处把「ark 无 video 适配器」写成预期的断言要反转，见「测试」）。
- **中断不等于重复付费**：`--no-wait` 建完即返回 task id，`video status <id>` 只查一次并在
  成功时下载；轮询预算耗尽时报错带 task id 并说明「任务已付费，别再提交」。
- **统一三层、不统一取值域**：异步引擎、内部请求模型、flag 名字统一；各模型的参数取值
  由方言翻译、由服务端强校验（见「方案」一节的颗粒度结论）。
- 所有能在本地判定的错误仍然发生在第一个 `fetch` 之前。
- 视频的 JSON 输出带 `task_id` 与 `status`，让 agent 不需要解析 stderr。

## 非目标

- **dashscope 视频不做了（正式划掉，不是「还没做」）。** 同一个端点下压着三代互不兼容的
  请求词汇（legacy 的 `parameters.size` + `input.img_url`、wan2.7 的 `media[]`、
  wan3.0 的全素材 `media[]`），要它就得再引入一层「按模型分派请求体」的能力层。
  用户已决定不投入，因此 `dashscope` 在 `video` 槽长期为空，相关文案要去掉「yet」
  这种「将来会有」的暗示。
- 不做 openai（Sora）式视频。
- **首尾帧、参考图/参考视频/参考音频**不做。`--image` 只表示首帧，第二张明确报错并说明
  首尾帧尚未支持。两个方言的参考素材词表（`reference_image` / `reference_video` /
  `reference_audio`）形状都已经在文档里，属于纯增量。
- 视频编辑 / 延长 / 续写；MiniMax 的 H3-Context-IR、regeneration（768P→2K）、
  list / cancel / delete；ark 的 draft 样片模式、`tools`、`priority`、
  `safety_identifier`、`omni_reference_task_type`；两家的 `callback_url`。
- 不做 per-model 能力表（用户已定：不统一取值域，见 §4.6）。
- 不做 `video list`、不做取消任务、不做流式下载。
- 不改图像命令的任何 flag、输出格式或退出码。

## 已核实的事实（官方文档，2026-10-28）

### ark：建任务

`POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`

```json
{"model":"doubao-seedance-1-0-pro-250528",
 "content":[{"type":"text","text":"小猫对着镜头打哈欠"},
            {"type":"image_url","image_url":{"url":"https://…/a.png"},"role":"first_frame"}],
 "resolution":"720p","ratio":"16:9","duration":5,"seed":11,"watermark":true}
```

- 响应只有任务 id：`{"id":"cgt-20261028…"}`。**没有状态字段。**
- 图片 `role`：首帧可写 `first_frame` 或省略；首尾帧两张时 `role` 必填；参考图每张必须
  `reference_image`。首帧、首尾帧、全模态参考三种场景**互斥**。
- 图片输入接受公网 URL / `data:image/<fmt>;base64,…` / `asset://<ID>`；请求体 ≤ 64MB。
- 参数可用性随模型变化：`camera_fixed`/`frames` 仅 1.0；`generate_audio` 2.0/2.5；
  `output_format`/`draft`/`tools`/`priority` 仅 2.5。`resolution` 可选值与 `duration`
  区间每个模型不同（1.0 pro：`480p/720p/1080p`，默认 `1080p`，duration 2–12；
  2.0：含 `4k`，duration 4–15 或 `-1`；2.5：无 `4k`，duration 4–30 或 `-1`，默认 `-1`）。
- 文档自身有一处不一致：`seed` 的「模型支持」只列 1.0，但查询响应里 2.0 也回 `seed`。

### ark：查询任务

`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`

- `status`：`queued` | `running` | `cancelled` | `succeeded` | `failed` | `expired`
  （`expired` = 超过 `execution_expires_after`，默认 48 小时）。
- 成片 `content.video_url`（24h；Seedance 2.5 另有 100 次下载上限）；失败为顶层
  `error: {code, message}`，成功时 `null`。回显 `model`、`resolution`、`ratio`、
  `duration`、`framespersecond`、`seed`、`output_format`；用量是 token。

### minimax：建任务

`POST https://api.minimax.io/v2/video_generation`

```json
{"model":"MiniMax-H3",
 "content":[{"type":"text","text":"…"},
            {"type":"image_url","image_url":{"url":"https://…/a.png"},"role":"first_frame"}],
 "duration":5,"resolution":"2K","ratio":"16:9"}
```

**这一份请求体与 ark 逐字同构**：同一个 `content[]`、同一个 `type` 词表
（`text` / `image_url` / `video_url` / `audio_url`）、同一套 `role` 词表
（`first_frame` / `last_frame` / `reference_image` / `reference_video` /
`reference_audio`）、同一组顶层标量（`model` / `resolution` / `ratio` / `duration`）。
差异只在：字段**必填性**（`resolution`、`duration` 必填；`ratio` 在文生视频里必填且
**不能** `adaptive`，图生视频里恒为 `adaptive` 且传别的被静默忽略）、**取值域**
（`480P` / `768P` / `2K`，大写）、以及独有字段（`extra.prompt_expansion_mode` 仅 `-Max`）。

- 响应：`{"task_id":"424010985738629"}`。**没有状态字段**（与 ark 一致）。
- 模型变体：`MiniMax-H3`（`768P`/`2K`，4–15s）、`-Highspeed`（仅 `768P`，4–15s）、
  `-Lite`（`480P`/`768P`，4–15s，不支持 `adaptive`）、`-Max`（`480P`/`768P`，5–15s）。
- 素材限制：首帧/尾帧各 ≤1，参考图 ≤9，参考视频 ≤3（单段 2–15s、合计 ≤15s），
  参考音频 ≤3（合计 ≤15s），混合素材合计 ≤12 个；单文件 ≤50MB（视频）/30MB（图片）/
  15MB（音频），请求体 ≤64MB；提示词 ≤7000 字符。
- 参考素材对象的形状 `{"type":"audio_url","audio_url":{"url":…},"role":"reference_audio"}`
  是按同一套规则推出来的（官方示例只给了 text / image_url / video_url 三种）——
  本期不做参考素材，实现时若要碰它再核一次。
- 错误体是另一种形状：`{"type":"error","error":{"type":"bad_request_error",
  "message":"…(2013)","http_code":"400"},"request_id":"…"}`——**数字错误码藏在
  message 文本的括号里**，`error.type` 是稳定的类别。

### minimax：查询任务

`GET https://api.minimax.io/v2/query/video_generation/{task_id}`

- 结果全嵌在 `task` 里：`task.status`、`task.content.url`、`task.model`、
  `task.resolution`、`task.duration`、`task.ratio`、`task.usage`（`total_seconds` /
  `input_seconds` / `output_seconds` / `total_tokens` …）、失败时 `task.error`。
- 终态：`succeeded` / `failed` / `cancelled`；非终态 `queued` / `running`
  （create 文档的回调状态表列的是这五个）。
- 成功时**直接给可下载 URL**，不需要老 `/v1` 那套 `file_id` → `retrieve` 的第三次调用。
- 官方建议轮询间隔 10s。

### 三家对比小结（决定了下面「统一到哪一层」）

| 层 | ark vs minimax | dashscope |
|---|---|---|
| 异步骨架（create → poll → 直接给 URL） | 几乎一致 | 一致（多一个 `X-DashScope-Async: enable` 头） |
| 请求体形状 | **逐字同构** | 异类：`input.prompt` + `input.media[]` + `parameters`，且有三代词汇 |
| 标量参数名 | 一致（`resolution` / `ratio` / `duration`） | 一致 |
| 标量取值域 | 不同（`720p` vs `768P`/`2K`；duration 区间不同） | 又不同，且大小写是 `720P` |
| 模式 | 都由素材组合推导、无 `mode` 字段 | 同左，但用 `media[].type` 白名单表达 |
| 状态词表 | ark 多 `expired`；minimax 无 | 多 `UNKNOWN` |
| 结果位置 | 平铺 `content.video_url` vs 嵌 `task.content.url` | `output.video_url` |
| 错误体 | `{error:{code,message}}` vs `{type,error:{type,message}}` | 顶层 `{code,message}` 或 `output` 内 |

结论：**骨架与请求体值得统一（2/3 家天然同构），取值域与独有参数不统一。**

## 方案（已选定 A）

**A. 并列的异步接口（选定）。** 图像继续用 `TaskAdapter`，视频用新的 `AsyncTaskAdapter`，
注册表两个槽，`getAdapter` 用重载区分。图像适配器、`generate.ts` 与图像信封的渲染都不动；
图像测试也不动（除了几处把「ark 无 video 适配器」写成预期的断言，见「测试」）。

**B. 把 `TaskAdapter` 整体泛型化。** `TaskAdapter<Req, Res>` + `ParsedResponse` 泛化成
`items[]`。概念更统一，但要动 3 个图像适配器、`generate.ts`、`output.ts` 以及所有断言
`response.images` 的测试；收益只是「少一个接口」，风险全落在与视频无关的图像路径上。

**C. 为每个厂商写死一条快路径。** 今天最快，但轮询引擎要写两遍，第三个方言再来一遍，
`config show` 的端点也会失去唯一真相。

### 统一的颗粒度（用户已定）

**统一三层**：① 异步引擎（create/poll/预算/续查/退出码/JSON 信封）；② 内部请求模型
（`prompt` + 有序 `media[{role,url}]` + 少量标量）；③ flag 的**名字**与**格式校验类别**。

**不统一三层**：① 标量参数的**取值域**（`720p` / `768P` / `2K`、duration 区间）——
方言翻译，模型级规则交服务端强校验；② **模式**（不设 `--mode t2v/i2v/r2v`，两家都是
「由给了哪些素材推导模式」）；③ **独有参数**（`--generate-audio`、`--output-format`
是 ark 专属，用错方言本地拒绝——沿用图像侧 `ARK_ONLY_FIELDS` 的做法）。

**一条纪律**：引擎**永远不替用户补值**，默认值只由适配器提供。因为「同名不同义」
——`ratio: "adaptive"` 在 ark 可选、minimax 文生视频禁止、minimax 图生视频被强制、
`-Lite` 不支持；`duration: -1` 在 ark 是「智能时长」而在 minimax 是非法值——
统一语义会造成静默错误行为。

## 决定的形状

### 4.1 两个接口并列，注册表两个槽，`Dialect` 加一个值

`src/types.ts`

```ts
/** 协议家族，不是厂商。`openai` 是 OpenAI 兼容格式；`qwen` 只是它的旧别名。 */
export type Dialect = "openai" | "dashscope" | "ark" | "minimax";
```

`minimax` 与 `ark` 同级：方言名对应一个 code path（一套端点 + 一套错误体 + 一套解析），
而不是一个形状。「厂商名当方言名」在本仓库已是有例在先（`dashscope`、`ark`）。

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
  /** ark: json.id；minimax: json.task_id。 */
  taskIdFrom(json: unknown): string;
  /** ark: {createPath}/{id}；minimax: 另一个前缀，所以这是函数而不是后缀规则。 */
  pollPath(id: string): string;
  /** 一次轮询响应 → 明确结局，或「还没完」。 */
  pollOutcome(json: unknown): TaskOutcome;
  parseErrorBody?(json: unknown): { code?: string; message: string } | undefined;
  /** 这个方言接受哪些 resolution 取值（小写）。见 §4.6 的三层校验。 */
  resolutions: readonly string[];
  /** 只被这个方言接受的 flag；别的方言用了要在本地报错。 */
  exclusiveFields?: readonly (keyof VideoRequest)[];
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

**刻意没有 `buildHeaders?()`**：本期两个方言都只要 `Authorization: Bearer`，加一个没有方言
实现的可选钩子就是没人调用的死代码（而且它无法被测试——适配器来自注册表，没法注入）。
第一个需要额外头的方言（dashscope 若复活，或 MiniMax 未来的 Context-IR 端点）落地时再加，
那时它自然有实现也有测试。

### 4.2 视频的请求模型

`VideoRequest` 沿用 `ImageRequest` 的 snake_case 命名（线上字段名即内部字段名）：

```ts
export interface VideoRequest {
  model: string;
  prompt: string;
  first_frame?: string;          // URL 或 data URL；只收 1 张
  resolution?: string;           // 已归一化为小写，如 "720p" / "768p" / "2k"
  ratio?: string;                // "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive"
  duration?: number;             // 秒，正整数
  seed?: number;
  watermark?: boolean;
  generate_audio?: boolean;      // ark 2.0/2.5；minimax 拒绝
  output_format?: "mp4" | "mov"; // ark 2.5；minimax 拒绝
}
```

`media` 只有一项（`first_frame`），所以本期用一个字符串而不是数组。首尾帧与参考素材
落地时它改成 `media: { role, url }[]`，适配器与引擎的形状不用动（两家都是这个形状）。

### 4.3 轮询引擎

新文件 `src/video.ts`，对外两个入口：

```ts
export async function runVideoGenerate(prompt: string, opts: VideoOptions, deps?: VideoDeps): Promise<VideoResult>;
export async function runVideoStatus(taskId: string, opts: VideoStatusOptions, deps?: VideoDeps): Promise<VideoResult>;
```

- **节奏**：建任务成功后先等 2s，之后每次 ×1.5 递增、封顶 10s（`2, 3, 4.5, 6.75, 10, 10…`）。
  两家的官方建议分别是 10s（ark SDK 示例）与 10s（minimax），先快后慢能让快模型不必干等，
  又不会在长排队时打满 RPM。
- **预算**：`binding.timeout_ms`（默认 1800s）。**预算耗尽不是失败**，是「已付费、还没出片」：
  抛带 `taskId` 与 code `TaskNotFinished` 的 `ApiError`，消息里给
  `mediagen video status <id>`，并明确写「任务已付费，不要重新提交」。
- **可注入**：`VideoDeps { sleep(ms): Promise<void>; now(): number }`，默认真实实现。
  测试传 `sleep: async () => {}` + 假时钟，因此超时路径不需要真等 30 分钟。
- **一次视频**：`TaskOutcome.succeeded` 给一个 `AsyncTaskResult`，所以下载走一次
  `downloadMedia`，`saved[].index` 恒为 0。
- **task id 立刻落到终端，不等结局**：`createTask` 成功后马上往 **stderr** 写一行
  `note: task <id> created and paid for; if this process is interrupted, resume with "mediagen video status <id>"`。
  否则「默认阻塞」这条路就是开篇那个漏洞：进程被 Ctrl-C 或 agent 的 shell 超时杀掉时，
  id 只存在于内存里，用户手里什么都没有，只能重跑、再付一次。stdout 仍只放结果
  （`--json` 时也写 stderr，agent 读 stdout 不受影响），因此不需要信号处理。
- **轮询可以重试，建任务不可以**：GET 不花钱且幂等，所以网络错误、`429`、`5xx` 在预算内
  重试（沿用同一条退避曲线），连续失败 **5** 次则终止并报出最后一次的原因；
  `401`/`403`/`404` 与其他 4xx 立即终止（那是密钥、配置或 task id 错，重试只会拖 30 分钟）。
  这与「付费请求永不重试」不矛盾：重试的是查询，不是付费。
- **建任务超时是最危险的一种失败**：请求可能已经到达服务端并创建成功。文案必须写
  「创建请求超时，任务**可能**已创建并计费；先查 `video status`，不要直接重跑」。

### 4.4 传输层：`http.ts` 增加两个动作

`callApi()` 是「build → POST → 解析」；视频需要「POST 只拿 id」与「GET 只拿状态」，
但它们必须共用现有的错误/脱敏/超时逻辑（`errorForStatus`、`redactorFor`、`parseJson`、
ANSI 清洗），这些是模块私有函数。因此传输层留在 `http.ts`：

```ts
export async function createTask(params: {binding; apiKey; request}): Promise<{taskId: string; requestId?: string}>;
export async function pollTask(params: {binding; apiKey; taskId}): Promise<TaskOutcome & {requestId?: string}>;
```

- 两个函数自己用 `getAdapter(binding.dialect, "video")` 取适配器：`pollTask` 需要它是因为
  轮询路径是 `adapter.pollPath(id)`，不能靠后缀猜（minimax 的轮询前缀与建任务前缀不同）。
- URL：建任务用 `binding.path ?? adapter.createPath`；轮询用
  `binding.path !== undefined ? `${binding.path}/${encodeURIComponent(id)}` : adapter.pollPath(id)`。
  即 **`path` 同时覆盖建任务与轮询**，语义是「这台主机的布局与厂商一致，只是前缀不同」。
  需要独立轮询前缀的**代理**（不是方言——两个方言各自的路径都由适配器给）要 `poll_path`
  （见「留给实现者」）。
- **三个时间常量，不许复用**：`REQUEST_TIMEOUT_MS = 60s`（单次 create / 单次 poll 的
  `AbortSignal`；一个挂住不返回的请求不能吃掉整个预算）、`binding.timeout_ms`
  （默认 1800s，**只**做轮询总预算记账）、下载超时（图像 120s / 视频 600s，独立、
  不计入预算——成片 URL 24 小时有效，1799s 才出片不该因下载慢而被报成「已付费未出片」）。
- `Authorization: Bearer`；两个方言都不需要额外的头，所以本期不设 `buildHeaders()`（§4.1）。
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
  天然没有重复付费风险；两个动词各有明确的退出码语义。
- **`video status` 只查一次**：`pending`/`running` → 打印状态、exit 0（不是错误）；
  `succeeded` → 下载并打印路径；`failed`/`cancelled`/`expired` → exit 1。
  人类想等就再跑一次；agent 想等就轮询这个命令。两端都有了，不需要 `--wait`。
- **`--no-wait`**：建完任务立刻返回 `task_id`，不轮询、不下载，exit 0。
- **`--image` 只收 1 张**：第 2 张报 `UsageError`，点名首尾帧尚未支持。
- **拒绝图像专属 flag**：`--n`、`--size` 不在 video 命令上声明，commander 直接报未知选项
  （exit 2，未发出任何请求）。`--n` 另有一条专门文案（它最容易被误用）。
- `video status` 的 provider 解析复用 `resolveSelection({provider, task:"video"})`；
  模型只用于拿到 binding（轮询不需要模型），默认模型即可。

### 4.6 本地校验三层：格式 → 方言 → 模型（服务端）

用户已定「不统一取值域」，所以校验分三层，各管一段：

| 层 | 管什么 | 谁负责 | 例子 |
|---|---|---|---|
| 格式 | 这个词是不是一个合法形状 | `video.ts` | `--duration` 是正整数；`--seed` 是非负整数；`--watermark` 是 true/false |
| 方言 | 这个方言有没有这档 | `AsyncTaskAdapter.resolutions` / `exclusiveFields` | `--resolution 768p` 对 ark 立即报错（ark 没有这一档）；`--generate-audio` 对 minimax 立即报错 |
| 模型 | 这个**模型**支持这档吗 | **服务端强校验**（建任务时，未计费） | `--resolution 4k --model doubao-seedance-1-0-pro-250528` 本地通过，建任务时 400 |

`resolution` 的内部取值是小写，每个方言声明自己的集合，线上大小写由方言翻译：

| 方言 | 接受（内部小写） | 线上形态 |
|---|---|---|
| `ark` | `480p` `720p` `1080p` `4k` | 小写，如 `720p` |
| `minimax` | `480p` `768p` `2k` | 大写，如 `768P`、`2K` |

`--ratio` 是三家共有的封闭枚举：`16:9` `4:3` `1:1` `3:4` `9:16` `21:9` `adaptive`，
本地只查枚举，**不替用户补**（minimax 文生视频禁止 `adaptive`、图生视频强迫 `adaptive`，
这属于模型的场景规则，交给服务端）。

`--duration` / `--seed` 只查整数形状；区间与模型支持交服务端。

### 4.7 两个适配器的契约

**`src/api/ark.ts`（在现有文件里加视频部分）**

```ts
createPath: "/api/v3/contents/generations/tasks"
buildRequest(req) → {
  model, 
  content: [{type:"text", text: prompt}, ...(first_frame ? [{type:"image_url", image_url:{url}, role:"first_frame"}] : [])],
  resolution?, ratio?, duration?, seed?, watermark?, generate_audio?, output_format?
}
taskIdFrom(json)  → json.id（缺失/非字符串/空串 → ApiError）
pollPath(id)      → `/api/v3/contents/generations/tasks/${encodeURIComponent(id)}`
pollOutcome(json) → queued|running → pending/running；
                    succeeded → {state:"succeeded", result:{url: content.video_url, model, duration, resolution, ratio, format: output_format, usage}}；
                    failed → failure 来自 json.error；cancelled、expired 各给一条点名的文案；
                    其他/缺失状态、succeeded 但无 video_url → ApiError
resolutions: ["480p","720p","1080p","4k"]
exclusiveFields: ["generate_audio","output_format"]
parseErrorBody: 不实现（`{error:{code,message}}` 走 http.ts 现有回落）
```

**`src/api/minimax.ts`（新文件）**

```ts
createPath: "/v2/video_generation"
buildRequest(req) → {
  model,
  content: [{type:"text", text: prompt}, ...(first_frame ? [{type:"image_url", image_url:{url}, role:"first_frame"}] : [])],
  resolution: req.resolution ?? "768p"  → 线上 "768P"，
  duration:   req.duration   ?? 5,        // 必填字段，默认值归适配器
  ratio?:     req.ratio                  // 图生视频时不传（恒 adaptive）
  watermark?（若该方言支持则传；见下）
}
taskIdFrom(json)  → json.task_id
pollPath(id)      → `/v2/query/video_generation/${encodeURIComponent(id)}`   // 与 create 前缀不同
pollOutcome(json) → task.status：queued|running → pending/running；
                    succeeded → {state:"succeeded", result:{url: task.content.url, model: task.model, duration, resolution, ratio, usage}}；
                    failed → failure 来自 task.error；cancelled → 点名的 cancelled 文案；
                    其他/缺失状态、succeeded 但无 task.content.url → ApiError
resolutions: ["480p","768p","2k"]
exclusiveFields: []            // 没有 ark 那两个
parseErrorBody(json) → {type:"error", error:{type, message}} 里取 message，code 用 error.type
```

两个说明：

1. **`minimax` 的必填字段由适配器补默认值**（`duration: 5`、`resolution: "768p"`）。
   这是「引擎不替用户补值」的例外，也是它的正例：默认值属于**协议**（这个方言缺了它会
   被拒），不属于 CLI。选 `768p` 而不是 `2k` 是因为前者处在更便宜的档位
   （具体单价见 MiniMax 的定价页，不在此固化到代码里）。
2. **`minimax` 的 `watermark`**：create 文档的 body 参数里没有 watermark
   （只有 `model` / `content` / `resolution` / `duration` / `ratio` / `extra` /
   `callback_url`）。所以 `--watermark` 对 minimax 属于「方言没有这个参数」——
   实现时先核对一次；若确认没有，就把它放进 minimax 的拒绝列表，
   与 `--generate-audio` 对 minimax 的处理一致。**这条不阻塞设计**：无论哪种，
   都是 `exclusiveFields` 里加减一个名字。

### 4.8 下载：媒体类型从「图像专用」变成参数

`src/download.ts` 现在是图像专用的：`KNOWN_IMAGE_EXTENSIONS`、
`CONTENT_TYPE_EXTENSIONS` 只有 `image/*`、兜底扩展名硬编码 `png`。

- `inferExtension(result, contentType, kind)`：`kind: "image" | "video"`。
  视频已知扩展名 `mp4/mov/webm/mkv`、`video/*` 的 content-type 映射、兜底 `mp4`。
- `SavedFile.meta` 现在是 `ImageResult`，视频的 `resolution`/`format` 对不上，所以放宽成
  `SavedMedia = ImageResult | VideoResult`。读取方只有两处：`output.ts` 的图像信封
  （读 `meta.size`，加类型守卫）与新增的视频信封（读 `meta.duration`）。
- 超时按类型：图像 120s；视频 600s。
- 「厂商返回值插进文件名」的既有防御（`SAFE_EXTENSION`）对视频同样生效。
- 仍然整包进内存再原子写：两家单文件上限（ark 200MB、minimax 50MB）在 Node 默认堆内可接受，
  且「要么没有文件、要么完整文件」比流式更符合本仓库的失败语义。流式列入「留给实现者」。

### 4.9 输出

- 文件名：`<provider>-<slug(model)>-<yyyyMMdd-HHmmss>-<index>.<ext>`，后缀来自 4.8 的推断
  （`…-0.mp4`）。这里的 model **优先用服务端回显的 `AsyncTaskResult.model`**，回落
  `binding.model`：`video status <id>` 只拿默认模型去凑 binding（轮询不需要模型），
  照 binding 写文件名会用 1.0 的 id 给一个 2.5 生成的片子命名——一个关于文件内容的错误陈述。
  两家查询响应都带 `model`。（`--no-wait` 不写文件，不涉及。）
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
  所以 `--no-wait` 与 `status: "running"` 都是 `ok: true, files: []`。
  这条差异必须写进 README 与 SKILL.md，否则读者会把两个信封当成同一个契约。
- **失败信封必须带机器可读的 `task_id`，且区分「还没完」与「真失败」**：预算耗尽抛的
  `ApiError` 带 code `TaskNotFinished`，`ApiError` 新增可选字段 `taskId`，
  `renderError()` 在 JSON 模式下把它写成
  `{"error":{"message":…,"code":"TaskNotFinished","task_id":"cgt-…"}}`；人类模式把 task id
  与续查命令写进 message。只把 id 塞进 message（靠正则捞）不满足目标里那句
  「agent 不必解析 stderr」。这条例外只对带 `taskId` 的 `ApiError` 生效。

### 4.10 配置、种子与 dashscope 的收尾

- `Dialect` 加 `minimax` 会牵动四处：`config.ts` 的 `readDialect()`、`DIALECT_CHOICES`
  那句错误文案、`config add --api-type` 的可选值、`isVendorHost()` 的域名表
  （加 `api.minimax.io`；CN 站点域名见「留给实现者」）。
- 种子新增一个 `[providers.minimax]`（`base_url = "https://api.minimax.io"`、
  `api_key_env = "MINIMAX_API_KEY"`、`[providers.minimax.video]` 默认 `MiniMax-H3`、
  `models = ["MiniMax-H3", "MiniMax-H3-Max"]`）。理由：方言进了代码就该在种子里有可跑的
  样例，与 `volcengine` 的两个图像模型同构。`default_provider` 不动（仍是 `volcengine`）。
- 种子里的 `[providers.volcengine.video]` 模型换成带日期的快照
  `doubao-seedance-1-0-pro-250528`（README 自己写着「ids 是带日期的快照」）。
- **dashscope 视频划掉**：`getAdapter()` 的缺适配器文案去掉 `yet`（改成
  `the "dashscope" dialect has no "video" adapter; implemented tasks: image`），
  README 把「`video` tables parse and are validated, but no dialect has a video adapter yet」
  改成「视频方言是 `ark` 与 `minimax`；`dashscope` 不提供视频」，
  `config show` 对 dashscope video 仍打印 `no adapter yet` → 改为
  `endpoint: (the dashscope dialect has no video task)`。这句话要说「没有」，不要说「还没做」。

## 代码改动

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `Dialect` 加 `minimax`；新增 `VideoRequest`、`AsyncTaskResult`、`TaskOutcome`、`AsyncTaskAdapter`；`SavedFile.meta` 放宽为 `SavedMedia`；`DialectAdapters` 改为两个具名槽 |
| `src/errors.ts` | `ApiError` 新增可选 `taskId` |
| `src/api/ark.ts` | 新增 `buildArkVideoRequest`、`taskIdFromArk`、`arkPollPath`、`arkPollOutcome`、`ArkVideoDialect` |
| `src/api/minimax.ts`（新） | `buildMinimaxVideoRequest`、`taskIdFromMinimax`、`minimaxPollPath`、`minimaxPollOutcome`、`parseMinimaxError`、`MinimaxVideoDialect` |
| `src/api/index.ts` | `DIALECTS` 加 `minimax`（只有 video 槽），`ark` 加 video 槽；`getAdapter` 三个重载；`adapterPath` 不变 |
| `src/http.ts` | 新增 `createTask()` / `pollTask()`，共用脱敏、错误体解析、超时与 ANSI 清洗 |
| `src/video.ts`（新） | `runVideoGenerate()`、`runVideoStatus()`、轮询节奏与预算、`VideoOptions`/`VideoResult`/`VideoDeps`、三层校验 |
| `src/download.ts` | `inferExtension(result, contentType, kind)`、`downloadMedia()`；视频扩展名表与 600s 超时；`downloadImage` 保留为 `kind:"image"` 的薄包装（图像调用点与测试不动） |
| `src/output.ts` | 新增 `renderVideoJson()` / `renderVideoHuman()`；`renderJson`/`renderHuman`（图像）不动；`renderError` 仅在 `ApiError.taskId` 存在时多写 `task_id` |
| `src/config.ts` | `readDialect()` 接受 `minimax`；`DIALECT_CHOICES` 文案；`isVendorHost()` 加 `api.minimax.io` |
| `src/cli.ts` | `video` 命令组（`generate` / `status`）与 `VIDEO_OPTION_HELP`、`videoHelpText()`；`config add --api-type` 加 `minimax`；根 help 的 Quickstart 加一条视频示例；`config show` 的缺适配器文案改为「没有这个任务」 |
| `src/providers.ts` | 种子：`volcengine.video` 换成带日期的快照 id；新增 `[providers.minimax]` 与它的 video 表；注释里「video 尚无适配器」删掉 |
| `README.md` / `README.zh-CN.md` | Commands 表加 `video generate` / `video status`；新增「Video」一节（异步语义、`--no-wait`、续查、预算、成本、两个方言的模型表）；方言表加 `minimax`；dashscope 视频写成「不提供」；JSON 信封加视频版并说明 `ok` 的差异 |
| `skills/mediagen/SKILL.md` | 何时用视频而非图像；长耗时任务如何配合 `--no-wait` + `video status`；`ok` 语义的差异 |

## 测试（全部离线，`fetch` 全程 stub）

- `src/api/ark.test.ts`：`buildArkVideoRequest` 的文生 / 首帧（`role: first_frame`、图在
  文本之后）、各标量逐个落位、未给的字段不出现、未知字段不外泄；`taskIdFrom`
  （缺 `id` / 非字符串 / 空串 → `ApiError`）；`arkPollPath`；`pollOutcome` 覆盖
  `queued`/`running`/`succeeded`/`failed`/`cancelled`/`expired`/未知状态/成功但缺
  `content.video_url`。
- `src/api/minimax.test.ts`（新）：`buildMinimaxVideoRequest` 的文生 / 首帧、`resolution`
  小写→大写（`768p`→`768P`、`2k`→`2K`）、**必填字段的默认值**（缺 `duration`→5、
  缺 `resolution`→`768P`）、`taskIdFrom`（`task_id`）、`minimaxPollPath` 与 createPath
  **前缀不同**、`pollOutcome` 覆盖 `queued`/`running`/`succeeded`/`failed`/`cancelled`/
  未知状态/成功但缺 `task.content.url`、`parseErrorBody` 从 `{type:"error",error:{…}}`
  取 message 与 code。
- `src/api/index.test.ts`：`getAdapter("ark","video")` 与 `getAdapter("minimax","video")`
  返回各自的异步适配器；`getAdapter("dashscope","video")` 报「没有 video 任务」；
  `getAdapter("minimax","image")` 报「minimax 只有 video」（该方言本期没有图像适配器）；
  `adapterPath` 对三家各自正确。
- `src/video.test.ts`（新）：每个 flag 的三层校验与文案（格式错、方言没有这一档、
  方言专属 flag 用错方言）；校验失败时**未发生 fetch**；成功路径
  （create → pending → running → succeeded → 下载，文件名以 `.mp4` 结尾）；
  `failed`/`cancelled`/`expired` 各报对应 code；**预算耗尽**的消息含 task id 与
  「不要重新提交」，JSON 模式带 `task_id` 与 `TaskNotFinished`；轮询瞬时失败重试、
  连续 5 次后终止、4xx 立即终止；`--no-wait` 只发一次请求、不轮询、不下载；
  `runVideoStatus` 的四种状态；错误消息里不含 API key；两个方言各跑一遍同一组用例
  （用一个表驱动的 `for (const dialect of ["ark","minimax"])`）。
- `src/download.test.ts`：视频扩展名三级推断、`mov` 保持 `mov`、视频超时常量、文件名格式。
- `src/output.test.ts`：视频 JSON 信封（`ok`/`task_id`/`status`/`files[].duration`）、
  `--no-wait` 的 `files: []`、带 `taskId` 的错误信封；人类模式的 task id 行与 stderr 提示。
- `src/cli.test.ts`：`video generate --help` 含两个方言的模型表与「一次一个视频」；
  `video generate --n 2` 与 `video generate --size 2K` 报未知选项（exit 2，未 fetch）；
  `--generate-audio` 对 minimax 立即报错；`config add --api-type minimax` 可写可读；
  `video status` 在无 provider 且无 `default_provider` 时给出既有文案；
  `config show` 对 ark/minimax video 打印 `endpoint:`；`--json` 下的用法错误仍是 JSON。
- `src/smoke.test.ts`：两个方言各一条端到端（stub fetch）。
- `src/config.test.ts`：`minimax` 能被解析；ark/minimax 的 video 表都能解析出 binding。

### 必须反转的现有断言

仓库里有几处用例把「视频没有适配器」写成了预期，本轮必须反过来，否则新行为会被当成回归。
这是本轮唯一允许改到图像以外断言的改动，已逐条点出：

| 位置 | 现在断言 | 改成 |
|---|---|---|
| `src/api/index.test.ts` | `getAdapter("ark","video")` 抛 `no video adapter yet` | 返回 `ArkVideoDialect` |
| `src/config.test.ts`（video 任务解析） | `resolveSelection({task:"video"…})` 抛「无适配器」 | 解析出 binding，`dialect === "ark"` |
| `src/cli.test.ts:1652` | `config show` 里 `(no adapter yet)` 恰好 1 次 | 改为 0 次 |
| `src/cli.test.ts:1728` | `toContain("(no adapter yet)")` | 改为 `toContain("endpoint: https://ark…/api/v3/contents/generations/tasks")` |
| `src/cli.test.ts:1619-1620` | `config add --task video --api-type ark` 打 note | note 不再出现 |
| `src/config.test.ts`（非法 api_type 文案） | 文案里只有三个协议名 | 文案含四个（`openai`/`dashscope`/`ark`/`minimax`）；`qwen` 仍是 `openai` 的旧别名 |

**种子 model 改名会打到这些字面量**（`doubao-seedance-1-0-pro` →
`doubao-seedance-1-0-pro-250528`）：`src/config.test.ts:208-209, 309-310, 334, 504-507,
732-733`、`src/cli.test.ts:1584-1585, 1613, 1619-1620, 1714`、`src/smoke.test.ts:319`。
纯字面量替换，无逻辑改动。新增的 `[providers.minimax]` 会不会打到「provider 数量」这类
断言，实现时用 `npm test` 找一遍。

## 怎么验（人工，一次性）

自动化测试全离线，所以合并前每个方言各真跑一次最便宜的组合：

```bash
# ark（1.0 pro 没有余额门槛；2.0/2.5 需要余额 > 200 元或资源包）
mediagen video generate "一只猫在窗台上伸懒腰，晨光" --provider volcengine \
  --model doubao-seedance-1-0-pro-250528 --resolution 480p --duration 4

# minimax（H3 走按量付费；768P 比 2K 便宜）
mediagen video generate "一只猫在窗台上伸懒腰，晨光" --provider minimax \
  --resolution 768p --duration 4

mediagen video status <上一步打印的 task_id> --provider <上一步的 provider>
```

## 否决的方案

- **阻塞到底、不给 task id**（最小实现）。进程被 agent 的 shell 超时杀掉就是「已付费 +
  看起来失败 + 用户重跑」。
- **给 `generate` 加 `--task-id`，prompt 变成可选位置参数。** commander 对「有时必填」的
  位置参数只能靠 `[prompt]` + 手工校验，且同一命令既写又读，退出码语义会打架。
- **`video status` 默认阻塞到出片。** 那它和 `video generate` 的区别只剩「没有 prompt」，
  而 agent 需要的恰恰是「一次调用、立刻返回状态」。
- **继续做 dashscope 视频。** 用户已决定不投入：它要按模型分派请求体（三代词汇），
  而它的两代新形状（wan2.7/3.0）与 ark/minimax 的 `content[]` 结构不同，
  收益不抵维护成本。
- **把 MiniMax 塞进 `ark` 方言或用一个通用 `video` 方言。** 两者的端点、轮询前缀、
  错误体、必填字段、分辨率取值都不同；「方言名对应一个 code path」这条规则里，
  塞进去就等于在适配器内部再造分支。
- **本期一并加 `poll_path` 配置键。** 两个方言的轮询路径都由适配器给（是常量），
  `path` 覆盖时拼 `{path}/{id}` 就够；需要独立前缀的只有「改写前缀的代理」，本期没有。
- **统一 per-model 能力表。** 用户已定不统一取值域：服务端强校验会在建任务时报错、不计费；
  本地建表要随每次上新模型维护。
- **流式下载到临时文件再改名。** 更省内存，但要么接受失败时留下 `.part` 文件，
  要么多一套清理逻辑；两家的单文件上限在内存里完全可行。
- **把 `video` 做成 `image` 的 `--video` flag。** 异步语义、输出信封、退出码、flag 集
  全都不同，塞进一个命令会让 image 的 help 与校验分支失控。

## 留给实现者

- `--duration -1`（ark 的智能时长）与 `--seed -1`：commander 会把负数当成选项。
  本期维持现状（不接受负数）。
- `video status --wait`：引擎已经支持，加它只是多一个 flag + 一条测试。
- 独立的 `poll_path` 配置键（形如 `/api/v1/tasks/{id}`）——只有当某个「改写轮询前缀的
  代理」出现时才需要。
- MiniMax 的中国站点域名（`api.minimaxi.com` 一类）：本期只加已核实的 `api.minimax.io`，
  确认后往 `isVendorHost()` 加一行。
- MiniMax 是否接受 `watermark`（§4.7 说明）：核一次，然后决定它在 `exclusiveFields` 里
  还是在 `buildRequest` 里。
- 流式下载 + `.part` 临时文件。
- `video list` / 取消任务 / `callback_url` 回环。
- 首尾帧与参考素材：`--last-frame` 与 `--reference` 在两家都只是再塞一个
  `{type, url, role}` 进 `content[]`，`VideoRequest.media` 改成数组即可，接口不用动。
- dashscope 视频若日后复活，它需要的是「按模型分派请求体」的能力层，而不是本接口的改动。

## 修订记录

### 第一轮（builder check，2026-10-28）

写完初稿后让一个独立评审者（无对话上下文，只读文档与源码）提了一轮问题，下面是吸收的八条。
它们都是「不回答就得猜、猜错会重新设计」的点，结论已写进对应的小节。

1. **task id 不等结局就要落到终端**（§4.3）。初稿只规定了成功与 `--no-wait` 两种输出，
   恰好漏掉「默认阻塞中进程被杀」——而它正是本文开篇要防的漏洞。
2. **失败信封必须带机器可读的 `task_id` 与稳定 code**（§4.9）。初稿说 `renderError` 不变，
   但目标里写着「agent 不必解析 stderr」——两者矛盾。
3. **轮询可重试，建任务不可**（§4.3）。初稿字面上是「一次非 2xx 就终止」，那一次网络抖动
   就会把一个已付费、服务端正常跑着的任务变成 CLI 的失败。
4. **`AsyncTaskResult` 原来没定义**（§4.1），且它与 `SavedFile.meta` 不是同一个东西
   （协议层产物 vs 磁盘产物），因此后者放宽为 `SavedMedia`（§4.8）。
5. **`path` 与 `pollPath` 的优先级自相矛盾**（§4.4）。定为 `path` 同时覆盖建任务与轮询。
6. **`timeout_ms` 原来同时当三个超时**（§4.4）。拆成三个常量：单次请求 60s、
   轮询总预算 `timeout_ms`、下载 600s（不计入预算）。
7. **`ok` 的语义**（§4.9）。视频的 `ok` 恒等于 exit code 是否为 0
   （「建了任务、还在跑」是 `ok: true, files: []`）。这是与图像信封的**刻意差异**。
8. **`video status` 的文件名会写错 model**（§4.9）。改为优先用服务端回显的 `model`。

另有两处内部不一致当轮改掉：`getAdapter` 需要第三个「传变量」的重载（§4.1）；`buildHeaders?()` 从接口里拿掉（没有方言实现它，就是死代码）；
「现有测试零改动」是过强的说法，已逐条列出必须反转的断言与种子改名会打到的字面量。

### 第二轮（范围变更，2026-10-28）

- **`minimax` 从「下一轮」提到本期**：新增 §4.7 的 minimax 契约、`Dialect` 的第四个值、
  种子的 `[providers.minimax]`、以及全部相关测试与文案。
- **dashscope 视频从「下一轮」改为「不做」**：非目标里写明，并把「还没有适配器（yet）」
  这套「将来会有」的措辞从 `getAdapter()`、`config show` 与 README 里去掉。
- **校验从两层变三层**（§4.6）：加 `minimax` 之后 `--resolution` 的取值域按方言分叉
  （ark 没有 `768p`/`2k`，minimax 没有 `720p`/`1080p`/`4k`），所以本地校验要能回答
  「这个**方言**有没有这一档」，而「这个**模型**有没有」仍交服务端。
  这正是不统一取值域的直接后果。
