# 提示词工艺知识卡草稿（2026-10-22）

状态：草稿（待录入原始库，未同步）
日期：2026-10-22
任务：技能迭代 v2 · I3.2 / Task C1 Step 1
范围：本文件只承载 7 张卡片草稿。录入原始库、`$knowledge-sync`、`refresh_local_index`
与检索验证属 Task C1 Step 2–5，由用户执行；本草稿不代表任何已完成的同步。

## 1. 来源与引用约定

- 工艺来源（外部）：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`
  （检索日期 2026-10-22）。本草稿只吸收其方法论，按本项目口径改写，不逐字搬运技能文本。
- 交叉引用（本地 AI 库现有卡片，只读核对，检索日期 2026-10-22）：

| 卡片 id | 标题 | 原始库路径 | `source_revision` |
| --- | --- | --- | --- |
| `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011` | Seedance 2.0 与 2.5 的提示词维度差异对照 | `通用知识/视频生成模型说明` | 43 |
| `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:009` | 官方约束词写法与使用限制 | `通用知识/视频生成模型说明` | 43 |
| `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:004` | 镜头连续性与时间表达 | `通用知识/视频生成模型说明` | 43 |
| `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:prompt_technique:008` | 把负向要求写成约束短句 | `通用知识/视频生成模型说明` | 43 |
| `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:003` | 进阶公式：按空间层与时间层组织提示词 | `通用知识/Seedance 2.0 提示词指南` | 5 |
| `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:007` | 情绪具象外化：可直接写入提示词的身体细节 | `通用知识/Seedance 2.0 提示词指南` | 5 |
| `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:013` | 语言与特殊字符规范 | `通用知识/Seedance 2.0 提示词指南` | 5 |
| `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007` | 声音与文字的特殊字符约定 | `通用知识/Seedance 2.5 提示词指南` | 39 |
| `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:008` | 台词语言与地区口音的强化公式 | `通用知识/Seedance 2.5 提示词指南` | 39 |
| `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:010` | 30 秒长视频：用阶段与结束状态组织事件 | `通用知识/Seedance 2.5 提示词指南` | 39 |
| `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:020` | 情绪方向与可观察表现的写法 | `通用知识/Seedance 2.5 提示词指南` | 39 |
| `src:YcFddglYToIItoxnK3mcXXctnJb:seedance_rule:011` | 时间戳与节奏控制规则 | `通用知识/Seedance 2.5 提示词指南` | 39 |
| `src:UqiqdDC49oPIL3xzRQ2cgEk3nKc:camera_lexicon:007` | 构图方法词典 | `通用知识/镜头语言` | 13 |

- 卡片字段口径（`skills/knowledge-sync/references/card-authoring.md`）：一张卡只讲一件事；
  内容必须可执行、可转译成画面；`category` 按「原始库目录 → 分类」映射取一个值；
  `target_models` 只填 `seedance-2.0` 与 `seedance-2.5` 两个模型标识，通用知识用空数组；
  来源与检索日期写进 `content`。

## 2. 卡片清单与建议落点

| # | title | `category` | `target_models` | 建议录入文档 |
| --- | --- | --- | --- | --- |
| 1 | 台词语法与语言规则（Seedance 2.0） | `prompt_technique` | `["seedance-2.0"]` | `通用知识/提示词技巧/台词与语言规则` |
| 2 | 台词语法与语言规则（Seedance 2.5） | `prompt_technique` | `["seedance-2.5"]` | `通用知识/提示词技巧/台词与语言规则`（与卡片 1 同文档） |
| 3 | 情绪可观察化：把情绪词改写成可见表现 | `prompt_technique` | `[]` | `通用知识/提示词技巧/情绪可观察化` |
| 4 | 事件脚本与 30 秒阶段化（Seedance 2.5） | `prompt_technique` | `["seedance-2.5"]` | `通用知识/提示词技巧/事件脚本与阶段化` |
| 5 | 声音符号与保留 / 不采用写法（Seedance 2.5） | `prompt_technique` | `["seedance-2.5"]` | `通用知识/提示词技巧/声音符号与声音控制` |
| 6 | 负面约束策略：只写有依据的限制 | `seedance_rule` | `[]` | `通用知识/Seedance/负面约束词与使用限制` |
| 7 | 空间与站位描述：可核对的主体位置关系 | `prompt_technique` | `[]` | `通用知识/提示词技巧/空间与站位描述` |

建议口径：6 个原始文档、合计 7 张卡（卡片 1 与 2 同文档）。落点与文档拆分由录入者在
Step 2 裁决；每个原始库文档是一个同步单元，同步时该文档的卡片整体替换，Step 5 的
「N 个文档 / X 张卡」断言按最终拆分核对。

## 3. 卡片 1：台词语法与语言规则（Seedance 2.0）

- title：台词语法与语言规则（Seedance 2.0）
- category：`prompt_technique`
- target_models：`["seedance-2.0"]`
- tags：`["台词", "语言规范", "特殊字符", "Seedance 2.0"]`
- content：

台词统一用 `{}` 包裹，括号内只放要说出口的原文，不混入语气、动作或镜头说明，
例如 `{你终究还是来了}`。

- 同一段提示词内的台词语种保持统一：以中文或英语为主，避免中英文混用；人名、品牌、
  术语等专有名词保留原写法。
- 台词为小语种（非中英文）时，在台词前标注语种，写成「语种 + 说话人 + `{}` 台词」的
  结构，例如「用日语说道{こんにちは}」。
- 多人对话逐句标明说话人，一句对应一个说话人，不写成没有主语的长引语。
- 同一套符号约定用于区分信息类型：音效 `<远处传来狗叫声>`、音乐 `(背景播放着快节奏的摇滚乐)`、
  字幕 `【第一章：启程】`；一个符号只承担一种职责，不重复嵌套。
- 落地检查：逐句核对括号形态、说话人与语种；发现中英文混用先统一语种，小语种缺标注
  就补标注。只补语言信息，不改写、不删改台词原文。

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:013`「语言与特殊字符规范」
（原始库 `通用知识/Seedance 2.0 提示词指南`，`source_revision=5`）、
`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011`「Seedance 2.0 与 2.5 的提示词维度差异对照」
（原始库 `通用知识/视频生成模型说明`，`source_revision=43`），检索日期 2026-10-22。

