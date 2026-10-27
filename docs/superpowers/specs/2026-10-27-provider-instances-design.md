# 方言与 provider 实例拆分；login 与 config 职责分离

日期：2026-10-27
状态：待评审

## 问题

现状把「API 方言」和「一个具体供应商入口」压成了同一个概念，导致四类症状：

1. **`login --base-url` 越界。** `login` 的语义是凭据管理，却会原地改写 `config.toml`
   （`src/cli.ts:893`）。同名 flag 在 `image generate --base-url` 里是「一次性、不落盘」
   （`src/cli.ts:217`），在 `login` 里是「持久改写」—— 同名反义，最容易坑人。
   原设计文档 `2026-10-24-media-cli-design.md:130` 自己写的是「**login 只管 key**」，
   实现开了后门，属于实现偏离设计。
2. **内置名与方言名重合。** `BUILTIN_PROVIDERS` 的 key 是 `qwen`/`ark`，同时
   `api_type` 也是 `qwen`/`ark`（`src/providers.ts:7-27`）。于是 `--provider qwen`
   既像「选方言」又像「选这家供应商」，无法表达「同一方言下的第二个入口」。
3. **两条不一致的解析路径。** 内置 provider 是 merge 覆盖（字段可全缺），
   custom provider 是 `api_type`+`base_url`+`model` 三条必填（`src/config.ts:70-95`）。
   用户得记两套规则。
4. **`config.toml` 的所有字段都没有 CLI setter。** `default_provider`、`output_dir`、
   `[providers.*]` 的每个字段都只能手写文件。

另有一处坏默认：README:74 明确写着 `base_url` **是 qwen 必需的**，因为内置域名
`https://dashscope.aliyuncs.com` 不提供 images 接口。这正是 `login --base-url` 当初
被加进来的真实动机。本次不做补救性 setter，而是把这个事实**写进种子配置的注释里**。

## 目标

- 方言（`api_type`）只承载协议：请求编码、响应解析、默认路径、内置 key 环境变量名。
- provider 是「方言 + 入口」的具体实例，区别在 `base_url` 和 `model`。
- `config.toml` 是唯一真相；CLI 只负责**引导创建**，日常修改一律手写文件。
- `login` 只做凭据。

## 非目标

- 通用配置 setter（`config set`）。决定不做：字段少、注释敏感，手写文件更直接。
  代价是 qwen 的 `base_url` 必须手改，用种子注释和报错信息兜住。
- 新增方言（如 openai-compatible）。仍是 `src/api/` 加适配器 + `DIALECT_DEFAULTS` 加一行。
- 远程配置、profile 切换、多账号并存。
- 任何针对旧版本配置的兼容、迁移或弃用告警（见「不做兼容」）。

## 新模型

```
Dialect   = "qwen" | "ark"        协议方言，拥有：编解码、默认 path
Provider  = { name, api_type, base_url, model, path?, api_key_env? }   一条入口
```

内置条目不再是解析期的兜底，而是**首次运行时写入文件的种子**。写法上改为厂商名，
方言名只留在 `api_type`：

| 实例名 | api_type | 种子 base_url | 种子 model | 种子 api_key_env |
|---|---|---|---|---|
| `dashscope` | `qwen` | `https://dashscope.aliyuncs.com` | `qwen-image-3.0` | `DASHSCOPE_API_KEY` |
| `volcengine` | `ark` | `https://ark.cn-beijing.volces.com` | `doubao-seedream-5-0-flash-260915` | `ARK_API_KEY` |

**key 跟着 provider 实例走，不跟着方言走。** `api_key_env` 是纯实例字段，方言层不提供任何
key 环境变量默认值。种子里的 `api_key_env` 只是为了出厂可用而显式写在每个实例上；
用户自建的新入口必须自己声明（或走 `login` / `--api-key`）。这样两个 dashscope 代理
可以各自用不同的 key，而不会被一个方言级默认值悄悄混到一起。

`qwen` / `ark` 不再能作为 `--provider` 的取值，只作为 `api_type` 的取值。

**解析只有一条路径**：`config.providers` 里有什么就是什么。种子写完之后，内置表不再
参与任何计算 —— 从文件里删掉 `[providers.volcengine]`，这个 provider 就真的消失。
方言默认值仍按 `api_type` 补齐：

```
DIALECT_DEFAULTS[api_type]  →  path（仅当实例没写）
[providers.name]            →  api_type、base_url、model 必填；path、api_key_env 可选
```

`api_type` 缺失时无法推断（名字不再是方言名），直接报错并给出补丁内容。

## 种子配置

`config.toml` 不存在时，第一次加载配置就写入下面这份内容（best-effort：写失败只在
stderr 提示，不阻断命令，只读文件系统上 `config show` 仍要能用）。

```toml
# mediagen 配置。改完直接保存，CLI 每次运行都会重新读取。
#
# 一个 provider = 一种 API 方言（api_type）+ 一个具体入口（base_url + model）。
# 同一方言可以有多个 provider：复制下面任意一节，改名字、base_url、model 即可。

default_provider = "dashscope"
# output_dir = "./media-output"     # 输出目录，默认当前目录

[providers.dashscope]
api_type = "qwen"
# 注意：公共域名不提供 images 接口，必须换成你工作空间的域名。
# 形如 https://<workspace-id>.cn-beijing.maas.aliyuncs.com
base_url = "https://dashscope.aliyuncs.com"
model = "qwen-image-3.0"
api_key_env = "DASHSCOPE_API_KEY"   # 这个入口从哪个环境变量取 key
# path = "/compatible-mode/v1/images/generations"   # 可选，默认按方言取

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com"
model = "doubao-seedream-5-0-flash-260915"
api_key_env = "ARK_API_KEY"

# 自己加的代理商入口：
# [providers.my-proxy]
# api_type = "qwen"
# base_url = "https://proxy.example.com"
# model = "qwen-image-3.0"
# api_key_env = "MY_PROXY_KEY"
```

