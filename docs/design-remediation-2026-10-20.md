# 设计复盘最小修正清单（2026-10-20）

状态：Applied
依据：`docs/design-review-2026-10-20.md`

本清单只处理会影响第一版设计落地的问题。原则是保留“原始库与 AI 库分离、
文件阶段交接、本地确定性 MCP、Skill 负责归纳与创作”的简单架构，不引入
服务端、并发锁、事务队列、审核流程或第一版不需要的检索基础设施。

## 1. 收敛同步判定与失败恢复

- 增量扫描只比较 Wiki 节点元数据和 `obj_edit_time`，以及路径、标题、父节点变化。
- `source_revision` 在读取文档正文后获得，用于来源追踪和本地缓存刷新。
- 删除 `content_hash`。第一版不使用内容哈希参与同步或缓存判定。
- `replace_doc_cards` 保持为一个确定性工具：输入是 Skill 已生成的新卡；
  内部按“记录旧卡 record_id -> 写入新卡 -> 删除旧 record_id”执行。
- 卡片替换或 SyncState 更新失败时都不更新 SyncState，使当前文档在下一次同步
  自然重试。不增加事务系统、补偿队列或并发锁。

解决：R-01、R-02、R-03、R-04、R-17。

## 2. 定义 AI 库不可达与批量确认

- AI 库不可达时，已有本地缓存则继续运行并写入 warning；没有缓存则停止。
- 同步写入前生成一份整批 dry-run 清单，用户确认后一次执行整批。
- 不按文档逐条询问，也不引入后台任务或断点队列。

解决：R-05、R-22。

## 3. 让入口成为 knowledge_refs 的唯一写入者

- 三个阶段的引用记录放在各自主产物中：
  `script_analysis.json`、`shot_plan.json`、`prompts.ir.json`。
- `script2shot` 入口读取三个阶段产物并生成唯一的 `knowledge_refs.json`。
- 第一版只记录 `used` 和 `dropped_by_budget`，不记录
  `retrieved_not_used`。

解决：R-06、R-19、R-27。

## 4. 第一版删除向量检索

- 本地索引只使用 SQLite 关键词检索、字段过滤和 `priority` 排序。
- 删除嵌入模型、向量索引、混合评分权重和模型重排相关协议。
- 检索不可用时回退到按 `priority` 排序，并写入 warning。

解决：R-12、R-26。

## 5. 固化模型与阶段检索契约

- 一次 run 只接受一个 `target_model`，只生成
  `prompts.<model>.md`。
- `script-breakdown` 开场加载一次 `shot_breakdown` 通用方法论，不按
  `target_model` 过滤；角色和场景按其查询配方检索。
- `shot-planning` 和 `shot-prompting` 按目标模型过滤。

解决：R-07、R-08、R-09。

## 6. 明确 Skill 是流程说明而不是 CLI

- `script2shot`、`knowledge-sync` 等是 Codex Skill。用户通过
  `$skill-name` 或自然语言触发，不把 `--from`、`--only` 等写成真实
  可执行命令。
- `script2shot` Skill 明确要求按顺序读取并执行三个阶段的 `SKILL.md`，
  阶段之间只通过文件交接。
- 续跑参数作为用户请求中的明确字段传入，并由 `run.json` 恢复上下文。

解决：R-20。

## 7. 固化运行输入契约

- 新 run 必须显式提供 `project_id` 和 `target_model`；续跑从
  `run.json` 读取。
- 第一版提示词正文统一使用中文，结构化枚举和字段标识保持英文。
- 多集输入可以在一个 run 中识别集边界，但不做自动拆分和硬性镜头上限；
  入口在 warnings 中建议按集运行以便控制会话长度。
- 删除未定义用途的 `.script2shot/project.json`。

解决：R-15、R-16、R-21。

## 8. 固化 Base 表初始化与字段映射

- `setup` 负责创建或校验 `KnowledgeCards` 和 `SyncState`，写操作前先
  dry-run 并确认。
- 固定表名在初始化时解析成 `table_id`，随后写入本地配置。
- 第一版把 `tags`、`entities`、`target_models` 作为 JSON 文本数组存储，
  由本地索引解析；其余字段使用普通的文本、数字和时间类型。
- `card_id` 只要求表内唯一，不承诺跨文档重同步保持稳定。

解决：R-13、R-14、R-18。

## 9. 收敛插件清单、规则来源与权限说明

- 使用根目录 `plugin.json` 作为唯一主清单，删除
  `.codex-plugin/plugin.json` 的重复规划。
- Seedance 规则文件必须包含 `source` 和 `checked_at`。
- 保留“插件不做项目权限隔离”的既有约束，并明确由飞书 Base 权限或
  按项目拆 Base 承担隔离责任。

解决：R-10、R-28、R-29。

## 10. 补最小验证与文档权威边界

- 实现阶段至少验证：schema fixture、同一文档同步重跑幂等、
  分类与项目过滤、提示词渲染快照。
- `setup` 只做一次 `lark-cli` 版本与能力自检，不把 R-30 当作当前设计阻塞。
  `wiki +node-list`、`docs +fetch` 和 Base 批量记录操作已经由当前
  `lark-cli 1.0.98` 的本地 schema 核对。
- 以 `docs/architecture.md` 为设计权威源；原始库与 AI 库的内容说明文档只保留内容说明，
  README 只做概览，不再复制完整字段和算法。
- README 流程图把本地索引刷新画在 `script2shot` 内部，不表现为独立系统步骤。

解决：R-23、R-24、R-25、R-30、R-31。

## 本轮不处理

- R-11：MCP Server 技术栈需要在 Phase 1 实现前单独决定，不能替用户预设。
- 完整测试系统、向量检索、三态知识账本、项目级权限系统：
  不进入第一版。
