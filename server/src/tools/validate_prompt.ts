/**
 * PromptIR 硬规则校验（架构 §11.3–§11.4；Task 4c-2）。
 *
 * 校验分两层：
 * 1. 结构层：复用 `validate_prompt_ir`（Task 4c-1 的冻结 schema）。结构不成立时
 *    直接返回，不再进入模型硬规则——结构错位时越界 / 禁止项的结论没有意义。
 * 2. 硬规则层：`duration` 落在规则文件区间、`aspect_ratio` 在规则文件集合内、
 *    逐镜头 `target_model` 与顶层及规则文件一致、禁止项词表不得命中提示词正文字段。
 *
 * 输出固定为 `{ ok, errors[] }`，`errors[] = { shot_id, field, code, message }`，
 * `code` 只取 `MISSING_FIELD` / `OUT_OF_RANGE` / `FORBIDDEN_TERM` / `MODEL_MISMATCH`
 * （brief 冻结集合）。文件缺失 / 不可读 / JSON 非法返回单条结构化错误，用
 * `field: "prompt_ir_path"` 标记问题出在入参文件本身，不穿透 MCP 边界。
 *
 * 顺序确定性：镜头顺序 → 镜头内 PromptIR 字段顺序（`SHOT_FIELD_ORDER`，与
 * `schemas/prompt_ir.schema.json` 的 shot 属性顺序一致）；同一字段内先
 * MISSING_FIELD，再范围 / 模型一致，最后禁止项（按规则文件词表顺序）。结果不含时间戳。
 */

import { readFileSync } from "node:fs";
import { load_model_rules, type ModelRules } from "../rules.js";
import { validate_prompt_ir, type SchemaValidationError } from "../schemas.js";

export type PromptValidationCode =
  | "MISSING_FIELD"
  | "OUT_OF_RANGE"
  | "FORBIDDEN_TERM"
  | "MODEL_MISMATCH";

export interface PromptValidationError {
  shot_id: string;
  field: string;
  code: PromptValidationCode;
  message: string;
}

export interface ValidatePromptInput {
  prompt_ir_path: string;
}

export interface ValidatePromptResult {
  ok: boolean;
  errors: PromptValidationError[];
}

/** 镜头字段的固定顺序，与 `schemas/prompt_ir.schema.json` 的 shot 属性顺序一致。 */
const SHOT_FIELD_ORDER = [
  "shot_id",
  "target_model",
  "duration",
  "aspect_ratio",
  "subject",
  "action",
  "setting",
  "time",
  "camera_angle",
  "camera_movement",
  "lighting",
  "color",
  "style",
  "continuity",
  "negative_prompt",
  "knowledge_refs",
] as const;

/**
 * 禁止项扫描范围：最终会渲染进提示词正文的文本字段（画面 / 动作 / 场景 / 时间 /
 * 机位 / 运镜 / 光影 / 色调 / 风格），另加 `continuity` 的两个状态字段与
 * `negative_prompt[]` 条目。`knowledge_refs` 是知识溯源元数据，不渲染进正文，不扫描。
 */
const FORBIDDEN_SCAN_FIELDS = [
  "subject",
  "action",
  "setting",
  "time",
  "camera_angle",
  "camera_movement",
  "lighting",
  "color",
  "style",
] as const;

const CONTINUITY_TEXT_FIELDS = ["character_state", "environment_state"] as const;

/** 文件级问题的占位 `field`：问题出在入参路径本身，而不是某个 PromptIR 字段。 */
const PROMPT_IR_PATH_FIELD = "prompt_ir_path";

export function validate_prompt(input: ValidatePromptInput): ValidatePromptResult {
  const loaded = read_prompt_ir(input.prompt_ir_path);
  if (!loaded.ok) {
    return { ok: false, errors: loaded.errors };
  }

  const schema_result = validate_prompt_ir(loaded.value);
  if (!schema_result.ok) {
    return { ok: false, errors: map_schema_errors(loaded.value, schema_result.errors) };
  }

  const document = loaded.value as PromptIrDocument;
  const target_model = document.target_model;

  const rules_result = load_model_rules(target_model);
  if (!rules_result.ok) {
    return {
      ok: false,
      errors: [
        {
          shot_id: "",
          field: "target_model",
          code: "MODEL_MISMATCH",
          message:
            `PromptIR 的目标模型 "${target_model}" 没有对应的模型规则文件：` +
            `${rules_result.error.message}`,
        },
      ],
    };
  }
  const rules = rules_result.rules;

  const errors = validate_hard_rules(document, rules);
  return { ok: errors.length === 0, errors };
}

