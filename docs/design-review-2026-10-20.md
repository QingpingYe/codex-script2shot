# 设计复盘报告（2026-10-20）

状态：Superseded
后续处理：[最小修正清单](design-remediation-2026-10-20.md)
复盘对象版本：2026-10-20（本仓库初始设计文档集）
复盘范围：AGENTS.md、README.md、docs/architecture.md、docs/knowledge-base-raw.md、
docs/knowledge-base-ai.md、references/stage-conventions.md

问题编号 R-01 到 R-31 供后续修复讨论直接引用。位置引用以章节号为准；行号会随
文档修改漂移，不作为长期引用依据。

## 1. 复盘范围与方法

- 仓库当前只有文档，没有代码、schema 和规则文件实现，本复盘只针对设计本身。
- 方法：逐份通读，跨文档交叉比对阶段契约、检索契约、同步流程和输出清单，并
  逐条核对 AGENTS.md 的工作约定。
- 外部事实（lark-cli 能力、飞书 API 行为、Seedance 模型规格）未联网核实，相关
  不确定性集中在 R-30。
- 本报告只记录问题与影响，不直接修改设计文档；修复应按 AGENTS.md 约定另行评审
  后先改文档再改实现。

## 2. 总体结论

架构方向成立：原始库与 AI 库职责分离、剧本不进知识库、三阶段文件产物交接、
确定性操作下沉 MCP Server 的骨架没有原则性问题。问题集中在三层：

1. 同步链路的可靠性假设不成立。设计把 AI 库定位为唯一同步事实来源，但单文档
   同步是多步非原子写入，没有故障中间态的恢复策略（R-01、R-02），增量判定依据在
   文档内部就不自洽（R-04）。AI 库一旦进入不一致状态会静默自锁，无法自愈。
2. 阶段交接与输出契约存在文档间矛盾。knowledge_refs 归属、script-breakdown 的
   知识依赖、单双模型输出三处在实现时必须先裁决（R-06、R-07、R-09）。
3. 检索设计相对知识规模偏重，且前提条件（嵌入模型、评分权重）缺失（R-12、R-26）。
   第一版可以收敛为关键词检索加规则排序，向量检索降级为可选增强。

严重程度统计：P1 阻断性缺陷 5 项，P2 一致性问题 5 项，P3 欠定义 12 项，
P4 冗余 3 项，P5 过度设计 2 项，P6 风险与验证缺口 4 项，共 31 项。

## 3. 问题清单

### 3.1 P1 阻断性设计缺陷

#### R-01 同步先删后写，存在数据丢失窗口

- 位置：docs/architecture.md §6.3、§6.5
- 问题：单文档同步顺序为「读正文 → AI 生成新卡 → 删除旧卡 → 写入新卡 → 更新
  SyncState」。删除与写入是两次独立的外部写操作，若写入失败，旧卡已删而
  SyncState 仍是旧的已同步状态。下次同步时 obj_edit_time 未变，文档被判定为
  未变化直接跳过。
- 影响：该文档的知识卡永久缺失，只能靠人工使用 --doc 强制同步补救。§6.5 的失败
  处理只覆盖「不更新 SyncState」，没有覆盖删除后写入失败的中间态。

#### R-02 SyncState 更新失败导致本地缓存静默过期

- 位置：docs/architecture.md §6.3、§7.4
- 问题：若新卡写入成功但 SyncState 更新失败，AI 库中是新卡、SyncState 中是旧值。
  本地缓存刷新以 SyncState 的 last_synced_at 和 content_hash 为判断依据，会永远
  认为该文档没有变化。
- 影响：检索继续使用过期知识卡，且没有任何告警路径。与 R-01 同源，根因是多步
  写入缺少原子性保障和中间态标记。

#### R-03 replace_doc_cards 的职责定义与 MCP 定位矛盾

- 位置：docs/architecture.md §8
- 问题：MCP Server 被定义为只做确定性操作、LLM 归纳放在 Skill，但
  replace_doc_cards 被定义为「删除并重建一个来源文档对应的知识卡」。重建知识卡
  需要 AI 归纳，MCP 无法独立完成。
- 影响：工具边界和 Skill/MCP 分工在关键写路径上断裂，实现时会产生职责歧义。
  该工具应拆为删除与写入两个确定性工具，由 Skill 先完成归纳再分别调用。

#### R-04 增量判定的判定依据文档内部不自洽

- 位置：docs/architecture.md §2.5、§6.1、§6.2、§6.4
- 问题：§2.5 声称比较 obj_edit_time、source_revision、content_hash 三个值，但
  source_revision 和 content_hash 都必须读取正文才能获得，与「未变化文档不读
  正文」直接冲突；§6.2 实际只用 obj_edit_time 判定修改；§6.4 又承认
  obj_edit_time 可能因时间精度不可靠。source_revision 与 content_hash 在增量
  判定中的真实角色从未定义。
