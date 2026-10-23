# script2shot live 演练记录（Task 4d-3 / Phase 4 出口）

- 状态：已完成（无交互会话演练，见「执行方式」）
- 日期：2026-10-22
- 分支：`yeqingping`
- 参与 Skill：`skills/script2shot/SKILL.md`、`skills/script-breakdown/SKILL.md`、
  `skills/shot-planning/SKILL.md`、`skills/shot-prompting/SKILL.md`
- 使用数据：默认 `SCRIPT2SHOT_HOME`（`~/.codex-script2shot`）里已构建的本地索引与 AI 库
  （只读）。本次演练没有修改原始库或 AI 库，没有执行 `refresh_local_index` 的写路径，
  没有推送。

## 1. 演练输入

| 项 | 值 |
| --- | --- |
| 剧本 | `.script2shot/drill-4d-3/sample-script.md`（演练用原创单集片段，2 场 3 个镜头组） |
| `input_mode` | `single_episode` |
| `project_id` | `wufu-linmen`（本地配置里唯一映射的项目根节点） |
| `target_model` | `seedance-2.5` |
| `aspect_ratio` | `16:9` |
| `workspace_root` | `.script2shot/drill-4d-3/workspace`（gitignored） |
| 运行目录 | `<workspace_root>/.script2shot/outputs/run-20261022-152310/` |
| 阶段剧本 | 第 12 集：`ep12-sc01` 外景 寝宫门外 夜；`ep12-sc02` 内景 寝宫 夜 |

演练用的驱动脚本、请求 JSON、工具返回原文与产物副本都在
`.script2shot/drill-4d-3/`（gitignored），没有进入仓库跟踪范围。

## 2. 执行方式

按 controller ruling R9：无交互会话下由实现会话扮演 `$script2shot`，按
`skills/script2shot/SKILL.md` 的顺序执行；三个阶段（创作部分）由会话模型本人完成，
所有确定性操作都走真实 MCP stdio 调用。

驱动：`.script2shot/drill-4d-3/driver.mjs`，每次请求串起一串 MCP 工具调用
（`{label, tool, arguments}`），逐条把工具返回原文写入
`out/<step>/NN-<label>.json`，并写 `transcript.json`。12 次请求共 69 次工具调用。

```powershell
# 目录准备（已存在）
# .script2shot/drill-4d-3/{driver.mjs, requests/, out/, workspace/, broken/}

# 1) 刷新预览 + 知识检索探针（只读）
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\01-probe.json"
# 2) 入口第 3 步：init_run + 运行上下文 + script-breakdown 检索
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\02-breakdown.json"
# 3) 实体级检索（单实体关键词重试）
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\03-breakdown-refined.json"
node ".script2shot\drill-4d-3\build-breakdown.mjs"
# 4) 校验 script_analysis + 更新状态 + shot-planning 检索
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\04-shot-planning.json"
node ".script2shot\drill-4d-3\build-shot-plan.mjs"
# 5) 校验 shot_plan + 更新状态 + shot-prompting 逐镜头检索
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\05-shot-prompting.json"
node ".script2shot\drill-4d-3\build-prompt-ir.mjs"
# 6) validate_prompt -> render_prompt -> update_run_state -> 聚合
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\06-prompt-render-aggregate.json"
# 7-9) from shot-planning 续跑（重跑本阶段与其下游，再聚合）
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\07-from-shot-planning.json"
node ".script2shot\drill-4d-3\build-shot-plan-rerun.mjs"
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\08-from-prompting-rerun.json"
node ".script2shot\drill-4d-3\build-prompt-ir-rerun.mjs"
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\09-from-rerun-finish.json"
# 10-11) only shot-prompting 续跑
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\10-only-shot-prompting.json"
node ".script2shot\drill-4d-3\build-prompt-ir-only.mjs"
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\11-only-rerun-finish.json"
# 12) 人工修改产物后的重校验
node ".script2shot\drill-4d-3\make-broken.mjs"
node ".script2shot\drill-4d-3\driver.mjs" ".script2shot\drill-4d-3\requests\12-hand-edited-artifact.json"

# 核对七个产物、引用结构与产物哈希
node ".script2shot\drill-4d-3\verify-drill.mjs"
```

