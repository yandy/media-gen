# config.toml 的生命周期：启动即引导，config show 只读

日期：2026-10-27
状态：已批准（2026-10-27）

## 问题

`config.toml` 的「创建」和「校验」现在都藏在 `loadConfig()` 里
（`src/config.ts:98` 调 `ensureConfigFile()`，`src/config.ts:83` 写种子），
于是出现三个症状：

1. **`config show` 会写盘。** 空目录里跑一次 `config show` 就留下 1179 字节的种子
   配置。一个号称「打印解析结果」的命令不该改磁盘。
2. **创建时机跟着命令走。** `config show` / `auth status` / `login` / `logout` /
   `config add` / `image generate` 各自在 action 里 `loadConfig()` 才创建；`config path`
   完全不碰。想找「配置文件什么时候被创建」要翻六个 action。
3. **`config show` 的 `exists` 恒为 `true`。** 种子在 `existsSync` 之前就写好了，所以
   输出永远是 `(loaded)`，`(could not be created)` 分支实际只在配置目录不可写时出现。

## 目标

- **每次运行 CLI，在分派命令之前**处理 `config.toml`：不存在则创建；存在则校验；
  不合法则报错退出。与后面跟什么参数无关。
- `config show` 的代码路径**只读**：不创建、不改写、不修复。
- 「创建 / 校验」只有一个入口，命令 action 里不再有写配置的副作用。

## 非目标

- `config set` 之类的通用 setter（沿用上游设计：手写文件）。
- 自动修复不合法的 `config.toml`（不猜测用户意图，只报错）。
- `auth.json` 的同款处理（本次只动 `config.toml`）。
- 多 profile / 远程配置。

## 方案（已选 A）

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 启动阶段引导** | `main()` 在 `parseAsync` 之前跑一次 `ensureConfigFile()` + `loadConfig()`；`loadConfig()` 变纯读；`config show` 不再创建 | **采用** |
| B. 只读命令只校验不创建 | 文件缺失时报「尚未创建」，只有需要配置的命令才创建 | 否决：可观察行为分裂成两套，用户要记哪个命令会创建文件 |
| C. 只读命令也不校验 | 损坏的配置在 `config show` 里也看不出来 | 否决：把问题推后，报错点离病因更远 |

A 的代价：空目录里跑 `config show` 之后文件仍然存在——但那是**启动阶段**创建的，
不是 `config show` 写的。这正是「创建时机统一」想要的副作用。

另一个方向上的分歧（已选「报错退出」）：引导阶段发现配置**目录不可写**时怎么办？
- 告警后继续：只读命令还能用，但用户可能在空 provider 列表里迷路。
- **直接报错退出（采用）**：创建失败不再静默，和「配置不合法」同一强度。
- 按命令分流：需要配置的命令报错、纯查询命令只告警；多一套规则要记。

## 已定的做法

- **引导位置**：`main(argv)` 内、`parseAsync` 之前，包在现有 `try` 里，失败走
  `reportError`（`--json` 时输出 JSON 错误，退出码沿用 `ConfigError` 的 1）。
- **帮助/版本豁免**：argv 里出现 `-h` / `--help` / `-V` / `--version` 时跳过引导，
  保证配置损坏时帮助仍然可用。扫描到 `--` 为止，避免把 `image generate -- --help`
  的 prompt 误判成求助。
- **`loadConfig()` 只读**：删掉它内部对 `ensureConfigFile()` 的调用；文件缺失时仍返回
  空 provider 表（不再顺手创建）。
- **创建失败即报错**（用户决定，不静默）：`ensureConfigFile()` 不再 `catch` 后吞掉异常，
  写入失败时抛 `ConfigError`，与「配置不合法」同等对待，退出码 1。
  常见成因：目录权限 `EACCES`、路径某一级是普通文件 `ENOTDIR`、只读文件系统 `EROFS`、
  磁盘满 `ENOSPC`。报错必须给出**三件事**：① 出问题的绝对路径（用户批准时明确要求
  「错误提示里应该包含路径」，因为 `config path` 本身也会失败，这是用户唯一能定位文件
  的线索）② errno 原因 ③ 出路（`MEDIAGEN_CLI_CONFIG_DIR` 指到可写目录）。措辞沿用
  `unreadableFileMessage()` 的风格，不带文件内容。
- **`config show`**：仍自己解析一遍文件取 `declared`（用来标注每个值的来源）；因为启动
  阶段已校验过，这次解析不会失败。
- **报错提前**：TOML 损坏时，`config path`、`config add`、`image generate` 都在分派前
  就失败，报错信息与现在一致（含路径、不含文件内容），只是不再等命令自己撞上。

## 连带影响（选「创建失败即报错」的代价，需确认接受）

- 配置目录不可写时，**除 `--help`/`--version` 外所有命令退出 1**，包括 `config path`
  ——它本该是「我的配置在哪」最好用的排查命令。
- `cli.test.ts:566`（不可写目录下 `config show` 仍退出 0）的断言要**反转**成退出 1
  + stderr 含路径与 `MEDIAGEN_CLI_CONFIG_DIR`。
- `config show` 的 `(could not be created)` 分支变成不可达（引导阶段已经抛错），文案
  简化成 `(loaded)`；`--json` 里的 `config_file.exists` 仍如实输出，只是引导之后恒为
  `true`。

## 要改的地方

- `src/config.ts`：`loadConfig()` 去掉创建调用；`ensureConfigFile()` 改为失败抛
  `ConfigError`（不再静默），注释改成「由 `main()` 的引导阶段调用」，不再是
  `loadConfig()` 的副作用。
- `src/cli.ts`：新增引导函数（放在 `main()` 之前调用）；`runConfigShow` 去掉
  「loadConfig 会种下文件」的隐含依赖；`config add` 里 `loadConfig() also seeds...`
  的注释作废；命令帮助里「first run writes a commented config.toml」的措辞跟着改
  （`config show` 不再是首次运行的推荐入口）。
- 测试：`config.test.ts` 的「writes the seed config on first load」要改成直接测引导；
  「still returns a usable config when the seed cannot be written」要反转成抛错；
  新增「`config show` 不写盘」「损坏的配置让 `config path` 也失败」「`--help` 在配置
  损坏时仍可用」「启动阶段在空目录创建」「不可写目录下任意命令退出 1」。
  注意 `cli.entry.test.ts` 跑真实子进程，新增用例要确认它们没把临时配置目录写挂。
- 文档：`README.md:12`、`README.zh-CN.md`、`skills/mediagen/SKILL.md:31`。

## 留给实现者

- 引导函数的命名与拆分（`prepareConfig()` vs 直接两行），以及它是否复用 `loadConfig()`
  的返回值（不缓存，配置文件很小）。
- 创建失败报错的完整措辞（是否直接复用 `unreadableFileMessage()`，或新增一个
  `unwritableDirMessage()` 到 `src/errors.ts`）。硬性要求只有一条：**必须包含路径**。
- 帮助/版本 token 扫描写成独立的小函数还是内联在 `main()` 里。
- 命令帮助与文档的具体措辞。
