# 协议跟着任务走：`api_type` 下沉到任务表，并新增 DashScope 原生图像方言

日期：2026-10-28
状态：已实现（2026-10-28）
取代/修订：`2026-10-28-provider-tasks-design.md` §「provider 是账本：协议、主机、凭据」中的「协议」

## 问题

### 直接触发：megcoreai 的图像生成每次都失败

```
qwen API response is missing the data array
```

实测 `POST https://megcoreai.com/v1/images/generations`（body 是我们按 `qwen` 方言发出的
扁平形态 `{model, prompt, n}`），返回 200：

```json
{"output":{"choices":[{"finish_reason":"stop",
  "message":{"content":[{"image":"https://.../x.png","type":"image"}],"role":"assistant"}}],
  "rewrite_status":"success"},
 "request_id":"7af801a7-...","usage":{"output_image_count":1,"output_width":2528,...},
 "megcore_meta":{"image_input_shape":"messages","shape_attempts":1}}
```

这是 **DashScope 原生**响应。入参之所以没被拒，是网关自己"猜形状"救了回来
（`shape_attempts: 1`）——但出参永远按原生形态给，永不带 `data[]`，所以**换任何参数
都救不回来**。`src/api/qwen.ts` 的 `parseQwenResponse` 严格按 OpenAI 兼容规范实现，
没有 bug：缺的是「原生协议」这种方言。

### 根本问题：`api_type` 挂错了层

现在 `api_type` 长在 `[providers.<name>]` 上（`src/config.ts`、`src/types.ts:3`），
含义是「这个账号的全部任务都用同一种协议」。而协议的三样东西——端点、请求体、
响应信封——都**随任务变**：

| 协议 | 图像 | 视频 |
|---|---|---|
| `dashscope` | `POST /api/v1/services/aigc/multimodal-generation/generation`（同步，`output.choices[].message.content[].image`） | `POST /api/v1/services/aigc/video-generation/video-synthesis`（`X-DashScope-Async: enable` → 轮询 `/api/v1/tasks/{id}`） |
| `ark` | `POST /api/v3/images/generations`（同步） | `POST /api/v3/contents/generations/tasks`（建任务 → 轮询 `/tasks/{id}` → `content.video_url`） |
| `openai` | `POST /compatible-mode/v1/images/generations`（同步，`data[].url`） | （本轮不涉及） |

于是一个账号（例如 megcoreai，或任何同时代理原生图像与 ark 式视频的网关）若要两个任务，
只能拆成两个 provider，把同一把 key 在 `auth.json` 里存两份 —— 这正是
`2026-10-28-provider-tasks-design.md` 当年要消灭的症状之一，只是这次换个方向复发。

## 已核实的事实

### 百炼（阿里云）侧：图像生成本身只有原生协议

- 帮助中心「图像生成」目录（`/zh/model-studio/image-generation/`）只有六篇：千问、万相、
  Z-Image、可灵、Vidu、创意工具。**没有「OpenAI 兼容」这一篇。**
- 千问那篇（`/zh/model-studio/qwen-image-api`）原文：千问-文生图等图像生成模型
  "通过 DashScope 原生接口调用，**不支持 OpenAI 兼容（compatible-mode）模式**"。
- 原生请求体（本文实现的形态），文档约束：`messages` **有且只有一条** `role: "user"`；
  `size` 用 `宽*高`（`*` 分隔，兼容模式才是 `x`）；图生图时 `image` 与 `text` 同在该
  `content` 数组内，**图在前、文本在后**：

  ```json
  {"model":"qwen-image-2.0-pro",
   "input":{"messages":[{"role":"user",
     "content":[{"image":"https://.../in.png"},{"text":"编辑指令"}]}]},
   "parameters":{"size":"2048*2048","n":1,"watermark":false,
                 "negative_prompt":"...","prompt_extend":true,"seed":42}}
  ```