interface PromptIrDocument {
  target_model: string;
  shots: Array<Record<string, unknown>>;
}

function validate_hard_rules(
  document: PromptIrDocument,
  rules: ModelRules,
): PromptValidationError[] {
  const required_fields = new Set(rules.required_fields);
  const errors: PromptValidationError[] = [];

  for (const [shot_index, shot] of document.shots.entries()) {
    const shot_id = read_string(shot, "shot_id");
    const prefix = scope_prefix(shot_index, shot_id);

    for (const field of SHOT_FIELD_ORDER) {
      if (required_fields.has(field) && read_string(shot, field).trim() === "") {
        errors.push({
          shot_id,
          field,
          code: "MISSING_FIELD",
          message: `${prefix}字段 "${field}" 缺失或为空，模型 ${rules.model} 要求该字段非空。`,
        });
      }

      if (field === "target_model") {
        const shot_model = read_string(shot, field);
        if (shot_model !== document.target_model) {
          errors.push({
            shot_id,
            field,
            code: "MODEL_MISMATCH",
            message:
              `${prefix}target_model "${shot_model}" 与顶层 target_model ` +
              `"${document.target_model}"（规则文件 ${rules.model}）不一致；` +
              "一次 run 只能使用一个目标模型。",
          });
        }
      }

      if (field === "duration") {
        const duration = read_number(shot, field);
        const { min_sec, max_sec } = rules.duration;
        if (duration < min_sec || duration > max_sec) {
          errors.push({
            shot_id,
            field,
            code: "OUT_OF_RANGE",
            message:
              `${prefix}duration ${duration} 秒超出模型 ${rules.model} 允许的 ` +
              `${min_sec}-${max_sec} 秒范围。`,
          });
        }
      }

      if (field === "aspect_ratio") {
        const aspect_ratio = read_string(shot, field);
        if (!rules.aspect_ratios.includes(aspect_ratio)) {
          errors.push({
            shot_id,
            field,
            code: "OUT_OF_RANGE",
            message:
              `${prefix}aspect_ratio "${aspect_ratio}" 不在模型 ${rules.model} ` +
              `允许的画幅集合内（允许：${rules.aspect_ratios.join("、")}）。`,
          });
        }
      }

      if (is_forbidden_scan_field(field)) {
        errors.push(
          ...forbidden_errors(shot_id, field, read_string(shot, field), rules, prefix),
        );
      }

      if (field === "continuity") {
        const continuity = shot.continuity;
        for (const state_field of CONTINUITY_TEXT_FIELDS) {
          const state = is_record(continuity) ? continuity[state_field] : undefined;
          if (typeof state !== "string") {
            continue;
          }
          errors.push(
            ...forbidden_errors(
              shot_id,
              `continuity.${state_field}`,
              state,
              rules,
              prefix,
            ),
          );
        }
      }

      if (field === "negative_prompt") {
        const negative_prompt = shot.negative_prompt;
        if (Array.isArray(negative_prompt)) {
          for (const [entry_index, entry] of negative_prompt.entries()) {
            if (typeof entry !== "string") {
              continue;
            }
            errors.push(
              ...forbidden_errors(
                shot_id,
                `negative_prompt[${entry_index}]`,
                entry,
                rules,
                prefix,
              ),
            );
          }
        }
      }
    }
  }

  return errors;
}

function is_forbidden_scan_field(field: string): boolean {
  return (FORBIDDEN_SCAN_FIELDS as readonly string[]).includes(field);
}

