import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { health, type HealthOptions } from "./tools/health.js";
import { init_knowledge_b, type InitKnowledgeBInput } from "./tools/init_knowledge_b.js";
import { read_config } from "./tools/read_config.js";
import { write_config, type WriteConfigInput } from "./tools/write_config.js";
import { build_sync_plan } from "./sync_plan.js";
import type { SyncState } from "./base_mapping.js";
import { delete_doc_cards } from "./tools/delete_doc_cards.js";
import { fetch_knowledge_a_doc } from "./tools/fetch_knowledge_a_doc.js";
import { read_sync_state } from "./tools/read_sync_state.js";
import {
  refresh_local_index,
  type RefreshLocalIndexInput,
} from "./tools/refresh_local_index.js";
import {
  load_knowledge_pack,
  LOAD_KNOWLEDGE_PACK_FIELDS,
  type LoadKnowledgePackInput,
} from "./tools/load_knowledge_pack.js";
import {
  KNOWLEDGE_CATEGORY_VALUES,
  KNOWLEDGE_SCOPE_VALUES,
  SEARCH_KNOWLEDGE_FIELDS,
  search_knowledge,
  TARGET_MODEL_VALUES,
  type SearchKnowledgeInput,
} from "./tools/search_knowledge.js";
import {
  replace_doc_cards,
  type ReplaceDocCardsInput,
} from "./tools/replace_doc_cards.js";
import { scan_knowledge_a, type ScannedNode } from "./tools/scan_knowledge_a.js";
import { update_doc_sync_state, type UpdateDocSyncStateInput } from "./tools/update_doc_sync_state.js";
import {
  STAGE_ARTIFACT_STAGE_VALUES,
  validate_stage_artifact,
  type StageArtifactStage,
  type ValidateStageArtifactInput,
} from "./tools/validate_stage_artifact.js";
import { validate_prompt, type ValidatePromptInput } from "./tools/validate_prompt.js";
import { render_prompt, type RenderPromptInput } from "./tools/render_prompt.js";
import {
  RUN_ASPECT_RATIO_VALUES,
  RUN_DEFAULT_ASPECT_RATIO,
  RUN_DEFAULT_DISPLAY_TIMELINE,
  RUN_INPUT_MODE_VALUES,
  RUN_STAGE_STATUS_VALUES,
  RUN_STAGE_VALUES,
  RUN_TARGET_MODEL_VALUES,
  init_run,
  type InitRunInput,
} from "./tools/init_run.js";
import { read_run, type ReadRunInput } from "./tools/read_run.js";
import { update_run_state, type UpdateRunStateInput } from "./tools/update_run_state.js";
import {
  aggregate_knowledge_refs,
  write_warnings,
  type AggregateKnowledgeRefsInput,
  type WriteWarningsInput,
} from "./aggregate.js";

