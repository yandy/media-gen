/**
 * Written verbatim to config.toml the first time the CLI needs a configuration.
 *
 * After that the file is the only source of truth: deleting a table here makes
 * that provider disappear. The dialect table above carries no provider names,
 * no hosts and no keys — those belong to the instance, so two providers of the
 * same dialect can point at different hosts and use different keys.
 */
export const SEED_CONFIG = `# mediagen configuration. Edit and save; the CLI re-reads it on every run.
#
# A provider = one API dialect (api_type) + one concrete entry point
# (base_url + model). A dialect can back several providers: copy any section
# below, rename it, and change base_url and model.
#
# base_url runs up to the version segment; the endpoint file name
# (/images/generations) belongs to the dialect and is appended for you.

default_provider = "volcengine"
# output_dir = "./media-output"     # where generated files land; defaults to the cwd

[providers.volcengine]
api_type = "ark"
base_url = "https://ark.cn-beijing.volces.com/api/v3"
model = "doubao-seedream-5-0-flash-260915"
api_key_env = "ARK_API_KEY"   # which environment variable holds this entry's key

[providers.dashscope]
api_type = "qwen"
# The public host does not serve the images API. Replace the placeholder with
# your workspace id, e.g. https://abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
base_url = "https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
model = "qwen-image-3.0"
api_key_env = "DASHSCOPE_API_KEY"

# Your own entry, e.g. a proxy of the qwen dialect:
# [providers.my-proxy]
# api_type = "qwen"
# base_url = "https://proxy.example.com/my-gateway/v1"   # gateway prefix + version segment
# model = "qwen-image-3.0"
# api_key_env = "MY_PROXY_KEY"
`;
