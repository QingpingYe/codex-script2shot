# 改造指南：让 Codex 插件同时支持 Claude Code

- 日期：2026-10-30
- 依据：本仓库 `script2shot` 的实测改造（提交 `53363af`，plugin `0.3.0`），
  并用 `obra/superpowers`（v7.0.1）交叉核对了布局惯例
- 适用对象：已有的 Codex 插件仓库（根 `plugin.json` + `mcp.json` + `skills/`；
  Codex 兼容布局 `.codex-plugin/plugin.json` 同样适用）
- 目标读者：执行改造的 AI 会话或开发者；读者可先通读再动手

改造的总体思路：**两种宿主各读各的清单目录，共享同一份 `skills/`**。Claude Code
不认识 Codex 的任何文件，所以不改 Codex 侧、只做加法与少量中性化改写。

---

## 0. 准备工作

先盘点插件形态，决定改造工作量：

| 形态 | 改造工作量 |
| --- | --- |
| 纯 Skills（无 MCP、无构建产物） | 最小：加两个清单文件即可，参考 superpowers |
| Skills + MCP Server，但启动器只找系统 `node` | 小–中：加清单 + 处理 Node 运行时前置 |
| Skills + MCP Server + 构建产物（如 esbuild 打包） | 中：还要解决产物分发（见 §4） |

盘点命令（在插件仓库根执行）：

```bash
ls plugin.json mcp.json .codex-plugin 2>/dev/null
grep -rn "CODEX_\|codex-runtimes" scripts/ 2>/dev/null
grep -rn "process.env" <server-src>/ | head   # MCP Server 读取的环境变量
cat <server-dir>/package.json                 # 构建脚本与 Node 版本要求
```

需要提前确认的事实（本指南中所有结论的验证方法）：

- 本机装了 Claude Code（CLI 或桌面端任一即可，二者共享同一套配置与插件目录）。
- 若走 git 分发，用户机器需要 Git；本地目录分发不需要。
- 改造过程不需要联网下载任何新工具。

---

## 1. 新增 Claude Code 清单（必做）

### 1.1 `.claude-plugin/plugin.json`

Claude Code 的插件清单位置是 **`.claude-plugin/plugin.json`**（不是仓库根）。
`name` 必填、kebab-case，且不能以 `claude-`/`anthropic-`/`cc-plugin-` 开头。
其余字段可选，建议至少写版本与描述：

```json
{
  "name": "<plugin-name>",
  "version": "0.3.0",
  "description": "...",
  "author": { "name": "..." },
  "repository": "https://github.com/<owner>/<repo>",
  "keywords": ["..."]
}
```

要点：

- `name` 决定组件命名空间：技能 `/plugin-name:skill-name`、MCP 工具
  `mcp__plugin_<name>_<server>__<tool>`。**一次定好，改动成本高**。
- 根目录原有的 Codex `plugin.json` 保持不动（Claude Code 不读它，也不会冲突）。
  参照 superpowers：其仓库同时存在 `.claude-plugin/`、`.codex-plugin/` 等多套清单，
  互不干扰。
- `version` 是更新检测的唯一依据（宿主只在版本变化时更新已安装副本）；
  多清单并存时，每次发布必须把所有清单里的版本号一起递增（见 §5）。

### 1.2 `.claude-plugin/marketplace.json`

如果希望插件仓库自带 marketplace（用户一条命令即可添加），新建该文件：

```json
{
  "name": "<marketplace-name>-git",
  "description": "...",
  "owner": { "name": "..." },
  "plugins": [
    {
      "name": "<plugin-name>",
      "description": "...",
      "version": "0.3.0",
      "source": "./",
      "author": { "name": "..." }
    }
  ]
}
```

要点：

- 条目 `name` 必须与 `.claude-plugin/plugin.json` 的 `name` 完全一致，否则安装时报
  `Plugin "<name>" not found in marketplace`。
- `owner` 必填；`plugins[].source: "./"` 表示插件就在本仓库根。
- marketplace 名字不能是保留名 `inline` / `skills-dir` / `synced`。
- Codex 侧的 `.agents/plugins/marketplace.json` 保持不动，两者并存。
- 建议给 marketplace 条目也写 `version`（与清单同步）；没有版本字段时宿主用
  提交 SHA 计算版本，行为也可用，但显式版本更可控。