const server = new Server(
  { name: "script2shot", version: "0.2.1" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "health",
    description:
      "只读检查：lark-cli 路径与版本、登录状态、原始库与 AI 库可达性、本地目录与索引状态；" +
      "可选 pending_config 替代磁盘配置做写入前预检（不写盘）。",
    inputSchema: {
      type: "object",
      properties: {
        pending_config: {
          type: "object",
          description:
            "可选：与 write_config 的 config 同形状的待写入配置；提供时本次检查完全不读磁盘配置，" +
            "成功结果带 config_source=pending，校验失败时只返回 config fail check。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_config",
    description:
      "只读返回 ~/.codex-script2shot/config.toml 是否存在、路径与掩码后的配置快照；" +
      "base_b 只保留前 6 位加 …（完整 token 不经过对话），供 setup 的「保留既有配置」决策使用；不写任何文件。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "write_config",
    description:
      "dry-run 预览或写入 ~/.codex-script2shot/config.toml，并按需创建本地目录；返回的 diff 中 base_b 已掩码。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "object",
          description:
            "完整配置：{ lark: { cli_path, profile, space_a, base_b, knowledge_cards_table_id, sync_state_table_id, project_roots: [{ node_token, project_id }] }, retrieval: { default_top_k } }；缺省字段使用插件默认知识库配置（server/src/setup_defaults.ts）。",
        },
        create_local_dirs: {
          type: "boolean",
          description: "缺省 true：写入时创建本地 cache、index、logs 目录。",
        },
        dry_run: {
          type: "boolean",
          description: "缺省 true：只返回 diff 与将要创建的目录，不写任何文件、不建目录。",
        },
        preserve_existing: {
          type: "boolean",
          description:
            "缺省 true：保留磁盘上既有的非空字段；false 时按纯默认语义覆盖（用于显式重写）。" +
            "回执用 preserved_existing[] 与 applied_defaults[] 分别列出保留项与默认项。",
        },
      },
      required: ["config"],
      additionalProperties: false,
    },
  },
  {
    name: "init_knowledge_b",
    description:
      "创建或校验 AI 库的 KnowledgeCards 与 SyncState 两张数据表（按固定表名解析 table_id），" +
      "报告字段漂移；dry_run 缺省 true，只有 dry_run=false 且校验通过后才把 table_id 写回本地配置。",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "缺省 true：只读取并校验，不建表、不写配置。",
        },
        pending_config: {
          type: "object",
          description:
            "可选：与 write_config 的 config 同形状的待写入配置；提供时本次调用完全不读磁盘配置，" +
            "只允许 dry_run 预览（执行路径携带它返回 CONFIG_INVALID）；成功结果带 config_source。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scan_knowledge_a",
    description:
      "只读扫描原始库的 Wiki 节点元数据（不读正文），返回 nodes[] / skipped[] / warnings[]；" +
      "nodes[] 是 build_sync_plan 的输入。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_sync_state",
    description:
      "只读读取 AI 库的 SyncState 全表，返回 records[]（每条带 Base record_id）；" +
      "records[] 是 build_sync_plan 的输入。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "build_sync_plan",
    description:
      "对 scan_knowledge_a 的 nodes[] 与 read_sync_state 的 records[] 做变化分类，" +
      "返回 to_add / to_update / to_move / to_delete / unchanged / warnings 的整批 dry-run 计划（原样 JSON）。",
    inputSchema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          description: "scan_knowledge_a 返回的 nodes[]。",
        },
        sync_records: {
          type: "array",
          description: "read_sync_state 返回的 records[]。",
        },
      },
      required: ["nodes", "sync_records"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_knowledge_a_doc",
    description:
      "只读读取一个原始库文档的 markdown 正文与 revision_id；" +
      "expand_references=true 时展开正文里的飞书文档引用与网页链接，返回 references[]；" +
      "标题提取顺序为 <title> 标签 → 首个 Markdown 标题行 → 节点标题（带 warning）。",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "飞书文档 URL 或 token。" },
        expand_references: {
          type: "boolean",
          description:
            "缺省 false：只读正文；true 时展开正文中的引用（飞书文档引用卡片、飞书文档链接、网页链接）。",
        },
        max_references: {
          type: "number",
          description: "展开引用的数量上限，缺省 10，最大 50。",
        },
      },
      required: ["doc"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_doc_cards",
    description:
      "替换模式（cards）或元数据模式（metadata_patch）二选一，dry_run 缺省 true：" +
      "执行时先记录该文档旧卡的 record_id、写入新卡、再只删除旧 record_id；cards: [] 表示清空该文档全部卡片。",
    inputSchema: {
      type: "object",
      properties: {
        source_doc_token: {
          type: "string",
          description: "原始库文档 token（即知识卡的 source_doc_token）。",
        },
        cards: {
          type: "array",
          description: "该文档的完整新卡集合；与 metadata_patch 二选一。",
        },
        metadata_patch: {
          type: "object",
          description:
            "只更新现有卡的来源元数据：source_path / source_title / scope / project_id；与 cards 二选一。",
        },
        dry_run: { type: "boolean", description: "缺省 true：只预览，不写不删。" },
      },
      required: ["source_doc_token"],
      additionalProperties: false,
    },
  },
  {
    name: "update_doc_sync_state",
    description:
      "按 source_doc_token upsert 一个文档的 SyncState 记录；没有 dry-run 参数，" +
      "只在用户确认整批、且该文档的卡片替换或元数据更新成功后才调用。",
    inputSchema: {
      type: "object",
      properties: {
        record: {
          type: "object",
          description:
            "SyncState 逻辑记录；可携带 read_sync_state 回读的 record_id（upsert 时忽略）。",
        },
      },
      required: ["record"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_doc_cards",
    description:
      "删除一个文档在 AI 库中的全部知识卡与 SyncState 记录（不可逆）；" +
      "dry_run 缺省 true 只预览，只有执行路径才带高风险确认 --yes，返回值中的 dry_run 字段区分预览与执行。",
    inputSchema: {
      type: "object",
      properties: {
        source_doc_token: {
          type: "string",
          description: "要删除知识卡与 SyncState 的原始库文档 token。",
        },
        dry_run: { type: "boolean", description: "缺省 true：只预览，不真正删除。" },
      },
      required: ["source_doc_token"],
      additionalProperties: false,
    },
  },
  {
    name: "refresh_local_index",
    description:
      "以 AI 库的 SyncState 为准增量刷新本地卡片缓存与关键词索引：只拉取变化文档的知识卡、" +
      "删除 AI 库中已移除文档的本地数据；dry_run 缺省 true（不写缓存、不建索引）；" +
      "AI 库不可达但有缓存时降级返回并写 warning。",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "缺省 true：只读取 AI 库并计算变化清单，不写缓存、不建索引。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_knowledge",
    description:
      "只读关键词检索本地知识索引：按 scope → project_id → category → target_model → 关键词 → " +
      "排序（命中级别升序 → priority 降序 → updated_at 降序 → card_id 升序）返回候选卡、" +
      "上下文文本与被预算截断的 card_id；索引不可用时按 priority 降序回退到本地缓存并写 warning。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "关键词：标题/实体精确命中(1) 优先于 标题/标签子串(2)，再是正文子串(3)。",
        },
        scope: {
          type: "string",
          enum: [...KNOWLEDGE_SCOPE_VALUES],
          description: "可选：知识范围过滤。",
        },
        project_id: {
          type: "string",
          description: "可选：项目过滤（scope=project 的卡）。",
        },
        categories: {
          type: "array",
          items: { type: "string", enum: [...KNOWLEDGE_CATEGORY_VALUES] },
          description: "可选：知识分类过滤；缺省或空数组表示不过滤。",
        },
        target_model: {
          type: "string",
          enum: [...TARGET_MODEL_VALUES],
          description: "可选：目标模型；target_models 为空的通用卡一律放行。",
        },
        max_cards: {
          type: "integer",
          minimum: 0,
          description:
            "可选：候选上限（含 0），缺省取配置 retrieval.default_top_k；超出的卡记入 dropped_by_budget。",
        },
        char_budget: {
          type: "integer",
          minimum: 0,
          description:
            "可选：上下文正文预算（字符，不含来源标注）；超预算时从最低排序开始截断。",
        },
        explain: {
          type: "boolean",
          description: "Phase 5 的诊断输出；本期接受参数并返回 EXPLAIN_NOT_AVAILABLE warning。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "load_knowledge_pack",
    description:
      "只读组装一个项目的知识包：全部 scope=general 卡片、scope=project 且 project_id 匹配的卡片、" +
      "以及 target_models 兼容目标模型的 seedance_rule 卡片；顺序固定为 general → project → seedance" +
      "（各自 category 升序 → card_id 升序），返回 cards[] / stats / warnings[]；索引不可用时返回 " +
      "INDEX_UNAVAILABLE（无缓存回退）。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "项目 ID：只加载该项目 scope=project 的知识卡。",
        },
        target_model: {
          type: "string",
          enum: [...TARGET_MODEL_VALUES],
          description: "目标模型：seedance_rule 卡按 §3.1 兼容性过滤。",
        },
        explain: {
          type: "boolean",
          description: "Phase 5 的诊断输出；本期接受参数并返回 EXPLAIN_NOT_AVAILABLE warning。",
        },
      },
      required: ["project_id", "target_model"],
      additionalProperties: false,
    },
  },
  {
    name: "init_run",
    description:
      "在工作区创建 .script2shot/outputs/<run-YYYYMMDD-HHMMSS>/ 与 v2 run.json（三阶段初始 pending），返回 run_context_hash。" +
      "workspace_root 必填：MCP Server 位于插件根目录，仅凭 run_id 无法定位用户工作区的运行目录。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: {
          type: "string",
          minLength: 1,
          description: "用户工作区根目录；运行产物写入其 .script2shot/outputs 下。",
        },
        input_mode: {
          type: "string",
          enum: [...RUN_INPUT_MODE_VALUES],
          description: "剧本文本粒度：片段、单集或多集。",
        },
        project_id: {
          type: "string",
          minLength: 1,
          description: "项目 ID，用于项目知识检索。",
        },
        target_model: {
          type: "string",
          enum: [...RUN_TARGET_MODEL_VALUES],
          description: "本次运行唯一的目标视频模型。",
        },
        aspect_ratio: {
          type: "string",
          enum: [...RUN_ASPECT_RATIO_VALUES],
          default: RUN_DEFAULT_ASPECT_RATIO,
          description: `可选运行级画幅比例；未提供时默认 ${RUN_DEFAULT_ASPECT_RATIO}。`,
        },
        input_references: {
          type: "array",
          description: "可选：用户提供的参考素材与职责，仅保存本地路径或素材标识，不写凭据。",
          items: { type: "object" },
        },
        display_timeline: {
          type: "boolean",
          default: RUN_DEFAULT_DISPLAY_TIMELINE,
          description: "可选：是否在 2.0 提示词中显示秒数；默认 false；2.5 强制显示。",
        },
      },
      required: ["workspace_root", "input_mode", "project_id", "target_model"],
      additionalProperties: false,
    },
  },
  {
    name: "read_run",
    description:
      "读取工作区 .script2shot/outputs/<run_id>/run.json 与三阶段产物校验结果；先识别 v2 版本和内容指纹，返回 run_context_hash；" +
      "产物存在且通过校验时以产物为准修正 run.json，并用 warning RUN_STATE_RECONCILED 报告；" +
      "同时核对产物身份字段（run_id / input_mode / project_id / target_model）与 run.json " +
      "及产物之间是否一致，冲突时把冲突产物所属阶段置 failed，在 warning 的 " +
      "details.conflicts[] 中报告，且不重写身份字段。" +
      "workspace_root 必填，用于定位用户工作区中的运行目录。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: {
          type: "string",
          minLength: 1,
          description: "用户工作区根目录。",
        },
        run_id: {
          type: "string",
          pattern: "^run-\\d{8}-\\d{6}$",
          description: "运行目录名。",
        },
      },
      required: ["workspace_root", "run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_run_state",
    description:
      "更新工作区 .script2shot/outputs/<run_id>/run.json 中一个阶段的状态、产物名和运行级警告，" +
      "并写入 updated_at；workspace_root 必填，用于定位用户工作区中的运行目录。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: {
          type: "string",
          minLength: 1,
          description: "用户工作区根目录。",
        },
        run_id: {
          type: "string",
          pattern: "^run-\\d{8}-\\d{6}$",
          description: "运行目录名。",
        },
        stage: {
          type: "string",
          enum: [...RUN_STAGE_VALUES],
          description: "要更新的阶段 key。",
        },
        status: {
          type: "string",
          enum: [...RUN_STAGE_STATUS_VALUES],
          description: "阶段状态。",
        },
        artifact: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          description: "可选阶段产物文件名；null 表示清空。",
        },
        warnings: {
          type: "array",
          description: "可选运行级 warning；只追加，不改既有条目。",
          items: {
            type: "object",
            properties: {
              code: { type: "string", minLength: 1 },
              message: { type: "string", minLength: 1 },
              refs: { type: "array", items: { type: "string" } },
              details: {
                type: "object",
                description: "结构化明细，例如 RUN_STATE_RECONCILED 的 conflicts[]。",
              },
            },
            required: ["code", "message"],
            additionalProperties: false,
          },
        },
      },
      required: ["workspace_root", "run_id", "stage", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_stage_artifact",
    description:
      "按 v2 阶段 schema 与语义规则校验阶段产物 JSON，返回 { ok, errors[], content_hash }；errors[].path 使用 JSON Pointer，" +
      "文件缺失 / 不可读 / JSON 非法分别返回 STAGE_ARTIFACT_MISSING / UNREADABLE / INVALID_JSON。",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: [...STAGE_ARTIFACT_STAGE_VALUES],
          description: "阶段 key：script_breakdown 或 shot_planning。",
        },
        path: {
          type: "string",
          description: "阶段产物 JSON 文件路径。",
        },
        script_analysis_path: {
          type: "string",
          description: "可选：规划阶段用于跨产物语义校验的 script_analysis.json 路径。",
        },
      },
      required: ["stage", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_prompt",
    description:
      "按 v2 PromptIR schema、上游链接与目标模型硬规则校验 prompts.ir.json，返回 { ok, errors[] }；" +
      "errors[] = { clip_id, shot_id, field, code, message }，code 为 MISSING_FIELD / OUT_OF_RANGE / " +
      "FORBIDDEN_TERM / MODEL_MISMATCH（硬规则校验码）或 MODEL_RULES_UNAVAILABLE" +
      "（目标模型规则文件缺失 / 损坏，安装问题）；文件缺失 / 不可读 / JSON 非法返回一条 " +
      "field=prompt_ir_path 的错误。",
    inputSchema: {
      type: "object",
      properties: {
        shot_plan_path: {
          type: "string",
          description: "可选：跨产物校验使用的 shot_plan.json 路径。",
        },
        script_analysis_path: {
          type: "string",
          description: "可选：跨产物校验使用的 script_analysis.json 路径。",
        },
        prompt_ir_path: {
          type: "string",
          description: "PromptIR（prompts.ir.json）文件路径。",
        },
      },
      required: ["prompt_ir_path"],
      additionalProperties: false,
    },
  },
  {
    name: "render_prompt",
    description:
      "渲染每段视频的五模块 Seedance 提示词：先校验 PromptIR、上游指纹和硬规则，" +
      "通过后按规则模板生成一个 clip 一份的中文 Markdown 并写入 output_path；" +
      "校验或渲染失败返回 { ok: false, errors[] }，不写或覆盖文件。",
    inputSchema: {
      type: "object",
      properties: {
        shot_plan_path: {
          type: "string",
          description: "可选：跨产物校验使用的 shot_plan.json 路径。",
        },
        script_analysis_path: {
          type: "string",
          description: "可选：跨产物校验使用的 script_analysis.json 路径。",
        },
        prompt_ir_path: {
          type: "string",
          description: "PromptIR（prompts.ir.json）文件路径。",
        },
        output_path: {
          type: "string",
          description: "提示词 Markdown 输出路径（约定为 prompts.<model>.md）。",
        },
      },
      required: ["prompt_ir_path", "output_path"],
      additionalProperties: false,
    },
  },
  {
    name: "aggregate_knowledge_refs",
    description:
      "读取 script_analysis.json、shot_plan.json 和 prompts.ir.json 的知识引用，" +
      "生成 knowledge_refs.json；PromptIR 的逐镜头引用按镜头顺序展平，" +
      "阶段重跑时整体替换对应阶段数组。",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          pattern: "^run-\\d{8}-\\d{6}$",
          description: "运行目录名。",
        },
        script_analysis_path: {
          type: "string",
          minLength: 1,
          description: "script_analysis.json 路径。",
        },
        shot_plan_path: {
          type: "string",
          minLength: 1,
          description: "shot_plan.json 路径。",
        },
        prompt_ir_path: {
          type: "string",
          minLength: 1,
          description: "prompts.ir.json 路径。",
        },
        output_path: {
          type: "string",
          minLength: 1,
          description: "knowledge_refs.json 输出路径。",
        },
      },
      required: [
        "run_id",
        "script_analysis_path",
        "shot_plan_path",
        "prompt_ir_path",
        "output_path",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "write_warnings",
    description:
      "读取 run.json warnings 与三个阶段产物的 missing_info，按 code + message " +
      "去重并生成中文 Markdown 警告汇总，返回 { output_path, count }。",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          pattern: "^run-\\d{8}-\\d{6}$",
          description: "运行目录名。",
        },
        run_path: {
          type: "string",
          minLength: 1,
          description: "run.json 路径。",
        },
        script_analysis_path: {
          type: "string",
          minLength: 1,
          description: "script_analysis.json 路径。",
        },
        shot_plan_path: {
          type: "string",
          minLength: 1,
          description: "shot_plan.json 路径。",
        },
        prompt_ir_path: {
          type: "string",
          minLength: 1,
          description: "prompts.ir.json 路径。",
        },
        output_path: {
          type: "string",
          minLength: 1,
          description: "warnings.md 输出路径。",
        },
      },
      required: [
        "run_id",
        "run_path",
        "script_analysis_path",
        "shot_plan_path",
        "prompt_ir_path",
        "output_path",
      ],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  if (name === "health") {
    const parsed = parse_health_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await health(parsed.value)) : tool_json(parsed);
  }
  if (name === "read_config") {
    const parsed = parse_empty_arguments(request.params.arguments);
    return parsed.ok ? tool_json(read_config()) : tool_json(parsed);
  }
  if (name === "write_config") {
    return tool_json(
      write_config((request.params.arguments ?? {}) as unknown as WriteConfigInput),
    );
  }
  if (name === "init_knowledge_b") {
    return tool_json(
      await init_knowledge_b(
        (request.params.arguments ?? {}) as unknown as InitKnowledgeBInput,
      ),
    );
  }
  if (name === "scan_knowledge_a") {
    const parsed = parse_empty_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await scan_knowledge_a()) : tool_json(parsed);
  }
  if (name === "read_sync_state") {
    const parsed = parse_empty_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await read_sync_state()) : tool_json(parsed);
  }
  if (name === "build_sync_plan") {
    const parsed = parse_build_sync_plan_arguments(request.params.arguments);
    return parsed.ok
      ? tool_json(build_sync_plan(parsed.value.nodes, parsed.value.sync_records))
      : tool_json(parsed);
  }
  if (name === "fetch_knowledge_a_doc") {
    const parsed = parse_fetch_doc_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await fetch_knowledge_a_doc(parsed.value)) : tool_json(parsed);
  }
  if (name === "replace_doc_cards") {
    const parsed = parse_replace_doc_cards_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await replace_doc_cards(parsed.value)) : tool_json(parsed);
  }
  if (name === "update_doc_sync_state") {
    const parsed = parse_update_doc_sync_state_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await update_doc_sync_state(parsed.value)) : tool_json(parsed);
  }
  if (name === "delete_doc_cards") {
    const parsed = parse_delete_doc_cards_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await delete_doc_cards(parsed.value)) : tool_json(parsed);
  }
  if (name === "refresh_local_index") {
    const parsed = parse_refresh_local_index_arguments(request.params.arguments);
    return parsed.ok ? tool_json(await refresh_local_index(parsed.value)) : tool_json(parsed);
  }
  if (name === "search_knowledge") {
    const parsed = parse_search_knowledge_arguments(request.params.arguments);
    return parsed.ok ? tool_json(search_knowledge(parsed.value)) : tool_json(parsed);
  }
  if (name === "load_knowledge_pack") {
    const parsed = parse_load_knowledge_pack_arguments(request.params.arguments);
    return parsed.ok ? tool_json(load_knowledge_pack(parsed.value)) : tool_json(parsed);
  }
  if (name === "init_run") {
    const parsed = parse_init_run_arguments(request.params.arguments);
    return parsed.ok ? tool_json(init_run(parsed.value)) : tool_json(parsed);
  }
  if (name === "read_run") {
    const parsed = parse_read_run_arguments(request.params.arguments);
    return parsed.ok ? tool_json(read_run(parsed.value)) : tool_json(parsed);
  }
  if (name === "update_run_state") {
    const parsed = parse_update_run_state_arguments(request.params.arguments);
    return parsed.ok ? tool_json(update_run_state(parsed.value)) : tool_json(parsed);
  }
  if (name === "validate_stage_artifact") {
    const parsed = parse_validate_stage_artifact_arguments(request.params.arguments);
    return parsed.ok ? tool_json(validate_stage_artifact(parsed.value)) : tool_json(parsed);
  }
  if (name === "validate_prompt") {
    const parsed = parse_validate_prompt_arguments(request.params.arguments);
    return parsed.ok ? tool_json(validate_prompt(parsed.value)) : tool_json(parsed);
  }
  if (name === "render_prompt") {
    const parsed = parse_render_prompt_arguments(request.params.arguments);
    return parsed.ok ? tool_json(render_prompt(parsed.value)) : tool_json(parsed);
  }
  if (name === "aggregate_knowledge_refs") {
    const parsed = parse_aggregate_knowledge_refs_arguments(request.params.arguments);
    return parsed.ok
      ? tool_json(aggregate_knowledge_refs(parsed.value))
      : tool_json(parsed);
  }
  if (name === "write_warnings") {
    const parsed = parse_write_warnings_arguments(request.params.arguments);
    return parsed.ok ? tool_json(write_warnings(parsed.value)) : tool_json(parsed);
  }
  throw new McpError(ErrorCode.MethodNotFound, `未知工具：${name}`);
});

