# mediagen

[English](README.md) | 简体中文

通过阿里云百炼（**qwen**）和火山方舟（**doubao / seedream**）生成与编辑图片，
写到磁盘，打印文件路径。参数全部显式、没有交互式提问、`--json` 供程序解析。

```bash
npm install -g @yandy0725/mediagen-cli

# 任何命令首次运行都会写出一份带注释的 config.toml；之后每次运行都会先校验它，
# config show 本身只读。直接编辑这个文件即可
mediagen config show

# 新增一条入口（同一个方言可以有多条，宿主和模型各自不同）
mediagen config add my-proxy --api-type qwen \
  --base-url https://<workspace-id>.cn-beijing.maas.aliyuncs.com \
  --model qwen-image-3.0 --api-key-env DASHSCOPE_API_KEY

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

`dashscope` / `volcengine` 是首次运行写进 `config.toml` 的两个实例名，可以随意改，
也可以照着复制出更多入口。模型 id 是带日期的快照，可以用 `--model` 或 `config.toml`
覆盖任意一个。`--size`
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
default_provider = "dashscope"
# output_dir = "./media-output"

[providers.dashscope]
api_type = "qwen"
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"   # qwen 的 images 接口在 workspace 域名下
model = "qwen-image-3.0"
api_key_env = "DASHSCOPE_API_KEY"

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
model = "doubao-seedream-5-0-flash-260915"
api_key_env = "ARK_API_KEY"

[providers.my-proxy]              # 同一方言的第二条入口
api_type = "qwen"
base_url = "https://proxy.example.com"
model = "qwen-image-3.0"
# path = "/v1/images/generations"  # 可选：覆盖方言默认路径
```

一个 provider = 一种 API 方言（`api_type`，取 `qwen` 或 `ark`）+ 一个具体入口
（`base_url` + `model`）。`api_type`、`base_url`、`model` 三项必填，`path` 和
`api_key_env` 可选（`path` 缺省时按方言取）。文件是唯一真相：内置没有任何 provider，
首次运行只是把上面这份内容写进 `config.toml` 供你修改。

key 跟着 provider 实例走，依次来自 `--api-key`、该实例声明的 `api_key_env`、
`auth.json`。没有任何方言级的默认 key 变量，所以同一方言的两条入口可以各用各的 key。
key 永远只以打码形式输出。`base_url` 只能写在文件里 —— 对 qwen 来说不改它直接就是
`404`，错误信息会指路。Node >= 24 上设 `NODE_USE_ENV_PROXY=1` 可走 `HTTP_PROXY`。
超时：每次请求 300 秒，每次下载 120 秒。

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
（`src/api/index.ts`）里的一行，以及 `src/providers.ts` 里的默认路径。

发布：`npm pack --dry-run` 检查 tarball（发布 `dist/` 和 `skills/`），然后
`npm version patch && npm publish`。设计文档在 `docs/superpowers/specs/`。

MIT