## 4. 卡片 2：台词语法与语言规则（Seedance 2.5）

- title：台词语法与语言规则（Seedance 2.5）
- category：`prompt_technique`
- target_models：`["seedance-2.5"]`
- tags：`["台词", "语言强化", "口音", "多人对话", "Seedance 2.5"]`
- content：

台词用 `{}` 包裹，并与 2.5 的声音符号体系配合使用：音乐 `()`、音效 `<>`、台词 `{}`、
字幕 `【】`。

- 台词语种以原文为准，不擅自翻译、改语种或混用中英文；多人对话逐句绑定说话人与语言，
  不只在段落开头统一声明。
- 台词不是中文时，在台词前明确语言；需要控制地区语言习惯时，用「台词语言 + 地区变体或
  口音 + 表达方式 + 说话人 + `{}` 台词」的完整结构，例如「女孩用自然、口语化的美式英语说：
  {I thought you weren't coming.}」。
- 用户没有指定语言、口音或表达方式时，只标注台词文本可直接判定的语种，不凭文字形态
  补「普通话」、方言或地区口音。
- 落地检查：英文台词容易被读成中文时，至少在台词前写明「使用英语」；逐句核对说话人、
  语种与括号形态，缺哪项补哪项。

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007`「声音与文字的特殊字符约定」、
`src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:008`「台词语言与地区口音的强化公式」
（原始库 `通用知识/Seedance 2.5 提示词指南`，`source_revision=39`）、
`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011`「Seedance 2.0 与 2.5 的提示词维度差异对照」
（原始库 `通用知识/视频生成模型说明`，`source_revision=43`），检索日期 2026-10-22。

## 5. 卡片 3：情绪可观察化

- title：情绪可观察化：把情绪词改写成可见表现
- category：`prompt_technique`
- target_models：`[]`
- tags：`["情绪", "可观察表现", "表演控制", "身体细节"]`
- content：

只写「紧张、温馨、压抑」这类情绪词，模型只能拿到方向，具体表演由模型自行发挥；要稳定
控制表演，把情绪改写成画面里能直接看到或听到的表现。

- 选择少量最清楚的表现：单次情绪转折选 2 至 4 个，从眼神、眉头、嘴角、呼吸、视线、
  手部动作、身体姿态里挑，不把全部微表情堆进一帧。
- 首选写法：情绪方向 + 触发事件 + 即时可观察反应 + 随后变化 + 最终可见状态。示例：
  同伴把一份未拆的信推到她面前（触发事件），她翻页的手停在半空、视线移到信封上
  （即时反应）；随后呼吸变浅、肩膀微收，最后抬手把信翻面扣在桌上（可见的结束状态）。
- 出现多次转折时才按触发事件分阶段描述，一个阶段对应一个触发事件，不把多个转折压进
  一句话。
- 落地检查：把情绪词删掉后画面信息仍然完整，说明已完成外化；只剩情绪词、看不出人物
  具体在做什么，就继续改写。
- 取材边界：只用素材或上游已有线索改写；没有依据时不替人物发明呼吸、姿态或触发事件，
  写不出来就留空。

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:007`「情绪具象外化：可直接写入
提示词的身体细节」（原始库 `通用知识/Seedance 2.0 提示词指南`，`source_revision=5`）、
`src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:020`「情绪方向与可观察表现的写法」
（原始库 `通用知识/Seedance 2.5 提示词指南`，`source_revision=39`），检索日期 2026-10-22。

## 6. 卡片 4：事件脚本与 30 秒阶段化（Seedance 2.5）

- title：事件脚本与 30 秒阶段化（Seedance 2.5）
- category：`prompt_technique`
- target_models：`["seedance-2.5"]`
- tags：`["事件脚本", "阶段化", "长镜头", "结束状态", "Seedance 2.5"]`
- content：

2.5 单段最长 30 秒，可以承载同一连续镜头内的多个连续节拍；事件多时不堆动作清单，
而是按时间顺序写成连续过程。

- 单镜头组织：开始时 → 随后 → 结束时。开始时写镜头进入时主体在做什么；随后写画面里
  可观察的变化过程；结束时写镜头结束瞬间主体与画面的可观察状态。
- 长镜头阶段化：把这段连续画面拆成连续阶段，每个阶段只写一个主要状态变化，并写清该
  阶段结束时画面中可见的状态，作为下一阶段的衔接依据；阶段之间是同一连续镜头的先后
  关系，不拆成多个镜头。
- 保持一致项：每个阶段都保持人物身份、数量、服装、道具归属、空间方向与声音关系稳定，
  不互相交换。
- 数字时间段只在素材或需求已给出时使用：时间区间要连续、不重叠；时间表达是事件的
  时间预算，不是帧级剪辑点；不要用时间戳控制动作频率。
- 边界：不为填满时长添加原文没有的动作、台词或事件；阶段化只改动作的组织方式，
  不改镜头决策。

示例（按阶段组织动作文本）：

```text
阶段一：开始时，她站在灶台前搅动锅里的汤；结束时，汤面冒出第一串气泡。
阶段二：随后，她伸手去够高处的碗；结束时，碗已经端在手中。
阶段三：随后，她转身把碗放到桌上；结束时，桌上的碗轻轻晃了一下，热气升起。
```

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:010`「30 秒长视频：用阶段与结束
状态组织事件」、`src:YcFddglYToIItoxnK3mcXXctnJb:seedance_rule:011`「时间戳与节奏控制规则」
（原始库 `通用知识/Seedance 2.5 提示词指南`，`source_revision=39`）、
`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011`「Seedance 2.0 与 2.5 的提示词维度差异对照」
（原始库 `通用知识/视频生成模型说明`，`source_revision=43`），检索日期 2026-10-22。

## 7. 卡片 5：声音符号与保留 / 不采用写法（Seedance 2.5）

- title：声音符号与保留 / 不采用写法（Seedance 2.5）
- category：`prompt_technique`
- target_models：`["seedance-2.5"]`
- tags：`["声音", "特殊字符", "声音控制", "保留与不采用", "Seedance 2.5"]`
- content：

用固定符号区分四类信息：音乐 `()`、音效 `<>`、台词 `{}`、字幕 `【】`，让模型准确判断
声音类型与归属。

- 控制声音时直接写明保留与不采用的类别，不靠暗示：「无背景音乐，只保留人物对白、
  环境声和动作音效。」「不要字幕。」「不要任何声音。」
- 画面内容优先正向描述，只有素材职责、编辑范围和容易被误带入的内容才写限制。
- 符号不兼职：已用 `<>` 标记音效时，主体名称用普通称谓书写，避免同一符号承担两种职责。
- 落地检查：每个声音条目都能指回具体来源（对白、环境声、动作音效或音乐）；没有来源的
  声音不写，宁缺勿造。

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007`「声音与文字的特殊字符约定」
（原始库 `通用知识/Seedance 2.5 提示词指南`，`source_revision=39`）；符号口径与 2.0 的
同名约定一致（`src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:013`「语言与特殊字符规范」，
`通用知识/Seedance 2.0 提示词指南`，`source_revision=5`），检索日期 2026-10-22。

## 8. 卡片 6：负面约束策略

- title：负面约束策略：只写有依据的限制
- category：`seedance_rule`
- target_models：`[]`
- tags：`["负面约束", "约束短句", "字幕", "Logo", "水印"]`
- content：

负面约束只约束画面内容，只写有依据的条目；用户或素材没有提出限制时留空，不自动添加
画质包、稳定包、水印、Logo、字幕、分身类约束。

- 每条条目都要能指回依据：用户要求、原文线索或检索卡片；说不出依据的条目删掉，不为
  「保险」兜底填充。
- 用正向短句表达希望看到的画面，再用清楚的约束短句排除不需要的元素；不另列冗长的
  负向词清单，也不写「完美」「高质量」「不要出错」这类无法执行的要求。
- 已核实的官方约束句式：避免字幕与文字写「保持无字幕」「避免生成任何文字或字幕」；
  避免 Logo 写「不要生成 Logo」；避免水印写「不要生成水印」。
- Seedance 2.5 的补充句式：负向控制字幕写「不额外加入对白字幕」「不要字幕」；负向控制
  音频写「无 bgm，只生成环境音和动作音」或「不要任何声音」。
- 画面瑕疵类约束按正向短语写（例如「画面流畅无卡顿」），不发明固定模板词。
- 使用限制：字幕无法 100% 避免，参考素材自带字幕时这类指令可能失效；需要绝对准确的
  字幕或文字，交给前期素材与后期处理实现。
- 负面条目不改写上游事实：不借负面约束删改台词原文，也不改镜头时长、景别、机位或运镜。

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:009`「官方约束词写法与使用限制」、
`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:prompt_technique:008`「把负向要求写成约束短句」
（原始库 `通用知识/视频生成模型说明`，`source_revision=43`），检索日期 2026-10-22。

## 9. 卡片 7：空间与站位描述

- title：空间与站位描述：可核对的主体位置关系
- category：`prompt_technique`
- target_models：`[]`
- tags：`["空间关系", "站位", "构图", "主体朝向", "连续性"]`
- content：

先交代画面里有什么、各主体在哪里，再交代事情如何随时间变化；空间信息写不清，画面无法
转译，后续镜头也无法衔接。

- 多主体镜头写清三件事：主体的画面方位与前后距离（谁在左、谁在右、谁在前、谁在后）、
  主体朝向（面向镜头、背对、侧身、望向何处）、关键道具的归属与位置（谁持有、放在哪张
  桌面上）。
- 用景别、机位与构图术语固定空间关系：需要纵深时写「前中后景分明」「前景遮挡」「引导线」；
  需要固定观察角度时写「过肩拍 A 看向 B」「从 A 左侧后方拍向 B」这类可复现的方位描述。
- 运镜写清围绕谁、从哪里开始、到哪里结束，例如「镜头从 A 的过肩构图缓慢横移到 B 的正面」；
  不写脱离主体的术语。
- 跨镜头连续性：相邻镜头重复关键空间与朝向信息（画面方位、主体朝向、道具位置），
  不假定下一段自动继承未写明的信息；需要换边时写明换边动作或镜头运动。
- 落地检查：按这段描述画一张俯视图，能把每个主体与关键道具落位，说明空间信息已可
  转译；落不了位的部分补写方位或朝向，不写「氛围感强」「构图高级」这类不可核对的说法。

来源：火山方舟技能源 `https://arkdocs.tos-cn-beijing.volces.com/skills/`（检索日期 2026-10-22）；
本地卡片 `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:003`「进阶公式：按空间层与时间层
组织提示词」（原始库 `通用知识/Seedance 2.0 提示词指南`，`source_revision=5`）、
`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:004`「镜头连续性与时间表达」
（原始库 `通用知识/视频生成模型说明`，`source_revision=43`）、
`src:UqiqdDC49oPIL3xzRQ2cgEk3nKc:camera_lexicon:007`「构图方法词典」
（原始库 `通用知识/镜头语言`，`source_revision=13`），检索日期 2026-10-22。