- `content[].image` 支持三种输入：公网 URL（http/https）、`oss://` 临时 URL、
  `data:{mime};base64,{data}`。**本地文件转出的 data URL 可直接透传。**
- `size` 接受任意 `宽*高`，只约束总像素 `512*512`–`2048*2048`（服务端对齐到 16 的倍数）。
- `n` 对 qwen-image 系列为 1–6。
- 该端点**是同步的**（文档明示"支持同步接口，一次请求即可获得结果"，SDK 章节标注
  "不支持异步接口"）；请求头只有 `Content-Type` 与 `Authorization`。
- 原生错误体是顶层 `{request_id, code, message}`，**没有** `error` 对象：

  ```json
  {"request_id":"31f808fd-...","code":"InvalidApiKey","message":"Invalid API-key provided."}
  ```

### megcoreai 侧

用户确认：`POST https://megcoreai.com/v1/images/generations`，body 就是上面那份原生形态；
编辑类在同一 `content` 内先 `{"image":...}` 再 `{"text":...}`。即**同协议、不同端点**。

## 目标

- **协议（`api_type`）属于任务**：`[providers.x.image].api_type`、
  `[providers.x.video].api_type`。provider 退回它的本职：一个账号 = 主机 + 凭据。
- **协议名用协议本身**：`openai`（OpenAI 兼容）、`dashscope`（DashScope 原生）、
  `ark`（Volcengine Ark）。旧名 `qwen` 作为 `openai` 的别名继续可用，**零配置迁移**。
- **每个任务有自己的协议白名单**：`image` → `openai | dashscope | ark`；
  `video` → `dashscope | ark`。白名单由 (协议 × 任务) 注册表表达，不另立规则。
- 新增 `dashscope` 的图像适配器，让 megcore 这类网关**只改配置就能跑通**。
- 所有协议相关错误在第一个 `fetch` 之前暴露。
- 视频**本轮不实现**，但形状、扩展点、协议白名单在本轮定死，下一轮只填适配器。

## 非目标

- 不实现视频适配器（两个都是异步任务，需要 `TaskAdapter` 的三段扩展，见 §4.7）。
- 不改 `openai`（原 `qwen`）方言的线上行为：它对应的协议在第三方网关与镜像站上客观存在。
- 不给 `openai` 方言加"容忍解析"（理由见「否决的方案 A」）。
- 不做 `2K` → 像素的档位映射（用户选定严格路线，§4.5）。
- 不把 provider 级的 `api_type` 删掉（它是旧配置的唯一升级路径，§4.2）。

## 决定的形状

### 4.1 三个协议名，一个旧名别名

```ts
export type Dialect = "openai" | "dashscope" | "ark";
```

- `qwen` 在 `config.ts` 解析时归一化为 `openai`；`config show` 里标注
  `api_type = qwen (deprecated alias of openai)`，让旧名可见地过期，而不是悄悄永久化。
- 常量与错误文案全部改用新名；`src/api/qwen.ts` 的文件名本轮不必改（纯内部命名）。

### 4.2 `api_type` 下沉到任务表，provider 级保留为默认

```toml
[providers.megcoreai]
base_url    = "https://megcoreai.com"
api_key_env = "MEGCOREAI_API_KEY"
# api_type 可留在这里，作为所有任务的默认协议

[providers.megcoreai.image]
api_type = "dashscope"
path     = "/v1/images/generations"
default  = "qwen/qwen-image-3.0"
models   = ["qwen/qwen-image-3.0", "qwen/qwen-image-3.0-pro"]

# 未来的视频（本轮只解析、不实现）：
# [providers.megcoreai.video]
# api_type = "ark"
```

解析顺序：`task.api_type ?? provider.api_type`。两者都没有 → 现有的
「缺少 api_type」类错误，文案改为点名**该任务**缺协议。

**旧配置零迁移**：`[providers.x] api_type = "qwen"` 照旧有效，并把 `qwen`
归一化为 `openai`。这条兼容不需要"迁移脚本"，只多一个 `??` 和一个别名映射。

