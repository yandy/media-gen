# media-cli 设计文档

日期：2026-10-24
状态：待审批

## 意图与背景

给 AI agent（如 pi、Claude Code 等）增加多媒体生成/编辑能力。现有官方 CLI（火山方舟 ark-cli、阿里百炼 bailian-cli）功能过重——包含 plan 管理、SSO、精调部署等大量无关功能，且不支持第三方代理商的自定义 base URL。我们需要一个**小而专注**的 CLI：

- 调用 qwen（阿里百炼）与 doubao（火山方舟）两家模型做图片生成与编辑（本期只做图片，为视频预留命令结构）
- 只支持最新模型（qwen-image-3.0 系列、seedream-5.0 pro/flash）
- 配置文件支持 base URL / model 等，第三方代理商可完全自定义
- `login` 命令把 API key 落盘到 auth 文件；API key 同时支持环境变量

**为什么**：媒体生成只是 agent 工具箱里的一块拼图，工具必须小、可预测、help 自解释，agent 才能可靠地使用它。

## 目标 / 非目标 / 反目标

**目标**
1. `media image generate`（文生图 + 图生图）与 `media image edit`（图生图语法糖）覆盖两家最新图片模型
2. 零配置可用内置 provider（qwen/ark），登录即可用；自定义 provider（代理商）通过配置文件接入
3. 生成结果默认自动下载落盘（API 返回的 URL 仅 24h 有效）
4. 丰富 help（示例、模型表、尺寸规格）+ 薄 skill（唤起入口，指路 help）
5. `--json` 结构化输出，便于 agent 消费

**非目标（本期不做）**
- 视频生成/编辑（命令结构预留 `media video ...`）
- 旧模型（qwen-image-2.x、seedream-4.x 等）
- 异步任务轮询（两家图片接口均可同步调用）、流式输出
- MCP server、plan/用量/账单管理、SSO 登录
- 组图（sequential_image_generation，seedream 5.0 pro/flash 不支持）、联网搜索

**反目标**
- 像官方 CLI 那样膨胀成平台工具箱
- 隐藏式智能猜测（自动按模型名推断 provider 等"魔法"，显式优先）
- 自动重试付费请求（可能造成重复计费）

## 约束

- 两家 API 均 OpenAI 兼容 `POST .../images/generations`，T2I/I2I 共用端点（传不传 `image` 字段之别），差异在路径前缀、扩展参数与响应细节
- 模型快照 ID 会滚动更新（如 `doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-flash-260915`），代理商模型名可能不同 → 模型名必须完全可配置，内置值只是默认
- 图片 URL 24 小时过期 → 默认立即下载
- 生成耗时 10–120s → 客户端超时 300s；seedream 5.0 pro/flash 每请求只出 1 张图

## 已定方案（对话中决策）

| 决策点 | 选择 | 备选（被否） |
|---|---|---|
| 实现语言/形态 | **Node/TypeScript npm 包**，bin 名 `media` | Python+uv、Go 单二进制 |
| 命令结构 | **方案 A：动词优先**（`media image generate/edit`），`--provider` 显式选择 | 单命令 `media gen`；provider 子命令树 |
| agent 指导 | **丰富 help + 薄 skill**（一个 SKILL.md 做唤起入口） | 只 help；多文件 skill 树 |

## 技术栈（我的决定）

- Node >= 18（内置 fetch），TypeScript，ESM
- 运行时依赖仅 2 个：`commander`（CLI 框架）、`smol-toml`（配置解析）
- **不做 HTTP 代理支持**（用户确认运行环境直连境内 API；需要时代理用户可设 `NODE_USE_ENV_PROXY=1`（Node ≥ 24），README 注明）
- 构建：`tsup`；测试：`vitest`（均为 devDependencies）
- 发布前 npm 包名待定（`media-cli` 若被占用则改名；bin 名 `media` 不变）

## 命令规格

```
media login [--provider <p>] [--api-key <key>] [--base-url <url>]
media logout [--provider <p>]
media auth status                      # 各 provider 凭证来源与状态（脱敏）
media config show                      # 解析后的生效配置（含来源标注，key 脱敏）
media config path                      # 配置/auth 文件路径
media image generate "<prompt>" [flags]   # T2I；传 --image 即 I2I
media image edit "<prompt>" --image ...   # generate 的语法糖：强制要求 --image
```

`generate` / `edit` 共享全部 flag：