- 影响：漏同步是静默失败，与「SyncState 是唯一事实来源」的定位不符。增量判定
  语义必须在实现前收敛为一张明确的判定表。

#### R-05 AI 库不可达时主流程行为未定义

- 位置：docs/architecture.md §9.3、§11.2、§13
- 问题：script2shot 每次运行都要先读 AI 库的 SyncState 刷新本地索引，但 §13 失败
  处理表没有「AI 库无法访问」条目，既没有降级路径（用本地缓存继续并写 warnings），
  也没有明确禁止运行。
- 影响：飞书抖动即阻塞主流程，且行为未定义会导致各阶段实现各自发挥。

### 3.2 P2 一致性问题

#### R-06 knowledge_refs.json 的写入者三处说法不一致

- 位置：docs/architecture.md §9.4、§9.6；references/stage-conventions.md §4
- 问题：stage-conventions 说 knowledge_refs.json 由入口聚合、各阶段只写自己的
  块；architecture §9.6 把它列为 shot-prompting 的输出；architecture §9.4 的
  script-breakdown 输出清单没有它，但 stage-conventions 的示例包含
  script_breakdown 块。
- 影响：文件创建者、script-breakdown 是否参与写入两个实现必答题没有答案，
  三阶段写同一文件的协议无法落地。

#### R-07 script-breakdown 的知识依赖与检索配方矛盾

- 位置：docs/architecture.md §9.4；references/stage-conventions.md §3.2
- 问题：architecture 说 script-breakdown 依赖通用知识「剧本解析」（对应
  shot_breakdown 分类），但 stage-conventions 的 script-breakdown 查询配方允许
  分类不含 shot_breakdown。「依赖」是检索语义还是方法论语义，两个文档没有
  同一答案。
- 影响：script-breakdown 的检索行为在实现时无法确定。若「依赖」仅指方法论，
  则该知识不应通过知识卡进入检索路径，需要明确写清。

#### R-08 target_model 过滤的例外没有回写架构文档

- 位置：docs/architecture.md §10.1；references/stage-conventions.md §3.1
- 问题：stage-conventions 给 script-breakdown 开了不按 target_model 过滤的例外，
  而 architecture 把过滤顺序写成无条件固定管线。
- 影响：只读架构文档会得出错误实现；例外应显式标注在 §10.1。

#### R-09 一次 run 生成单模型还是双模型提示词，前后矛盾

- 位置：docs/architecture.md §9.6、§11.3、§11.5；README.md「主要能力」
- 问题：PromptIR 的 target_model 是单值，§9.6 说渲染目标模型提示词，但 README 与
  architecture §11.5 的输出目录固定列出 2.0 和 2.5 两份提示词文件。
- 影响：若只生成目标模型，输出清单误导；若双模型都生成，与「目标模型」语义和
  PromptIR 结构矛盾，且渲染成本翻倍。需要裁决。

#### R-10 根目录与 .codex-plugin 下两个 plugin.json 未解释

- 位置：docs/architecture.md §7.1
- 问题：插件目录树同时列出 plugin.json 和 .codex-plugin/plugin.json，无任何说明。
- 影响：两者哪个生效、各自承载什么不明确，插件打包时会出错或产生重复维护。

### 3.3 P3 欠定义

#### R-11 MCP Server 技术栈未决定

- 位置：docs/architecture.md §7.1
- 问题：目录树有 server/src 与 server/dist，暗示编译型语言，但语言、构建工具、
  运行方式全文未提。
- 影响：违反 AGENTS「技术栈决定后写进设计文档」；进入 Phase 1 前必须先决定并
  写入文档。

#### R-12 向量检索的前提条件全部缺失

- 位置：docs/architecture.md §10.2、§7.2
- 问题：vectors.bin 依赖嵌入模型，但用什么模型、本地还是 API、维度与成本未提；
  评分公式 w1-w4 无取值、无归一化定义；entity_match 的实体抽取由谁完成未定义。
- 影响：§10.2 目前是占位符，无法据此实现；结合 R-26 应重新评估向量检索是否
  进入第一版。

#### R-13 知识卡 JSON 模型到飞书 Base 字段的映射未定义

- 位置：docs/architecture.md §5.1、§5.2
- 问题：知识卡含数组字段（tags、entities、target_models），写入 Base 时字段
  类型映射、数组序列化方式、knowledge_card.schema.json 与 Base 字段的对应关系
  均未说明；table_id 写配置还是运行时按表名解析，文档两说并存等于未决定。