/** 禁止项按大小写不敏感的子串匹配（中文提示词没有词边界，只能按子串判定）。 */
function forbidden_errors(
  shot_id: string,
  field: string,
  text: string,
  rules: ModelRules,
  prefix: string,
): PromptValidationError[] {
  const haystack = text.toLowerCase();
  const errors: PromptValidationError[] = [];
  for (const term of rules.forbidden) {
    if (term.trim() !== "" && haystack.includes(term.toLowerCase())) {
      errors.push({
        shot_id,
        field,
        code: "FORBIDDEN_TERM",
        message:
          `${prefix}字段 "${field}" 命中禁止项 "${term}"；` +
          "提示词正文不得夹带工程配置或模型参数。",
      });
    }
  }
  return errors;
}

/**
 * schema 错误映射：`required` → MISSING_FIELD；其余 schema 违规（枚举 / 类型 /
 * 额外字段等）统一落到 OUT_OF_RANGE（brief 冻结的四个码里唯一表达「取值不在允许
 * 范围内」的码），消息保留 schema 的原始说明。
 */
function map_schema_errors(
  value: unknown,
  errors: SchemaValidationError[],
): PromptValidationError[] {
  const shots = read_shots(value);
  const mapped = errors.map((error, index) => {
    const location = locate_error_path(error.path);
    const shot_id = location.shot_index >= 0 ? read_string(shots[location.shot_index], "shot_id") : "";
    return {
      index,
      shot_index: location.shot_index,
      field_index: location.field_index,
      error: {
        shot_id,
        field: location.field,
        code:
          error.keyword === "required"
            ? ("MISSING_FIELD" as const)
            : ("OUT_OF_RANGE" as const),
        message: `${scope_prefix(location.shot_index, shot_id)}${error.message}`,
      },
    };
  });

  mapped.sort(
    (a, b) =>
      a.shot_index - b.shot_index || a.field_index - b.field_index || a.index - b.index,
  );
  return mapped.map((entry) => entry.error);
}

interface ErrorLocation {
  /** 顶层（非镜头内）错误为 -1，镜头内错误为 shots[] 下标。 */
  shot_index: number;
  /** 镜头内错误取相对字段路径；顶层错误取完整路径。 */
  field: string;
  field_index: number;
}

function locate_error_path(error_path: string): ErrorLocation {
  const match = /^shots\[(\d+)\](?:\.(.*))?$/.exec(error_path);
  if (match === null) {
    return { shot_index: -1, field: error_path, field_index: field_order_index(error_path) };
  }
  const field = match[2] ?? "";
  return {
    shot_index: Number(match[1]),
    field,
    field_index: field_order_index(field),
  };
}

function field_order_index(field: string): number {
  const head = field.split(".")[0].split("[")[0];
  const index = (SHOT_FIELD_ORDER as readonly string[]).indexOf(head);
  return index < 0 ? SHOT_FIELD_ORDER.length : index;
}

/** 镜头内错误用 `镜头 <shot_id>：`；shot_id 缺失时退化为下标；顶层错误用 `PromptIR：`。 */
function scope_prefix(shot_index: number, shot_id: string): string {
  if (shot_index < 0) {
    return "PromptIR：";
  }
  return shot_id === "" ? `镜头 #${shot_index}：` : `镜头 ${shot_id}：`;
}

type PromptIrReadResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: PromptValidationError[] };

function read_prompt_ir(file_path: string): PromptIrReadResult {
  let text: string;
  try {
    text = readFileSync(file_path, "utf8");
  } catch (error) {
    const error_code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const label = error_code === "ENOENT" ? "不存在" : "不可读";
    return {
      ok: false,
      errors: [prompt_ir_path_error(`PromptIR 文件${label}：${file_path}（${describe_error(error)}）`)],
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      errors: [
        prompt_ir_path_error(`PromptIR JSON 非法：${file_path}（${describe_error(error)}）`),
      ],
    };
  }
}

function prompt_ir_path_error(message: string): PromptValidationError {
  return {
    shot_id: "",
    field: PROMPT_IR_PATH_FIELD,
    code: "MISSING_FIELD",
    message,
  };
}

function read_shots(value: unknown): Array<Record<string, unknown>> {
  if (!is_record(value) || !Array.isArray(value.shots)) {
    return [];
  }
  return value.shots.map((shot) => (is_record(shot) ? shot : {}));
}

function read_string(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function read_number(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  return typeof value === "number" ? value : Number.NaN;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