/** 工具结果统一按原样 JSON 返回；分发层校验失败也走同一形状，不用 JSON-RPC 错误。 */
function tool_json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

type DispatchFailure = {
  ok: false;
  error: { code: "CONFIG_INVALID"; message: string; details?: Record<string, unknown> };
};

type Parsed<T> = { ok: true; value: T } | DispatchFailure;

function invalid_arguments(message: string, details?: Record<string, unknown>): DispatchFailure {
  return {
    ok: false,
    error:
      details === undefined
        ? { code: "CONFIG_INVALID", message }
        : { code: "CONFIG_INVALID", message, details },
  };
}

/** arguments 省略等价于空对象；显式 null / 数组 / 标量按 fail-closed 拒绝。 */
function parse_arguments_object(raw: unknown): Parsed<Record<string, unknown>> {
  if (raw === undefined) {
    return { ok: true, value: {} };
  }
  if (!is_record(raw)) {
    return invalid_arguments("工具入参必须是 JSON 对象。", { field: "arguments" });
  }
  return { ok: true, value: raw };
}

function reject_unknown_keys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): DispatchFailure | undefined {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return invalid_arguments(`入参包含不支持的字段 "${key}"。`, {
        field: key,
        allowed: [...allowed],
      });
    }
  }
  return undefined;
}