- 影响：Phase 2 建表时字段设计无依据，映射返工成本高。

#### R-14 AI 库两张表的创建归属未定义

- 位置：docs/architecture.md §14 Phase 2；§9.1、§9.2
- 问题：Phase 2 提到「建立 KnowledgeCards 和 SyncState」，但 setup 与
  knowledge-sync 的职责清单都不含建表；是手动建、setup 建、还是同步首跑自动建
  没有归属。
- 影响：自动建表触发写操作确认流程，手动建表则字段约定依赖人，需要明确写进
  某个 Skill 的职责。

#### R-15 project_id 的解析来源未定义

- 位置：docs/architecture.md §9.3、§7.2
- 问题：入口要「锁定 project_id」，但来源（用户输入、配置、还是
  .script2shot/project.json）未定；project.json 只在目录树出现过一次，内容、
  格式与写入者全文未解释。
- 影响：多项目场景下入口行为不确定；project.json 应补充定义或删除。

#### R-16 提示词输出语言未定义

- 位置：docs/architecture.md §11.3
- 问题：PromptIR 示例字段值中英文混杂，Seedance 提示词最终用中文还是英文、对白
  如何处理、knowledge-base-raw.md 提到的多语言台词如何落字段，均无约定。
- 影响：直接影响渲染模板设计与 seedance_rule 卡的内容组织，Phase 4c 前必须定。

#### R-17 content_hash 的计算口径未定义

- 位置：docs/architecture.md §6.1
- 问题：对什么内容做哈希（纯文本、块 JSON、规范化规则）未定义。
- 影响：口径不稳定会导致误判变化或漏判，且历史数据无法重新计算对齐。

#### R-18 card_id 序号的稳定性规则缺失

- 位置：docs/architecture.md §5.2
- 问题：card_id 形如 src:<doc_token>:<category>:001，序号来源未定义；若来自
  AI 生成顺序，重同步后 ID 漂移。
- 影响：knowledge_refs 与本地索引对 ID 稳定有隐含依赖；应明确基于
  source_block_id 或内容哈希等稳定量生成。

#### R-19 knowledge_refs 的 usage 三态判定机制未定义

- 位置：references/stage-conventions.md §4
- 问题：used 与 retrieved_not_used 由谁判定未写明；若靠 LLM 自报，账本可信度
  存疑。
- 影响：排查账本的可信度取决于判定机制，需要明确是自报还是从产物反推。

#### R-20 Skill「按顺序调用」的机制未定义

- 位置：docs/architecture.md §9.3
- 问题：Codex Skill 是指令文档不是可编程函数，「入口按顺序调用三个阶段」实际
  是同一会话内加载多份 SKILL.md 顺序执行；会话上下文长度约束、阶段失败后入口
  如何续跑、--from 如何携带 run_id 均未写。
- 影响：编排可行性依赖这套机制约束，是 Phase 4d 的前提，必须先写清楚。

#### R-21 多集输入无规模策略

- 位置：docs/architecture.md §11.1
- 问题：支持 multiple_episodes，但单 run 镜头数上限、是否按集拆 run、产物文件
  过大如何处理均未定义。
- 影响：多集输入可能生成超长产物与超长会话，失败恢复成本高；至少应给出建议
  上限或自动按集拆分的策略。

#### R-22 写操作 dry-run 的确认粒度未定义

- 位置：docs/architecture.md §8
- 问题：写操作默认先 dry-run、用户确认后执行，但一次全量同步可能涉及几十个
  文档的删除与写入，逐条确认不现实。
- 影响：确认粒度（按文档、按批次、按整次同步）必须先定，否则同步 UX 无法设计。

### 3.4 P4 冗余

#### R-23 knowledge-base-ai.md 与 architecture.md 大段重复

- 位置：docs/knowledge-base-ai.md §1-§3；docs/architecture.md §5
- 问题：AI 库的定位、物理形态与分类表几乎逐句重复，无权威源标注。
- 影响：两处维护必然漂移；应让 knowledge-base-ai.md 只保留内容要求，结构与字段
  只引用 architecture。

#### R-24 原始库与 README 重复承载同一事实，无权威源标注

- 位置：docs/knowledge-base-raw.md §2；README.md
- 问题：目录结构与推导规则在 knowledge-base-raw.md 重复 architecture；README 重复
  流程与输出清单。
- 影响：同一事实三处承载；应标注每类信息的唯一权威文档，其余只做摘要加引用。

#### R-25 README 流程图把「刷新本地索引」画成独立步骤

- 位置：README.md「工作原理」
- 问题：图中刷新本地索引位于 AI 库与 script2shot 之间，实际是 script2shot
  的内部动作。