| Flag | 说明 | 默认 |
|---|---|---|
| `--provider <p>` | provider 名（内置 `qwen`/`ark` 或配置文件自定义） | config `default_provider` |
| `--model <m>` | 模型 ID | config 中 provider 的 `model`，见默认表 |
| `--image <path-or-url>...` | 参考图，可重复；本地文件自动转 base64 data URL | 无（T2I） |
| `--size <s>` | `1K`/`1.5K`/`2K`/`3K`/`4K` 档位或 `1024x1024` 像素值（两家均可）；qwen 另支持 `auto`。透传 + 轻量格式校验（非白名单，保留 ark 任意尺寸/比例能力） | 不传（两家均可省略：qwen 按提示词自动推荐分辨率，ark 默认 2K） |
| `--n <count>` | 出图数。qwen 原生支持 1-6；ark 5.0 每请求 1 张，n>1 时并发发 n 个请求，子请求种子用 `seed, seed+1, ...`（基准种子，help 与 --json 中明确标注） | 1 |
| `--seed <n>` | 随机种子 | 无 |
| `--watermark <bool>` | 水印 | 不传（用服务端默认：qwen false / ark true） |
| `--negative-prompt <text>` | 反向提示词（qwen 专属） | 无 |
| `--prompt-extend <bool>` | 提示词改写（qwen 专属） | 不传（服务端默认 true） |
| `--prompt-extend-mode <direct\|agent>` | 改写方式（qwen 专属，agent 仅 T2I） | direct |
| `--enable-thinking <bool>` | 思考模式（qwen 专属） | 不传 |
| `--output-format <png\|jpeg>` | 输出格式（ark 专属） | 不传（服务端默认 jpeg） |
| `--optimize-prompt <standard\|fast>` | 提示词优化（ark 专属；flash 仅 standard） | 不传 |
| `--layer-decomposition <bool>` | 图层拆分（ark 专属，需 --image，产出多文件） | false |
| `--background <transparent\|opaque>` | 透明背景（ark 专属，需单张带透明通道的图） | 不传 |
| `--out-dir <dir>` | 输出目录 | config `output_dir`，默认当前目录 |
| `--json` | 结构化输出（文件路径、模型、usage、request id） | 人类可读输出 |
| `--api-key <key>` / `--base-url <url>` | 一次性覆盖，便于临时测试代理商 | 无 |

错误约定：人读模式错误输出到 stderr、退出码非 0；`--json` 模式输出 `{"error": {...}}` 到 stdout、退出码非 0。付费请求失败**不自动重试**。

**部分成功契约**（ark 并发 n 请求 / 图层拆分 / 单图审核失败时）：≥1 张成功即退出码 0，失败项逐条列出（stderr 警告；`--json` 中 `partial: true` + per-item error），明确提示已落盘文件，避免 agent 惯例性整体重试付费请求；全部失败才非 0。

## 配置与认证

**配置文件** `~/.config/media-cli/config.toml`（XDG；`MEDIA_CLI_CONFIG_DIR` 环境变量可整体改路径，便于测试）：

```toml
default_provider = "qwen"
# output_dir = "./media-output"     # 可选

[providers.qwen]                    # 内置 provider 可零配置；出现则覆盖默认
# base_url = "https://dashscope.aliyuncs.com"
# model = "qwen-image-3.0"

[providers.ark]
# base_url = "https://ark.cn-beijing.volces.com"
# model = "doubao-seedream-5-0-flash-260915"

[providers.my-proxy]                # 第三方代理商：必填 base_url + api_type
base_url = "https://proxy.example.com"
api_type = "ark"                    # 方言：qwen | ark，决定参数集/路径/响应解析
model = "some-model-name"
api_key_env = "MY_PROXY_KEY"        # 可选：该 provider 专用的 env 变量名
# path = "/v3/images/generations"   # 可选：覆盖默认路径（适配前缀不同的代理）
```

**auth 文件** `~/.config/media-cli/auth.json`（权限 600）：

```json
{ "providers": { "qwen": { "api_key": "sk-..." }, "ark": { "api_key": "..." } } }
```

`media login`：TTY 且未给 flag 时交互式（选 provider → 隐藏输入 key → 确认写入）；给了 `--api-key` 则非交互。**login 只管 key**：provider 定义（base_url/api_type/model）只活在 config.toml；对配置中不存在的 provider 执行 login → 报错并指路 config.toml（与 PRD"配置文件管 baseurl、login 填 key"的划分一致）；`--base-url` 仅更新已存在 provider 的配置。