创作阶段的产物由会话模型按三个阶段 Skill 逐字写出，引用元数据来自工具返回原文：

- `script_analysis.json`：2 个场景、3 个镜头组，16 条 `knowledge_refs`；
- `shot_plan.json`：3 个镜头（8/6/5 秒首轮，重跑 7/5/5 秒），18 条 `knowledge_refs`；
- `prompts.ir.json`：3 个镜头，首轮 15 条逐镜头引用，其中 1 条
  `dropped_by_budget`（`character_bible:007`，按 `load_knowledge_pack` 回填来源元数据）。

## 3. 工具调用结果（关键读数）

### 3.1 入口第 2 步：`refresh_local_index`（只读预览）

```json
{"dry_run": true, "refreshed_docs": [], "removed_docs": [], "unchanged_docs": [13 个 token],
 "index_status": {"state": "ready", "card_count": 107}, "degraded": false, "warnings": []}
```

- 索引 `ready`，本地与 AI 库的 SyncState 一致（13 个文档无变化），没有降级 warning。
- 按演练约束只调用 `dry_run: true`；未执行写路径。

### 3.2 入口第 3 步：`init_run`

```json
{"run_id": "run-20261022-152310",
 "run_json_path": "...\\drill-4d-3\\workspace\\.script2shot\\outputs\\run-20261022-152310\\run.json"}
```

`update_run_state(script_breakdown, running)` 记录入口上下文后，`run.json` 里
`input_mode/project_id/target_model/aspect_ratio` 与本次请求一致。

### 3.3 检索读数

| 阶段 | 查询 | 候选数 | dropped |
| --- | --- | --- | --- |
| script-breakdown | `剧本解析`（general，`shot_breakdown`） | 2 | 0 |
| script-breakdown | `武灵汐`（project） | 7 | 0 |
| script-breakdown | `寝宫门外`（project） | 6 | 0 |
| script-breakdown | `无字幕`（project） | 1 | 0 |
| script-breakdown | `侍女`（project） | 0 | 0 |
| shot-planning | `寝宫门外`（project，`max_cards: 8`） | 6 | 0 |
| shot-planning | `石灯` / `发冠` / `深红长裙` | 3 / 5 / 0 | 0 |
| shot-planning | `武灵汐`（第二场景） | 7 | 0 |
| shot-prompting | `石灯` / `发冠` / `武灵汐`（`max_cards: 6`, `char_budget: 4000`） | 3 / 5 / 6+1 | 1 |
| shot-prompting（重跑） | `石阶` / `金红常服` / `乌黑` | 5 / 1 / 2 | 0 |
| shot-prompting（only） | `石灯` / `发冠` / `武灵汐` | 3 / 5 / 6+1 | 1 |

`load_knowledge_pack({project_id: "wufu-linmen", target_model: "seedance-2.5"})` 每次返回
104 张卡（general 74 / project 14 / seedance 16），`degraded: false`、无 warning。

观察（未构成缺陷，但影响检索配方落地）：**关键词命中是把整条 query 当子串匹配**
（标题/实体 → 标题/标签 → 正文）。因此「实体名 + 动作/地点/服装描述」拼成的长查询
（如 `武灵汐 高髻 凤鸟发冠 深红长裙 薄纱外衫 寝宫门外`）命中 0 张卡；改成单实体关键词
（`武灵汐`、`寝宫门外`）后立刻命中对应卡片。本次演练的前三次实体检索就是这种情况，
记录在 `out/02-breakdown/` 与 `out/03-breakdown-refined/` 两份 transcript 里。

### 3.4 校验与渲染

| 调用 | 结果 |
| --- | --- |
| `validate_stage_artifact(script_breakdown)` | `{ok: true, errors: []}` |
| `validate_stage_artifact(shot_planning)`（首轮与两次重跑） | 三次全部 `{ok: true, errors: []}` |
| `validate_prompt(prompts.ir.json)`（首轮与两次重跑） | 三次全部 `{ok: true, errors: []}` |
| `render_prompt` → `prompts.seedance-2.5.md` | `{ok: true, output_path: ...}` |
| `read_run`（聚合前） | 三阶段 `done`，三个产物 `valid: true`，`warnings: []` |

