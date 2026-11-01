# mediagen

[English](README.md) | 简体中文

通过阿里云百炼（**qwen**）和火山方舟（**doubao / seedream**）生成与编辑图片，
通过火山方舟（**doubao / seedance**）或 MiniMax（**H3**）生成视频。结果写到磁盘、
打印文件路径。参数全部显式、没有交互式提问、`--json` 供程序解析。

```bash
npm install -g @yandy0725/mediagen-cli

# 任何命令首次运行都会写出一份带注释的 config.toml；之后每次运行都会先校验它，
# config show 本身只读。直接编辑这个文件即可
mediagen config show

# 新增一条入口：一个账号（协议 + origin + key）带一张 image 任务表
mediagen config add my-proxy --api-type openai \
  --base-url https://abc123.cn-beijing.maas.aliyuncs.com \
  --model qwen-image-3.0 --api-key-env DASHSCOPE_API_KEY
# 视频表加 --task video；再加一个模型只需往 models 里多写一项

mediagen login --provider my-proxy --api-key sk-...

mediagen image generate "a red fox in fresh snow, soft morning light" --provider my-proxy --out-dir ./out
# /abs/path/out/my-proxy-qwen-image-3-0-20261025-020839-0.png
```

Node >= 18，两个运行时依赖，需要 DashScope 和/或方舟的 API key。

## 命令

| 命令 | 作用 |
|---|---|
| `mediagen image generate <prompt>` | 文生图；加 `--image` 即变为编辑 |
| `mediagen image edit <prompt>` | 同上，但 `--image` 必填 |
| `mediagen video generate <prompt>` | 文生视频，或用一张首帧；建任务即计费 |
| `mediagen video status <task-id>` | 查一次任务，成功则把视频取下来 |
| `mediagen login` / `logout` / `auth status` | 保存、删除、查看 API key |
| `mediagen config show` / `config path` | 解析后的配置，以及它存在哪里 |
| `mediagen config add <name>` | 在 config.toml 里新建一条 provider（其余修改手写文件） |

`mediagen image generate --help` 与 `mediagen video generate --help` 才是参考手册：
全部参数、模型表、尺寸表、示例。下面只是简化版。

## 模型与参数

| 模型 | provider | 什么时候选它 |
|---|---|---|
| `qwen-image-3.0` | `--provider aliyun` | 文字渲染（中日韩 + 拉丁）、图像编辑 |
| `doubao-seedream-5-0-flash-260915` | `--provider volcengine` | 速度：草稿、迭代 |
| `doubao-seedream-5-0-pro` | `--provider volcengine --model doubao-seedream-5-0-pro` | 最高质量 |

| 视频模型 | provider | 什么时候选它 |
|---|---|---|
| `doubao-seedance-1-0-pro-250528` | `--provider volcengine` | 文生视频，或让一张首帧动起来 |
| `MiniMax-H3` | `--provider minimax` | 同样的事，最高 2K，来自 MiniMax |

`aliyun` / `volcengine` / `minimax` 是首次运行写进 `config.toml` 的三个 provider 名，可以随意改。
一个模型只有被列在该 provider **对应任务**（`image` 或 `video`）表的 `models = [...]` 里才可用；同一家厂商的
第二个模型是往那张表里加一行 —— 不需要新增 provider。模型 id 是带日期的快照，随版本
滚动时改 `models`（以及 `default`）即可。

### 协议

每个任务的表自己声明 `api_type`，所以同一个账号可以让图片走一种协议、视频走另一种：