**API key 解析优先级**：`--api-key` flag > provider 的 `api_key_env` 指定的环境变量 > 内置约定（`qwen`→`DASHSCOPE_API_KEY`，`ark`→`ARK_API_KEY`）> auth 文件。均无则报错并提示 `media login`。

**内置 provider 默认表**：

| provider | api_type | base_url | 默认 model | 默认 path |
|---|---|---|---|---|
| qwen | qwen | `https://dashscope.aliyuncs.com` | `qwen-image-3.0` | `/compatible-mode/v1/images/generations` |
| ark | ark | `https://ark.cn-beijing.volces.com` | `doubao-seedream-5-0-flash-260915` | `/api/v3/images/generations` |

（内置模型 ID 只是默认值；快照滚动更新时改配置即可，无需升级 CLI。）

## API 方言适配

统一内部请求模型 `{model, prompt, images[], size, n, seed, watermark, ...ext}`，两个适配器负责编解码：

- **qwen**：POST `{base}{path}`，body 平铺：`model, prompt, image?(string\|array), n, size, negative_prompt, seed, prompt_extend, prompt_extend_mode, enable_thinking, watermark`。响应 `{created, data:[{url}], usage, error?}`；request id 取响应头 `x-request-id`
- **ark**：POST `{base}{path}`，body：`model, prompt, image?(string\|array), size, seed, watermark, output_format, optimize_prompt_options{mode}, layer_decomposition, background, response_format:"url"`。响应 `{model, created, data:[{url, size, output_format?, z_index?...}], usage, error?}`；逐项检查 `data[].error`（审核失败等单图失败），request id 取响应头 `x-request-id`

已验证的关键事实（builder check 补充）：
- qwen-image-3.0 系列**同一模型 ID** 同时支持 T2I 与 I2I/编辑（百炼官方文档明确），edit 语法糖成立；独立编辑模型是 2.x 时代旧物，已排除
- 两家 `image` 均接受公网 URL 与 `data:image/<格式>;base64,<数据>`（方舟文档明确支持 base64 data URL）
- 两家 `size` 均可省略（qwen 自动推荐分辨率 / ark 默认 2K）

方言不识别的 flag（如对 qwen 传 `--layer-decomposition`）→ 调用前报参数冲突错误，不打无效请求。

## 下载与输出

- 成功响应后立即下载所有图片到 `--out-dir`，文件名 `{provider}-{model缩写}-{yyyyMMdd-HHmmss}-{序号}.{ext}`
- ext 推断：qwen 恒为 png；ark 按 `output_format`（默认 jpeg）；URL 无扩展名时按 Content-Type 兜底
- ark `--layer-decomposition` 返回多文件（底图 + 图层）时全部下载，`--json` 输出 z_index/bounding_box 等元数据
- 进度信息（模型、耗时）输出到 stderr；文件路径输出到 stdout

## 薄 Skill

`skills/media-cli/SKILL.md`（约 60-80 行）：触发条件（用户要生成/编辑/修改图片）、最小示例（login → generate → edit）、模型选择速查、指向 `media image generate --help`。npm 包内附带，README 说明复制到各 harness 的 skills 目录即可。

## 测试

- vitest 单测：配置解析与合并、auth 优先级、两种方言的请求构造/响应解析/错误映射、文件名生成、参数冲突检测
- HTTP 层 mock fetch，不打真实付费接口（也不自动重试，见反目标）
- 手工冒烟（有 key 时）：`media login` → `generate` → `edit` → `--json` → 自定义 provider

## 仓库结构

```
media-cli/
  package.json  tsconfig.json
  src/
    cli.ts          # commander 装配 + 丰富 help 文案
    config.ts       # 加载/合并/校验配置
    auth.ts         # login/logout/status + key 解析优先级
    providers.ts    # 内置默认表 + 方言注册
    api/qwen.ts     # 百炼方言
    api/ark.ts      # 方舟方言
    generate.ts     # generate/edit 核心（解析→请求→下载）
    download.ts     # 下载 + 文件名
    util.ts
  skills/media-cli/SKILL.md
  docs/superpowers/specs/2026-10-24-media-cli-design.md
  README.md
  src/**/*.test.ts
```

## 留给实现者的细节

- help 文案的措辞与示例选取
- 具体错误信息文案（原则：告诉 agent 下一步该做什么，如"先运行 media login"）
- 交互式 login 的提示语
- 单测的具体断言粒度
