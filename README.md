# codex-script2shot

把剧本变成 AI 视频提示词的 Codex 插件。

用户提交一段剧本、一集剧本或多集剧本，插件通过剧本解析、镜头规划和知识检索，
为 Seedance 2.0 或 Seedance 2.5 生成视频提示词。

当前状态：设计阶段。仓库中已有架构设计和通用知识文档，插件代码尚未实现。

## 工作原理

系统由三部分组成：

- 飞书知识库 A：用户维护的原始知识，包括通用知识和项目知识。插件只读取，不写入。
- 飞书知识库 B：一个飞书多维表格（Base），保存插件从 A 归纳出的结构化知识卡
  （`KnowledgeCards`）和同步状态（`SyncState`）。只保留最新版，不保存历史，
  不提供人工阅读页面。
- 本地 Codex 插件：六个 Skill 和本地 MCP Server，负责知识同步、本地关键词
  索引、检索、阶段产物校验和提示词渲染。

主流程：

```text
知识库 A
  -> knowledge-sync（增量归纳，只处理变化文档）
  -> 知识库 B
  -> script2shot 入口
       -> 刷新本地索引
       -> script-breakdown（剧本 -> 结构化解析）
       -> shot-planning（解析结果 + 项目知识 -> 镜头计划）
       -> shot-prompting（镜头计划 + 知识 -> PromptIR）
  -> 校验 Seedance 硬规则 -> 渲染提示词
```

设计原则：知识库 A/B 职责分离、剧本不进知识库、同步状态以知识库 B 为准、
增量同步优先、插件不在服务端运行。

## 主要能力（规划）

插件提供六个 Skill，其中 `script2shot` 是薄入口，创作工作由三个阶段 Skill 承担：

| Skill | 职责 |
| --- | --- |
| `setup` | 查找 `lark-cli`、检查登录状态、配置知识库 A 和 B、初始化本地目录 |
| `knowledge-sync` | 扫描 A 的节点元数据，只读取变化文档，生成知识卡并更新 B 的 `SyncState` |
| `script2shot` | 入口编排：刷新索引、创建运行目录、依次执行三个阶段、校验硬规则、聚合输出 |
| `script-breakdown` | 剧本 -> 结构化解析（场次、节拍、动作、情绪、对白、镜头组建议） |
| `shot-planning` | 解析结果 + 项目知识 -> 镜头计划（景别、机位、运镜、时长、连贯性） |
| `shot-prompting` | 镜头计划 + 知识包 -> PromptIR -> 校验 -> Seedance 提示词 |

本地 MCP Server 只负责确定性操作，包括扫描知识库、读写知识卡、
刷新索引、检索知识、管理运行目录、校验阶段产物和 PromptIR、渲染提示词。
LLM 归纳放在 Skill 中完成。

在 Codex 中可以用自然语言指定单个文档同步：

```text
$knowledge-sync 只同步这个文档：<飞书文档 URL 或 token>
```

`script2shot` 的运行产物输出到工作区：

```text
.script2shot/outputs/<run_id>/
  run.json
  script_analysis.json
  shot_plan.json
  prompts.ir.json
  prompts.<model>.md
  knowledge_refs.json
  warnings.md
```

每次运行必须指定 `project_id` 和一个目标模型。三个阶段之间只通过文件产物交接，
`run.json` 记录输入模式、项目、目标模型和阶段状态。
`shot_plan.json` 可以人工修改后再继续，也可以从任意阶段续跑：

```text
$script2shot 从 shot-planning 继续，run_id 是 <run_id>
$script2shot 只执行 shot-prompting，run_id 是 <run_id>
```

## 快速开始（规划）

1. 安装并登录 `lark-cli`。
2. 运行 `$setup`，配置知识库 A、知识库 B、Base 表和本地目录。
3. 运行 `$knowledge-sync`，把知识库 A 归纳到知识库 B。
4. 在 Codex 会话中提交剧本，指定 `project_id` 和目标模型，
   `$script2shot` 默认按顺序跑完三个阶段。

具体命令以插件实现后的文档为准。

## 文档

- [架构设计](docs/architecture.md)：总体架构、知识卡与同步状态模型、检索和生成流程。
- [阶段约定](references/stage-conventions.md)：阶段交接、检索配方和知识引用聚合规则。
- [知识库 A 内容说明](docs/knowledge-base-a.md)：飞书知识库 A 应包含的目录、文档和内容。
- [知识库 B 内容说明](docs/knowledge-base-b.md)：飞书知识库 B 应包含的表、字段和内容。
- [设计复盘最小修正清单](docs/design-remediation-2026-10-20.md)：本轮设计收敛项。

## 路线图

1. Phase 1：插件骨架、`setup`、`health`、飞书连接。
2. Phase 2：知识库 B 建表、增量同步、`knowledge-sync`。
3. Phase 3：本地缓存、SQLite 关键词索引和规则排序。
4. Phase 4：阶段技能与提示词生成。
   - 4a：`script-breakdown` 与 `script_analysis` schema。
   - 4b：`shot-planning` 与 `shot_plan` schema。
   - 4c：`shot-prompting`、PromptIR、Seedance 规则文件和渲染。
   - 4d：`script2shot` 入口编排、续跑和输出聚合。
5. Phase 5（可选）：检索诊断 `explain` 输出和 `knowledge-inspect` 诊断技能。