function parse_empty_arguments(raw: unknown): Parsed<Record<string, never>> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, []);
  return unknown_key === undefined ? { ok: true, value: {} } : unknown_key;
}

/** health 只接受可选的 `pending_config`；其余字段 fail-closed。 */
function parse_health_arguments(raw: unknown): Parsed<HealthOptions> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, ["pending_config"]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const pending_config = parsed.value.pending_config;
  if (pending_config !== undefined && !is_record(pending_config)) {
    return invalid_arguments('入参字段 "pending_config" 期望对象。', {
      field: "pending_config",
    });
  }
  return { ok: true, value: pending_config === undefined ? {} : { pending_config } };
}

function parse_fetch_doc_arguments(
  raw: unknown,
): Parsed<{ doc: string; expand_references?: boolean; max_references?: number }> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, [
    "doc",
    "expand_references",
    "max_references",
  ]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const doc = parsed.value.doc;
  if (typeof doc !== "string" || doc.trim() === "") {
    return invalid_arguments('入参字段 "doc" 期望非空字符串。', { field: "doc" });
  }
  const expand_references = parsed.value.expand_references;
  if (expand_references !== undefined && typeof expand_references !== "boolean") {
    return invalid_arguments('入参字段 "expand_references" 期望布尔值。', {
      field: "expand_references",
    });
  }
  const max_references = parsed.value.max_references;
  if (
    max_references !== undefined &&
    (typeof max_references !== "number" || !Number.isFinite(max_references))
  ) {
    return invalid_arguments('入参字段 "max_references" 期望数字。', {
      field: "max_references",
    });
  }
  return {
    ok: true,
    value: {
      doc,
      ...(expand_references === undefined ? {} : { expand_references }),
      ...(max_references === undefined ? {} : { max_references }),
    },
  };
}