### 4.3 每个任务的协议白名单＝注册表本身

`src/api/index.ts` 的 `DIALECTS`（`api_type` × `task`）既是白名单也是报错来源：

|  | image | video |
|---|---|---|
| `openai` | ✅（OpenAI Images 形状 + 兼容模式参数集） | — |
| `dashscope` | ✅（本轮新增，原生多模态同步） | ⬜ 下轮（异步任务） |
| `ark` | ✅（OpenAI 形状 + Ark 专属参数与逐条 error 语义） | ⬜ 下轮（异步任务） |

缺格子的报错沿用现有文案（"the "${apiType}" dialect has no "${task}" adapter yet"）。
`adapterPath()` 保持不抛异常的语义，供 `config show` 使用。

### 4.4 `dashscope` 图像适配器的契约

`createPath = "/api/v1/services/aigc/multimodal-generation/generation"`
（`base_url` 仍是 origin；网关用 task `path` 覆盖，例如 megcore 的 `/v1/images/generations`）。

**buildRequest**

```ts
{ model, input: { messages: [ { role: "user", content: [ ...图, { text } ] } ] }, parameters }
```

- `content` 里图在前、文本在后，多图保序；无输入图时只有 `{ text }`。
- `image` 值原样透传（公网 URL / `data:` base64 / `oss://` 都是合法形式）。
- `parameters` 只含文档列出的原生字段，且仅在调用方给了值时才出现：
  `size`、`n`、`negative_prompt`、`prompt_extend`、`watermark`、`seed`。
- `size` 由 CLI 的 `WxH`（小写 `x`）翻译成线上 `宽*高`；CLI 契约不变。
- `n` 恒在 `parameters` 内（不像 ark 那样 fan-out 成多次请求）。

**parseResponse**

- 取 `output.choices[].message.content[]` 中所有带非空 `image` 的项，按序成
  `ImageResult[]`；`text` 项（图文交织）忽略。
- `output` 缺失 / `choices` 非数组或空 / 一个 `image` 都没有 → `ApiError`，文案点名
  原生形态（`output.choices[].message.content[].image`）；`content: []` 的情况要说明是
  「上游未产出图像」，不是「格式错误」。
- `usage` 原样透传；body 顶层 `request_id` 进 `requestId`（HTTP 头 `x-request-id` 仍兜底）。
- 顶层 `code` + `message`（即便意外出现在 2xx）→ `ApiError(message, code)`。

**错误体**：`TaskAdapter` 增可选 `parseErrorBody?(json) => {code?, message} | undefined`，
`http.ts:errorForStatus` 优先用它，未实现则回落现有 `vendorError()`。只给 `dashscope`
实现（`ark` 的 `{error:{...}}` 走回落），让"方言拥有自己的线上格式"不外溢进 `http.ts`。

### 4.5 `--size`：严格路线（方案 b，用户已定）

| 协议 | 接受 | 拒绝 |
|---|---|---|
| `ark` | 档位、`WxH` | `auto` |
| `openai`（原 qwen） | 档位、`WxH`、`auto` | — |
| `dashscope` | 仅 `WxH` | 档位、`auto` |

拒绝文案点名「原生协议只接受 `宽*高`，例如 `--size 2048x2048`」。像素值区间不在本地
校验（由厂商 `InvalidParameter` 带回），与现有「只做格式检查」哲学一致。

### 4.6 兼容模式专属字段：拒绝而不是丢弃

`prompt_extend_mode`、`enable_thinking` 在 `dashscope` 下报 `UsageError`，文案点名它们
是兼容模式能力，并给出"删掉或改用 `api_type = "openai"`"的出路。与现有
`ARK_ONLY_FIELDS` / `QWEN_ONLY_FIELDS` 的"宁可失败不静默丢弃"一致。

> 存疑点：若日后确认 3.0 系列原生端点也支持这两个字段，放开是一行改动 + 一条测试。
> 当前依据只有兼容模式文档，故按拒绝处理。

