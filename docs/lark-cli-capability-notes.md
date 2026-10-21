# lark-cli 能力实测记录

状态：已完成（Phase 1 Task 7：现场探测 + 离线整理 + 脱敏 fixture）
核对日期：2026-10-21
lark-cli：1.0.98，路径 `D:\lark-cli\lark-cli.exe`
机器：Windows 桌面端本机会话（Codex Desktop，PowerShell）

本文档记录能力形状与结论，不包含账号凭证类信息。
Base / 空间 / 数据表标识按需保留，作为插件默认配置依据；A 库文档节点与对象的 token 不在此记录。

## 1. 登录与身份

- `lark-cli auth login` 为设备码登录：命令输出验证地址与用户码，在浏览器确认授权后
  凭证写入本机；`lark-cli auth status --json` 读取当前状态。
- 当前身份：用户身份已就绪。
- 已具备本阶段所需 scope，例如 `wiki:node:read`、`wiki:space:read`、
  `docx:document:readonly`、`base:table:read`、`base:field:read`、
  `base:record:read`、`base:record:create`、`base:record:delete`。

## 2. 知识库 A 实测

A 库空间：Wiki `7695983197091302359`。

### 2.1 结构

两个根节点，均为 `origin` docx：

1. 「通用知识」（有子节点）：
   - 镜头语言（docx）
   - 剧本解析（docx）
   - 从剧本到镜头拆分（docx）
   - 视频生成模型说明（docx）
   - Seedance 2.0 系列提示词指南.pdf（`obj_type=file`）
   - Seedance 2.5 提示词指南（docx）
   - 视频提示词模板与正例（docx）
2. 「《五夫临门》影游项目知识」（有子节点）：
   - 《五夫临门》影游-项目概述（docx）
   - 《五夫临门》影游-视觉风格（docx）
   - 《五夫临门》影游-角色清单（docx）
   - 《五夫临门》影游-场景清单（docx）

### 2.2 关键偏差：快捷命令裁剪字段，必须使用原始 API

- 快捷命令 `wiki +node-list` 实测只返回：`has_child`、`node_token`、`node_type`、
  `obj_token`、`obj_type`、`parent_node_token`、`space_id`、`title`；没有 `obj_edit_time`。
- 原始 API `wiki nodes list` 返回完整字段：`creator`、`owner`、`node_create_time`、
  `obj_create_time`、`obj_edit_time`、`origin_node_token`、`origin_space_id`、`url`、
  `has_child`、`node_type`、`parent_node_token`、`space_id`、`title` 等。
- 结论：Phase 2 扫描必须使用原始 API `wiki nodes list` 手动翻页 + BFS 递归，
  快捷命令输出不能作为增量判断依据。相关设计已同步到架构 §4.4、§6.1。

### 2.3 文档读取（docs +fetch）

- 样本：「通用知识 / 镜头语言」（`node_type=origin`、`obj_type=docx`）。
- 实测：`data.document.document_id` 存在；`data.document.revision_id = 13`；
  `data.document.content` 为 Markdown 正文，5393 字符；`tips` 为空。
- 本次输出中 `reference_map` 与 `tips` 的空值未单独出现；fixture 按文档形状保留
  `reference_map: {}`、`tips: ""`。
- warning（落盘证据：`live/docs-fetch-sample.json` 的 `data.warnings[0]`）：
  `--doc-format markdown` 与 `--detail with-ids` 组合时 detail 会被忽略并返回 warning，
  原文为 `--detail with-ids is only supported with --doc-format xml; returning markdown output and ignoring the unsupported detail option`。
  含义：markdown 模式不提供 block id；需要 block id 时应改用 `--doc-format xml --detail with-ids`。

### 2.4 非 docx 节点

- 「通用知识」下存在一个 `obj_type=file` 的 PDF 节点
  （`Seedance 2.0 系列提示词指南.pdf`）。
- 第一版处理：跳过非 docx 节点并写 warning（`NON_DOC_NODE_SKIPPED`），不下载、不解析。

## 3. 知识库 B 实测

B 空间：Wiki `7695983325910961131`；探测时该空间根节点列表为空。

新建 Base（作为 Wiki 节点挂载）：

| 项 | 值 |
| --- | --- |
| `node_token` | `MP4Xw6jI6iksQlkTsLec6Q8lnib` |
| `obj_token` | `WRrVblDbqaEFOSs39P0cFzilnfd` |

默认数据表（`base +table-list`，表键为 `id` / `name` / `records_count`）：
`tblFQ5fKP2LPsjZE`（`Table`，`records_count=10`，`rev=0`，`total=1`）。

默认字段（`base +field-list`，字段键为 `id` / `name` / `type`）：

| id | name | type |
| --- | --- | --- |
| `fldg2j85Yj` | Text | text |
| `fldNnP992K` | Single option | select |
| `fldYPge8xE` | Attachment | attachment |
| `fldyVJTVIB` | Date | datetime |

初始记录数：10 条（默认示例数据，字段值均为空）。

### 3.1 写入探针（2026-10-21）

命令序列（`$BASE_B` / `$TABLE_ID` / `$RECORD_ID` 均为变量占位）：

1. 写入（batch create）：
   `lark-cli base +record-batch-create --base-token "$BASE_B" --table-id "$TABLE_ID" --as user --json '{"create_records":[{"fields":{"Text":"<probe text>"}}]}'`