| `api_type` | 线上形态 | 什么时候选它 |
|---|---|---|
| `openai` | OpenAI Images 形态：扁平的 `{model, prompt, size, n}`，返回 `data[].url` | 百炼的 `compatible-mode`、多数第三方代理 |
| `dashscope` | 阿里原生态：`input.messages` + `parameters`，返回 `output.choices[].message.content[].image` | 百炼原生端点，或暴露该协议的网关（见下） |
| `ark` | 火山自有 API：图片形态接近 OpenAI，但参数与逐条错误语义自成一套 | 火山 Ark，图片与视频 |
| `minimax` | MiniMax 的视频 API：`content[]` 元素按 `text`/`image_url` 分类型，结果嵌在 `task` 里 | MiniMax H3，仅视频 |

`dashscope` 只做图片，没有视频任务。`video generate` 讲 `ark` 或 `minimax`，两者各自
声明分辨率档位（`ark`：480p/720p/1080p/4k；`minimax`：480p/768p/2k）——所选方言没有的档位
在本地就失败，而**某个模型**支持哪一档由厂商在建任务时校验，此时还没计费。

`qwen` 仍可用，是 `openai` 的弃用别名。所选协议不接受的参数会在发出任何付费请求之前失败
（`--output-format` 仅 ark，`--prompt-extend-mode` 仅 openai；视频上
`--seed`/`--generate-audio`/`--output-format`/`--watermark` 仅 ark）。`--size` 接受档位（`2K`）、
像素（`2048x2048`）或 `auto`（仅 openai）；`dashscope` 只收像素，因为它发送 `宽*高`，
没有档位与 `auto` 的概念。`--n` 接受 1-6 —— 在 ark 上每张图都是一个独立的付费请求。

## 输出

文件写到 `--out-dir`（否则 `output_dir`，否则当前目录），文件名
`<provider>-<model>-<yyyyMMdd-HHmmss>-<index>.<ext>`，永不覆盖。人类可读模式在
stdout 上每行打印一个绝对路径；`--json` 打印一个对象：

```json
{"ok":true,"partial":false,"files":[{"path":"/tmp/out/aliyun-qwen-image-3-0-20261025-020839-0.png","index":0,"url":"https://dashscope-result.oss-cn-beijing.aliyuncs.com/1.png"}],"errors":[],"usage":{"image_count":1},"request_id":"a1b2c3d4"}
```

`partial: true` 且退出码 `0` 表示部分图片成功、部分失败：磁盘上那些已经付过费了，
不要整条请求重跑。退出码：`0` 成功（含部分成功），`1` API / 配置 / 运行时失败，
`2` 用法错误 —— 总是在发请求之前抛出，所以不花钱。付费请求不会自动重试。

视频返回的是它创建的那个任务，因为**建任务那一刻就已经计费**：

```json
{"ok":true,"task_id":"cgt-20261028-abcd","status":"succeeded","files":[{"path":"/tmp/out/volcengine-doubao-seedance-1-0-pro-250528-20261028-101500-0.mp4","index":0,"url":"https://...","duration":5,"resolution":"720p"}],"errors":[],"usage":{"completion_tokens":108900}}
```

视频没有 `partial`：一次请求一个片子。**`ok` 表示命令本身成功，不表示有文件** ——
`--no-wait`、以及 `video status` 查到 `pending`/`running`，都是 `{"ok":true,...,"files":[]}`
且退出码 `0`。要看 `status` 与 `files`：写成 `ok: false` 会让调用方去重跑一个已经付过费的
任务。轮询预算耗尽时错误里带 `task_id` 与 `TaskNotFinished`，用 `video status <id>`
续查即可，不会再付一次。

## 配置

`config.toml` —— 你手动编辑的那个文件 —— 位于
`$MEDIAGEN_CLI_CONFIG_DIR`、`$XDG_CONFIG_HOME/mediagen`、
`~/.config/mediagen` 三者中第一个存在的。

`auth.json`（权限 `600`）属于**状态而非配置**，单独存放：取
`$MEDIAGEN_CLI_STATE_DIR`、`$XDG_STATE_HOME/mediagen`、
`~/.local/state/mediagen` 三者中第一个。`~/.config` 是人们会同步、分享、提交到
仓库的目录，把密钥放在那里，一次 `.gitignore` 疏忽就等于泄露。state 目录按定义是
「本机状态、不该被同步」，正合设备绑定的凭证。

