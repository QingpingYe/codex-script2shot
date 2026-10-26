import { readFileSync } from "node:fs";
import {
  load_model_rules,
  type LoadModelRulesOptions,
  type ModelRules,
} from "../rules.js";
import { validate_prompt_ir, type SchemaValidationError } from "../schemas.js";
import { check_artifact_version } from "../artifact_version.js";
import { validate_prompt_semantics, type ArtifactSemanticError } from "../artifact_semantics.js";

export interface PromptValidationError {
  clip_id: string;
  shot_id: string;
  field: string;
  code: string;
  message: string;
}

export interface ValidatePromptInput {
  prompt_ir_path: string;
  shot_plan_path?: string;
  script_analysis_path?: string;
}

export interface ValidatePromptResult {
  ok: boolean;
  errors: PromptValidationError[];
}

export interface ValidatePromptDocumentOptions extends LoadModelRulesOptions {
  shot_plan?: unknown;
  script_analysis?: unknown;
}

const PROMPT_IR_PATH_FIELD = "prompt_ir_path";

export function validate_prompt(
  input: ValidatePromptInput,
  options: LoadModelRulesOptions = {},
): ValidatePromptResult {
  const loaded = read_json_document(input.prompt_ir_path, PROMPT_IR_PATH_FIELD);
  if (!loaded.ok) {
    return loaded;
  }
  const plan = read_optional_document(input.shot_plan_path, "shot_plan_path");
  if (!plan.ok) {
    return plan;
  }
  const analysis = read_optional_document(input.script_analysis_path, "script_analysis_path");
  if (!analysis.ok) {
    return analysis;
  }
  return validate_prompt_document(loaded.value, {
    ...options,
    shot_plan: plan.value,
    script_analysis: analysis.value,
  });
}

export function validate_prompt_document(
  document: unknown,
  options: ValidatePromptDocumentOptions = {},
): ValidatePromptResult {
  const errors: PromptValidationError[] = [];
  const version = check_artifact_version(document);
  if (!version.ok) {
    return {
      ok: false,
      errors: [
        {
          clip_id: "",
          shot_id: "",
          field: "schema_version",
          code: version.code,
          message: `PromptIR schema_version 不受支持：${String(version.found_version)}。`,
        },
      ],
    };
  }

  const schema_result = validate_prompt_ir(document);
  if (!schema_result.ok) {
    return {
      ok: false,
      errors: schema_result.errors.map((error) => to_schema_error(error, document)),
    };
  }

  const target_model = is_record(document) ? document.target_model : undefined;
  if (typeof target_model !== "string") {
    return {
      ok: false,
      errors: [
        {
          clip_id: "",
          shot_id: "",
          field: "target_model",
          code: "MISSING_FIELD",
          message: "PromptIR 缺少 target_model。",
        },
      ],
    };
  }

  let rules: ModelRules;
  try {
    const result = load_model_rules(target_model, options);
    if (!result.ok) {
      return {
        ok: false,
        errors: [
          {
            clip_id: "",
            shot_id: "",
            field: "target_model",
            code: "MODEL_RULES_UNAVAILABLE",
            message: result.error.message,
          },
        ],
      };
    }
    rules = result.rules;
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          clip_id: "",
          shot_id: "",
          field: "target_model",
          code: "MODEL_RULES_UNAVAILABLE",
          message: `模型规则不可用：${describe_error(error)}`,
        },
      ],
    };
  }

  const model_mismatch = collect_model_errors(document, rules);
  errors.push(...model_mismatch);
  const hard_errors = collect_hard_rule_errors(document, rules);
  errors.push(...hard_errors);
  const semantic_errors = validate_prompt_semantics(
    document,
    {
      duration: rules.duration,
      reference_limits: rules.reference_limits,
      timeline: rules.timeline,
    },
    options.shot_plan,
    options.script_analysis,
  );
  errors.push(...semantic_errors.map(to_semantic_error));

  errors.push(...collect_upstream_identity_errors(document, options));

  return { ok: errors.length === 0, errors };
}

export function read_prompt_ir_document(
  prompt_ir_path: string,
): { ok: true; value: unknown } | { ok: false; errors: PromptValidationError[] } {
  return read_json_document(prompt_ir_path, PROMPT_IR_PATH_FIELD);
}

