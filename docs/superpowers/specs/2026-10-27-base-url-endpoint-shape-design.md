# base_url 含版本段，端点文件名归方言

日期：2026-10-27
状态：待评审

## 问题

**一、`base_url` 名不符实。** 它只到 host，版本段（`/api/v3`、`/compatible-mode/v1`）
藏在方言的默认 `path` 里。而它在通行约定里是「含版本段的前缀」——OpenAI SDK 的
`base_url` 是 `https://api.openai.com/v1`，axios 的 `baseURL`、httpx 的 `base_url` 同理。
同一个词两种含义，产生两类故障：

1. **写重复版本段，只得到 404。** 按通行约定把版本段写进 `base_url`，拼接（`src/http.ts:223`
   的字面 `${base_url}${path}`）不报错，只是打到一个不存在的端点：
   `https://proxy.example.com/v1/compatible-mode/v1/images/generations`。404 的文案
   （`src/http.ts:181-183`）只摘响应体，不含 URL，用户看不到自己拼出了什么。
2. **`path` 一个字段干两件事。** 它同时承载「网关/版本前缀」和「端点文件名」，两者边界
   只靠约定维持。空字符串还能绕过 `path ?? default` 打到裸 host，于是需要一条专门的
   校验补丁（`src/cli.ts:737-742`）。

**二、`base_url` 从未在解析期校验。** 只有 `config add` 的 flag 走 `normalizeBaseUrl`
（`src/generate.ts:105-115`），手写进 `config.toml` 的值直接进 `fetch`。
种子正是这个漏洞的实例：`[providers.dashscope].base_url` 写的是公共 host
`https://dashscope.aliyuncs.com`，它**必然 404**（公共域名不提供 images 接口），
唯一提示是旁边一行注释。用户第一次运行拿到的是一个没有 URL 的 404。

## 目标

- `base_url` 的语义与通行约定一致：协议 + host + 网关前缀 + 版本段，到版本段为止。
- 方言只拥有端点文件名（`/images/generations`）。两个方言此刻同值。
- provider 的必填字段仍是 `api_type` + `base_url` + `model`，可选字段只剩 `api_key_env`。
- 配置面少一个字段：`path` 从 `config.toml`、`config add`、`config show` 里消失。
- 对新形状的配置，实际请求 URL 与今天逐字节一致。
- qwen 的种子写占位符 URL，第一次运行在**联网前**失败并指出要改什么。

## 非目标

- **不做兼容、迁移、弃用路径。** 项目未发版，没有需要照顾的旧配置：provider 表里残留的
  `path` 就是未知键，按现有规则（`src/config.ts:228-236`）忽略，不写特判、不报警告。
- 不改其它字段，不改 `--provider` / `--model` / `--size` / `--out-dir` 等命令面。
- 不引入 `config set`，不新增方言，不做 `base_url` 的自动推导（workspace id 无法猜）。

## 约束

- 每一次检查都在第一次 `fetch` 之前；付费请求不重试。
- stdout 只放结果，key 只以掩码出现，错误信息不含未掩码 key。
- 两种退出码不要混：CLI flag 的用法错误是 `UsageError`（退出 2），`config.toml` 内容
  错误是 `ConfigError`（退出 1）。
- 拼接仍是字面 `${base_url}${path}`：`base_url` 去尾部斜杠（`src/generate.ts:114`），
  端点自带前导 `/`。

## 方案

| 方案 | 写法 | 结论 |
|---|---|---|
| **A** 改名 `host` + `endpoint_path` | 语义准确 | 只换名字，仍要两个字段、仍要手写版本段，配置面没变简单 |
| **B** `base_url` 到版本段为止 | `https://ark.cn-beijing.volces.com/api/v3` + 方言端点 | **采用** |
| **C** 单个完整 `url` | 零命名歧义 | 方言默认值消失，必填字段从 3 个变 4 个 |

B 有两个分支，都已评估：

- **B1** 保留可选 `path` 作为「代理端点文件名不同」的逃生口。两个方言的默认值变得相同，
  `DIALECT_DEFAULT_PATHS` 退化成一张同值表，`--path` 的空值校验和 `config add --path`
  都得留着。
- **B2** 删掉 `path`，端点文件名由方言固定。代理前缀本来就该写进 `base_url`，
  逃生口没有存在的必要；将来出现非 OpenAI 形状的方言，本来也要写适配器。
  **采用 B2。**

## 新形状

