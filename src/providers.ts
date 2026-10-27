/**
 * Written verbatim to config.toml the first time the CLI needs a configuration.
 *
 * After that the file is the only source of truth: deleting a table here makes
 * that provider disappear. A provider is one account — protocol, origin, key —
 * and each task it serves hangs off it by name, so a second model is one more
 * line in `models`, never a second provider.
 */
export const SEED_CONFIG = `# mediagen configuration. Edit and save; the CLI re-reads it on every run.
#
# A provider is one account: a protocol (api_type), one host (base_url) and a key.
# Each task it can serve hangs off it by name — [providers.<name>.image],
# [providers.<name>.video] — and lists the models you allow there. A second model
# of the same vendor is one more entry in \`models\`, not another provider.
#
# base_url is the origin. The version segment belongs to the endpoint, which the
# dialect appends per task (/api/v3/images/generations, /compatible-mode/v1/...).

default_provider = "volcengine"
# output_dir = "./media-output"     # where generated files land; defaults to the cwd

[providers.volcengine]
api_type    = "ark"
base_url    = "https://ark.cn-beijing.volces.com"
api_key_env = "ARK_API_KEY"   # which environment variable holds this provider's key

[providers.volcengine.image]
default = "doubao-seedream-5-0-flash-260915"
models  = ["doubao-seedream-5-0-flash-260915", "doubao-seedream-5-0-pro"]

[providers.volcengine.video]
default = "doubao-seedance-1-0-pro"
models  = ["doubao-seedance-1-0-pro"]

[providers.dashscope]
api_type = "qwen"
# The public host does not serve the images API. Replace the placeholder with
# your workspace id, e.g. https://abc123.cn-beijing.maas.aliyuncs.com
base_url    = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com"
api_key_env = "DASHSCOPE_API_KEY"

[providers.dashscope.image]
default = "qwen-image-3.0"
models  = ["qwen-image-3.0"]

# Your own entry, e.g. a proxy of the qwen dialect:
# [providers.my-proxy]
# api_type    = "qwen"
# base_url    = "https://proxy.example.com/my-gateway"   # a gateway prefix is fine
# api_key_env = "MY_PROXY_KEY"
#
# [providers.my-proxy.image]
# default = "qwen-image-3.0"
# models  = ["qwen-image-3.0"]
`;
