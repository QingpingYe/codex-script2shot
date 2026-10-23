# setup 自动化设计复审报告

日期：2026-10-23（Asia/Shanghai）  
复审对象：[2026-10-23-setup-automation-design.md](./2026-10-23-setup-automation-design.md)  
结论：**方向可行，但当前版本不建议直接进入实现。** 设计正确地把「不能自动化的人类操作」和「确定性自举」分开了，也覆盖了复盘里的主要 P0/P1。不过，人机边界、既有配置保留、`pending_config` 契约、临时输入文件安全和外部下载事实仍有需要先收敛的缺口。

## 总体判断

选定方案 B 合理：脚本承担确定性步骤，Skill 只做编排、翻译和确认，能避免模型每次手写命令导致漂移。用 `call-tool` 绕过本会话 MCP 未注册的问题，也是解决「缺 `dist` 导致 `health` 不可用」的正确路径。

主要风险不在总体架构，而在若干接口边界没有写死。现在留给构建者的地方偏多，容易实现成能跑但和设计目标不一致的版本，尤其是重跑时覆盖用户配置、把敏感配置写进临时文件、或遇到默认知识库不可访问时退回给用户操作。

## 问题清单

### P0-1：「人类只做两件事」和例外路径矛盾

设计在第 2 节和 §5.1 说人类只做浏览器动作和一次写入确认，但同一份设计又至少引入了两类额外确认：

- `install-cli` 的系统级 `npm install -g` 回退要求用户显式授权（第 107、127-131 行）；
- `ensure-app` 在 agent 上下文被拒绝后，要求取得用户明确同意才能使用 `--force-init`（第 109、292-295 行）；
- 网络或提权受阻时，AI 还要向用户申请提权（§5.3、§7）。

这些不是「人类在终端敲命令」，但仍然是人类动作。目标描述应改成「常规路径人类只做两类动作；异常路径最多出现结构化授权/确认」，或直接把这类授权归并进一次明确的前置授权。否则验收时无法判断是否达标。

### P0-2：默认知识库不可访问时缺少合法失败路径

§5.3 的流程直接「组装完整 config」，没有重新写明 `space_a` / `base_b` 的来源。结合 §5.4 只删除 `lark.profile` 默认值，可推定其他默认值仍会使用插件默认知识库。但新机器新建自建应用后，用户或应用不一定能访问默认 Wiki 空间和默认 Base。

当前 [skills/setup/SKILL.md](/e:/codex-script2shot/skills/setup/SKILL.md:33) 明确让用户选择「默认或替换」，而新设计没有保留这个分支。如果默认资源不可访问，AI 只会收到 `KB_A_UNREACHABLE` / `KB_B_UNREACHABLE`，但设计没有说明下一步：是停等管理员授权，还是允许用户提供替换资源。后者会打破「不填写路径/参数」的目标，因此必须先裁决，而不是留给实现。

### P0-3：重跑 setup 可能覆盖既有自定义配置

[write_config.ts](/e:/codex-script2shot/server/src/tools/write_config.ts:149) 会从空对象套默认值，`save_config()` 也说明「写入内容完全来自传入对象，不保留未知字段」（[config.ts](/e:/codex-script2shot/server/src/config.ts:96)）。设计没有定义 setup 重跑时如何读取并保留既有 `space_a`、`base_b`、`project_roots`、`table_id`、`cli_path`、`retrieval.default_top_k`。

这会造成两个问题：

1. 用户已替换知识库后重跑 setup，可能被插件默认值覆盖；
2. 既有 `table_id` 在 `write_config` 执行后被抹掉，`init_knowledge_b` 执行后才回填；中途失败会让配置处于比开始更差的状态。

设计应增加既有配置读取、掩码摘要、默认/保留/替换三元决策，以及「执行前先写入完整配置，成功后才允许进入建表」的失败边界。

### P1-1：`init_knowledge_b.pending_config` 契约不完整

§5.4 说 `pending_config` 与 `write_config.config` 同形状、同一套校验，但还有几个关键点没有写明：

- 磁盘配置缺失、损坏或无效时，`pending_config` 是否完全替代磁盘配置；
- `resolve_lark_cli()` 是否使用 `pending_config.lark.cli_path`；
- 工具入参 schema 当前是 `additionalProperties: false`（[index.ts](/e:/codex-script2shot/server/src/index.ts:103)），新增字段必须同步；
- 校验是否复用 `write_config` 的 normalizer，避免两套默认值或校验规则；
- `pending_config` 在 dry-run 下是否允许省略 `profile`，还是必须显式要求活动 profile。