---

## 2. 配置 MCP Server（有 MCP 才需要）

### 2.1 根目录 `.mcp.json`

Claude Code **不读** Codex 的 `mcp.json`，需要新建根目录 `.mcp.json`：

```json
{
  "mcpServers": {
    "<short-name>": {
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/<launcher>"
    }
  }
}
```

要点：

- `${CLAUDE_PLUGIN_ROOT}` 在 stdio 服务器的 `command` / `args` / `env` 中会被替换为
  插件安装目录，这是官方支持的变量；不要用相对工作目录的路径。
- **不要写 `cwd`**——MCP 条目没有这个文档化字段（Codex 的 `mcp.json` 里有 `cwd`，
  但 Claude Code 侧删掉它）。
- server 键取**短名**：工具全名会拼成
  `mcp__plugin_<plugin-name>_<server>__<tool>`，用长名会让工具全名非常冗长。
- `command` 可以指向无扩展名的启动器：Windows 上宿主能解析到同名 `.cmd`（实测，
  `command: "${CLAUDE_PLUGIN_ROOT}/scripts/launch_xxx"` 配合同目录 `launch_xxx.cmd`
  可正常连接）；POSIX 上指向带 shebang 的 sh 脚本。两个文件同名并存即可同时覆盖
  两种平台。
- 若 MCP Server 是 Node 脚本且宿主没有内置 Node，还要处理运行时前置（§3）。

### 2.2 验证连接

```bash
claude mcp list
```

期望输出 `plugin:<plugin-name>:<server>: ... - ✔ Connected`；失败先看
`claude plugin validate` 与 `/plugin` 面板的 Errors 标签。

---

## 3. Node 运行时策略（MCP 用 Node 时必做）

关键事实：**Claude Code 自身不提供可供 MCP Server 使用的 Node**（其 CLI 是原生
二进制，不依赖 Node）。Codex 桌面端自带 Node 的 `CODEX_*` 环境变量链在 Claude Code
下全部落空。已实测的应对模式：

### 3.1 启动器补充解析顺序

在启动器（`.cmd` 与 sh 两份）中，在 `CODEX_*` 链之后追加：

1. 插件自建的私有运行时目录（如 `~/.<plugin-home>/runtime/node-*/node-*/`，
   即安装引导自行下载的 Node）；POSIX 侧记得尊重自定义 home 环境变量
   （如 `PLUGIN_HOME`）以支持测试隔离。
2. 系统 `node`（`where node` / `command -v node`）。
3. 全部缺失时报中性错误（如「未找到可用的 Node 运行时」）并以退出码 127 结束；
   不要提示「请更新 Codex」这类宿主专属文案。

批量脚本中探测目录建议用 `for /d %%V in ("%RT%\node-*")` 的双层 glob；
实测路径含空格也能正确处理，多个版本时会取到字典序最大的目录（视为最新）。

### 3.2 无 Node 宿主的首次落地脚本

如果插件的安装引导原本依赖「宿主自带 Node」来运行引导脚本，会陷入死锁
（`node 引导.mjs` 需要 node）。补一个**零依赖**的引导脚本 `ensure_node.ps1` /
`ensure_node.sh`：探测系统 Node 与私有运行时 → 都没有则从官方源下载、校验
SHA256、解压到私有运行时目录 → 输出 `node_path` / `npm_path` 的 JSON。安装引导
技能在收到「未找到 Node」（127）时先调用它，再用返回的 node 跑后续步骤。

两个实测出的 Windows 坑：

- **`.ps1` 含中文注释时必须带 UTF-8 BOM**，否则 Windows PowerShell 5.1 按 ANSI
  解析会报语法错误（错误位置会显示成注释行，极易误判为结构问题）。
- 解压与校验逻辑与主引导脚本的 `ensure-runtime` 保持一致，避免两套口径。

### 3.3 复用当前进程运行时

引导脚本的 `doctor` / `ensure-runtime` 支持「复用当前进程运行时」：当系统 node
探测失败时，若 `process.execPath` 满足版本要求就直接复用（返回
`source: "process"`），npm 取 `execPath` 同目录的 sibling，找不到再退回 PATH。
这样从启动器链里跑起来的会话不会重复下载 Node。建议同时提供
`allow_process_runtime: false` 开关供测试关闭该回退。

---

