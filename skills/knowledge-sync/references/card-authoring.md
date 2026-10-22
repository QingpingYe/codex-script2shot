# 知识卡生成参考

`$knowledge-sync` 生成知识卡时按本文件执行。知识卡写入 AI 库的 `KnowledgeCards`
表，字段定义以 `schemas/knowledge_card.schema.json` 为准。

## 分类映射

十类分类与原始库目录一一对应（目录说明见 `docs/knowledge-base-raw.md`）：

| 原始库目录 | 分类 `category` |
| --- | --- |
| 拆镜方法 | `shot_breakdown` |
| 镜头语言词典 | `camera_lexicon` |
| 镜头组与组接 | `storyboard` |
| 提示词结构 | `prompt_technique` |
| 正例反例 | `example` |
| Seedance | `seedance_rule` |
| 角色圣经 | `character_bible` |
| 场景说明 | `scene_description` |
| 视觉风格 | `visual_style` |
| 项目概述 / 项目术语 | `project_rule` |

一张卡只取一个分类；文档内容覆盖多个主题时，按主题拆成多张卡后分别归类。

## 生成规则

- 一张卡只讲一件事。
- 内容必须可执行、可转译成画面：写可拍的可见信息、可落地的做法和明确的判断标准，
  不写抽象评价或无法验证的描述。
- `card_id` 格式固定为 `src:<source_doc_token>:<category>:<三位序号>`，例如
  `src:doccnXXXX:shot_breakdown:001`；序号从 `001` 起连续编号，同一文档内不重复。
- `target_models` 只填两个模型标识：`seedance-2.0`、`seedance-2.5`；通用知识留空
  数组 `[]`。
- 来源字段必填：
  - `source_doc_token`：`fetch_knowledge_a_doc` 返回的 `doc_token`；
  - `source_revision`：`fetch_knowledge_a_doc` 返回的 `revision_id`；
  - `source_node_token`、`source_path`：扫描结果（指定文档模式取 SyncState 现有记录）；
  - `source_title`：本次 fetch 的 `title`，为空时按 `SKILL.md` 的标题回退链处理；
  - `updated_at`：生成时刻，带时区偏移的 ISO 8601。
- `scope`、`project_id` 与来源文档一致（取扫描结果或 SyncState 现有记录）。
- 其余字段（`title`、`content`、`tags`、`entities`、`priority`、`source_block_id`）
  按 schema 填写；`source_block_id` 固定为 `null`（markdown 正文不提供 block id）。

## 引用展开内容的写法（2026-10-22）

当来源文档只是「链接占位」、正文来自引用目标（飞书云文档或网页）时：

- 知识卡仍以该 Wiki 文档为同步单元：`source_doc_token`、`source_node_token`、
  `source_path`、`source_title`、`source_revision` 全部取 Wiki 文档本身的值。
- 卡片 `content` 里必须写明引用来源与检索日期，格式固定为：
  `来源：<飞书文档 token 或网页 URL>（检索日期 YYYY-MM-DD）。` 需要时再补引用标题。
- 引用内容里的外部事实同样按「来源 + 检索日期」标注，不把易变信息写成无出处的结论。
- 引用目标本身是 JS 渲染页面、只拿到 `needs_render` 时，先按 `SKILL.md` 的流程用
  会话内工具读取全文，再归纳；不要用空内容生成卡片。

