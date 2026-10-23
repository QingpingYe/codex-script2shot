# 阶段约定

状态：Draft
日期：2026-10-20
最近修订：2026-10-20（收敛引用聚合、模型过滤和关键词检索）

本文件是 `script2shot` 入口和三个创作阶段共同遵守的约定。各 Skill 引用本文件，不复制内容。

冲突时以 `docs/architecture.md` 为准；本文件只写落地细节，不重新定义架构。

## 1. 阶段 key 与产物

| 阶段 key | Skill | 产物 |
| --- | --- | --- |
| `script_breakdown` | `script-breakdown` | `script_analysis.json`（含本阶段引用） |
| `shot_planning` | `shot-planning` | `shot_plan.json`（含本阶段引用） |
| `shot_prompting` | `shot-prompting` | `prompts.ir.json`（含按镜头引用）、`prompts.<model>.md` |

运行目录为 `.script2shot/outputs/<run_id>/`，`run_id` 格式为 `run-YYYYMMDD-HHMMSS`。

产物文件名不可更改、不可合并、不可省略。时间统一用带时区的 ISO 8601。
`knowledge_refs.json` 是入口在三个阶段完成后生成的聚合产物，阶段 Skill
不直接写入该文件。

## 2. 阶段交接

- 阶段只读上游产物、适用知识包和模型规则，不依赖会话上下文。
- 运行阶段前必须用 `validate_stage_artifact` 校验上游产物。
- 上游产物被人工修改后，必须重新校验再运行下游阶段。
- 阶段失败时不更新 `run.json` 中该阶段的状态，保留已完成的中间产物。

## 3. 检索契约

### 3.1 通用规则

过滤顺序固定为 `scope -> project_id -> category -> target_model -> 关键词检索 -> priority 排序`。

- `target_model` 过滤放行两类卡片：`target_models` 含当前模型的卡，以及 `target_models` 为空的通用卡。
- `script-breakdown` 不按 `target_model` 过滤，其余阶段必须按目标模型过滤。
- 候选数量取 `retrieval.default_top_k`（默认 12），再按命中级别和 `priority` 排序。
- 关键词索引不可用时按 `priority` 降序取候选，并写入 warnings。

### 3.2 script-breakdown 查询配方

开场方法论：加载一次 `shot_breakdown` 分类的通用 `剧本解析` 卡，不按
目标模型过滤。

实体粒度：输入中每个角色或场景首次出现时检索一次。

- 查询来源：角色名或场景名，加上原文中的动作、地点和服装描述。
- 允许分类：`character_bible`、`scene_description`、`visual_style`、`project_rule`。
- 用途：补全跨集稳定设定，写入 `script_analysis.json` 的连续性字段。
- 边界：不得用检索结果补写原文没有的剧情、关系和事件。

### 3.3 shot-planning 查询配方

粒度：每个场景一次，场景内每个镜头组可追加一次。

- 查询来源：场景目标、情绪弧、出场角色、地点、时间和镜头组建议。
- 允许分类：`shot_breakdown`、`storyboard`、`camera_lexicon`、`character_bible`、`scene_description`、`visual_style`、`seedance_rule`。
- 用途：确定景别、机位、运镜、时长和组接，并补齐空间与风格一致性。
- 边界：只取用于镜头决策的知识，不取提示词写作技巧。

### 3.4 shot-prompting 查询配方

粒度：每个镜头一次；需要连续性时可带上相邻镜头的关键状态。

- 查询来源：镜头的 `subject`、`action`、`setting`、情绪、光线方向和目标模型。
- 允许分类：`prompt_technique`、`seedance_rule`、`example`、`camera_lexicon`、`character_bible`、`scene_description`、`visual_style`。
- 用途：写 PromptIR 和渲染提示词，并保持角色与场景一致。
- 必须按 `target_model` 过滤。

### 3.5 结果精简与上下文上限

- 进入生成上下文：`shot-planning` 每个场景不超过 8 张卡，`shot-prompting` 每个镜头不超过 6 张卡。
- 单镜头上下文文本预算不超过 4000 字符，不含来源标注。
- `character_bible`、`scene_description`、`visual_style` 保持正文原文，不压缩。
- `prompt_technique`、`example`、`seedance_rule` 可以压缩为要点使用，不逐字复制。
- 超出预算时按排序结果从低到高截断，被截断的卡以
  `dropped_by_budget` 记入所属阶段产物。

## 4. knowledge_refs 追加与聚合

各阶段把本阶段引用写进自己的主产物。入口读取
`script_analysis.json`、`shot_plan.json` 和 `prompts.ir.json` 后，生成唯一的
`knowledge_refs.json`。

```json
{
  "run_id": "run-20261020-120000",
  "stages": {
    "script_breakdown": [
      {
        "card_id": "src:doc-token:character_bible:001",
        "scene_id": "ep01-sc01",
        "shot_id": null,
        "query": "角色A 外观 服装",
        "usage": "used",
        "source_doc_token": "doc-token",
        "source_path": "项目知识/demo/角色圣经/角色A",
        "source_revision": 12,
        "last_synced_at": "2026-10-20T12:00:00+08:00"
      }
    ],
    "shot_planning": [],
    "shot_prompting": []
  }
}
```

`script_analysis.json` 和 `shot_plan.json` 使用顶层 `knowledge_refs` 数组，
条目结构同上，不包含 `run_id` 和 `stages` 外层。`prompts.ir.json` 在每个镜头
对象内保存 `knowledge_refs`，入口把全部镜头条目展平后放入最终总账。

`usage` 取值：

| 取值 | 含义 |
| --- | --- |
| `used` | 写进了本阶段产物，或直接影响了本阶段决策 |
| `dropped_by_budget` | 命中且排序通过，但被上下文预算截断 |

写入规则：

- 阶段 Skill 只写本阶段主产物中的 `knowledge_refs`，不创建或修改运行目录的
  总账文件。
- 入口在阶段完成或重跑后重新生成总账，同一阶段重跑时整体替换该阶段数组。
- 同一张卡在不同阶段出现时分别保留，不做跨阶段合并。
- 阶段产物内部自带的局部引用（例如 `script_analysis.json` 的连续性字段）保留原样，`knowledge_refs.json` 是唯一总账。
- `used` 表示引用直接影响了本阶段产物或决策；进入候选但未采用的卡不记录。

## 5. 诊断输出

`search_knowledge` 和 `load_knowledge_pack` 的 `explain` 输出约定见
`docs/architecture.md` 第 10 章。第一版不返回向量或重排诊断。

`explain` 只返回给调用方，不写入运行产物，也不新增输出文件。