### 4.7 视频的扩展点（本轮只定形状，不实现）

两个视频协议都是异步任务，形状一致：**建任务 → 轮询 → 取结果**。因此 `TaskAdapter`
需要一个可选的异步三段，而不是把轮询硬塞进 `parseResponse`：

```ts
interface TaskAdapter {
  createPath: string;
  buildRequest(req: ImageRequest): unknown;
  parseResponse(json: unknown, requestId?: string): ParsedResponse;
  parseErrorBody?(json: unknown): { code?: string; message: string } | undefined;
  // 下轮：
  // asyncTask?: { buildHeaders(): Record<string,string>; taskIdFrom(json): string;
  //               pollPath(id: string): string; parseTaskResult(json): ParsedResponse };
}
```

本轮把它写成设计备注（上面这段注释落到 `types.ts` 的文档注释里即可），不新增方法。

## 代码改动

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `Dialect` = `openai | dashscope | ark`；`TaskAdapter` 加可选 `parseErrorBody`；注释写明异步任务扩展点 |
| `src/api/dashscope.ts` | 新增：`buildDashscopeRequest` / `parseDashscopeResponse` / `parseDashscopeError` / `DashscopeDialect` |
| `src/api/index.ts` | `DIALECTS` 键改名 `qwen → openai`，新增 `dashscope`；`adapterPath` 同步 |
| `src/api/qwen.ts` | 仅改名引用（`QwenDialect` 常量名可变可不变）；线上行为零改动 |
| `src/config.ts` | `api_type` 允许出现在任务表；解析 `task.api_type ?? provider.api_type`；`qwen → openai` 别名；`isDialect`；`resolveBaseUrl`/`pathAfterVendorRoot`/`vendorPathIssue` 改用**该任务的**协议；报错文案点名任务 |
| `src/generate.ts` | `validateSize` 三分支；`validateN` 去掉 ark 专属措辞；`resolveSelection` 产出 `binding.api_type` 供后续使用 |
| `src/http.ts` | `errorForStatus` 接受适配器钩子（`callApi` 已有 `adapter`） |
| `src/providers.ts` | 种子：provider `dashscope` → `aliyun`；新增一段原生协议网关的注释示例（`api_type = "dashscope"` + `path`）；文档注释里"协议在 provider 上"改为"协议在任务上" |
| `src/cli.ts` | `--api-type` 可选值改为三协议名并接受 `qwen` 别名；`config add` 写入任务表；`config show` 逐任务显示协议与端点；模型表与"qwen only"标注改为"openai / dashscope" |
| `README.md` / `README.zh-CN.md` | 方言表：`openai` / `dashscope` / `ark` 与任务矩阵；原生协议何时选；`qwen` 旧名说明 |
| `skills/**` | 若有 `api_type` / 方言名提及，同步 |

## 测试

- `src/api/dashscope.test.ts`（新）：`buildRequest` 的文生图 / 图生图（图在 text 前、
  多图保序、data URL 原样）/ `x`→`*` / 各参数落位 / 未给字段不出现 /
  拒绝 `prompt_extend_mode` 与 `enable_thinking`；`parseResponse` 的单图、多图、
  混 `text`、`usage`+`request_id` 透传、缺 `output`、`choices` 空、`image` 非字符串、
  2xx 带 `code`；`parseErrorBody`；`createPath`。
- `src/config.test.ts`：任务级 `api_type` 生效并覆盖 provider 级；只写 provider 级的旧
  配置仍可用；`qwen` 归一化为 `openai`；非法 `api_type` 的文案含三个协议名；
  两个任务各用不同协议可解析；`path` 与任务级协议的冲突检测。
- `src/generate.test.ts`：`validateSize` 三协议矩阵（`2K` / `1024x1024` / `auto`）；
  `--n` 的上限与文案。
- `src/http.test.ts`：非 2xx + 原生错误体 → 带 `InvalidApiKey` 这类 code；未实现钩子
  的方言行为不变；错误信息不含 key。