## 4. 构建产物分发（有构建步骤时必做）

关键事实：**任何宿主都不会为用户自动构建插件**。Claude Code 只在安装时对**插件
根目录**的 `package.json` + lockfile 自动安装依赖（且不运行构建），依赖放在子目录
（如 `server/`）时不触发。实测缺失构建产物时，MCP 连接直接失败：
`Failed to connect — CONNECTION_CLOSED`。

处理方式（按推荐程度排序）：

1. **把构建产物提交入库**（script2shot 采用）：`.gitignore` 改成白名单——
   忽略 `dist/*` 但保留 `dist/server.mjs`；`.gitattributes` 给该文件固定
   `text eol=lf`；发布流程约定「改源码必须重建并一起提交」。esbuild 输出实测
   字节稳定（连续两次构建 sha256 一致），适合入库。
2. 安装引导先构建再使用（依赖用户机器的 npm 与网络，失败路径多）。
3. 打包成归档源分发（把构建步骤放在发布侧）。

采用方式 1 时，顺手把发行版本号同步到构建产物会读到的位置（如 MCP Server
`initialize` 汇报的版本），并写测试锁定（§5）。

---

## 5. 版本纪律与多清单同步

宿主只在版本变化时更新已安装插件。改造后仓库里会有多个版本号来源，必须保持
一致，否则会出现「发了新提交但用户更新不到」或版本记录混乱。script2shot 的做法
（可照搬）：

- 同步清单：Codex 根 `plugin.json`、`.claude-plugin/plugin.json`、
  `.claude-plugin/marketplace.json` 条目、子包 `package.json` 与其 lockfile。
- 一个「版本一致性」测试：读出以上各处版本与 MCP Server 源码里的版本字符串，
  断言全部相等。script2shot 的实现见
  `server/tests/plugin_manifest.test.ts`（`all plugin versions stay in sync`）。
- 每次发布递增全部版本号；纯引用/文案改动（不改插件行为）可以不升版本，
  但要在提交信息里写明。

---

## 6. 技能文本中性化（共享 skills/ 的关键）

两个宿主共享同一份 `skills/`。技能正文里**不要写任何单一宿主的触发语法**：

- `$skill-name`：Codex 的触发写法，Claude Code 不识别（只当普通文本）。
- `/plugin:skill`：Claude Code 的写法，Codex 不识别。
- 互相引用统一写成中性形式 `<plugin-name>:<skill>`（superpowers 全库采用的做法，
  如 `superpowers:writing-plans`）。
- 宿主专属的触发方式写进 README 的分宿主小节（「Codex 里输入 `$setup`」/
  「Claude Code 里输入 `/plugin:setup`」）。

可加一条测试守卫：扫描 `skills/**/*.md`，断言不出现 `\$[a-z]` 形式。script2shot
的实现在 `server/tests/skills_contract.test.ts`（`skill bodies avoid
harness-specific invocation syntax`）。

---

## 7. 权限与用户指引（Claude Code 侧）

- 插件**不能**自带 MCP 工具权限配置（插件的 `settings.json` 只认 `agent` 与
  `subagentStatusLine` 两个键）。在 README 写明预允许片段：

  ```json
  { "permissions": { "allow": ["mcp__plugin_<plugin-name>_<server>__*"] } }
  ```

  通配只能出现在 `mcp__<server>__` 字面前缀之后；随手写 `mcp__*` 不生效。
- README 给出一行安装命令（实测可用）：
  `/plugin marketplace add <owner>/<repo>` 或
  `claude plugin marketplace add <owner>/<repo>`，然后安装
  `<plugin-name>@<marketplace-name>`；桌面端图形入口是输入框旁
  **+ → Add plugins**。
- 工作区信任：桌面端/CLI 首次打开未信任的目录会弹信任对话框；本地目录源
  marketplace 不走 git 凭据。

---

## 8. 验证清单（改造完成前逐项跑）