/** build_sync_plan 消费的字段；只校验类型，不改写调用方数据。 */
const PLAN_NODE_STRING_FIELDS = [
  "node_token",
  "obj_token",
  "title",
  "path",
  "obj_edit_time",
] as const;
const PLAN_SYNC_STATE_STRING_FIELDS = [
  "source_doc_token",
  "source_node_token",
  "source_path",
  "source_title",
  "obj_edit_time",
] as const;

function parse_build_sync_plan_arguments(
  raw: unknown,
): Parsed<{ nodes: ScannedNode[]; sync_records: SyncState[] }> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, ["nodes", "sync_records"]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const nodes = parsed.value.nodes;
  if (!Array.isArray(nodes)) {
    return invalid_arguments('入参字段 "nodes" 期望数组（scan_knowledge_a 返回的 nodes[]）。', {
      field: "nodes",
    });
  }
  const sync_records = parsed.value.sync_records;
  if (!Array.isArray(sync_records)) {
    return invalid_arguments(
      '入参字段 "sync_records" 期望数组（read_sync_state 返回的 records[]）。',
      { field: "sync_records" },
    );
  }
  const node_error = require_string_fields(nodes, PLAN_NODE_STRING_FIELDS, "nodes");
  if (node_error !== undefined) {
    return node_error;
  }
  const state_error = require_string_fields(
    sync_records,
    PLAN_SYNC_STATE_STRING_FIELDS,
    "sync_records",
  );
  if (state_error !== undefined) {
    return state_error;
  }
  return { ok: true, value: { nodes: nodes as ScannedNode[], sync_records: sync_records as SyncState[] } };
}