### 3.5 聚合读数

| 时机 | `script_breakdown` | `shot_planning` | `shot_prompting` |
| --- | --- | --- | --- |
| 首轮三阶段后（`06`） | 16 | 18 | 15 |
| `from shot-planning` 重跑后（`09`） | 16 | 18 | 8 |
| `only shot-prompting` 重跑后（`11`） | 16 | 18 | 15 |

- `aggregate_knowledge_refs` 三次都返回 `{output_path, counts}`，没有 `ok: true`
  （与工具契约一致）；`write_warnings` 每次返回 `{output_path, count}`。
- 重跑是**整体替换该阶段数组**：`shot_prompting` 从 15 → 8 → 15，没有出现累加
  （15+8=23 或 8+15=23）；`shot_planning` 两次重跑都保持 18。
- `verify-drill.mjs` 复核：三个阶段的条目字段集合与顺序都等于 stage-conventions §4 的
  九个字段，`usage` 只取 `used` / `dropped_by_budget`，script/planning 阶段的
  `shot_id` 允许 `null`、prompting 阶段为字符串，各阶段内部没有重复条目。

### 3.6 `warnings.md`

首轮与重跑后的 `warnings.md` 一致，来自 `script_analysis.json` 的 `missing_info`
（`run.json` 的 `warnings` 为空，本 run 没有工具 warning）：

```text
# 警告汇总
- 运行：`run-20261022-152310`
- 警告数：2
## 1. SCENE_LOCATION_DETAIL_UNKNOWN（引用 ep12-sc02）
## 2. OFFSCREEN_CHARACTER_NO_REFERENCE（引用 ep12-sc01）
```

## 4. 七个运行产物

`<workspace_root>/.script2shot/outputs/run-20261022-152310/` 下恰好七个文件，没有多余文件；
演练结束时的 SHA-256：

| 产物 | SHA-256 |
| --- | --- |
| `run.json` | `e316885afc2a1479e988b6445dfe233637a3836c3f29fbedad9b3a1a573c6545` |
| `script_analysis.json` | `075efbd3487b398912c00c1f7f0b7cc048385cd0b6ae306916d4d21a266a4f8e` |
| `shot_plan.json` | `9947dd0c67b3538faf6a8148bad4a4a32b0e0fb8aa35a0b5270fa6b37e1ae109` |
| `prompts.ir.json` | `6d0e13edf0bf93e8f4c423b0da53f96c191b12b33023df04eb44a78d8542ee7a` |
| `prompts.seedance-2.5.md` | `e0a7c0816265a4f6475aeea8d56aca325dd2d9cda0080f0cc3a84cf6c17a7b8d` |
| `knowledge_refs.json` | `f6d250416999acdf0580fef1596c4523a8734c257877a6f16b525f47c181eca3` |
| `warnings.md` | `c50f3b069b0bc252ecf94903ab8da4edcd8a8675ed064033f482b6c42dbf0703` |

## 5. 续跑路径

### 5.1 `from shot-planning`（`07` → `09`）

1. `read_run(workspace_root, run_id)` 恢复上下文（`project_id`/`target_model`/
   `aspect_ratio`/`input_mode` 全部来自 `run.json`，没有重新询问）。
2. `validate_stage_artifact(script_breakdown)` 重新校验上游后，重跑 shot-planning：
   重新检索 2 个场景与 2 个镜头组，写出 7/5/5 秒的新 `shot_plan.json`，
   `validate_stage_artifact(shot_planning)` 通过后 `update_run_state(shot_planning, done)`。
3. 按 `from` 语义继续 shot-prompting：重新逐镜头检索，写出新 `prompts.ir.json`，
   `validate_prompt` 通过后 `render_prompt` 覆盖 `prompts.seedance-2.5.md`，
   `update_run_state(shot_prompting, done)`。
