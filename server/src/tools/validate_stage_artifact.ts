import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { hash_artifact_document } from "../artifact_hash.js";
import {
  validate_script_analysis_semantics,
  validate_shot_plan_semantics,
  type ArtifactSemanticError,
} from "../artifact_semantics.js";
import { check_artifact_version } from "../artifact_version.js";
import { load_model_rules } from "../rules.js";

export const STAGE_ARTIFACT_STAGE_VALUES = ["script_breakdown", "shot_planning"] as const;
export type StageArtifactStage = (typeof STAGE_ARTIFACT_STAGE_VALUES)[number];

export interface StageArtifactValidationError {
  path: string;
  message: string;
  keyword?: string;
  code?: string;
  clip_id?: string;
  shot_id?: string;
}

export interface StageArtifactValidationResult {
  ok: boolean;
  errors: StageArtifactValidationError[];
  content_hash?: string;
}

export interface ValidateStageArtifactInput {
  stage: StageArtifactStage;
  path: string;
  script_analysis_path?: string;
}

const STAGE_SCHEMA_FILES: Record<StageArtifactStage, string> = {
  script_breakdown: "script_analysis.schema.json",
  shot_planning: "shot_plan.schema.json",
};

const SCHEMA_DIR_CANDIDATES = [
  fileURLToPath(new URL("../../../schemas/", import.meta.url)),
  fileURLToPath(new URL("../../schemas/", import.meta.url)),
];

const ajv = new Ajv2020({ allErrors: true });
const validators = new Map<StageArtifactStage, ValidateFunction>();

export function validate_stage_artifact(
  input: ValidateStageArtifactInput,
): StageArtifactValidationResult {
  const artifact = read_json_file(input.path, "阶段产物");
  if (!artifact.ok) {
    return artifact;
  }
  const version = check_artifact_version(artifact.value);
  if (!version.ok) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `阶段产物 schema_version 不受支持：${String(version.found_version)}。`,
          code: version.code,
        },
      ],
    };
  }

  const validator = get_validator(input.stage);
  if (!validator.ok) {
    return validator;
  }
  if (!validator.value(artifact.value)) {
    return {
      ok: false,
      errors: (validator.value.errors ?? []).map(to_validation_error),
    };
  }

  let analysis_document: unknown;
  if (input.stage === "shot_planning" && input.script_analysis_path !== undefined) {
    const analysis = read_json_file(input.script_analysis_path, "解析产物");
    if (!analysis.ok) {
      return analysis;
    }
    const analysis_version = check_artifact_version(analysis.value);
    if (!analysis_version.ok) {
      return {
        ok: false,
        errors: [
          {
            path: "",
            message: `解析产物 schema_version 不受支持：${String(analysis_version.found_version)}。`,
            code: analysis_version.code,
          },
        ],
      };
    }
    analysis_document = analysis.value;
  }

  const semantic_errors: SemanticStageResult =
    input.stage === "script_breakdown"
      ? { ok: true, errors: validate_script_analysis_semantics(artifact.value) }
      : validate_shot_plan_stage(artifact.value, analysis_document);
  if (semantic_errors.ok === false) {
    return semantic_errors;
  }
  if (semantic_errors.errors.length > 0) {
    return {
      ok: false,
      errors: semantic_errors.errors.map(to_semantic_error),
    };
  }

  return {
    ok: true,
    errors: [],
    content_hash: hash_artifact_document(artifact.value),
  };
}

type SemanticStageResult =
  | { ok: true; errors: ArtifactSemanticError[] }
  | { ok: false; errors: StageArtifactValidationError[] };

function validate_shot_plan_stage(
  value: unknown,
  analysis: unknown,
): SemanticStageResult {
  if (!is_record(value) || typeof value.target_model !== "string") {
    return {
      ok: false,
      errors: [{ path: "/target_model", message: "规划产物缺少 target_model。", code: "MISSING_FIELD" }],
    };
  }
  const loaded = load_model_rules(value.target_model);
  if (!loaded.ok) {
    return {
      ok: false,
      errors: [{ path: "/target_model", message: loaded.error.message, code: "MODEL_UNKNOWN" }],
    };
  }
  try {
    const rules = loaded.rules;
    return {
      ok: true,
      errors: validate_shot_plan_semantics(value, {
        duration: rules.duration,
        reference_limits: rules.reference_limits,
        timeline: rules.timeline,
      }, analysis),
    };
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `目标模型规则不可用：${describe_error(error)}`,
          code: "MODEL_RULES_UNAVAILABLE",
        },
      ],
    };
  }
}

type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: StageArtifactValidationError[] };

function read_json_file(file_path: string, label: string): JsonReadResult {
  let text: string;
  try {
    text = readFileSync(file_path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "STAGE_ARTIFACT_MISSING"
      : "STAGE_ARTIFACT_UNREADABLE";
    return {
      ok: false,
      errors: [{
        path: "",
        message: `${label}文件${code === "STAGE_ARTIFACT_MISSING" ? "不存在" : "不可读"}：${file_path}（${describe_error(error)}）`,
        code,
      }],
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        path: "",
        message: `${label} JSON 非法：${describe_error(error)}`,
        code: "STAGE_ARTIFACT_INVALID_JSON",
      }],
    };
  }
}

type ValidatorLookup =
  | { ok: true; value: ValidateFunction }
  | { ok: false; errors: StageArtifactValidationError[] };

function get_validator(stage: StageArtifactStage): ValidatorLookup {
  const cached = validators.get(stage);
  if (cached !== undefined) {
    return { ok: true, value: cached };
  }
  try {
    const validate = ajv.compile(load_schema(STAGE_SCHEMA_FILES[stage]));
    validators.set(stage, validate);
    return { ok: true, value: validate };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        path: "",
        message: `阶段 "${stage}" 的 schema 不可用：${describe_error(error)}`,
        code: "STAGE_ARTIFACT_UNREADABLE",
      }],
    };
  }
}

function load_schema(file_name: string): object {
  const file_path = find_schema_file(file_name);
  try {
    return JSON.parse(readFileSync(file_path, "utf8")) as object;
  } catch (error) {
    throw new Error(`无法加载 schema 文件 ${file_path}：${describe_error(error)}`);
  }
}

function find_schema_file(file_name: string): string {
  for (const schema_dir of SCHEMA_DIR_CANDIDATES) {
    const candidate = path.join(schema_dir, file_name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(SCHEMA_DIR_CANDIDATES[0], file_name);
}

function to_validation_error(error: ErrorObject): StageArtifactValidationError {
  return {
    path: error_path(error),
    message: error.message ?? "字段校验失败。",
    keyword: error.keyword,
  };
}

function to_semantic_error(error: ArtifactSemanticError): StageArtifactValidationError {
  return {
    path: error.path,
    message: error.message,
    code: error.code,
    ...(error.clip_id === undefined ? {} : { clip_id: error.clip_id }),
    ...(error.shot_id === undefined ? {} : { shot_id: error.shot_id }),
  };
}

function error_path(error: ErrorObject): string {
  const base = error.instancePath;
  if (error.keyword === "required") {
    const missing = read_param_string(error, "missingProperty");
    return missing === undefined ? base : append_pointer(base, missing);
  }
  if (error.keyword === "additionalProperties") {
    const extra = read_param_string(error, "additionalProperty");
    return extra === undefined ? base : append_pointer(base, extra);
  }
  return base;
}

function append_pointer(base: string, segment: string): string {
  return `${base}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function read_param_string(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
