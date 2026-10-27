# provider 内部按任务分层：任务、模型与端点各归其位

日期：2026-10-28
状态：待评审

## 问题

现状把「协议」「端点」「模型」压进同一个扁平表 `[providers.<name>]`
（`src/config.ts:resolveProvider()` → `ProviderConfig` 只有一个 `model` 字段，
`src/types.ts:3-9`），端点路径又是方言常量（`src/api/ark.ts:171`、
`src/api/qwen.ts:114` 的 `path: "/images/generations"`），由
`src/http.ts:225` 拼成 `${provider.base_url}${dialect.path}`。

三件不同的事共用一层，产生三类症状：

1. **同一家供应商的第二个模型必须复制一个 provider。** 用户配的是 `provider`，
   实际填的却是「端点 + 模型」的绑定，于是 `doubao-seedream-5-0-flash` 和
   `-pro` 只能变成两个 `[providers.*]` 表，`auth.json` 也跟着要两份 key。
2. **同一家供应商换任务类型必须换 `api_type`。** 端点属于方言常量，视频端点
   与图片不同，就只能新增方言 `ark-video`；而方言名同时承担「协议」语义，
   于是协议相同、端点不同这件事被谎报成「两种协议」。
3. **`base_url` 被迫按任务拆。** PR #4 定的规则是「`base_url` 止于版本段」，
   于是 qwen 图片要 `.../compatible-mode/v1`、视频要 `.../api/v1`，同一个
   workspace 主机被拆成两条 `base_url` ——症状 1 的翻版。

## 已核实的事实

两家供应商都是「同一台主机，换任务只换路径」：

| 方言 | 主机 | 图片路径 | 视频路径 |
|---|---|---|---|
| `ark` | `ark.cn-beijing.volces.com` | `/api/v3/images/generations` | `/api/v3/contents/generations/tasks`（同步建任务，轮询 `/tasks/{id}`，成片在 `content.video_url`，24h 有效） |
| `qwen` | `{workspace-id}.cn-beijing.maas.aliyuncs.com` | `/compatible-mode/v1/images/generations` | `/api/v1/services/aigc/video-generation/video-synthesis`（`X-DashScope-Async: enable`，轮询 `/api/v1/tasks/{id}`） |

qwen 的图片与视频同在 workspace 主机上（百炼文档给的就是
`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`），
所以「按任务拆 `base_url`」从来不是必需品，只是「端点归方言」这条规则逼出来的。

## 目标

- `config.toml` 里 **provider 是账本**：协议、主机、凭据。
- **任务类型是能力层**：图片、视频各有自己的模型列表、默认模型与行为参数。
- **模型是任务下的一个 id**：同一 provider 下想加多少个就加多少个，不新增 provider。
- 视频落地时**配置不迁移**：加视频只需要在已有的 `[providers.x.video]` 里填模型，
  以及新增适配器。
- 所有与配置相关的错误都在第一个 `fetch` 之前暴露，且给出可直接照抄的修复片段。

## 非目标

- 本轮**不实现视频**：注册表留 `video` 槽位，`[providers.x.video]` 能解析、能校验，
  但使用时报「该方言尚无 video 适配器」。没有 `mediagen video` 命令。
- 不实现 qwen 视频（异步 + 另一套鉴权头）。
- 不做 `config set`、`config add-model`（见「留给实现者」）。
- 不做 per-model 参数（如「flash 只接受 `optimize_prompt=standard`」）。
- 不把适配器接口泛化成异步形态，见「为什么异步接口不在本轮」。
- 不写旧配置的自动迁移脚本，只给一条明确的报错。

## 决定的形状

三层：

```toml
default_provider = "volcengine"
output_dir       = "./media-output"

[providers.volcengine]
api_type    = "ark"
base_url    = "https://ark.cn-beijing.volces.com"   # 只到 origin，版本段归适配器
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]
default         = "doubao-seedream-5-0-flash-260915"
models          = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]
timeout_seconds = 300                                # 可选，默认 300

[providers.volcengine.video]                         # 本轮留空位
default = "doubao-seedance-1-0-pro"
models  = ["doubao-seedance-1-0-pro"]

[providers.dashscope]
api_type    = "qwen"
base_url    = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.dashscope.image]
default = "qwen-image-3.0"
models  = ["qwen-image-3.0"]
```

### 字段