4. 再次聚合：`shot_prompting` 数组由 15 条整体替换为 8 条，`script_breakdown`
   保持 16 条不变（上游没有重跑）。

### 5.2 `only shot-prompting`（`10` → `11`）

1. `read_run` 后先重新校验两个上游产物：`shot_plan.json` 与 `script_analysis.json`
   都返回 `ok: true`。
2. 只执行 shot-prompting：重新逐镜头检索、重写 `prompts.ir.json`、
   `validate_prompt` → `render_prompt` → `update_run_state(shot_prompting, done)`。
3. 再次聚合：`shot_prompting` 15 条，`shot_planning` 仍是 18 条、`script_breakdown`
   仍是 16 条，两者与 `from` 重跑后的数组完全一致（`only` 没有触碰上游）。

## 6. 人工修改产物后的重校验（`12`）

`make-broken.mjs` 从当前运行目录复制产物到 `broken/` 并破坏三个字段；`12` 请求分别调用
校验工具，**没有**调用任何 `update_run_state`：

| 文件 | 破坏点 | 工具返回 |
| --- | --- | --- |
| `shot_plan.bad_duration.json` | `scenes[0].shots[0].duration_sec = 99` | `{ok: false, code: OUT_OF_RANGE, path: /scenes/0/shots/0/duration_sec}` |
| `shot_plan.bad_shot_size.json` | `scenes[0].shots[1].shot_size = "超特写"` | `{ok: false, keyword: enum, path: /scenes/0/shots/1/shot_size}` |
| `prompts_ir.missing_subject.json` | 删除 `shots[0].subject` | `{ok: false, code: MISSING_FIELD, shot_id: ep12-sc01-sh01, field: subject}` |

阶段停止的证据：校验前后 `run.json` 的阶段状态与 `updated_at` 完全一致
（`script_breakdown 07:25:19Z` / `shot_planning 07:28:54Z` / `shot_prompting 07:30:03Z`），
运行目录七个产物的 SHA-256 在失败校验前后逐字节相同（`out/verify-before-hand-edit.json`
与 `out/verify-after-hand-edit.json`），即失败校验没有改写任何产物、没有渲染、没有更新状态。

## 7. 未覆盖与已知差异

- **人机交互部分未覆盖**：R9 下本次演练由会话模型自己扮演用户与 `$script2shot`，
  `project_id`、`target_model`、`aspect_ratio` 是预先选定的；「向用户追问一次画幅」
  这类交互没有真实发生，只核对了 `run.json` 能恢复这四个字段。
- **未做写路径刷新**：`refresh_local_index` 只跑了 `dry_run: true`；真实写路径
  （`dry_run: false`）与「AI 库不可达但有缓存」的降级分支本次没有触发，索引本来就是
  `ready` 且与 SyncState 一致。
- **知识卡数量与任务说明不同**：任务说明提到「现有 55 张通用知识卡」，本次实测本地索引
  `card_count: 107`（`load_knowledge_pack`：general 74 / project 14 / seedance 16）。
  演练按实际索引执行，未做任何写入或重建。
- **长查询命中 0**：如 §3.3 的观察，多词长查询当前命中率极低；阶段 Skill 的检索配方
  写的是「实体名 + 描述」，实践中需要拆成单个高信号关键词。若要按配方拼长查询也能命中，
  需要先在设计文档里冻结分词规则，再改检索实现；本次只记录现象。
- **项目知识只覆盖一个项目**：本地只映射了 `wufu-linmen`；演练剧本因此重写为该项目的
  原创片段，否则项目级检索会全部返回 0 张卡。
- **未验证**：多集输入在真实会话里的 warning 提醒（离线端到端用例覆盖了
  `MULTIPLE_EPISODES` 的持久化与 `warnings.md` 汇总）；`run.json` 与产物不一致时的
  `RUN_STATE_RECONCILED` 修正（本次三次 `read_run` 都没有触发）。

## 8. 技能迭代全量回归（Task C2，2026-10-23）

