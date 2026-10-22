/**
 * 运行级产物聚合（references/stage-conventions.md §4；Task 4d-2）。
 *
 * 聚合层只做确定性搬运：
 * - `aggregate_knowledge_refs` 从三个阶段主产物读取引用，按固定阶段顺序写出
 *   `knowledge_refs.json`；PromptIR 的逐镜头引用按镜头数组顺序展平；
 * - `write_warnings` 读取 run.json 的运行级 warnings 与阶段产物 `missing_info`，
 *   按 code + message 去重后输出中文 Markdown。
 *
 * 读文件与写文件的异常都在本模块转换为结构化失败，不穿透 MCP 边界。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const KNOWLEDGE_REF_STAGE_VALUES = [
  "script_breakdown",
  "shot_planning",
  "shot_prompting",
] as const;

export type KnowledgeRefStage = (typeof KNOWLEDGE_REF_STAGE_VALUES)[number];

export type KnowledgeRefUsage = "used" | "dropped_by_budget";

export interface KnowledgeRefEntry {
  card_id: string;
  scene_id: string;
  shot_id: string | null;
  query: string;
  usage: KnowledgeRefUsage;
  source_doc_token: string;
  source_path: string;
  source_revision: number;
  last_synced_at: string;
}

export interface AggregateKnowledgeRefsInput {
  run_id: string;
  script_analysis_path: string;
  shot_plan_path: string;
  prompt_ir_path: string;
  output_path: string;
}

export interface AggregateKnowledgeRefsCounts {
  script_breakdown: number;
  shot_planning: number;
  shot_prompting: number;
}

export interface AggregateKnowledgeRefsSuccess {
  output_path: string;
  counts: AggregateKnowledgeRefsCounts;
}

export interface WriteWarningsInput {
  run_id: string;
  run_path: string;
  script_analysis_path: string;
  shot_plan_path: string;
  prompt_ir_path: string;
  output_path: string;
}

export interface WriteWarningsSuccess {
  output_path: string;
  count: number;
}

export type AggregationErrorCode =
  | "CONFIG_INVALID"
  | "STAGE_ARTIFACT_MISSING"
  | "STAGE_ARTIFACT_UNREADABLE"
  | "STAGE_ARTIFACT_INVALID_JSON"
  | "STAGE_ARTIFACT_INVALID"
  | "RUN_NOT_FOUND"
  | "RUN_UNREADABLE"
  | "RUN_INVALID_JSON"
  | "RUN_SCHEMA_INVALID"
  | "AGGREGATE_WRITE_FAILED"
  | "INTERNAL";

export interface AggregationFailure {
  ok: false;
  error: {
    code: AggregationErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type AggregateKnowledgeRefsResult =
  | AggregateKnowledgeRefsSuccess
  | AggregationFailure;

export type WriteWarningsResult = WriteWarningsSuccess | AggregationFailure;

interface RunWarning {
  code: string;
  message: string;
  refs?: string[];
}

interface StringInputResult {
  ok: true;
  value: Record<string, string>;
}

type JsonReadResult =
  | { ok: true; value: unknown }
  | AggregationFailure;

type KnowledgeRefsResult =
  | { ok: true; value: KnowledgeRefEntry[] }
  | AggregationFailure;

type WarningsResult =
  | { ok: true; value: RunWarning[] }
  | AggregationFailure;

const RUN_ID_PATTERN = /^run-\d{8}-\d{6}$/;

const AGGREGATE_KNOWLEDGE_REFS_FIELDS = [
  "run_id",
  "script_analysis_path",
  "shot_plan_path",
  "prompt_ir_path",
  "output_path",
] as const;

const WRITE_WARNINGS_FIELDS = [
  "run_id",
  "run_path",
  "script_analysis_path",
  "shot_plan_path",
  "prompt_ir_path",
  "output_path",
] as const;

const STAGE_ARTIFACT_READ_CODES = {
  missing: "STAGE_ARTIFACT_MISSING",
  unreadable: "STAGE_ARTIFACT_UNREADABLE",
  invalid_json: "STAGE_ARTIFACT_INVALID_JSON",
} as const;

const RUN_READ_CODES = {
  missing: "RUN_NOT_FOUND",
  unreadable: "RUN_UNREADABLE",
  invalid_json: "RUN_INVALID_JSON",
} as const;

export function aggregate_knowledge_refs(
  input: AggregateKnowledgeRefsInput,
): AggregateKnowledgeRefsResult {
  try {
    const args = validate_input(
      input,
      AGGREGATE_KNOWLEDGE_REFS_FIELDS,
      AGGREGATE_KNOWLEDGE_REFS_FIELDS,
    );
    if (!args.ok) {
      return args;
    }
    const run_id = validate_run_id(args.value.run_id);
    if (!run_id.ok) {
      return run_id;
    }

    const script_analysis = read_json_file(
      args.value.script_analysis_path,
      STAGE_ARTIFACT_READ_CODES,
      { stage: "script_breakdown" },
    );
    if (!script_analysis.ok) {
      return script_analysis;
    }
    const script_refs = read_top_level_refs(
      script_analysis.value,
      "script_breakdown",
      args.value.script_analysis_path,
    );
    if (!script_refs.ok) {
      return script_refs;
    }

    const shot_plan = read_json_file(
      args.value.shot_plan_path,
      STAGE_ARTIFACT_READ_CODES,
      { stage: "shot_planning" },
    );
    if (!shot_plan.ok) {
      return shot_plan;
    }
    const shot_refs = read_top_level_refs(
      shot_plan.value,
      "shot_planning",
      args.value.shot_plan_path,
    );
    if (!shot_refs.ok) {
      return shot_refs;
    }

    const prompt_ir = read_json_file(
      args.value.prompt_ir_path,
      STAGE_ARTIFACT_READ_CODES,
      { stage: "shot_prompting" },
    );
    if (!prompt_ir.ok) {
      return prompt_ir;
    }
    const prompt_refs = read_prompt_refs(prompt_ir.value, args.value.prompt_ir_path);
    if (!prompt_refs.ok) {
      return prompt_refs;
    }

    const document = {
      run_id: run_id.value,
      stages: {
        script_breakdown: script_refs.value,
        shot_planning: shot_refs.value,
        shot_prompting: prompt_refs.value,
      },
    };
    const write_error = write_text(
      args.value.output_path,
      `${JSON.stringify(document, null, 2)}\n`,
    );
    if (write_error !== undefined) {
      return write_error;
    }

    return {
      output_path: args.value.output_path,
      counts: {
        script_breakdown: script_refs.value.length,
        shot_planning: shot_refs.value.length,
        shot_prompting: prompt_refs.value.length,
      },
    };
  } catch (error) {
    return failure("INTERNAL", "聚合知识引用失败。", {
      reason: describe_error(error),
    });
  }
}

export function write_warnings(input: WriteWarningsInput): WriteWarningsResult {
  try {
    const args = validate_input(input, WRITE_WARNINGS_FIELDS, WRITE_WARNINGS_FIELDS);
    if (!args.ok) {
      return args;
    }
    const run_id = validate_run_id(args.value.run_id);
    if (!run_id.ok) {
      return run_id;
    }

    const run = read_json_file(args.value.run_path, RUN_READ_CODES);
    if (!run.ok) {
      return run;
    }
    const run_warnings = read_run_warnings(run.value, args.value.run_path);
    if (!run_warnings.ok) {
      return run_warnings;
    }

    const script_analysis = read_json_file(
      args.value.script_analysis_path,
      STAGE_ARTIFACT_READ_CODES,
      { stage: "script_breakdown" },
    );
    if (!script_analysis.ok) {
      return script_analysis;
    }
    const script_missing_info = read_missing_info(
      script_analysis.value,
      "script_breakdown",
      args.value.script_analysis_path,
    );
    if (!script_missing_info.ok) {
      return script_missing_info;
    }

    const shot_plan = read_json_file(
      args.value.shot_plan_path,
      STAGE_ARTIFACT_READ_CODES,
      { stage: "shot_planning" },
    );
    if (!shot_plan.ok) {
      return shot_plan;
    }
    const shot_missing_info = read_missing_info(
      shot_plan.value,
      "shot_planning",
      args.value.shot_plan_path,
    );
    if (!shot_missing_info.ok) {
      return shot_missing_info;
    }

    const prompt_ir = read_json_file(
      args.value.prompt_ir_path,
      STAGE_ARTIFACT_READ_CODES,
      { stage: "shot_prompting" },
    );
    if (!prompt_ir.ok) {
      return prompt_ir;
    }
    const prompt_missing_info = read_missing_info(
      prompt_ir.value,
      "shot_prompting",
      args.value.prompt_ir_path,
    );
    if (!prompt_missing_info.ok) {
      return prompt_missing_info;
    }

    const warnings = deduplicate_warnings([
      ...run_warnings.value,
      ...script_missing_info.value,
      ...shot_missing_info.value,
      ...prompt_missing_info.value,
    ]);
    const write_error = write_text(
      args.value.output_path,
      render_warnings_markdown(run_id.value, warnings),
    );
    if (write_error !== undefined) {
      return write_error;
    }

    return { output_path: args.value.output_path, count: warnings.length };
  } catch (error) {
    return failure("INTERNAL", "聚合 warnings 失败。", {
      reason: describe_error(error),
    });
  }
}

function validate_input(
  raw: unknown,
  allowed: readonly string[],
  required: readonly string[],
): StringInputResult | AggregationFailure {
  if (!is_record(raw)) {
    return failure("CONFIG_INVALID", "工具入参必须是 JSON 对象。", {
      field: "arguments",
    });
  }

  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return failure("CONFIG_INVALID", `入参包含不支持的字段 "${key}"。`, {
        field: key,
        allowed: [...allowed],
      });
    }
  }

  const value: Record<string, string> = {};
  for (const field of required) {
    const entry = raw[field];
    if (typeof entry !== "string" || entry.trim() === "") {
      return failure("CONFIG_INVALID", `入参字段 "${field}" 期望非空字符串。`, {
        field,
      });
    }
    value[field] = entry;
  }
  return { ok: true, value };
}

function validate_run_id(value: string): { ok: true; value: string } | AggregationFailure {
  if (!RUN_ID_PATTERN.test(value)) {
    return failure(
      "CONFIG_INVALID",
      '入参字段 "run_id" 期望格式 run-YYYYMMDD-HHMMSS。',
      { field: "run_id" },
    );
  }
  return { ok: true, value };
}

function read_json_file(
  file_path: string,
  codes: {
    missing: AggregationErrorCode;
    unreadable: AggregationErrorCode;
    invalid_json: AggregationErrorCode;
  },
  details: Record<string, unknown> = {},
): JsonReadResult {
  let text: string;
  try {
    text = readFileSync(file_path, "utf8");
  } catch (error) {
    const error_code =
      error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const code = error_code === "ENOENT" ? codes.missing : codes.unreadable;
    const label = code === codes.missing ? "不存在" : "不可读";
    return failure(code, `文件${label}：${file_path}（${describe_error(error)}）`, {
      ...details,
      path: file_path,
    });
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return failure(codes.invalid_json, `文件 JSON 非法：${file_path}`, {
      ...details,
      path: file_path,
      reason: describe_error(error),
    });
  }
}

function read_top_level_refs(
  value: unknown,
  stage: Exclude<KnowledgeRefStage, "shot_prompting">,
  file_path: string,
): KnowledgeRefsResult {
  if (!is_record(value) || !Array.isArray(value.knowledge_refs)) {
    return invalid_artifact(
      stage,
      file_path,
      "knowledge_refs",
      "阶段产物缺少 knowledge_refs 数组。",
    );
  }
  return normalize_refs(value.knowledge_refs, stage, file_path, "knowledge_refs");
}

function read_prompt_refs(value: unknown, file_path: string): KnowledgeRefsResult {
  if (!is_record(value) || !Array.isArray(value.shots)) {
    return invalid_artifact(
      "shot_prompting",
      file_path,
      "shots",
      "PromptIR 缺少 shots 数组。",
    );
  }

  const refs: KnowledgeRefEntry[] = [];
  for (const [shot_index, shot] of value.shots.entries()) {
    if (!is_record(shot) || !Array.isArray(shot.knowledge_refs)) {
      return invalid_artifact(
        "shot_prompting",
        file_path,
        `shots[${shot_index}].knowledge_refs`,
        `PromptIR 的 shots[${shot_index}] 缺少 knowledge_refs 数组。`,
      );
    }
    const normalized = normalize_refs(
      shot.knowledge_refs,
      "shot_prompting",
      file_path,
      `shots[${shot_index}].knowledge_refs`,
    );
    if (!normalized.ok) {
      return normalized;
    }
    refs.push(...normalized.value);
  }
  return { ok: true, value: refs };
}

function normalize_refs(
  raw: unknown[],
  stage: KnowledgeRefStage,
  file_path: string,
  field_name: string,
): KnowledgeRefsResult {
  const refs: KnowledgeRefEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    const normalized = normalize_ref(entry, stage, file_path, `${field_name}[${index}]`);
    if (!normalized.ok) {
      return normalized;
    }
    refs.push(normalized.value);
  }
  return { ok: true, value: refs };
}

function normalize_ref(
  value: unknown,
  stage: KnowledgeRefStage,
  file_path: string,
  field_name: string,
): { ok: true; value: KnowledgeRefEntry } | AggregationFailure {
  if (!is_record(value)) {
    return invalid_artifact(stage, file_path, field_name, "knowledge_ref 不是对象。");
  }

  const string_fields = [
    "card_id",
    "scene_id",
    "query",
    "source_doc_token",
    "source_path",
    "last_synced_at",
  ] as const;
  for (const field of string_fields) {
    if (typeof value[field] !== "string") {
      return invalid_artifact(
        stage,
        file_path,
        `${field_name}.${field}`,
        `knowledge_ref 字段 "${field}" 期望字符串。`,
      );
    }
  }

  if (value.shot_id !== null && typeof value.shot_id !== "string") {
    return invalid_artifact(
      stage,
      file_path,
      `${field_name}.shot_id`,
      'knowledge_ref 字段 "shot_id" 期望字符串或 null。',
    );
  }
  if (value.usage !== "used" && value.usage !== "dropped_by_budget") {
    return invalid_artifact(
      stage,
      file_path,
      `${field_name}.usage`,
      'knowledge_ref 字段 "usage" 期望 used 或 dropped_by_budget。',
    );
  }
  if (typeof value.source_revision !== "number" || !Number.isInteger(value.source_revision)) {
    return invalid_artifact(
      stage,
      file_path,
      `${field_name}.source_revision`,
      'knowledge_ref 字段 "source_revision" 期望整数。',
    );
  }

  return {
    ok: true,
    value: {
      card_id: value.card_id as string,
      scene_id: value.scene_id as string,
      shot_id: value.shot_id as string | null,
      query: value.query as string,
      usage: value.usage,
      source_doc_token: value.source_doc_token as string,
      source_path: value.source_path as string,
      source_revision: value.source_revision,
      last_synced_at: value.last_synced_at as string,
    },
  };
}

function read_run_warnings(value: unknown, file_path: string): WarningsResult {
  if (!is_record(value)) {
    return failure("RUN_SCHEMA_INVALID", "run.json 顶层必须是对象。", {
      path: file_path,
    });
  }
  if (value.warnings === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value.warnings)) {
    return failure("RUN_SCHEMA_INVALID", 'run.json 字段 "warnings" 期望数组。', {
      path: file_path,
      field: "warnings",
    });
  }

  const warnings: RunWarning[] = [];
  for (const [index, entry] of value.warnings.entries()) {
    if (!is_record(entry)) {
      return failure("RUN_SCHEMA_INVALID", `run.json warnings[${index}] 期望对象。`, {
        path: file_path,
        field: `warnings[${index}]`,
      });
    }
    if (typeof entry.code !== "string" || entry.code.trim() === "") {
      return failure("RUN_SCHEMA_INVALID", `run.json warnings[${index}].code 期望非空字符串。`, {
        path: file_path,
        field: `warnings[${index}].code`,
      });
    }
    if (typeof entry.message !== "string" || entry.message.trim() === "") {
      return failure(
        "RUN_SCHEMA_INVALID",
        `run.json warnings[${index}].message 期望非空字符串。`,
        { path: file_path, field: `warnings[${index}].message` },
      );
    }
    if (
      entry.refs !== undefined &&
      (!Array.isArray(entry.refs) || entry.refs.some((ref) => typeof ref !== "string"))
    ) {
      return failure("RUN_SCHEMA_INVALID", `run.json warnings[${index}].refs 期望字符串数组。`, {
        path: file_path,
        field: `warnings[${index}].refs`,
      });
    }
    warnings.push({
      code: entry.code,
      message: entry.message,
      ...(entry.refs === undefined ? {} : { refs: [...(entry.refs as string[])] }),
    });
  }
  return { ok: true, value: warnings };
}

function read_missing_info(
  value: unknown,
  stage: KnowledgeRefStage,
  file_path: string,
): WarningsResult {
  if (!is_record(value) || value.missing_info === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value.missing_info)) {
    return invalid_artifact(
      stage,
      file_path,
      "missing_info",
      '阶段产物字段 "missing_info" 期望数组。',
    );
  }

  const warnings: RunWarning[] = [];
  for (const [index, entry] of value.missing_info.entries()) {
    if (!is_record(entry)) {
      return invalid_artifact(
        stage,
        file_path,
        `missing_info[${index}]`,
        "missing_info 条目期望对象。",
      );
    }
    if (typeof entry.code !== "string" || entry.code.trim() === "") {
      return invalid_artifact(
        stage,
        file_path,
        `missing_info[${index}].code`,
        "missing_info 条目的 code 期望非空字符串。",
      );
    }
    if (typeof entry.message !== "string" || entry.message.trim() === "") {
      return invalid_artifact(
        stage,
        file_path,
        `missing_info[${index}].message`,
        "missing_info 条目的 message 期望非空字符串。",
      );
    }

    let refs: string[] | undefined;
    if (typeof entry.scene_id === "string") {
      refs = [entry.scene_id];
    } else if (
      Array.isArray(entry.refs) &&
      entry.refs.every((ref) => typeof ref === "string")
    ) {
      refs = [...entry.refs];
    }

    warnings.push({
      code: entry.code,
      message: entry.message,
      ...(refs === undefined ? {} : { refs }),
    });
  }
  return { ok: true, value: warnings };
}

function deduplicate_warnings(warnings: RunWarning[]): RunWarning[] {
  const seen = new Set<string>();
  const deduplicated: RunWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}\u0000${warning.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduplicated.push(warning);
  }
  return deduplicated;
}

function render_warnings_markdown(run_id: string, warnings: RunWarning[]): string {
  const lines = [
    "# 警告汇总",
    "",
    `- 运行：\`${run_id}\``,
    `- 警告数：${warnings.length}`,
  ];

  if (warnings.length === 0) {
    lines.push("", "无警告。");
  } else {
    for (const [index, warning] of warnings.entries()) {
      lines.push("", `## ${index + 1}. ${warning.code}`, "", warning.message);
      if (warning.refs !== undefined && warning.refs.length > 0) {
        lines.push(
          "",
          `引用：${warning.refs.map((ref) => `\`${ref}\``).join("、")}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function invalid_artifact(
  stage: KnowledgeRefStage,
  file_path: string,
  field: string,
  message: string,
): AggregationFailure {
  return failure("STAGE_ARTIFACT_INVALID", `${message}（阶段：${stage}）`, {
    stage,
    path: file_path,
    field,
  });
}

function write_text(file_path: string, content: string): AggregationFailure | undefined {
  try {
    mkdirSync(path.dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf8");
    return undefined;
  } catch (error) {
    return failure("AGGREGATE_WRITE_FAILED", `写入聚合产物失败：${file_path}`, {
      path: file_path,
      reason: describe_error(error),
    });
  }
}

function failure(
  code: AggregationErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AggregationFailure {
  return {
    ok: false,
    error:
      details === undefined
        ? { code, message }
        : { code, message, details },
  };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