function require_string_fields(
  entries: readonly unknown[],
  fields: readonly string[],
  field_name: string,
): DispatchFailure | undefined {
  for (const [index, entry] of entries.entries()) {
    if (!is_record(entry)) {
      return invalid_arguments(`入参字段 "${field_name}[${index}]" 期望对象。`, {
        field: `${field_name}[${index}]`,
      });
    }
    for (const key of fields) {
      if (typeof entry[key] !== "string") {
        return invalid_arguments(`入参字段 "${field_name}[${index}].${key}" 期望字符串。`, {
          field: `${field_name}[${index}].${key}`,
        });
      }
    }
  }
  return undefined;
}

function parse_replace_doc_cards_arguments(raw: unknown): Parsed<ReplaceDocCardsInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, [
    "source_doc_token",
    "cards",
    "metadata_patch",
    "dry_run",
  ]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const source_doc_token = parsed.value.source_doc_token;
  if (typeof source_doc_token !== "string" || source_doc_token.trim() === "") {
    return invalid_arguments('入参字段 "source_doc_token" 期望非空字符串。', {
      field: "source_doc_token",
    });
  }
  const cards = parsed.value.cards;
  if (cards !== undefined && !Array.isArray(cards)) {
    return invalid_arguments('入参字段 "cards" 期望数组。', { field: "cards" });
  }
  const metadata_patch = parsed.value.metadata_patch;
  if (metadata_patch !== undefined && !is_record(metadata_patch)) {
    return invalid_arguments('入参字段 "metadata_patch" 期望对象。', { field: "metadata_patch" });
  }
  const dry_run = parsed.value.dry_run;
  if (dry_run !== undefined && typeof dry_run !== "boolean") {
    return invalid_arguments('入参字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return {
    ok: true,
    value: {
      source_doc_token,
      ...(cards === undefined ? {} : { cards }),
      ...(metadata_patch === undefined ? {} : { metadata_patch }),
      ...(dry_run === undefined ? {} : { dry_run }),
    },
  };
}

function parse_update_doc_sync_state_arguments(
  raw: unknown,
): Parsed<UpdateDocSyncStateInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, ["record"]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const record = parsed.value.record;
  if (!is_record(record)) {
    return invalid_arguments('入参字段 "record" 期望 SyncState 对象。', { field: "record" });
  }
  // record 的具体字段由 update_doc_sync_state 内部按 schema 校验；这里只挡非对象。
  return {
    ok: true,
    value: { record: record as unknown as UpdateDocSyncStateInput["record"] },
  };
}

function parse_delete_doc_cards_arguments(
  raw: unknown,
): Parsed<{ source_doc_token: string; dry_run?: boolean }> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, ["source_doc_token", "dry_run"]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const source_doc_token = parsed.value.source_doc_token;
  if (typeof source_doc_token !== "string" || source_doc_token.trim() === "") {
    return invalid_arguments('入参字段 "source_doc_token" 期望非空字符串。', {
      field: "source_doc_token",
    });
  }
  const dry_run = parsed.value.dry_run;
  if (dry_run !== undefined && typeof dry_run !== "boolean") {
    return invalid_arguments('入参字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return {
    ok: true,
    value: { source_doc_token, ...(dry_run === undefined ? {} : { dry_run }) },
  };
}

function parse_refresh_local_index_arguments(
  raw: unknown,
): Parsed<RefreshLocalIndexInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, ["dry_run"]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const dry_run = parsed.value.dry_run;
  if (dry_run !== undefined && typeof dry_run !== "boolean") {
    return invalid_arguments('入参字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return { ok: true, value: dry_run === undefined ? {} : { dry_run } };
}

/**
 * 分发层只做「对象 + 未知字段」这层 fail-closed 校验；字段类型与取值范围由
 * `search_knowledge` 内部统一校验（同一套 CONFIG_INVALID 形状 + details.field），
 * 避免两处校验漂移。
 */
function parse_search_knowledge_arguments(raw: unknown): Parsed<SearchKnowledgeInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, SEARCH_KNOWLEDGE_FIELDS);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  return { ok: true, value: parsed.value as SearchKnowledgeInput };
}

/**
 * 分发层只做「对象 + 未知字段」这层 fail-closed 校验；字段类型与取值范围由
 * `load_knowledge_pack` 内部统一校验（同一套 CONFIG_INVALID 形状 + details.field），
 * 避免两处校验漂移。
 */
function parse_load_knowledge_pack_arguments(raw: unknown): Parsed<LoadKnowledgePackInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, LOAD_KNOWLEDGE_PACK_FIELDS);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  return { ok: true, value: parsed.value as LoadKnowledgePackInput };
}