- 影响：图与文不一致，读者会误解为存在独立刷新步骤或入口。

### 3.5 P5 过度设计

#### R-26 向量检索不应进入第一版主路径

- 位置：docs/architecture.md §10.2、§14 Phase 3
- 问题：原始库起步为最小集合，知识卡规模预计在几十到几百张，SQLite 关键词
  检索加 priority 排序已够用；向量检索引入嵌入模型依赖与索引维护成本，只有
  「模型重排」被标为可选，向量索引本体仍在主路径。
- 影响：第一版复杂度不必要地抬高；建议把向量检索与嵌入依赖整体降为可选增强，
  与 Phase 5 explain 同级。

#### R-27 knowledge_refs usage 三态账本收益成本比偏低

- 位置：references/stage-conventions.md §4
- 问题：三态账本引入入口聚合、各阶段分块写、重跑替换的协作协议与 LLM 自报
  问题（R-19），对第一版是纯调试功能。
- 影响：建议第一版只记录 used 与 dropped_by_budget，retrieved_not_used 与完整
  账本协议延后到有真实排查需求时再加。

### 3.6 P6 风险与验证缺口

#### R-28 多项目知识无权限隔离

- 位置：docs/architecture.md §10.1、§12
- 问题：所有项目的角色圣经等知识共存在一个共享 Base，飞书层面人人可读，检索只
  靠 project_id 过滤；设计已声明不做权限控制。
- 影响：若项目分属不同团队或客户，存在数据暴露风险。设计接受了该约束，但应向
  用户明示缓解手段（如 Base 权限分组或按项目拆 Base）。

#### R-29 模型规则文件缺来源与日期元数据

- 位置：docs/architecture.md §11.4
- 问题：rules/models/seedance-*.json 是硬约束权威来源，但设计未要求其包含来源
  与检索日期，也未定义模型规格变化时的更新验证流程。
- 影响：与 AGENTS 外部事实可追溯要求不符；规则文件应内含 source 与 checked_at
  字段。

#### R-30 lark-cli 能力假设未经核实

- 位置：docs/architecture.md §6.1
- 问题：设计假设 wiki +node-list 返回 obj_edit_time、parent_node_token 等字段，
  Base 支持按字段过滤后批量删除；这些是外部事实，无来源标注。
- 影响：若 CLI 缺任一字段或接口，增量同步的核心判定不成立；Phase 1 应先做能力
  验证清单并记录来源与日期。

#### R-31 没有任何测试策略

- 位置：全部设计文档
- 问题：AGENTS 要求受影响范围补最小测试，但设计文档没有测试计划；Phase 4 把
  script_analysis 与 shot_plan schema 定为冻结接口，却没有配套验证手段。
- 影响：冻结接口无验证是空的；应在设计文档中补充 schema fixture、同步幂等性、
  检索回归、渲染快照的最低验证清单。

## 4. 修复优先级建议

### 4.1 动手写代码前必须解决

- R-01、R-02、R-03、R-04：同步写入顺序改为「生成新卡 → 写入新卡 → 删除旧卡 →
  更新 SyncState」或引入等价的中间态标记；重定义 MCP 写工具边界；收敛增量判定表。
- R-05：定义 AI 库不可达时的降级路径或明确禁止。
- R-06、R-09：裁决 knowledge_refs 写入协议与单双模型输出语义。
- R-11、R-20：决定 MCP 技术栈，写清 Skill 编排机制。

### 4.2 进入对应 Phase 前解决

- Phase 1：R-14（建表归属可提前到 setup）、R-30（lark-cli 能力验证清单）、
  R-31（最低测试清单）。
- Phase 2：R-13、R-17、R-18、R-22。
- Phase 4：R-15、R-16、R-21。

### 4.3 建议降级或延后

- R-12、R-26：向量检索连同嵌入依赖整体降为可选增强，第一版检索收敛为关键词
  加规则排序。
- R-19、R-27：usage 三态账本降级为 used 与 dropped_by_budget 两态，完整协议
  延后。
- R-28：在架构文档补一段数据隔离风险说明与缓解建议，不做权限功能。

### 4.4 文档修正

- R-07、R-08、R-10、R-23、R-24、R-25、R-29：按单项修正文档。其中 R-23、R-24
  涉及去重和权威源标注，建议与内容修正一次完成。

## 5. 复盘局限

- 本复盘未联网核实 lark-cli 实际能力、飞书 API 行为与 Seedance 模型规格，
  R-30 的验证是下一步前置工作。
- 未评估知识归纳质量与提示词生成质量——这两者依赖实现后的真实样本，属于
  Phase 4 之后的复盘范围。
- 行号为复盘当日快照，后续修复请以章节号定位。