从 0.1.1 及更早版本升级：两个目录都去掉了 `-cli` 后缀，程序不会替你迁移。手动挪一次，
然后随便跑一条命令即可：

```bash
mv ~/.config/mediagen-cli ~/.config/mediagen
mv ~/.local/state/mediagen-cli ~/.local/state/mediagen
```

（设置了 `XDG_CONFIG_HOME` 或 `XDG_STATE_HOME` 的，改挪那两个目录下面的 `mediagen-cli`。
用了 `MEDIAGEN_CLI_CONFIG_DIR` 或 `MEDIAGEN_CLI_STATE_DIR` 的，变量名没变，不需要动。）

```toml
default_provider = "volcengine"
# output_dir = "./media-output"

[providers.volcengine]              # 账号：主机 + key
base_url    = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]        # 能力：一个任务一张表
api_type = "ark"                    # 协议声明在任务上，不在账号上
default  = "doubao-seedream-5-0-flash-260915"
models   = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]

[providers.volcengine.video]
api_type = "ark"
default  = "doubao-seedance-1-0-pro"
models   = ["doubao-seedance-1-0-pro"]

[providers.aliyun]
base_url    = "https://dashscope.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.aliyun.image]
api_type = "openai"
default  = "qwen-image-3.0"
models   = ["qwen-image-3.0"]

[providers.minimax]                 # 只做视频的账号
base_url    = "https://api.minimax.io"
api_key_env = "MINIMAX_API_KEY"

[providers.minimax.video]
api_type = "minimax"
default  = "MiniMax-H3"
models   = ["MiniMax-H3", "MiniMax-H3-Max"]

[providers.my-gateway]              # 提供原生协议的网关
base_url    = "https://gateway.example.com"
api_key_env = "MY_GATEWAY_KEY"

[providers.my-gateway.image]
api_type = "dashscope"
path     = "/v1/images/generations" # 网关自己的路径，不是百炼的
default  = "qwen-image-2.0-pro"
models   = ["qwen-image-2.0-pro"]
```

一个 provider = **一个账号**：一台主机（`base_url`）+ 可选的 `api_key_env`。它能提供的
每个任务按名字挂在下面（`[providers.<name>.image]`、`[providers.<name>.video]`），
各自声明 `api_type`、允许使用的模型 id，以及 `--model` 缺省时用的 `default`。
`timeout_seconds` 按任务可选（图片 300、视频 1800）。同一家厂商的两个模型是同一个
`models` 列表里的两项，不是两个 provider；同一个账号的两种协议是两行 `api_type`，
也不是两个 provider。`api_type` 也可以写在账号表上，作为其下所有任务的默认值。

**`base_url` 就是 origin** —— 可以带网关前缀，但不带版本段。版本段属于端点，由方言按任务
自己拼接（`/api/v3/images/generations`、`/compatible-mode/v1/images/generations`、
`/api/v1/services/aigc/multimodal-generation/generation`），
所以换任务只换 path。若在厂商自有域名上仍以 `/api/v3`、`/api/v1` 或
`/compatible-mode/v1` 结尾，会在发请求前被拒绝，并给出应填的 origin。
文件是唯一真相：内置没有任何 provider，首次运行只是把上面这份内容写进 `config.toml`
供你修改。种子三条都能直接跑：`volcengine` 走 Ark，`aliyun` 走百炼原生协议（公网域名即可），`minimax` 走 MiniMax 的视频 API。
若要把 `aliyun` 换成 OpenAI 兼容协议，需改用业务空间专属域名
`https://{workspace-id}.cn-beijing.maas.aliyuncs.com` —— 那个端点不对外公开提供。