```toml
default_provider = "volcengine"   # ark 的种子 URL 可直接用；qwen 用户改这一行或传 --provider

[providers.dashscope]
api_type = "qwen"
# 该占位符在解析期就会被拒；把你的工作空间 id 填进去（域名不提供 workspace 时 images 接口 404）
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
model = "qwen-image-3.0"
api_key_env = "DASHSCOPE_API_KEY"

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/v3"
model = "doubao-seedream-5-0-flash-260915"
api_key_env = "ARK_API_KEY"

# [providers.my-proxy]
# api_type = "qwen"
# base_url = "https://proxy.example.com/my-gateway/v1"   # 网关前缀 + 版本段都写在这里
# model = "qwen-image-3.0"
# api_key_env = "MY_PROXY_KEY"
```

拼接结果与今天的种子配置逐字节相同：
`https://ark.cn-beijing.volces.com/api/v3/images/generations`、
`https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations`。

## 实现要点

1. **端点归属方言。** `src/types.ts` 的 `ProviderConfig` 删 `path`，`DialectAdapter` 增
   `path: string`；`src/api/qwen.ts`、`src/api/ark.ts` 的适配器常量各自声明
   `"/images/generations"`。`src/providers.ts` 删 `DIALECT_DEFAULT_PATHS`。
2. **url 拼接。** `src/http.ts:223` 改为 `${provider.base_url}${dialect.path}`（`dialect`
   已在函数内解析）。
3. **配置层。** `src/config.ts` 的 `ProviderOverride` 与 `PROVIDER_STRING_FIELDS` 删
   `path`，`resolveProvider()` 不再补该字段；同一函数新增 `base_url` 校验（下述）。
4. **`base_url` 校验。** `resolveProvider()` 用 `new URL()` 校验 `base_url` 是绝对
   http(s) URL，否则抛 `ConfigError` 并给出该 provider 的正确形状：
   `api_type = "qwen"` 用 `QWEN_WORKSPACE_BASE_URL` 举例（种子里的占位符即走这条），
   `ark` 用 `https://ark.cn-beijing.volces.com/api/v3` 举例。
   `src/generate.ts` 的 `normalizeBaseUrl` 保留给 `config add` 的 flag（退出码 2 的
   用法错误），两者不合并。
5. **命令面。** `src/cli.ts` 删 `config add --path` 选项与其空值校验、`appendProviderTable`
   的 `path` 字段、`config show` 字段清单里的 `path`；`config show` 改为每个 provider 打印
   一行 `endpoint:`，值为解析后的完整请求 URL（`base_url` + 方言端点，不含 query）。
   `base_url` 解析不了时该行省略，未知 `api_type` 时也省略，都不走会抛错的 `getDialect()`。
6. **种子配置。** `src/providers.ts` 的 `SEED_CONFIG` 换成上面「新形状」的内容：
   qwen 用占位符、`default_provider` 注释掉、`# path` 整行删除、注释说明 `base_url`
   写到版本段为止。
7. **错误文案。** `src/http.ts:18` 的 `QWEN_WORKSPACE_BASE_URL` 加上
   `/compatible-mode/v1`；`missingQwenEndpointMessage()`（`:139-150`）说明「`base_url`
   要写到版本段为止，端点文件名由方言补」。
8. **文档与技能。** 两份 README 的 `[providers.my-proxy]` 示例、`config add` 示例、
   `skills/mediagen/SKILL.md` 里的 workspace host 说明（都要带 `/compatible-mode/v1`）。

## 我的判断（可在评审时推翻）

- **C1 `config show` 增加 `endpoint` 行。** 本次改动的全部风险都在 URL 形状上，show 就该
  展示将被 POST 的 URL；`base_url` 本来就完整打印，不新增泄漏面。`config show --json`
  的 provider 对象因此把 `path` 键换成 `endpoint`，算本 spec 认可的对外契约变更。
- **C2 端点放在 `DialectAdapter` 上，而非全局常量。** 端点文件名是方言属性，两个方言
  同值纯属巧合；放在适配器上，新增方言不必回头改 `http.ts`。
- **C3 不做 URL 规范化。** 既不补前导 `/`，也不 trim；`base_url` 已有尾斜杠归一
  （提到 `resolveProvider` 后两处共用同一规则），端点是我们自己写死的常量，
  第二个输入不来自用户。
- **C4 种子设 `default_provider = "volcengine"`。** ark 的种子 URL 是真实可用的，
  default 指向它，配置好 key 就能开箱跑；qwen 用户本来就必须改 `base_url`，
  顺手改这一行或传 `--provider dashscope` 即可。

## 待评审

- C1：`endpoint` 行要不要，`--json` 键名用 `endpoint` 是否合适？
- 是否给「`base_url` 只到 host（pathname 为空）」加提示？我倾向不加：根挂载的代理
  是合法形状（`https://img.example.com` + `/images/generations`），会误报。