建议把契约写成：提供 `pending_config` 且校验通过时，本次调用不读取磁盘配置；所有 CLI 解析、`base_b`、本地路径和校验都以 `pending_config` 为准；执行路径出现 `pending_config` 一律 `CONFIG_INVALID`。测试要覆盖配置缺失、配置损坏、`pending_config` 无效、CLI 路径来自 `pending_config` 四类。

### P1-2：profile mismatch 处置与现有 `health` 输出冲突

设计说 `health` 报 `LARK_PROFILE_MISMATCH` 时，AI 重新解析活动 profile 并用 `write_config` 更新配置值；同时禁止 setup 出现「请用户运行命令」。但当前 [health.ts](/e:/codex-script2shot/server/src/tools/health.ts:215) 的 warning 文本会直接建议用户运行 `lark-cli profile use <name>`。

如果工具文案不变，模型可能优先跟随工具输出，把命令转交用户，造成新契约被旧文案破坏。设计应明确修改 `health` 文案为结构化差异和 setup 可执行的修复路径，或规定 setup 消费 `detail.code` 而不透出该句命令。architecture §7.3 也要同步，否则文档之间继续冲突。

### P1-3：`call-tool --input <json-file>` 的敏感文件生命周期未定义

`write_config` / `init_knowledge_b` 的输入会包含 `base_b`，未来还可能包含用户自定义 token。§5.2 说工具原始结果「由脚本保证不落盘」，但入参本身来自 JSON 文件，设计没有写：

- 文件放在哪里；
- 权限如何限制；
- 进程退出、异常、崩溃时如何清理；
- 是否允许留在系统临时目录；
- AI 是否会看到原始入参。

更安全的契约是改为从 stdin 传 JSON，或写入私有 home 下的临时文件、使用最低权限、在子进程启动后立刻删除，并把删除失败记录为结构化 warning。系统临时目录不应作为默认落点。这里的规则必须在设计层固定，不能留给构建者。

### P1-4：构建和 lark-cli 安装回退没有覆盖 npm 脚本策略的完整影响

§5.2 对 lark-cli 定义了四层回退，但 `build-server` 仍只是 `npm ci + npm run build`。复盘 4.6 已经记录 npm 新脚本拦截会同时影响 `@larksuite/cli` 和 `esbuild`。如果 `esbuild` 的安装脚本被拦截或产物缺失，`npm run build` 会失败。

设计应明确 `build-server` 的失败分类：普通网络/权限错误、npm 源错误、脚本拦截导致构建器缺失、插件目录只读。只有前两类适合直接申请提权或提示网络恢复；脚本拦截需要单独裁决，不能悄悄绕过宿主策略。

### P1-5：外部下载源、版本和校验链未收敛

§11 中 Node 官方分发来源仍是「待实现时核对」。如果实现时才选版本和 URL，两台机器可能得到不同 Node/Lark CLI 版本，也无法在设计评审时确认校验链。

建议补上：

- Node 精确版本、平台归档 URL、`SHASUMS256.txt` URL 的生成规则和固定域；
- lark-cli 安装版本是固定 `1.0.98` 还是受控最新版；
- 校验文件本身的来源域要求；
- 代理/企业网络是否支持，失败如何结构化上报；
- 输出里记录已下载版本、来源 URL、checksum 文件来源和匹配结果。

### P2-1：验证策略缺少几类高风险用例

现有测试计划覆盖了大部分复盘问题，但还应补充：

- 既有配置重跑不被默认值覆盖；
- 默认知识库不可访问时返回结构化错误；
- `build-server` 在 `esbuild` 安装脚本被拦截时的行为；
- `call-tool` 输入文件不残留敏感内容；
- setup Skill 不会透出 `health` 中的用户命令式文案；
- Windows / macOS 双平台包装脚本至少做 smoke test。

§9 的端到端演练如果要触达真实飞书资源，应标明属于 live smoke test，不作为 CI 验收；CI 只应跑 fake CLI、fake 网络和本地 MCP 合同测试。

## 建议的修改顺序

1. 先改设计稿：重新定义人机边界、默认知识库不可访问时的路径、既有配置保留策略。
2. 再固化 `pending_config` 和 `call-tool` 的安全契约，并同步 architecture §7.3 / §8 / §9.1 / §13。
3. 最后细化外部下载版本、checksum 与平台验证策略，避免实现期临时决策。
4. 报告中 P0 三项解决并同步文档后，再进入 TDD 实现。

## 未验证事项

本报告只做文档和现有实现一致性复审，未修改实现代码，也未运行测试或真实飞书初始化。设计稿中标注「待复核」的 Node 官方分发事实仍未核实。