2. 读回（记录级读回路径；返回矩阵形状，见 §4）：确认写入值可读回。
3. 删除：
   `lark-cli base +record-delete --base-token "$BASE_B" --table-id "$TABLE_ID" --as user --json '{"record_id_list":["$RECORD_ID"]}' --yes`
4. 复核列表：
   `lark-cli base +record-list --base-token "$BASE_B" --table-id "$TABLE_ID" --as user --format json`

结果：

1. 写入返回 `data.record_id_list`（1 条）与 `data.rev`；
2. 读回时写入值可见，返回为矩阵形状；
3. 删除返回 `data.record_id_list` 与 `data.rev`；
4. 最终列表记录数为 10，与初始一致，探针记录无残留。

## 4. 接口形状发现（inline JSON）

| 命令 | 形状 |
| --- | --- |
| `base +record-list --format json` | 矩阵形状：`data.fields`（字段名数组）+ `data.data`（行数组，每行按 `fields` 顺序的 CellValue）+ `data.record_id_list`（与行对齐的记录 ID）；另有 `field_id_list`、`field_type_list`、`has_more`、`query_context`（`field_scope` / `record_scope`）、`rev`、`timezone`。不是对象数组 |
| `base +record-batch-create` | `data.record_id_list` + `data.rev` |
| `base +field-list` | 字段键为 `id` / `name` / `type`（另有按字段类型出现的 `style`、`options` 等） |
| `base +table-list` | 表键为 `id` / `name` / `records_count`（及 `rev`），顶层 `total` |

对 Phase 2 适配器的建议：`list_records` 保持矩阵时，按 `fields × data rows` 拼装
对象数组（用 `record_id_list` 对齐行）；或改用 ndjson 输出。二选一后保持确定性，
并在实现里固定该选择。

## 5. 能力对照表（大纲 §6.5）

| # | 既有事实 | 结论 | 偏差 / 备注 |
| --- | --- | --- | --- |
| 1 | `wiki +node-list` 返回含 `obj_edit_time` 的完整字段，`--page-all --page-limit` 翻页 | 有偏差 | 快捷命令实测不含 `obj_edit_time`；原始 API `wiki nodes list` 返回完整字段（见 §2.2）。Phase 2 改用原始 API 手动翻页（`--page-token`） |
| 2 | `docs +fetch` 返回 `data.document.{document_id, revision_id, content, reference_map, tips}` | 实测通过 | `document_id`、`revision_id=13`、`content`（Markdown，5393 字符）实测拿到；结构按文档形状，空 `tips`、`reference_map` 未单独出现；markdown 模式不支持 with-ids（实测 warning，见 §2.3） |
| 3 | `base +table-create` 用 `--fields` JSON；`+record-batch-create` 用 `--json '{"create_records":[...]}'`（≤200 条）；datetime CellValue 形如 `2026-03-24 10:00` | 实测通过 | 本轮复测 `+record-batch-create` 形状与 `data.record_id_list` 返回；`+table-create --fields`、200 条上限与 datetime CellValue 属未复测项，Phase 2 Task 2 按 `--help` 复核 |
| 4 | `auth status --json` 可读；`auth login` 走设备码登录 | 实测通过 | 重新登录后状态输出用户身份已就绪 |
| 5 | 可移植插件布局：`plugin.json` + `mcp.json` + `skills/` | 实测通过 | Phase 1 清单与握手测试覆盖，本轮回归复跑 |
| 6 | Codex 桌面端自带 Node 与 `node:sqlite` 可用 | 未复测 | 属环境类事实，不属于 lark-cli 能力探测范围；本轮回归在开发机 Node 上运行 |

## 6. 脱敏 fixture 清单

| 文件 | 内容 |
| --- | --- |
| `server/tests/fixtures/lark-wiki-nodes-list.sample.json` | 原始 API `wiki nodes list` 形状，2 个根节点，含 `obj_edit_time` 等完整字段 |
| `server/tests/fixtures/lark-docs-fetch.sample.json` | `docs +fetch` 形状，`revision_id=13`、合成 Markdown、`reference_map={}`、`tips=""` |
| `server/tests/fixtures/lark-base-table-list.sample.json` | `base +table-list` 形状，1 张表（`records_count=10`） |
| `server/tests/fixtures/lark-base-record-batch-create.sample.json` | `base +record-batch-create` 形状（`data.record_id_list`） |
| `server/tests/fixtures/lark-base-record-list.sample.json` | `base +record-list` 矩阵形状（2 行） |

全部为合成占位值，不含真实标识符、标题或正文。

## 7. 对实现的影响（Phase 2）

1. 扫描改用原始 API：
   `wiki nodes list --space-id <space_a> --parent-node-token ? --page-size 50 --page-token ? --as user --format json`，
   手动翻页 + BFS 递归；不使用快捷 `wiki +node-list`。
2. `scope` / `project_id` 使用根节点映射：「通用知识」→ `scope=general`；其他
   origin docx 根节点 → `scope=project`，`project_id` 由配置中的 `project_roots` 给出
   （结构与语义见架构 §7.3）；未映射根节点跳过并写 warning。路径规则保留为建议目录
   （用于 `source_path` 展示）。
3. 非 docx 节点跳过并写 warning，不读取二进制。
4. 记录读写按 §4 处理矩阵形状与 `record_id_list`。
5. 正文读取以 `data.document.revision_id` 作为 `source_revision`；`content` 为 Markdown。