function collect_upstream_identity_errors(
  document: unknown,
  options: ValidatePromptDocumentOptions,
): PromptValidationError[] {
  if (!is_record(document)) return [];
  const errors: PromptValidationError[] = [];
  for (const [label, upstream] of [["shot_plan", options.shot_plan], ["script_analysis", options.script_analysis]] as const) {
    if (!is_record(upstream)) continue;
    for (const field of ["run_id", "target_model"] as const) {
      if (typeof upstream[field] === "string" && upstream[field] !== document[field]) {
        errors.push({ clip_id: "", shot_id: "", field, code: "MODEL_MISMATCH", message: `${label}.${field} 与 PromptIR 不一致。` });
      }
    }
  }
  return errors;
}

function collect_model_errors(document: unknown, rules: ModelRules): PromptValidationError[] {
  const errors: PromptValidationError[] = [];
  if (!is_record(document) || document.target_model !== rules.model) {
    errors.push({
      clip_id: "",
      shot_id: "",
      field: "target_model",
      code: "MODEL_MISMATCH",
      message: `PromptIR target_model 与规则文件 ${rules.model} 不一致。`,
    });
  }
  for (const [clip_index, clip] of as_array(is_record(document) ? document.clips : undefined).entries()) {
    if (!is_record(clip)) continue;
    const clip_id = as_string(clip.clip_id);
    if (clip.duration_sec !== undefined && typeof clip.duration_sec === "number") {
      if (clip.duration_sec < rules.duration.min_sec || clip.duration_sec > rules.duration.max_sec) {
        errors.push({
          clip_id,
          shot_id: "",
          field: "duration_sec",
          code: "OUT_OF_RANGE",
          message: `视频时长 ${clip.duration_sec} 秒超出模型允许的 ${rules.duration.min_sec}-${rules.duration.max_sec} 秒范围。`,
        });
      }
    }
    if (typeof clip.aspect_ratio === "string" && !rules.aspect_ratios.includes(clip.aspect_ratio)) {
      errors.push({
        clip_id,
        shot_id: "",
        field: "aspect_ratio",
        code: "FORBIDDEN_TERM",
        message: `画幅 ${clip.aspect_ratio} 不在模型允许范围内。`,
      });
    }
    void clip_index;
  }
  if (rules.timeline.required_in_prompt && rules.model === "seedance-2.5" && (is_record(document) ? document.display_timeline : undefined) !== true) {
    errors.push({
      clip_id: "",
      shot_id: "",
      field: "display_timeline",
      code: "MISSING_FIELD",
      message: "Seedance 2.5 必须显示秒数时间轴。",
    });
  }
  return errors;
}

function collect_hard_rule_errors(document: unknown, rules: ModelRules): PromptValidationError[] {
  const errors: PromptValidationError[] = [];
  for (const clip of as_array(is_record(document) ? document.clips : undefined)) {
    if (!is_record(clip)) continue;
    const clip_id = as_string(clip.clip_id);
    if (as_string(clip.generation_goal).trim() === "") {
      errors.push(missing(clip_id, "", "generation_goal"));
    }
    if (as_string(clip.subjects_and_relations).trim() === "") {
      errors.push(missing(clip_id, "", "subjects_and_relations"));
    }
    for (const field of rules.required_fields) {
      if (["generation_goal", "subjects_and_relations"].includes(field) || !Object.hasOwn(clip, field)) continue;
      if (as_string(clip[field]).trim() === "") errors.push(missing(clip_id, "", field));
    }
    for (const [shot_index, shot] of as_array(clip.shots).entries()) {
      if (!is_record(shot)) continue;
      const shot_id = as_string(shot.shot_id);
      if (as_string(shot.subject).trim() === "") errors.push(missing(clip_id, shot_id, "subject"));
      if (as_string(shot.action).trim() === "") errors.push(missing(clip_id, shot_id, "action"));
      for (const field of rules.required_fields) {
        if (["subject", "action"].includes(field) || !Object.hasOwn(shot, field)) continue;
        if (as_string(shot[field]).trim() === "") errors.push(missing(clip_id, shot_id, field));
      }
      for (const field of ["subject", "action", "emotion"] as const) {
        scan_forbidden(as_string(shot[field]), field, clip_id, shot_id, rules.forbidden, errors);
      }
      void shot_index;
    }
    for (const field of ["setting", "time", "lighting", "color", "style"] as const) {
      scan_forbidden(as_string(clip[field]), field, clip_id, "", rules.forbidden, errors);
    }
    scan_forbidden(as_string(clip.generation_goal), "generation_goal", clip_id, "", rules.forbidden, errors);
    scan_forbidden(as_string(clip.subjects_and_relations), "subjects_and_relations", clip_id, "", rules.forbidden, errors);
    const audio = is_record(clip.audio) ? clip.audio : undefined;
    for (const track of ["ambience", "sfx", "music"] as const) {
      for (const cue of as_array(audio?.[track])) {
        if (is_record(cue)) scan_forbidden(as_string(cue.text), "audio", clip_id, "", rules.forbidden, errors);
      }
    }
    for (const term of as_array(clip.negative_prompt)) {
      scan_forbidden(String(term), "negative_prompt", clip_id, "", rules.forbidden, errors);
    }
  }
  return errors;
}

