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
# (Alibaba's native input.messages/parameters form) and "ark" (Volcengine's own
# API, OpenAI-shaped for images but with its own parameters and per-item errors).
# "qwen" still works as a deprecated alias of "openai".
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
default  = "doubao-seedance-1-0-pro"
models   = ["doubao-seedance-1-0-pro"]

[providers.aliyun]
# The public host does not serve the images API. Replace the placeholder with
# your workspace id, e.g. https://abc123.cn-beijing.maas.aliyuncs.com
base_url    = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.aliyun.image]
# Bailian also documents the native protocol for these models; if this endpoint
# answers 404 on your workspace, switch the line below to api_type = "dashscope"
# and drop the workspace host in favour of https://dashscope.aliyuncs.com.
api_type = "openai"
default  = "qwen-image-3.0"
models   = ["qwen-image-3.0"]

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
