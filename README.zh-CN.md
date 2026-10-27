# mediagen

[English](README.md) | 简体中文

通过阿里云百炼（**qwen**）和火山方舟（**doubao / seedream**）生成与编辑图片，
写到磁盘，打印文件路径。参数全部显式、没有交互式提问、`--json` 供程序解析。

```bash
npm install -g @yandy0725/mediagen-cli

# 任何命令首次运行都会写出一份带注释的 config.toml；之后每次运行都会先校验它，
# config show 本身只读。直接编辑这个文件即可
mediagen config show

# 新增一条入口：一个账号（协议 + origin + key）带一张 image 任务表
mediagen config add my-proxy --api-type qwen \
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
| `mediagen login` / `logout` / `auth status` | 保存、删除、查看 API key |
| `mediagen config show` / `config path` | 解析后的配置，以及它存在哪里 |
| `mediagen config add <name>` | 在 config.toml 里新建一条 provider（其余修改手写文件） |

`mediagen image generate --help` 才是参考手册：全部参数、模型表、尺寸表、示例。
下面只是简化版。

## 模型与参数

| 模型 | provider | 什么时候选它 |
|---|---|---|
| `qwen-image-3.0` | `--provider dashscope` | 文字渲染（中日韩 + 拉丁）、图像编辑 |
| `doubao-seedream-5-0-flash-260915` | `--provider volcengine` | 速度：草稿、迭代 |
| `doubao-seedream-5-0-pro` | `--provider volcengine --model doubao-seedream-5-0-pro` | 最高质量 |

`dashscope` / `volcengine` 是首次运行写进 `config.toml` 的两个 provider 名，可以随意改。
一个模型只有被列在该 provider 的 `image` 表的 `models = [...]` 里才可用；同一家厂商的
第二个模型是往那张表里加一行 —— 不需要新增 provider。模型 id 是带日期的快照，随版本
滚动时改 `models`（以及 `default`）即可。`--size`
接受档位（`2K`）、像素（`2048x2048`）或 `auto`（仅 qwen）；`--n` 接受 1-6 ——
在 ark 上每张图都是一个独立的付费请求。厂商专属参数（`--negative-prompt` 仅 qwen，
`--output-format` 仅 ark）会在发出任何请求之前失败。

## 输出

文件写到 `--out-dir`（否则 `output_dir`，否则当前目录），文件名
`<provider>-<model>-<yyyyMMdd-HHmmss>-<index>.<ext>`，永不覆盖。人类可读模式在
stdout 上每行打印一个绝对路径；`--json` 打印一个对象：

```json
{"ok":true,"partial":false,"files":[{"path":"/tmp/out/dashscope-qwen-image-3-0-20261025-020839-0.png","index":0,"url":"https://dashscope-result.oss-cn-beijing.aliyuncs.com/1.png"}],"errors":[],"usage":{"image_count":1},"request_id":"a1b2c3d4"}
```

`partial: true` 且退出码 `0` 表示部分图片成功、部分失败：磁盘上那些已经付过费了，
不要整条请求重跑。退出码：`0` 成功（含部分成功），`1` API / 配置 / 运行时失败，
`2` 用法错误 —— 总是在发请求之前抛出，所以不花钱。付费请求不会自动重试。

## 配置

`config.toml` 和 `auth.json`（权限 `600`）位于
`$MEDIAGEN_CLI_CONFIG_DIR`、`$XDG_CONFIG_HOME/mediagen-cli`、
`~/.config/mediagen-cli` 三者中第一个存在的。

```toml
default_provider = "volcengine"
# output_dir = "./media-output"

[providers.volcengine]              # 账本：协议、主机、key
api_type    = "ark"
base_url    = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"

[providers.volcengine.image]        # 能力：一个任务一张表
default = "doubao-seedream-5-0-flash-260915"
models  = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]

[providers.volcengine.video]
default = "doubao-seedance-1-0-pro"
models  = ["doubao-seedance-1-0-pro"]