```bash
# 1. 清单与结构校验（CLI 2.1.309 实测）
claude plugin validate .
#    期望 Validation passed；插件目录提交类告警（LICENSE/icon）不影响私有分发

# 2. 本地安装演练（用隔离配置，不动用户真实配置）
#    CLAUDE_CONFIG_DIR=<临时目录> claude plugin marketplace add <本仓库路径>
#    CLAUDE_CONFIG_DIR=<临时目录> claude plugin install <name>@<marketplace>
#    CLAUDE_CONFIG_DIR=<临时目录> claude plugin details <name>@<marketplace>
#    期望：Skills 数量正确、MCP servers 列出、无 Errors

# 3. MCP 连接
claude mcp list        # 期望 ✔ Connected

# 4. 无 Node 场景（有私有运行时机制时）
#    构造假 home：<home>/runtime/node-vX.Y.Z/node-vX.Y.Z-<platform>-<arch>/（含 node 可执行文件）
#    剥离 PATH 中 node 后运行启动器，确认走私有运行时分支
#    （POSIX 侧记得隔离 XDG_CACHE_HOME 等 Codex 缓存变量，否则会命中宿主缓存）

# 5. 插件自己的测试套件照常全量跑（typecheck + tests）
```

改造时容易踩的坑（都来自实测）：

- 本地目录 marketplace 安装时，仓库里若有指向 `node_modules` 的符号链接
  （常见于 gitignored 的临时目录），复制会报 `EPERM: operation not permitted`；
  git 分发不受影响。测试前清理或移开这类目录。
- `.ps1` 的 UTF-8 BOM（见 §3.2）。
- 在 Git Bash 里调 `cmd /c` 跑 `.cmd` 脚本做手工验证时，路径会被 MSYS 转换导致
  「找不到文件」；用 Node `spawnSync('cmd.exe', [...])` 验证更可靠，且能拿到退出码。
- `mcp.json` 与 `.mcp.json` 是两份不同宿主的配置，内容语义相似但字段不同
  （`cwd`、`${PLUGIN_ROOT}` vs `${CLAUDE_PLUGIN_ROOT}`），不要互相复制。

---

## 9. 分发与更名（收尾）

- 分发渠道与安装体验：
  - 公开 GitHub：`/plugin marketplace add <owner>/<repo>` 一行完成；
  - 内网 git（GitLab 等）：marketplace add 完整 URL（如
    `https://<host>/<group>/<project>.git`），同样要求用户机器有 Git；
  - 无 Git 环境：把插件目录放进 `~/.claude/skills/<name>/`（skills-dir 插件，
    自动加载）或本地目录源；被组织的 managed settings 限制时除外。
- 第三方 marketplace **默认不开**自动更新，用户需要手动 Update，或在
  `/plugin` → Marketplaces 打开 auto-update。
- **仓库更名**（如需去前缀等）：GitHub 改名后旧地址 301 重定向保留，已装用户的
  宿主配置（如 marketplace source、`known_marketplaces.json` 里的旧 URL）会继续
  可用；**GitLab 改名后旧路径不做重定向**（实测其 git 端点直接失效），已装用户
  必须 `marketplace remove` 后按新 URL 重新 add。更名后需要同步：① 本地
  `git remote set-url`；② 仓库内安装命令、README 标题、清单 `repository` 字段
  （历史文档保持原样）；③ 本机宿主配置里的旧 URL（如 `~/.codex/config.toml` 的
  marketplace source 条目）；④ 通知已装用户按新地址重装或重新 add。
- 建议保留不改的：插件运行时数据目录名（如 `~/.<plugin-home>`）与本地物理目录名
  ——它们已被代码写死或影响到宿主会话/信任记录，属独立的破坏性变更。

---

## 附：script2shot 的最终文件布局（可作对照）

```text
plugin-root/
├── .claude-plugin/
│   ├── plugin.json          # Claude Code 清单（name/version/description/…）
│   └── marketplace.json     # Claude Code marketplace（owner + plugins["./"])
├── .mcp.json                # Claude Code MCP（${CLAUDE_PLUGIN_ROOT} → 启动器）
├── plugin.json              # Codex 清单（保留不动）
├── mcp.json                 # Codex MCP（保留不动）
├── .agents/plugins/
│   └── marketplace.json     # Codex marketplace（保留不动）
├── skills/                  # 两宿主共享（正文仅中性引用）
│   └── <skill>/SKILL.md
├── scripts/
│   ├── launch_mcp / .cmd    # 启动器：CODEX_* → 私有运行时 → 系统 node
│   ├── ensure_node.ps1/.sh  # 无 Node 首落引导（.ps1 带 BOM）
│   └── …
└── server/                  # MCP Server（构建产物 server.mjs 入库）
```