**如果某个主机的 API 不在厂商自己的路径下** —— 例如网关，或某个把 `/api/v3` 换成
`/api/plan/v3` 的套餐 —— 在任务表上用 `path` 声明这段前缀，适配器就不再追加：

```toml
[providers.volcengine]
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"

[providers.volcengine.image]
path = "/images/generations"        # 请求打到 .../api/plan/v3/images/generations
```

不写 `path` 时，厂商自有域名下的子路径会在发请求前被拒绝（否则会被拼重复），并给出
可用的 origin 或 `path` 值。`path` 只用于「不镜像厂商路径」的主机；平时适配器自带的
路径仍是默认值。

视频是异步的：`video generate` 先建任务（**计费就发生在这一刻**），把 task id 写进 stderr，
然后轮询到成片出现 —— 两三分钟是常态，轮询预算取该任务的 `timeout_seconds`（默认 1800）。
成片 URL 24 小时内有效，所以 `video status <id>` 可以稍后再取；`--no-wait` 立刻把 id 交回来，
这正是「自己的超时比厂商渲染更短」的 agent 需要的。一次请求一个片子：`--n` 属于图片。

key 跟着 provider 实例走，依次来自 `--api-key`、该实例声明的 `api_key_env`、
`auth.json`。没有任何方言级的默认 key 变量，所以同一方言的两条入口可以各用各的 key。
key 永远只以打码形式输出。`base_url` 写在文件里（`image generate` 有一次性的 `--base-url` 覆盖），并且会在发请求前校验：百炼的
OpenAI 兼容端点（`compatible-mode`）只在业务空间专属域名上提供，所以种子保留一个会明确失败
的占位符；而 `dashscope` 协议所用的百炼原生端点，公共域名同样可用。`mediagen config show`
会打印每个 provider 的任务、模型，以及各自实际会请求的 endpoint。Node >= 24 上设
`NODE_USE_ENV_PROXY=1` 可走 `HTTP_PROXY`。超时：每次请求取该任务的 `timeout_seconds`
（默认图片 300 秒、视频 1800 秒），每次图片下载 120 秒、视频下载 600 秒。对视频来说，
`timeout_seconds` 是**整个轮询窗口**，不是单次请求：建任务与每次轮询各自 60 秒，这样一个挂住
的请求吃不掉预算；下载另有 600 秒，不计入预算。

在 Agent 里用？`skills/mediagen/SKILL.md` 说明这个 CLI 能做什么、项目已有别的生成工具时该用哪个，
以及哪些规则能避免白花钱。

---

## 开发

```bash
npm install
npm run build    # tsup -> dist/cli.js
npm test         # vitest，完全离线：所有地方的 fetch 都被打桩
npm run dev -- image generate --help
```

`src/cli.ts` 负责 commander 接线和错误到退出码的映射；`src/generate.ts` 是流水线
（校验 → 解析 → 调用 → 下载 → 汇报）；`src/api/{qwen,ark,dashscope}.ts` 是
`src/types.ts` 中 `DialectAdapter` 接缝背后的方言适配器，周围是 `config.ts`、
`auth.ts`、`http.ts`、`download.ts`、`output.ts`。

值得守住的东西：所有检查都在第一次 `fetch` 之前完成；付费请求从不重试；stdout 只
放结果；任何输出路径都不含未打码的 key。说现有方言的新 provider 不需要写代码 ——
一张 `config.toml` 表就够。新方言则是 `src/api/` 下的适配器、`DIALECTS`
（`src/api/index.ts`）里的一行，以及适配器上的 `path` 字段 —— 方言拼在 `base_url`
后面的那个端点文件名。

发布：打一个 `vX.Y.Z` 的 GitHub Release，Actions 会自动发布 —— 见
`docs/guides/release.md`（发布的是 `dist/` 和 `skills/`，CI 每次 push 都会跑
`npm pack --dry-run`）。设计文档在 `docs/superpowers/specs/`。

MIT