function parse_init_run_arguments(raw: unknown): Parsed<InitRunInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, [
    "workspace_root",
    "input_mode",
    "project_id",
    "target_model",
    "aspect_ratio",
    "input_references",
    "display_timeline",
  ]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }

  const workspace_root = parsed.value.workspace_root;
  if (typeof workspace_root !== "string" || workspace_root.trim() === "") {
    return invalid_arguments('入参字段 "workspace_root" 期望非空字符串。', {
      field: "workspace_root",
    });
  }
  const input_mode = parsed.value.input_mode;
  if (
    typeof input_mode !== "string" ||
    !(RUN_INPUT_MODE_VALUES as readonly string[]).includes(input_mode)
  ) {
    return invalid_arguments(
      `入参字段 "input_mode" 期望以下之一：${RUN_INPUT_MODE_VALUES.join("、")}。`,
      { field: "input_mode" },
    );
  }
  const project_id = parsed.value.project_id;
  if (typeof project_id !== "string" || project_id.trim() === "") {
    return invalid_arguments('入参字段 "project_id" 期望非空字符串。', {
      field: "project_id",
    });
  }
  const target_model = parsed.value.target_model;
  if (
    typeof target_model !== "string" ||
    !(RUN_TARGET_MODEL_VALUES as readonly string[]).includes(target_model)
  ) {
    return invalid_arguments(
      `入参字段 "target_model" 期望以下之一：${RUN_TARGET_MODEL_VALUES.join("、")}。`,
      { field: "target_model" },
    );
  }
  const aspect_ratio = parsed.value.aspect_ratio;
  if (
    aspect_ratio !== undefined &&
    (typeof aspect_ratio !== "string" ||
      !(RUN_ASPECT_RATIO_VALUES as readonly string[]).includes(aspect_ratio))
  ) {
    return invalid_arguments(
      `入参字段 "aspect_ratio" 期望以下之一：${RUN_ASPECT_RATIO_VALUES.join("、")}。`,
      { field: "aspect_ratio" },
    );
  }

  const display_timeline = parsed.value.display_timeline;
  if (display_timeline !== undefined && typeof display_timeline !== "boolean") {
    return invalid_arguments('入参字段 "display_timeline" 期望布尔值。', { field: "display_timeline" });
  }

  return {
    ok: true,
    value: {
      workspace_root,
      input_mode: input_mode as InitRunInput["input_mode"],
      project_id,
      target_model: target_model as InitRunInput["target_model"],
      ...(aspect_ratio === undefined
        ? {}
        : { aspect_ratio: aspect_ratio as InitRunInput["aspect_ratio"] }),
      ...(parsed.value.input_references === undefined
        ? {}
        : { input_references: parsed.value.input_references as Array<Record<string, unknown>> }),
      ...(display_timeline === undefined ? {} : { display_timeline }),
    },
  };
}

function parse_read_run_arguments(raw: unknown): Parsed<ReadRunInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, ["workspace_root", "run_id"]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }

  const workspace_root = parsed.value.workspace_root;
  if (typeof workspace_root !== "string" || workspace_root.trim() === "") {
    return invalid_arguments('入参字段 "workspace_root" 期望非空字符串。', {
      field: "workspace_root",
    });
  }
  const run_id = parsed.value.run_id;
  if (typeof run_id !== "string" || !/^run-\d{8}-\d{6}$/.test(run_id)) {
    return invalid_arguments('入参字段 "run_id" 期望格式 run-YYYYMMDD-HHMMSS。', {
      field: "run_id",
    });
  }

  return { ok: true, value: { workspace_root, run_id } };
}

function parse_update_run_state_arguments(
  raw: unknown,
): Parsed<UpdateRunStateInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unknown_key = reject_unknown_keys(parsed.value, [
    "workspace_root",
    "run_id",
    "stage",
    "status",
    "artifact",
    "warnings",
  ]);
  if (unknown_key !== undefined) {
    return unknown_key;
  }

  const workspace_root = parsed.value.workspace_root;
  if (typeof workspace_root !== "string" || workspace_root.trim() === "") {
    return invalid_arguments('入参字段 "workspace_root" 期望非空字符串。', {
      field: "workspace_root",
    });
  }
  const run_id = parsed.value.run_id;
  if (typeof run_id !== "string" || !/^run-\d{8}-\d{6}$/.test(run_id)) {
    return invalid_arguments('入参字段 "run_id" 期望格式 run-YYYYMMDD-HHMMSS。', {
      field: "run_id",
    });
  }
  const stage = parsed.value.stage;
  if (typeof stage !== "string" || !(RUN_STAGE_VALUES as readonly string[]).includes(stage)) {
    return invalid_arguments(
      `入参字段 "stage" 期望以下之一：${RUN_STAGE_VALUES.join("、")}。`,
      { field: "stage" },
    );
  }
  const status = parsed.value.status;
  if (
    typeof status !== "string" ||
    !(RUN_STAGE_STATUS_VALUES as readonly string[]).includes(status)
  ) {
    return invalid_arguments(
      `入参字段 "status" 期望以下之一：${RUN_STAGE_STATUS_VALUES.join("、")}。`,
      { field: "status" },
    );
  }
  const artifact = parsed.value.artifact;
  if (
    artifact !== undefined &&
    artifact !== null &&
    (typeof artifact !== "string" || artifact.trim() === "")
  ) {
    return invalid_arguments('入参字段 "artifact" 期望非空字符串或 null。', {
      field: "artifact",
    });
  }
  const warnings = parsed.value.warnings;
  if (warnings !== undefined && !Array.isArray(warnings)) {
    return invalid_arguments('入参字段 "warnings" 期望数组。', { field: "warnings" });
  }

  return {
    ok: true,
    value: {
      workspace_root,
      run_id,
      stage: stage as UpdateRunStateInput["stage"],
      status: status as UpdateRunStateInput["status"],
      ...(artifact === undefined ? {} : { artifact: artifact as string | null }),
      ...(warnings === undefined ? {} : { warnings: warnings as UpdateRunStateInput["warnings"] }),
    },
  };
}

function parse_validate_stage_artifact_arguments(
  raw: unknown,
): Parsed<ValidateStageArtifactInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) return parsed;
  const unknown_key = reject_unknown_keys(parsed.value, ["stage", "path", "script_analysis_path"]);
  if (unknown_key !== undefined) return unknown_key;
  const stage = parsed.value.stage;
  if (typeof stage !== "string" || !is_stage_artifact_stage(stage)) {
    return invalid_arguments(`入参字段 "stage" 期望以下之一：${STAGE_ARTIFACT_STAGE_VALUES.join("、")}。`, { field: "stage" });
  }
  const artifact_path = parsed.value.path;
  if (typeof artifact_path !== "string" || artifact_path.trim() === "") {
    return invalid_arguments('入参字段 "path" 期望非空字符串。', { field: "path" });
  }
  const script_analysis_path = parse_optional_path(parsed.value.script_analysis_path, "script_analysis_path");
  if (!script_analysis_path.ok) return script_analysis_path;
  return { ok: true, value: { stage, path: artifact_path, ...(script_analysis_path.value === undefined ? {} : { script_analysis_path: script_analysis_path.value }) } };
}