function scan_forbidden(
  value: string,
  field: string,
  clip_id: string,
  shot_id: string,
  forbidden: string[],
  errors: PromptValidationError[],
): void {
  const haystack = value.toLocaleLowerCase();
  for (const term of forbidden) {
    if (haystack.includes(term.toLocaleLowerCase())) {
      errors.push({
        clip_id,
        shot_id,
        field,
        code: "FORBIDDEN_TERM",
        message: `字段命中禁止项 "${term}"。`,
      });
    }
  }
}

function missing(clip_id: string, shot_id: string, field: string): PromptValidationError {
  return {
    clip_id,
    shot_id,
    field,
    code: "MISSING_FIELD",
    message: `字段 "${field}" 不能为空。`,
  };
}

function to_schema_error(error: SchemaValidationError, document: unknown): PromptValidationError {
  const field = error.path.split(".").at(-1) ?? "";
  const { clip_id, shot_id } = schema_error_ids(error.path, document);
  return {
    clip_id,
    shot_id,
    field,
    code: error.keyword === "required" ? "MISSING_FIELD" : "SCHEMA_INVALID",
    message: `${error.path}: ${error.message}`,
  };
}

function schema_error_ids(path: string, document: unknown): { clip_id: string; shot_id: string } {
  if (!is_record(document) || !Array.isArray(document.clips)) return { clip_id: "", shot_id: "" };
  const clip_match = /clips\[(\d+)\]/.exec(path);
  const clip = clip_match === null ? undefined : document.clips[Number(clip_match[1])];
  if (!is_record(clip)) return { clip_id: "", shot_id: "" };
  const clip_id = as_string(clip.clip_id);
  const shot_match = /shots\[(\d+)\]/.exec(path);
  const shot = shot_match === null || !Array.isArray(clip.shots) ? undefined : clip.shots[Number(shot_match[1])];
  return { clip_id, shot_id: is_record(shot) ? as_string(shot.shot_id) : "" };
}

function to_semantic_error(error: ArtifactSemanticError): PromptValidationError {
  const path = error.path.split(".");
  return {
    clip_id: error.clip_id ?? "",
    shot_id: error.shot_id ?? "",
    field: path.at(-1) ?? "",
    code: error.code,
    message: error.message,
  };
}

type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: PromptValidationError[] };

function read_optional_document(
  file_path: string | undefined,
  field: string,
): { ok: true; value: unknown | undefined } | { ok: false; errors: PromptValidationError[] } {
  if (file_path === undefined) return { ok: true, value: undefined };
  const loaded = read_json_document(file_path, field);
  if (!loaded.ok) return loaded;
  const version = check_artifact_version(loaded.value);
  if (!version.ok) {
    return {
      ok: false,
      errors: [{
        clip_id: "",
        shot_id: "",
        field: "schema_version",
        code: version.code,
        message: `${field} schema_version 不受支持：${String(version.found_version)}。`,
      }],
    };
  }
  return loaded;
}

function read_json_document(file_path: string, field: string): JsonReadResult {
  let text: string;
  try {
    text = readFileSync(file_path, "utf8");
  } catch (error) {
    return {
      ok: false,
      errors: [{
        clip_id: "",
        shot_id: "",
        field,
        code: "MISSING_FIELD",
        message: `无法读取文件：${file_path}（${describe_error(error)}）`,
      }],
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        clip_id: "",
        shot_id: "",
        field,
        code: "MISSING_FIELD",
        message: `JSON 非法：${file_path}（${describe_error(error)}）`,
      }],
    };
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function as_array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function as_string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
