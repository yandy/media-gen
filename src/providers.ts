/**
 * Written verbatim to config.toml the first time the CLI needs a configuration.
 *
 * After that the file is the only source of truth: deleting a table here makes
 * that provider disappear. A provider is one account — host, key — and each task
 * it serves hangs off it by name, declaring its own protocol, so a second model
 * is one more line in `models`, never a second provider.
 */
export const SEED_CONFIG = `# mediagen configuration. Edit and save; the CLI re-reads it on every run.
#
# A provider is one account: one host (base_url) and one key. Each task it can
# serve hangs off it by name — [providers.<name>.image], [providers.<name>.video]
# — and declares its own protocol (api_type) plus the models you allow there. A
# second model of the same vendor is one more entry in \`models\`, not another
# provider. api_type may also sit on the provider table as the default for every
# task under it.
#
# The protocols are "openai" (the OpenAI-compatible wire format), "dashscope"
# (Alibaba's native input.messages/parameters form), "ark" (Volcengine's own API,
# OpenAI-shaped for images but with its own parameters and per-item errors) and
# "minimax" (MiniMax's video API). "qwen" still works as a deprecated alias of
# "openai". dashscope serves images only: it has no video task.
#
# base_url is the origin. The version segment belongs to the endpoint, which the
# dialect appends per task (/api/v3/images/generations, /compatible-mode/v1/...).

default_provider = "volcengine"
# output_dir = "./media-output"     # where generated files land; defaults to the cwd

[providers.volcengine]
base_url    = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"   # which environment variable holds this provider's key

[providers.volcengine.image]
api_type = "ark"
default  = "doubao-seedream-5-0-flash-260915"
models   = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]

[providers.volcengine.video]
api_type = "ark"
default  = "doubao-seedance-1-0-pro-250528"
models   = ["doubao-seedance-1-0-pro-250528"]   # ids are dated snapshots; add more here

[providers.aliyun]
# Bailian's native protocol is served on the public host, so this entry works as
# written. For the OpenAI-compatible protocol use your workspace-scoped host
# instead — https://{workspace-id}.cn-beijing.maas.aliyuncs.com — which is also
# where Alibaba recommends sending native calls.
base_url    = "https://dashscope.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.aliyun.image]
api_type = "dashscope"          # input.messages + parameters, output.choices[].image
default  = "qwen-image-3.0"
models   = ["qwen-image-3.0"]

[providers.minimax]
base_url    = "https://api.minimax.io"
api_key_env = "MINIMAX_API_KEY"

[providers.minimax.video]
api_type = "minimax"
default  = "MiniMax-H3"
models   = ["MiniMax-H3", "MiniMax-H3-Max"]   # -Max: 480P/768P only, 5s minimum

# A gateway that serves DashScope's native protocol on its own path:
# [providers.my-gateway]
# base_url    = "https://gateway.example.com"
# api_key_env = "MY_GATEWAY_KEY"
#
# [providers.my-gateway.image]
# api_type = "dashscope"          # input.messages + parameters, output.choices[].image
# path     = "/v1/images/generations"
# default  = "qwen-image-2.0-pro"
# models   = ["qwen-image-2.0-pro"]

# Your own entry, e.g. a proxy of the openai dialect:
# [providers.my-proxy]
# base_url    = "https://proxy.example.com/my-gateway"   # a gateway prefix is fine
# api_key_env = "MY_PROXY_KEY"
#
# [providers.my-proxy.image]
# api_type = "openai"
# default  = "qwen-image-3.0"
# models   = ["qwen-image-3.0"]
`;