`[providers.<name>]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `api_type` | 是 | `qwen` \| `ark`，只表示协议 |
| `base_url` | 是 | origin，可带网关前缀；禁止 query/fragment/凭据 |
| `api_key_env` | 否 | 该 provider 的 key 环境变量名 |
| `<task>` 子表 | 至少一个 | `image` \| `video` |

`[providers.<name>.<task>]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `default` | 是 | 该任务的默认模型 id，必须在 `models` 里 |
| `models` | 是 | 字符串数组，该 provider 在该任务下允许的模型 |
| `timeout_seconds` | 否 | 正整数，单次请求超时，默认 `300` |

**严格键校验。** provider 表与任务表里出现未列出的键一律 `ConfigError`，
并列出允许的键。理由：`model` 与 `models` 只差一个字母，现状下拼错会被当成
「缺字段」，而未来的 `timout_seconds` 会被静默忽略 —— 配置里一个静默无效的键
比一个报错更贵。

### base_url 与 path 的边界（本次最重要的决定）

- **`base_url` = origin + 可选网关前缀**，不含版本段、不含 API 前缀。
- **path 归 `(api_type × task)`**，从 origin 起算，包含版本段：
  - `ark/image` → `/api/v3/images/generations`
  - `ark/video` → `/api/v3/contents/generations/tasks`
  - `qwen/image` → `/compatible-mode/v1/images/generations`
  - `qwen/video` → `/api/v1/services/aigc/video-generation/video-synthesis`

这条规则反转了 PR #4 的「`base_url` 止于版本段」。反转的理由就是上表：
版本段按任务不同（`/api/v3` vs `/compatible-mode/v1` vs `/api/v1`），
把它留在 `base_url` 里，同一 provider 就无法容纳两个任务。

代价是第三方代理：镜像供应商路径的代理只需 `base_url = "https://proxy/my-gw"`；
改写版本段的代理（`/v2`）无法表达。这一代价被显式接受，因为本轮没有这类需求，
后补一个可选的 `path_override` 是纯增量。

**旧配置的兜底（不做静默裁剪）。** 当 `base_url` 的主机是供应商自有域名
（`ark.cn-beijing.volces.com`、`*.maas.aliyuncs.com`、`dashscope.aliyuncs.com`）
且路径以已知 API 前缀结尾（`/api/v3`、`/api/v1`、`/compatible-mode/v1`）时，
报错并直接给出应填入的 origin。只对自有域名生效，因此不会误伤合法代理路径。

### 选择与解析

命令自带任务类型：`image generate` / `image edit` → `image`。
（本轮没有 `video` 命令，`video` 只能通过 `config show` 看到。）

解析顺序（全部在第一个 `fetch` 之前）：

1. provider：`--provider` → 否则 `default_provider`；空则报原有的
   `noProviderSelectedMessage()`。
2. 任务：取自命令。
3. 模型：`--model` → 否则 `[providers.<p>.<task>].default`。
   `--model` 单独给出（无 `--provider`）时，在**该任务**的所有 provider 里反查：
   唯一命中就用它，零命中列出已知模型，多处命中列出 provider 名并要求 `--provider`。
4. 校验：provider 存在 → 有该任务表 → 模型在 `models` 里 → 与任务匹配 →
   `api_type` 有该任务适配器。全部发生在第一个 `fetch` 之前，因此不会花钱；
   错误类与退出码见下节。

`--base-url` 一次性覆盖保留，语义是「覆盖 origin」。它走与配置值同一套规范化与
检查（含「残留版本段」规则）。**文件里的 `base_url` 仍然先被校验**：给了一个非法值
时，`--base-url` 不会把它救回来 —— 这是现状行为（`resolveProvider()` 先于覆盖执行），
本轮不改，避免两条校验路径。

### 错误分类与校验时机

沿用仓库既有的契约（`src/output.ts:renderError()`）：`UsageError` → exit 2，其余 → exit 1。
新增的判定用一个简单规矩，与现状一致：

- **文件没有声明某件事 → `ConfigError`（exit 1）**：没这个 provider、没有该任务表、
  模型不在 `models` 里、模型属于别的任务、该 `api_type` 尚无该任务适配器。
  这与现状「未知 provider 抛 `ConfigError`」一致，且它们要修的都是 `config.toml`。
- **flag 的值本身畸形 → `UsageError`（exit 2）**：`--n`、`--size`、`--base-url` 语法。

**校验时机：结构在加载，值在被选中的那个（provider, 任务）上。**