本节记录 sd25-pe 迭代（I1–I3）落地后的全量回归：测试命令与结果、双模型 golden
人工核对、真机演练重跑读数与未验证项。执行计划见
`docs/superpowers/plans/2026-10-22-script2shot-skill-iteration.md`，方案状态见
`docs/sd25-pe-optimization-plan-2026-10-22.md`（已采纳 / Accepted）。

### 8.1 测试与类型检查

| 命令 | 结果 |
| --- | --- |
| `npm --prefix server test`（沙箱内） | 失败在 pretest 构建：`esbuild ... dist/server.mjs: Access is denied`（沙箱禁写 `server/dist`），未进入用例阶段 |
| `npm --prefix server test`（同命令在沙箱外执行） | PASS：32 个测试文件，393 passed / 1 skipped（394） |
| `npm --prefix server run typecheck` | PASS（`tsc --noEmit` 无输出） |

构建产物 `server/dist/server.mjs` 为 gitignored 派生文件，本次回归没有改动它的跟踪状态。

### 8.2 双模型 golden 人工核对

逐行核对 `tests/fixtures/prompts/seedance-2.0.golden.md` 与
`tests/fixtures/prompts/seedance-2.5.golden.md`（两份快照在
`server/tests/render_prompt.test.ts` 里按字节断言，全量套件已通过）：

| 核对项 | Seedance 2.0 golden | Seedance 2.5 golden |
| --- | --- | --- |
| 景别行（景别 / 机位 / 运镜） | 有：`景别：全景`、`景别：中全景`；机位、运镜逐项中文 | 有：`景别：中景`、`景别：中近景` |
| 对白行：language / delivery 拼接 | `角色A说：{这地方还有人吗}`（language / delivery 均省略的短路径） | `角色A说：{你一个外人}；角色B用日语轻声说：{もう大丈夫です}`（language + delivery 拼接，条目间「；」连接） |
| 对白行：空对白占位 | `无对白；人物自然闭口，无旁白`（sh02） | 同左（sh02） |
| 情绪子标签 | 有（sh01 `情绪：推门的手停了一下，目光扫过空荡的前厅`）；空字符串时子标签省略（sh02） | 有（sh01）；空值省略（sh02） |
| 声音行 | 有：`音效：<铁门被推开>；音乐：(低沉弦乐)`；三项全空时整行省略（sh02） | 同左（sfx `<远处雷声>`、music `(低沉弦乐)`） |
| 时间中文化 | `夜晚`、`清晨`，无英文时间词 | `夜晚`；`time` 为空时不生成「时间」子标签（sh02） |
| 反向核对 | `rg "night\|day\|dawn\|dusk\|morning\|evening\|无声音"` 两份 golden 均无命中 | 同左 |

结论：两份 golden 与各节冻结口径一致（`docs/model-rules-notes.md` §4.2–§4.3），没有
需要迁就实现的偏差。

### 8.3 真机演练重跑（`run-20261023-095430`）

`.script2shot/drill-4d-3/` 的驱动资产仍在，按本文件 §2 的 12 步请求序列就地重跑；
起草于新字段落地前的 gitignored 草稿脚本已就地补齐（不提交）：
`build-prompt-ir{,-rerun,-only}.mjs` 增加 schema 必填的
`shot_size` / `emotion` / `dialogue` / `audio`（取值遵循 `skills/shot-prompting/SKILL.md`：
台词取上游 `dialogue_units` 原文、情绪只用可观察线索、声音无依据时三项留空）；
`make-broken.mjs` 与 `verify-drill.mjs` 改为从 `init_run` 返回解析 run 目录；
`requests/04–12` 的 `run_id` 指向新 run；`requests/02` 按入口 Skill 第 3 步把索引降级
warning 原文通过 `update_run_state` 记进 `run.json`。

本轮与上一轮（`run-20261022-152310`）读数对照：

