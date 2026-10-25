import type { Dialect, ProviderConfig } from "./types.js";

export const DIALECT_DEFAULT_PATHS: Record<Dialect, string> = {
  qwen: "/compatible-mode/v1/images/generations",
  ark: "/api/v3/images/generations",
};

export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  qwen: {
    name: "qwen",
    api_type: "qwen",
    base_url: "https://dashscope.aliyuncs.com",
    model: "qwen-image-3.0",
    path: DIALECT_DEFAULT_PATHS.qwen,
    api_key_env: "DASHSCOPE_API_KEY",
    custom: false,
  },
  ark: {
    name: "ark",
    api_type: "ark",
    base_url: "https://ark.cn-beijing.volces.com",
    model: "doubao-seedream-5-0-flash-260915",
    path: DIALECT_DEFAULT_PATHS.ark,
    api_key_env: "ARK_API_KEY",
    custom: false,
  },
};
