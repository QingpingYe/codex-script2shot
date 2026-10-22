import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export const STAGE_ARTIFACT_STAGE_VALUES = ["script_breakdown", "shot_planning"] as const;

export type StageArtifactStage = (typeof STAGE_ARTIFACT_STAGE_VALUES)[number];

export interface StageArtifactValidationError {
  path: string;
  message: string;
  keyword?: string;
  code?: string;
}

export interface StageArtifactValidationResult {
  ok: boolean;
  errors: StageArtifactValidationError[];
}

export interface ValidateStageArtifactInput {
  stage: StageArtifactStage;
  path: string;
}

const STAGE_SCHEMA_FILES: Record<StageArtifactStage, string> = {
  script_breakdown: "script_analysis.schema.json",
  shot_planning: "shot_plan.schema.json",
};

/**
 * 源码测试从 `server/src/tools/` 解析，打包后从 `server/dist/server.mjs`
 * 解析；两种相对深度都列出，保持与 `server/src/schemas.ts` 相同的根目录 schema 约定。
 */
const SCHEMA_DIR_CANDIDATES = [
  fileURLToPath(new URL("../../../schemas/", import.meta.url)),
  fileURLToPath(new URL("../../schemas/", import.meta.url)),
];

const ajv = new Ajv2020({ allErrors: true });
const validators = new Map<StageArtifactStage, ValidateFunction>();

export function validate_stage_artifact(
  input: ValidateStageArtifactInput,
): StageArtifactValidationResult {
  const artifact = read_artifact(input.path);
  if (!artifact.ok) {
    return artifact;
  }

  let value: unknown;
  try {
    value = JSON.parse(artifact.text) as unknown;
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `阶段产物 JSON 非法：${describe_error(error)}`,
          code: "STAGE_ARTIFACT_INVALID_JSON",
        },
      ],
    };
  }

  const validator = get_validator(input.stage);
  if (!validator.ok) {
    return validator;
  }

  if (validator.value(value)) {
    return { ok: true, errors: [] };
  }
  return {
    ok: false,
    errors: (validator.value.errors ?? []).map(to_validation_error),
  };
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
      errors: [
        {
          path: "",
          message: `阶段 "${stage}" 的 schema 不可用：${describe_error(error)}`,
          code: "STAGE_ARTIFACT_UNREADABLE",
        },
      ],
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

type ArtifactReadResult =
  | { ok: true; text: string }
  | { ok: false; errors: StageArtifactValidationError[] };

function read_artifact(file_path: string): ArtifactReadResult {
  try {
    return { ok: true, text: readFileSync(file_path, "utf8") };
  } catch (error) {
    const error_code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const code =
      error_code === "ENOENT" ? "STAGE_ARTIFACT_MISSING" : "STAGE_ARTIFACT_UNREADABLE";
    const label = code === "STAGE_ARTIFACT_MISSING" ? "不存在" : "不可读";
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `阶段产物文件${label}：${file_path}（${describe_error(error)}）`,
          code,
        },
      ],
    };
  }
}

function to_validation_error(error: ErrorObject): StageArtifactValidationError {
  return {
    path: error_path(error),
    message: error.message ?? "字段校验失败。",
    keyword: error.keyword,
  };
}

/** Ajv 的 instancePath 已是 JSON Pointer；required / additionalProperties 需补末级字段。 */
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

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