- `loadConfig()` 只做**结构**校验，覆盖所有 provider：类型、未知键、旧形状、
  `models` 必须是字符串数组 —— 不校验具体的值。
- `resolveSelection()` 只校验**被选中的** provider 与该任务：占位符主机、残留版本段、
  `default` 是否在 `models` 里、`timeout_seconds` 是否为正整数。

理由是既有行为被测试固定：种子里 dashscope 的 `<workspace-id>` 占位符**不得**阻塞
`--provider volcengine`（`smoke.test.ts`、`generate.test.ts` 依赖这点），且 `config show`
必须能在一个写了一半的文件上工作。唯一跨 provider 的结构性新错误是旧形状，这是
刻意选择：旧配置不是「写了一半」，而是被取代了，所有命令报同一句话最省事。

### `--model` 反查只看结构，不做完整解析

`--model` 单独给出时，在**该任务**的所有 provider 里按「`models` 是否包含该 id」做
结构匹配，**不**逐个完整解析（否则种子里那个未替换的占位符会在反查途中抛错，
恰好在最需要反查的配置里失效）。命中唯一 → 只解析它；命中多个 → 列出 provider 名
并要求 `--provider`；零命中 → 列出该任务下已知的模型 id。

### login / logout / auth status 只要求结构完整

`login` 现在靠 `assertKnownProvider()` 调用 `resolveProvider()` 来判断「这个 provider 能不能用」。
新形状下一个 provider 是否可解析**取决于任务**，所以这条检查改成任务无关的结构检查
（新函数 `validateProviderShape()`）：provider 表存在、`api_type`/`base_url` 合法、
至少有一个任务表。

因此 `login --provider x` 在 x 只有 `[providers.x.video]` 时必须成功 —— 视频用户也得能
存 key，不能因为图片适配器没写就被拒。`auth status` 本来就逐表容错（直接读
`api_key_env`），保持现状不动。

### 为什么模型是白名单

未在 `models` 里声明的模型一律拒绝，报错里直接给出要加的那一行。
好处是让「所有检查先于第一个付费请求」这条既有不变量对**任务/模型错配**也成立：
`image generate --model doubao-seedance-1-0-pro` 在本地就被拦住，而不是拼错端点后
拿到一个 400。代价是临时试新模型要改一行配置 —— 接受，若实际用起来难受，
后补 `--allow-unknown-model` 是纯增量。

## 代码改动

`src/types.ts`

```ts
export type Task = "image" | "video";

export interface ProviderConfig {          // 账本，不再含 model
  name: string;
  api_type: Dialect;
  base_url: string;
  api_key_env?: string;
}

export interface TaskBinding {             // 一次调用所需的全部选择结果
  provider: ProviderConfig;
  task: Task;
  model: string;
  timeout_ms: number;
}

export interface TaskAdapter {             // 原 DialectAdapter，去掉 path→createPath
  createPath: string;
  buildRequest(req: ImageRequest): unknown;
  parseResponse(json: unknown, requestId?: string): ParsedResponse;
}

export type DialectAdapters = Partial<Record<Task, TaskAdapter>>;
```

`src/api/index.ts`：`DIALECTS` 从 `Record<Dialect, DialectAdapter>` 变为
`Record<Dialect, DialectAdapters>`，新增 `getAdapter(api_type, task)`；
任务无适配器时报「该方言尚无 `<task>` 适配器，现有：image」。
`dialectPath()` 改为 `adapterPath(api_type, task)`，它**只对已实现的任务有答案**；
刻意不建第二张 `PATHS` 表：路径的唯一真相是 `TaskAdapter.createPath`，否则视频落地时
文档里的四个路径与代码里的两份数据会各自漂移。没适配器的任务，`config show` 不打印 URL。
`src/api/ark.ts`、`src/api/qwen.ts` 的 `path` 改为含版本段的完整路径，
并挂到 `image` 槽位；`video` 槽位本轮为空。

`src/config.ts`

- `ProviderOverride` → `ProviderEntry { api_type?, base_url?, api_key_env?, tasks: Partial<Record<Task, TaskBlock>> }`，
  `TaskBlock { default?, models?, timeout_seconds? }`。
- `readProviderOverride()` 识别 `image`/`video` 子表；未知键报错；旧形状（provider 表里
  出现 `model`）报专门的迁移错误。
- `resolveProvider(name, config)` → `resolveSelection({ provider?, model?, task }, config): TaskBinding`。
- `resolveBaseUrl()` 的文案改为 origin 语义，加「残留版本段」检查（仅供应商自有域名）。