function is_stage_artifact_stage(value: string): value is StageArtifactStage {
  return (STAGE_ARTIFACT_STAGE_VALUES as readonly string[]).includes(value);
}

function parse_validate_prompt_arguments(raw: unknown): Parsed<ValidatePromptInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) return parsed;
  const unknown_key = reject_unknown_keys(parsed.value, ["prompt_ir_path", "shot_plan_path", "script_analysis_path"]);
  if (unknown_key !== undefined) return unknown_key;
  const prompt_ir_path = parsed.value.prompt_ir_path;
  if (typeof prompt_ir_path !== "string" || prompt_ir_path.trim() === "") {
    return invalid_arguments('入参字段 "prompt_ir_path" 期望非空字符串。', { field: "prompt_ir_path" });
  }
  const shot_plan_path = parse_optional_path(parsed.value.shot_plan_path, "shot_plan_path");
  if (!shot_plan_path.ok) return shot_plan_path;
  const script_analysis_path = parse_optional_path(parsed.value.script_analysis_path, "script_analysis_path");
  if (!script_analysis_path.ok) return script_analysis_path;
  return { ok: true, value: { prompt_ir_path, ...(shot_plan_path.value === undefined ? {} : { shot_plan_path: shot_plan_path.value }), ...(script_analysis_path.value === undefined ? {} : { script_analysis_path: script_analysis_path.value }) } };
}

function parse_render_prompt_arguments(raw: unknown): Parsed<RenderPromptInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) return parsed;
  const unknown_key = reject_unknown_keys(parsed.value, ["prompt_ir_path", "output_path", "shot_plan_path", "script_analysis_path"]);
  if (unknown_key !== undefined) return unknown_key;
  const prompt_ir_path = parsed.value.prompt_ir_path;
  if (typeof prompt_ir_path !== "string" || prompt_ir_path.trim() === "") {
    return invalid_arguments('入参字段 "prompt_ir_path" 期望非空字符串。', { field: "prompt_ir_path" });
  }
  const output_path = parsed.value.output_path;
  if (typeof output_path !== "string" || output_path.trim() === "") {
    return invalid_arguments('入参字段 "output_path" 期望非空字符串。', { field: "output_path" });
  }
  const shot_plan_path = parse_optional_path(parsed.value.shot_plan_path, "shot_plan_path");
  if (!shot_plan_path.ok) return shot_plan_path;
  const script_analysis_path = parse_optional_path(parsed.value.script_analysis_path, "script_analysis_path");
  if (!script_analysis_path.ok) return script_analysis_path;
  return { ok: true, value: { prompt_ir_path, output_path, ...(shot_plan_path.value === undefined ? {} : { shot_plan_path: shot_plan_path.value }), ...(script_analysis_path.value === undefined ? {} : { script_analysis_path: script_analysis_path.value }) } };
}

function parse_aggregate_knowledge_refs_arguments(
  raw: unknown,
): Parsed<AggregateKnowledgeRefsInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const fields = [
    "run_id",
    "script_analysis_path",
    "shot_plan_path",
    "prompt_ir_path",
    "output_path",
  ] as const;
  const unknown_key = reject_unknown_keys(parsed.value, fields);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const required = require_non_empty_string_fields(parsed.value, fields);
  if (!required.ok) {
    return required;
  }
  const run_id = required.value.run_id;
  if (!/^run-\d{8}-\d{6}$/.test(run_id)) {
    return invalid_arguments('入参字段 "run_id" 期望格式 run-YYYYMMDD-HHMMSS。', {
      field: "run_id",
    });
  }
  return {
    ok: true,
    value: {
      run_id,
      script_analysis_path: required.value.script_analysis_path,
      shot_plan_path: required.value.shot_plan_path,
      prompt_ir_path: required.value.prompt_ir_path,
      output_path: required.value.output_path,
    },
  };
}

function parse_write_warnings_arguments(raw: unknown): Parsed<WriteWarningsInput> {
  const parsed = parse_arguments_object(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const fields = [
    "run_id",
    "run_path",
    "script_analysis_path",
    "shot_plan_path",
    "prompt_ir_path",
    "output_path",
  ] as const;
  const unknown_key = reject_unknown_keys(parsed.value, fields);
  if (unknown_key !== undefined) {
    return unknown_key;
  }
  const required = require_non_empty_string_fields(parsed.value, fields);
  if (!required.ok) {
    return required;
  }
  const run_id = required.value.run_id;
  if (!/^run-\d{8}-\d{6}$/.test(run_id)) {
    return invalid_arguments('入参字段 "run_id" 期望格式 run-YYYYMMDD-HHMMSS。', {
      field: "run_id",
    });
  }
  return {
    ok: true,
    value: {
      run_id,
      run_path: required.value.run_path,
      script_analysis_path: required.value.script_analysis_path,
      shot_plan_path: required.value.shot_plan_path,
      prompt_ir_path: required.value.prompt_ir_path,
      output_path: required.value.output_path,
    },
  };
}

function parse_optional_path(value: unknown, field: string): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") {
    return invalid_arguments(`入参字段 "${field}" 期望非空字符串。`, { field });
  }
  return { ok: true, value };
}

function require_non_empty_string_fields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Parsed<Record<string, string>> {
  const value: Record<string, string> = {};
  for (const field of fields) {
    const entry = record[field];
    if (typeof entry !== "string" || entry.trim() === "") {
      return invalid_arguments(`入参字段 "${field}" 期望非空字符串。`, { field });
    }
    value[field] = entry;
  }
  return { ok: true, value };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("script2shot MCP Server 启动失败:", error);
  process.exit(1);
});