| 项 | 上一轮 | 本轮 |
| --- | --- | --- |
| 本地索引 `card_count` | 107 | 114 |
| 知识包 `load_knowledge_pack` | 104（general 74 / project 14 / seedance 16） | 111（general 80 / project 14 / seedance 17） |
| `refresh_local_index`（`dry_run: true`） | `ready`，无 warning | `ready` + `degraded: true`，`KB_B_UNREACHABLE` |
| 聚合读数（首轮） | 16 / 18 / 15 | 16 / 18 / 15 |
| 聚合读数（`from shot-planning` 重跑后） | 16 / 18 / 8 | 16 / 18 / 8 |
| 聚合读数（`only shot-prompting` 重跑后） | 16 / 18 / 15 | 16 / 18 / 15 |
| `warnings.md` 条数 | 2（`missing_info`） | 3（降级 warning + 2 条 `missing_info`） |
| 七个产物 | 7 个，无多余文件 | 7 个，无多余文件 |

检索读数与上一轮完全一致：`02` 4 次查询 2 / 0 / 0 / 0；`03` 7 / 6 / 0 / 1；
`04`（`max_cards: 8`）6 / 3 / 5 / 7 / 0；`05`（`max_cards: 6`, `char_budget: 4000`）
3 / 5 / 6 张（1 条 `dropped_by_budget`）；`07` 6 / 3 / 5 / 7；`08` 5 / 1 / 2；
`10` 3 / 5 / 6 张（1 条 `dropped_by_budget`）。

校验与产物：

- 三个阶段校验全部 `ok: true`（`validate_stage_artifact` × 多次、`validate_prompt` × 3）；
  `run.json` 三阶段 `done`、三个产物 `valid: true`、`warnings: []`（无对账冲突）。
- 本轮实跑覆盖了此前未跑的降级路径：AI 库（SyncState）不可达时按本地缓存继续，
  `KB_B_UNREACHABLE` 原文经 `update_run_state` 持久化并出现在 `warnings.md` 第 1 条。
- 本轮渲染产物新增覆盖：景别行（全景 / 中近景）、对白行（`侍女轻声说：{时辰到了。}`
  与两条空对白占位）、情绪子标签（有值 / 空值省略两条路径）、时间中文化；三个镜头
  `audio` 三项全空，渲染层整行省略且未出现「无声音」占位。
- 人工破坏产物后的重校验（§6 第 `12` 步）错误码与上一轮逐条一致：
  `OUT_OF_RANGE /scenes/0/shots/0/duration_sec`、`enum /scenes/0/shots/1/shot_size`、
  `MISSING_FIELD`（`ep12-sc01-sh01.subject`）；失败校验前后 `run.json` 三阶段
  `updated_at` 不变，七个产物 SHA-256 逐字节一致（`out/verify-before-hand-edit.json`
  与 `out/verify-after-hand-edit.json` 哈希无差异）。

### 8.4 C1 外部同步之后的索引读数

本轮读数落在 C1（AI 库同步）之后：本地索引 `card_count` 107 → 114，知识包
104 → 111（general 74 → 80、project 14、seedance 16 → 17），与 C1 记录的
「7 张新卡 + 2 个容器页、SyncState 全部创建」一致；「台词」「阶段化」
「情绪可观察化」检索命中新卡不在本轮演练查询里，本轮只核对数量与演练链路。

### 8.5 未验证项与顾虑

- **写路径刷新未验证**：`refresh_local_index` 仍只跑 `dry_run: true`；本轮沙箱环境无
  外网，SyncState 读取失败才走了降级分支，`dry_run: false` 的真实写路径与
  「远端与本地一致时零变化」的干净读数本轮没有复现。
- **人机交互部分未覆盖**：仍由会话模型扮演用户与 `$script2shot`；
  `project_id`、`target_model`、`aspect_ratio` 为预选值，只核对 `run.json` 能恢复。
- **长查询命中 0**：与 §3.3 的观察相同（多词长查询命中率低，单实体关键词正常）；
  本轮未改检索实现。
- **项目知识只覆盖 `wufu-linmen`**：演练剧本仍是该项目下的原创片段。
- **未验证**：多集输入在真实会话里的 warning 提醒（离线端到端用例覆盖）、
  `RUN_STATE_RECONCILED` 修正（本轮三次 `read_run` 均未触发）。