[providers.dashscope]
api_type    = "qwen"
base_url    = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.dashscope.image]
default = "qwen-image-3.0"
models  = ["qwen-image-3.0"]

[providers.my-proxy]                # 同一协议的第二个账号
api_type    = "qwen"
base_url    = "https://proxy.example.com/my-gateway"   # 可带网关前缀
api_key_env = "MY_PROXY_KEY"

[providers.my-proxy.image]
default = "qwen-image-3.0"
models  = ["qwen-image-3.0"]
```

一个 provider = **一个账号**：协议（`api_type`，取 `qwen` 或 `ark`）、一台主机
（`base_url`）、可选的 `api_key_env`。它能提供的每个任务按名字挂在下面
（`[providers.<name>.image]`、`[providers.<name>.video]`），表里列允许使用的模型 id，
以及 `--model` 缺省时用的 `default`。`timeout_seconds` 按任务可选（图片 300、视频 1800）。
同一家厂商的两个模型是同一个 `models` 列表里的两项，不是两个 provider。

**`base_url` 就是 origin** —— 可以带网关前缀，但不带版本段。版本段属于端点，由方言按任务
自己拼接（`/api/v3/images/generations`、`/compatible-mode/v1/images/generations`），
所以换任务只换 path。若在厂商自有域名上仍以 `/api/v3`、`/api/v1` 或
`/compatible-mode/v1` 结尾，会在发请求前被拒绝，并给出应填的 origin。
文件是唯一真相：内置没有任何 provider，首次运行只是把上面这份内容写进 `config.toml`
供你修改。种子 qwen 那条带 `<workspace-id>` 占位符，只有当它被选中时才会在花钱前报错，
所以只需要改这一行。

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

`video` 表能解析、能校验，但还没有任何方言实现视频适配器：视频任务会明确报这一点，
`config show` 也不会为它打印 endpoint。

key 跟着 provider 实例走，依次来自 `--api-key`、该实例声明的 `api_key_env`、
`auth.json`。没有任何方言级的默认 key 变量，所以同一方言的两条入口可以各用各的 key。
key 永远只以打码形式输出。`base_url` 写在文件里（`image generate` 有一次性的 `--base-url` 覆盖），并且会在发请求前校验：对 qwen
来说公共域名直接就是 `404`，所以种子保留一个会明确失败的占位符。`mediagen config show`
会打印每个 provider 的任务、模型，以及各自实际会请求的 endpoint。Node >= 24 上设
`NODE_USE_ENV_PROXY=1` 可走 `HTTP_PROXY`。超时：每次请求取该任务的 `timeout_seconds`
（默认图片 300 秒、视频 1800 秒），每次下载 120 秒。

在 Agent 里用？`skills/mediagen/SKILL.md` 说明什么时候该用这个 CLI。

---

## 开发

```bash
npm install
npm run build    # tsup -> dist/cli.js
npm test         # vitest，完全离线：所有地方的 fetch 都被打桩
npm run dev -- image generate --help
```

`src/cli.ts` 负责 commander 接线和错误到退出码的映射；`src/generate.ts` 是流水线
（校验 → 解析 → 调用 → 下载 → 汇报）；`src/api/{qwen,ark}.ts` 是
`src/types.ts` 中 `DialectAdapter` 接缝背后的方言适配器，周围是 `config.ts`、
`auth.ts`、`http.ts`、`download.ts`、`output.ts`。

值得守住的东西：所有检查都在第一次 `fetch` 之前完成；付费请求从不重试；stdout 只
放结果；任何输出路径都不含未打码的 key。说现有方言的新 provider 不需要写代码 ——
一张 `config.toml` 表就够。新方言则是 `src/api/` 下的适配器、`DIALECTS`
（`src/api/index.ts`）里的一行，以及适配器上的 `path` 字段 —— 方言拼在 `base_url`
后面的那个端点文件名。

发布：`npm pack --dry-run` 检查 tarball（发布 `dist/` 和 `skills/`），然后
`npm version patch && npm publish`。设计文档在 `docs/superpowers/specs/`。

MIT