`src/http.ts`：`callImageApi` → `callApi({ binding, apiKey, request })`，
URL 为 `${binding.provider.base_url}${adapter.createPath}`，超时取
`binding.timeout_ms`（默认常量保留在 config 层）。`QWEN_WORKSPACE_BASE_URL`
改为 origin `https://<workspace-id>.cn-beijing.maas.aliyuncs.com`，404 文案同步。

`src/generate.ts`：`resolveProvider()` → `resolveSelection({ provider: opts.provider, model: opts.model, task: "image" }, config)`，
`model` 与超时改从 binding 取；其余流水线（校验顺序、fan-out、下载、部分成功）不动。

`src/cli.ts`

- `config add <name> --api-type --base-url --model [--task image|video] [--api-key-env]`：
  写 provider 表 + 一个任务表（`default` 与 `models = ["<model>"]`）。`--task` 默认 `image`。
  仍然拒绝已存在的 provider 名（保持现有契约）。
- `config show`：每个 provider 打印 `api_type`/`base_url`/`api_key_env`，
  然后每个任务表打印 `default`、`models`、`timeout_seconds`；有适配器的任务额外打印
  计算出的 create URL，没有适配器的（本轮即 `video`）只标注「(no adapter yet)」、
  不打印 URL。
- `IMAGE_OPTION_HELP.baseUrl` 文案改为「origin, e.g. https://ark.cn-beijing.volces.com」。

`src/providers.ts`：`SEED_CONFIG` 改为新形状，volcengine 带两个图片模型作为「同
provider 多模型」的样例；dashscope 保留 `<workspace-id>` 占位。

文档：`README.md`、`README.zh-CN.md` 的 Configuration 一节与模型表；
`skills/mediagen/SKILL.md` 里若出现「一个 provider 一个模型」的说法一并修正。

## 旧配置怎么办

不做自动迁移。旧形状命中时给出唯一一条可执行的报错，例如：

```
config.toml still uses the pre-task shape: [providers.volcengine] sets "model",
which now belongs under a task table. Rewrite it as:

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"   # was "…/api/v3"
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]
default = "doubao-seedream-5-0-flash-260915"
models  = ["doubao-seedream-5-0-flash-260915"]
```

包尚未发布到 npm（registry 404），所以没有兼容包袱；但本机已存在的
`~/.config/mediagen-cli/config.toml` 会命中这条错误，报错必须能照抄。

## 测试

- `src/config.test.ts`：三层解析；未知键；旧形状错误文案；provider 无任务表；
  **加载时**（所有 provider）只查结构：类型、未知键、`models` 非字符串数组、旧形状；
  **解析时**（仅选中的）才查值：`default` 不在 `models` 里、`models` 为空数组、
  `timeout_seconds` 非正整数、`base_url` 残留版本段（自有域名报错、自定义域名放行）。
  另加一条：种子里未替换的 dashscope 占位符不阻塞 `resolveSelection({provider:"volcengine",…})`。
- `src/api/index.test.ts`：`getAdapter("ark","image")`、`getAdapter("qwen","image")`、
  `getAdapter(*,"video")` 的报错文案；两个图片适配器的 `createPath` 含版本段。
- `src/http.test.ts`：URL 为 `${origin}${createPath}`（不再有版本段重复）；
  超时来自 `timeout_ms`。
- `src/generate.test.ts`：`--model` 未声明 → 未 `fetch`（`ConfigError`，exit 1）；
  任务错配（video 模型走 `image`）→ 未 `fetch`；`--model` 反查在「另一个 provider 的
  base_url 是未替换占位符」时仍能成功；`default` 生效；`--base-url` 覆盖合法值、
  但救不回来文件里的非法 `base_url`。
- `src/cli.test.ts`：`config add` 写出的 TOML 能被 `loadConfig()` 读回；
  `config show` 输出任务分组与 `video` 的「(no adapter yet)」标注（不打印 URL）；
  旧配置下所有命令的报错一致；`login` 对只有 `[providers.x.video]` 的 provider 成功。
- `src/smoke.test.ts`：端到端仍走通（stub fetch），文件名仍是
  `<provider>-<model>-…`。

## 留给实现者的

- `config add-model <provider> <task> <model>`（往数组里追加一行）要不要做、怎么做
  （多行数组的文本改写 + `assertFaithfulRewrite` 校验）。本轮不做，手改一行即可。