API key 不进这个文件：`login` 写 `auth.json`（按实例名存，权限 600），环境变量名则由
该实例的 `api_key_env` 决定。解析优先级：`--api-key` 旗标 > 实例的 `api_key_env` > `auth.json`。

## 命令面

### `login` / `logout` / `auth status` —— 只碰凭据

```
mediagen login [--provider <实例名>] [--api-key <key>]
```

- 删掉 `--base-url`，随之删除 `runBaseUrlOnlyLogin()` / `keyRouteHint()`（`src/cli.ts:528-564`）。
- `--provider` 省略时取 `default_provider`；实例必须在 `config.toml` 中存在，
  否则报 usage error 并指路 `config add` 或文件位置。
- 写 `auth.json`，按实例名存 key，权限 600。

### `config` —— 只负责引导创建

```
mediagen config show                  # 生效配置；标注哪些值来自 config.toml、哪些是方言默认补的
mediagen config path                  # config.toml 与 auth.json 的路径
mediagen config add <name> --api-type <qwen|ark> --base-url <url> --model <id>
                           [--path <p>] [--api-key-env <VAR>]
```

- `config add` 一次原子写入完整表，表已存在则拒绝并提示直接编辑文件。
  这是**新增 provider 的唯一 CLI 入口**，必填三项一次给全，因此
  「`[providers.X]` 存在但字段不全」这个非法状态在 CLI 路径上不会产生。
- 没有 `set` / `unset`。改 `base_url`、换 `model`、切 `default_provider`、删 provider：
  全部手写文件。有了种子文件和注释，这是最直接的方式。
- 因此 `default_provider` 也无需特例：种子已经写了 `dashscope`。
- 写入复用 `assertFaithfulRewrite()`（`src/cli.ts:1000+`，它的注释本就允许
  「新增一整节 provider」），先解析 + 校验「除目标表外一切未变」再落盘。
  `setProviderBaseUrl` / `applyBaseUrl` / `replaceAssignment` / `findCommentStart` /
  `providerHeaderPattern` 全部删除；只保留 `tomlKey` / `tomlBasicString` 用于拼接。
- 旗标用 kebab（`--api-type`），写进文件时映射回 `api_type`。
- `config show` 的来源类别从三类（`built-in` / `config.toml` / `default`）减为两类
  （`config.toml` / `default`），因为内置实例不再参与解析。

### `image generate|edit`

`--provider` 只接受 `config.toml` 里已声明的实例名。`--model` 与 `--base-url`
保持「一次性覆盖、不落盘」。

## 不做兼容

项目尚未发布（0.1.0，包名刚改过一次），没有任何外部用户依赖现有配置形态。
因此**不写任何兼容层**：

- 不保留 `qwen` / `ark` 作为 provider 别名，不做 deprecated 告警。
- 不检测、不迁移旧的 `[providers.qwen]` 表，也不为旧格式写补丁提示文案。
- 不探测 `auth.json` 里旧 provider 名下的 key。
- 不做 `config.toml` 的 schema 版本号或迁移命令。

旧配置文件与新 schema 不符时，`loadConfig()` 就按新规则正常报错（缺 `api_type` 等），
用户自己删改。种子同样只在文件不存在时写入，因此不会与旧文件混用。

因此本次改动可以放手重命名、重排命令面、直接删字段（如 `ProviderConfig.custom`）。

## 实现要点

- `src/providers.ts`：`BUILTIN_PROVIDERS` 拆成两样东西 ——
  `DIALECT_DEFAULTS`（按 `api_type`：仅 `path`，解析期使用）与
  `SEED_CONFIG`（种子 `config.toml` 的文本，只在创建文件时使用）。
- `src/config.ts`：`loadConfig()` 在文件缺失时写种子（best-effort）；
  `resolveProvider()` 收敛成单一路径 —— 只查 `config.providers`，
  `api_type`/`base_url`/`model` 必填，`path` 缺失时按 `api_type` 补，`api_key_env` 保持实例字段不补；
  `default_provider` 缺失时报错提示在文件里补一行。
  写入助手 `ensureConfigFile()` 与 `loadConfig()` 分开，便于测试。
- `src/types.ts`：删掉 `ProviderConfig.custom`（`src/types.ts:9`），
  内置/自定义的区分不存在了。
- `src/auth.ts`：删掉内置 env 兜底（`src/auth.ts:78-82` 中按 provider 名查
  `BUILTIN_PROVIDERS[...].api_key_env` 的分支）。key 只跟实例走，优先级变为
  `--api-key` > 实例的 `api_key_env` > `auth.json`；`envVarFor()`（`src/cli.ts:713`）与
  `missingKeyHint()`（`src/cli.ts:729`）相应塌缩成直接读 `provider.api_key_env`。
- `src/cli.ts`：删 `login --base-url` 分支与 `runBaseUrlOnlyLogin` / `keyRouteHint` /
  `setProviderBaseUrl` / `applyBaseUrl` / `replaceAssignment` / `findCommentStart` /
  `providerHeaderPattern`；新增 `runConfigAdd()`；
  `buildProbe` / `providerProbes`（`src/cli.ts:692-712`）塌缩成直接读 `config.providers`；
  `config show` 去掉「not found; using built-in defaults」分支。
- 测试：删除 `src/cli.test.ts:538-710` 约 10 个 `login --base-url` 用例；
  新增约 6 个 `config add` 用例（创建、拒绝重名、必填校验、保留注释与其余配置、
  种子写入、种子不覆盖已有文件）；既有 provider 相关用例按新名与种子行为更新。

## 待定

无。