- `src/cli.test.ts`：`config add --api-type dashscope` 写入任务表；`--api-type qwen`
  仍被接受但提示旧名；`config show` 逐任务显示协议；模型表文案。
- `src/api/index.test.ts`：`openai`/`ark` 无 video 适配器；`dashscope` 有 image、无 video。

## 否决的方案

- **A. 让 `openai` 方言的解析器同时认原生形态。** 把网关的 bug 固化进协议语义，
  未来适配器无从判断契约；网关修好后留下删不掉的死分支。
- **B. 在 config 里加 `response_shape = "openai" | "dashscope-messages"`。** 把"协议"
  拆成两个正交开关，允许出现"扁平 body + 原生响应"这种不存在的组合。新增方言用
  一个注册项解决同一问题。
- **C. 只让 megcore 自己回译成 `data[]`。** 正确但不可交付；且原生协议本身是百炼
  文档里唯一的图像协议，`dashscope` 方言无论如何都要有。
- **D. 档位映射（`2K` → `2048*2048`）。** 用户已否决。
- **E. `api_type` 留在 provider 级，只把值改成协议名。** 看似更小，但"一个账号同时
  提供原生图像 + ark 式视频"就只能拆成两个 provider、同一把 key 存两份——spec #5
  明确要消灭的症状。视频一落地就会复发。这是本次选 4.2 的唯一原因。
- **F. `api_type` 下沉，且删除 provider 级 `api_type`。** 语义最干净，但所有现存
  `config.toml` 立刻失效。保留为默认值的代价是一个 `??`，没有理由不兼容。
- **G. 把 Ark 图像并入 `openai` 族（image 只留 `openai | dashscope`）。**
  形状确实同源（都是 `data[].url`），但参数集互为对方没有的东西：Ark 有
  `output_format` / `optimize_prompt_options` / `layer_decomposition` / `background`
  与**逐条 error 的部分成功语义**；`openai` 族（qwen 兼容模式）有 `n` /
  `negative_prompt` / `prompt_extend` / `prompt_extend_mode` / `enable_thinking`。
  合并的代价是二选一：要么把 Ark 专属字段提成 `openai` 可选字段，让“选错厂商的 flag”
  从本地 `UsageError` 退化成服务端 400（现有 `ARK_ONLY_FIELDS` / `QWEN_ONLY_FIELDS`
  守卫失效）；要么让 `openai` 解析器同时认两种 `data[]` 语义——即本文件否决的方案 A 再版。
  因此保留 `ark` 作为第三族：**协议名对应的是一个 code path，不是一个形状**。
  用户已于 2026-10-28 确认此路线。

## 分两阶段

- **阶段 A（本轮）**：§4.1 协议改名 + §4.2 下沉 + §4.4 `dashscope` 图像适配器 +
  文案/文档/种子与全部测试。交付标准：megcore 只改配置即可跑通图像生成。
- **阶段 B（下轮）**：`dashscope` 视频（异步任务）与 `ark` 视频，按 §4.7 的扩展点。

## 留给实现者的

- `ImageResult` 是否从原生响应补 `size`？原生只给整次请求的 `usage.width/height`，
  倾向不补。
- `output.rewrite_status`（`success` / `not_use`）暂不进内部模型：无消费方。
- `src/api/qwen.ts` 是否改名 `openai.ts`、`QwenDialect` 是否改名：纯内部命名，随实现者；
  若改，单独一个 commit，避免与行为改动混在一起。
- `isVendorHost()` 名单缺 `dashscope-intl.aliyuncs.com`（新加坡旧域名）。补它同时影响
  `openai` 与 `dashscope` 两个方言的"base_url 多带子路径"拦截，值得做，但可以独立成一个
  小 commit。
- 原生方言不需要 `missingQwenEndpointMessage` 那样的 404 补救文案：原生 404 通常意味着
  host 写错，且错误体会带 `code`/`message`。若实测是空 body，再补对称提示。