- 未声明模型的逃生阀 `--allow-unknown-model` 是否需要。本轮不做。
- 可选的 `path_override`（改写版本段的代理）。本轮不做。
- 错误文案的具体措辞（本文件给的是要点，不是逐字稿）。

## 为什么异步接口不在本轮

视频意味着「提交 → 轮询 → 下载」，与图片的「一次 fetch 出一个结果」不同，
`TaskAdapter.buildRequest/parseResponse` 的同步形态届时必然要扩展（`submit`/`poll`、
轮询预算、任务 id 的 JSON 输出）。本轮只把**配置与注册表的形状**定死，
让视频落地时不必动配置；接口泛化留到视频自己的设计文档里做。

这是刻意的不对称：配置是用户资产，改它要付迁移成本；代码接口是内部实现，
改它只付一次实现的成本。

## 备选方案与否决理由

**A′：模型直接挂在 provider 下，每个模型声明 `task`。**

```toml
[providers.volcengine.models.doubao-seedance-1-0-pro]
task = "video"
```

少一层，且同样满足「换任务只换 path」。否决理由：超时必须按任务分（图片 300s、
视频 1800s 起），A′ 里这参数只能挂 provider 级（两个任务冲突）或每个模型上
（重复写）。任务层就是这些「按任务」参数的归宿。

**C′（原始现状）：provider = 端点 + 一个模型，模型靠 `--model` 自由传。**

改动最小，但配置不知道哪个模型属于哪个任务，`image generate --model <视频模型>`
无法在付费前拦住，违背仓库「所有检查先于第一个 fetch」的不变量；且 qwen 的
host/prefix 差异无处安放。

**把任务类型放进 `api_type`（`ark-video`）。**

把「端点不同」谎报成「协议不同」，方言名会随任务数增长，且同一台主机、同一把
key 被拆成多个 provider ——正是本次要消灭的症状。

## 执行与评审后的修订（2026-10-28）

本文件上面的部分是设计当时的内容，保留作为决策记录。实际落地时改了四处，都在评审或与用户确认后决定：

1. **`path_override` 已实现，不再延后。** 用户本机有一份真实配置使用
   `base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"`（厂商域名下的非标准前缀），
   而新形状里 `base_url` 只能是 origin。为了让这种主机继续可用，任务表新增可选 `path`
   （`[providers.x.image] path = "/images/generations"`），优先级高于适配器的 `createPath`。
   这不是第二份真相：默认值仍只由适配器提供，`path` 只是显式覆盖。
2. **「残留版本段」检查推广为「厂商自有域名下不得有子路径」。** 原来只拦截
   `/api/v3`、`/api/v1`、`/compatible-mode/v1` 三个已知前缀，于是
   `/api/plan/v3` 这类未知子路径会通过校验后被拼成双前缀、拿到空 body 的 404。
   现在规则是：厂商域名（`ark.cn-beijing.volces.com`、`*.maas.aliyuncs.com`、
   `dashscope.aliyuncs.com`）下任何子路径，若无 `path` 覆盖就报错，并在错误里同时给出
   origin 与应填的 `path`。自定义域名（代理）不受影响。
3. **`auth.json` 迁出 `~/.config`，改放 XDG state 目录。** `config.toml` 留在
   `~/.config/mediagen-cli`（会被编辑、同步、分享），密钥放
   `~/.local/state/mediagen-cli`（机器本地、不该同步）。新增 `MEDIAGEN_CLI_STATE_DIR`，
   顺序为 `MEDIAGEN_CLI_STATE_DIR` → `$XDG_STATE_HOME/mediagen-cli` →
   `~/.local/state/mediagen-cli`。**未发布项目，不做任何旧位置兼容。**
4. **删除旧形状的专门报错。** 曾为 `[providers.x] model =` 写过一段「可照抄的新形状」提示；
   未发布项目里该形状只存在于开发分支，因此删掉，让 `model` 走通用的 unknown-key 报错。

另外，测试改为全局沙箱：`vitest.sandbox.ts` 在每个测试文件前把
`HOME`、`XDG_CONFIG_HOME`、`XDG_STATE_HOME`、`MEDIAGEN_CLI_CONFIG_DIR`、
`MEDIAGEN_CLI_STATE_DIR` 指向临时目录，并在 `afterAll` 里让「往仓库根丢文件」的运行失败。
测试曾把生成的 PNG 写进仓库根、也读过开发者真实的 `~/.config`；这两类事故现在由机制拦截。
