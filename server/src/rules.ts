/**
 * Seedance 模型规则文件加载（架构 §11.4；Task 4b-1）。
 *
 * 规则文件固定在插件根目录 `rules/models/`。`server/src/rules.ts` 与
 * `server/dist/server.mjs` 相对仓库根的深度一致（都在 `server/` 下一层），
 * 源码与 bundled 运行都命中候选一 `../../rules/models/`；候选二
 * `../rules/models/` 沿用 `validate_stage_artifact.ts` 的两深度模式，
 * 作为打包布局变化的兜底。
 *
 * 只支持 `seedance-2.0` 与 `seedance-2.5`：其他 `model_id` 返回结构化
 * `MODEL_UNKNOWN`，不读文件系统。规则文件缺失、JSON 非法、字段结构不符或
 * 文件内的 `model` 与请求的 `model_id` 不一致属于插件安装损坏，直接抛错
 * （与 `schemas.ts` 的 schema 加载失败处理一致）。
 *
 * 目前已覆盖规划子集（时长、画幅、镜头拆分边界）与硬规则子集
 * （`required_fields` 必填非空字段、`forbidden` 禁止项）；`render` 由 4c-3 补齐，
 * 届时同步扩展类型。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_RULE_IDS = ["seedance-2.0", "seedance-2.5"] as const;

export type ModelRuleId = (typeof MODEL_RULE_IDS)[number];

export interface ModelRulesDuration {
  min_sec: number;
  max_sec: number;
  default_sec: number;
}

export interface ModelRulesShotSplit {
  /** 单段提示词建议时长上限，供 shot-planning 决定拆分边界。 */
  prefer_max_sec: number;
  /** 中文拆分口径：一段提示词只安排一个主要动作或一个主要情绪。 */
  multi_action_rule: string;
}

export interface ModelRules {
  model: ModelRuleId;
  label: string;
  duration: ModelRulesDuration;
  aspect_ratios: string[];
  shot_split: ModelRulesShotSplit;
  /** 提示词正文必须非空的 PromptIR 镜头字段（字段名与 schemas/prompt_ir.schema.json 对齐）。 */
  required_fields: string[];
  /** 提示词正文字段不得命中的禁止项；validate_prompt 按大小写不敏感子串匹配。 */
  forbidden: string[];
  source: string[];
  checked_at: string;
}

export interface LoadModelRulesOptions {
  /** 覆盖规则目录，仅用于测试内置损坏场景；默认按源码 / bundled 两种相对路径解析。 */
  rules_dir?: string;
}

export interface LoadModelRulesFailure {
  ok: false;
  error: {
    code: "MODEL_UNKNOWN";
    message: string;
    details?: Record<string, unknown>;
  };
}

export type LoadModelRulesResult = { ok: true; rules: ModelRules } | LoadModelRulesFailure;

const RULES_DIR_CANDIDATES = [
  fileURLToPath(new URL("../../rules/models/", import.meta.url)),
  fileURLToPath(new URL("../rules/models/", import.meta.url)),
];

export function load_model_rules(
  model_id: unknown,
  options: LoadModelRulesOptions = {},
): LoadModelRulesResult {
  if (!is_model_rule_id(model_id)) {
    return {
      ok: false,
      error: {
        code: "MODEL_UNKNOWN",
        message: `目标模型未知：只支持 ${MODEL_RULE_IDS.join(" 和 ")}。`,
        details: { model_id },
      },
    };
  }

  const rules_dir = resolve_rules_dir(options.rules_dir);
  return { ok: true, rules: read_model_rules(rules_dir, model_id) };
}

function is_model_rule_id(value: unknown): value is ModelRuleId {
  return (
    typeof value === "string" && (MODEL_RULE_IDS as readonly string[]).includes(value)
  );
}

function resolve_rules_dir(override: string | undefined): string {
  if (override !== undefined) {
    return override;
  }
  for (const candidate of RULES_DIR_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return RULES_DIR_CANDIDATES[0];
}

function read_model_rules(rules_dir: string, model_id: ModelRuleId): ModelRules {
  const file_path = path.join(rules_dir, `${model_id}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file_path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`模型规则文件不可用：${file_path}（${describe_error(error)}）`);
  }
  return parse_model_rules(raw, file_path, model_id);
}

function parse_model_rules(raw: unknown, file_path: string, model_id: ModelRuleId): ModelRules {
  const fail = (reason: string): never => {
    throw new Error(`模型规则文件不可用：${file_path}（${reason}）`);
  };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("顶层必须是 JSON 对象");
  }
  const value = raw as Record<string, unknown>;
  if (value.model !== model_id) {
    fail(`文件内的 model 字段应为 "${model_id}"`);
  }
  if (typeof value.label !== "string" || value.label.trim() === "") {
    fail("缺少非空字符串字段 label");
  }
  if (value.checked_at === undefined || typeof value.checked_at !== "string") {
    fail("缺少字符串字段 checked_at");
  }
  if (!is_string_array(value.source)) {
    fail("缺少字符串数组字段 source");
  }
  if (!is_string_array(value.aspect_ratios)) {
    fail("缺少字符串数组字段 aspect_ratios");
  }
  if (!is_string_list(value.required_fields)) {
    fail("缺少字符串数组字段 required_fields");
  }
  if (!is_string_list(value.forbidden)) {
    fail("缺少字符串数组字段 forbidden");
  }

  const duration = value.duration;
  if (duration === null || typeof duration !== "object" || Array.isArray(duration)) {
    fail("缺少对象字段 duration");
  }
  const duration_value = duration as Record<string, unknown>;
  for (const key of ["min_sec", "max_sec", "default_sec"]) {
    if (typeof duration_value[key] !== "number" || !Number.isFinite(duration_value[key])) {
      fail(`duration.${key} 必须是数字`);
    }
  }

  const shot_split = value.shot_split;
  if (shot_split === null || typeof shot_split !== "object" || Array.isArray(shot_split)) {
    fail("缺少对象字段 shot_split");
  }
  const shot_split_value = shot_split as Record<string, unknown>;
  if (
    typeof shot_split_value.prefer_max_sec !== "number" ||
    !Number.isFinite(shot_split_value.prefer_max_sec)
  ) {
    fail("shot_split.prefer_max_sec 必须是数字");
  }
  if (
    typeof shot_split_value.multi_action_rule !== "string" ||
    shot_split_value.multi_action_rule.trim() === ""
  ) {
    fail("缺少非空字符串字段 shot_split.multi_action_rule");
  }

  return {
    model: model_id,
    label: value.label as string,
    duration: {
      min_sec: duration_value.min_sec as number,
      max_sec: duration_value.max_sec as number,
      default_sec: duration_value.default_sec as number,
    },
    aspect_ratios: value.aspect_ratios as string[],
    shot_split: {
      prefer_max_sec: shot_split_value.prefer_max_sec as number,
      multi_action_rule: shot_split_value.multi_action_rule as string,
    },
    required_fields: value.required_fields as string[],
    forbidden: value.forbidden as string[],
    source: value.source as string[],
    checked_at: value.checked_at as string,
  };
}

/** 非空字符串数组（source / aspect_ratios）。 */
function is_string_array(value: unknown): value is string[] {
  return is_string_list(value) && value.length > 0;
}

/** 允许为空的字符串数组（required_fields / forbidden）。 */
function is_string_list(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim() !== "")
  );
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
