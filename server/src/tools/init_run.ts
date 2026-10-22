/**
 * 运行目录与 `run.json` 的创建（架构 §7.2、§11.2、§11.5；Task 4d-1）。
 *
 * 本模块同时承载三个 run 工具共用的 run 模型、路径和 schema 校验，避免在
 * `read_run` / `update_run_state` 中复制冻结字段。工具失败统一返回
 * `{ ok: false, error: { code, message, details? } }`，不把文件系统异常抛穿 MCP。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export const RUN_INPUT_MODE_VALUES = [
  "script_segment",
  "single_episode",
  "multiple_episodes",
] as const;

export type RunInputMode = (typeof RUN_INPUT_MODE_VALUES)[number];

export const RUN_TARGET_MODEL_VALUES = ["seedance-2.0", "seedance-2.5"] as const;

export type RunTargetModel = (typeof RUN_TARGET_MODEL_VALUES)[number];

export const RUN_ASPECT_RATIO_VALUES = [
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
] as const;

export type RunAspectRatio = (typeof RUN_ASPECT_RATIO_VALUES)[number];

export const RUN_STAGE_VALUES = [
  "script_breakdown",
  "shot_planning",
  "shot_prompting",
] as const;

export type RunStage = (typeof RUN_STAGE_VALUES)[number];

export const RUN_STAGE_STATUS_VALUES = ["pending", "running", "done", "failed"] as const;

export type RunStageStatus = (typeof RUN_STAGE_STATUS_VALUES)[number];

export const RUN_STAGE_ARTIFACTS: Record<RunStage, string> = {
  script_breakdown: "script_analysis.json",
  shot_planning: "shot_plan.json",
  shot_prompting: "prompts.ir.json",
};

export const RUN_ID_PATTERN = /^run-\d{8}-\d{6}$/;

export interface RunStageState {
  status: RunStageStatus;
  artifact: string | null;
  updated_at: string | null;
}

export interface RunWarning {
  code: string;
  message: string;
  refs?: string[];
  /** 结构化明细（例如 `RUN_STATE_RECONCILED` 的 `conflicts[]`），写入 `run.json` 后原样保留。 */
  details?: Record<string, unknown>;
}

export interface RunDocument {
  run_id: string;
  input_mode: RunInputMode;
  project_id: string;
  target_model: RunTargetModel;
  aspect_ratio?: RunAspectRatio;
  warnings?: RunWarning[];
  stages: Record<RunStage, RunStageState>;
}

export interface InitRunInput {
  workspace_root: string;
  input_mode: RunInputMode;
  project_id: string;
  target_model: RunTargetModel;
  aspect_ratio?: RunAspectRatio;
}

export interface InitRunSuccess {
  run_id: string;
  run_json_path: string;
}

export type RunToolErrorCode =
  | "CONFIG_INVALID"
  | "RUN_NOT_FOUND"
  | "RUN_UNREADABLE"
  | "RUN_INVALID_JSON"
  | "RUN_SCHEMA_INVALID"
  | "RUN_WRITE_FAILED"
  | "INTERNAL";

export interface RunToolFailure {
  ok: false;
  error: {
    code: RunToolErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RunSchemaValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: RunSchemaError[] };

export interface RunSchemaError {
  path: string;
  message: string;
  keyword: string;
}

/**
 * 源码测试从 `server/src/tools/` 解析，打包后从 `server/dist/server.mjs`
 * 解析；两种相对深度都列出，保持与 `validate_stage_artifact` 相同的 schema 根目录约定。
 */
const SCHEMA_DIR_CANDIDATES = [
  fileURLToPath(new URL("../../../schemas/", import.meta.url)),
  fileURLToPath(new URL("../../schemas/", import.meta.url)),
];

const ajv = new Ajv2020({ allErrors: true });
let run_validator: ValidateFunction | undefined;

export function init_run(input: InitRunInput): InitRunSuccess | RunToolFailure {
  const workspace_root = validate_workspace_root(input?.workspace_root);
  if (!workspace_root.ok) {
    return workspace_root;
  }
  const input_mode = validate_input_mode(input?.input_mode);
  if (!input_mode.ok) {
    return input_mode;
  }
  const project_id = validate_project_id(input?.project_id);
  if (!project_id.ok) {
    return project_id;
  }
  const target_model = validate_target_model(input?.target_model);
  if (!target_model.ok) {
    return target_model;
  }
  const aspect_ratio = validate_aspect_ratio(input?.aspect_ratio);
  if (!aspect_ratio.ok) {
    return aspect_ratio;
  }

  const outputs_dir = path.join(path.resolve(workspace_root.value), ".script2shot", "outputs");
  const created = create_run_directory(outputs_dir, new Date());
  if (!created.ok) {
    return created;
  }

  const run: RunDocument = {
    run_id: created.run_id,
    input_mode: input_mode.value,
    project_id: project_id.value,
    target_model: target_model.value,
    ...(aspect_ratio.value === undefined ? {} : { aspect_ratio: aspect_ratio.value }),
    warnings: [],
    stages: initial_stages(),
  };

  const schema_result = validate_run_document(run);
  if (!schema_result.ok) {
    return run_failure("RUN_SCHEMA_INVALID", "生成的 run.json 不符合 schema。", {
      path: created.run_json_path,
      errors: schema_result.errors,
    });
  }

  const write_error = write_run_document(created.run_json_path, run);
  if (write_error !== undefined) {
    return write_error;
  }

  return { run_id: created.run_id, run_json_path: created.run_json_path };
}

export function validate_workspace_root(
  value: unknown,
): { ok: true; value: string } | RunToolFailure {
  if (typeof value !== "string" || value.trim() === "") {
    return run_failure("CONFIG_INVALID", '入参字段 "workspace_root" 期望非空字符串。', {
      field: "workspace_root",
    });
  }
  return { ok: true, value };
}

export function validate_input_mode(
  value: unknown,
): { ok: true; value: RunInputMode } | RunToolFailure {
  if (typeof value !== "string" || !(RUN_INPUT_MODE_VALUES as readonly string[]).includes(value)) {
    return run_failure(
      "CONFIG_INVALID",
      `入参字段 "input_mode" 期望以下之一：${RUN_INPUT_MODE_VALUES.join("、")}。`,
      { field: "input_mode" },
    );
  }
  return { ok: true, value: value as RunInputMode };
}

export function validate_project_id(
  value: unknown,
): { ok: true; value: string } | RunToolFailure {
  if (typeof value !== "string" || value.trim() === "") {
    return run_failure("CONFIG_INVALID", '入参字段 "project_id" 期望非空字符串。', {
      field: "project_id",
    });
  }
  return { ok: true, value };
}

export function validate_target_model(
  value: unknown,
): { ok: true; value: RunTargetModel } | RunToolFailure {
  if (typeof value !== "string" || !(RUN_TARGET_MODEL_VALUES as readonly string[]).includes(value)) {
    return run_failure(
      "CONFIG_INVALID",
      `入参字段 "target_model" 期望以下之一：${RUN_TARGET_MODEL_VALUES.join("、")}。`,
      { field: "target_model" },
    );
  }
  return { ok: true, value: value as RunTargetModel };
}

export function validate_aspect_ratio(
  value: unknown,
): { ok: true; value: RunAspectRatio | undefined } | RunToolFailure {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    typeof value !== "string" ||
    !(RUN_ASPECT_RATIO_VALUES as readonly string[]).includes(value)
  ) {
    return run_failure(
      "CONFIG_INVALID",
      `入参字段 "aspect_ratio" 期望以下之一：${RUN_ASPECT_RATIO_VALUES.join("、")}。`,
      { field: "aspect_ratio" },
    );
  }
  return { ok: true, value: value as RunAspectRatio };
}

export function validate_run_id(
  value: unknown,
): { ok: true; value: string } | RunToolFailure {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    return run_failure(
      "CONFIG_INVALID",
      '入参字段 "run_id" 期望格式 run-YYYYMMDD-HHMMSS。',
      { field: "run_id" },
    );
  }
  return { ok: true, value };
}

export function validate_run_document(value: unknown): RunSchemaValidation {
  let validator: ValidateFunction;
  try {
    validator = get_run_validator();
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `run schema 不可用：${describe_error(error)}`,
          keyword: "schema",
        },
      ],
    };
  }

  if (validator(value)) {
    return { ok: true, errors: [] };
  }
  return {
    ok: false,
    errors: (validator.errors ?? []).map(to_run_schema_error),
  };
}

export function run_outputs_dir(workspace_root: string): string {
  return path.join(path.resolve(workspace_root), ".script2shot", "outputs");
}

export function run_json_path(workspace_root: string, run_id: string): string {
  return path.join(run_outputs_dir(workspace_root), run_id, "run.json");
}

export function read_run_document(
  workspace_root: string,
  run_id: string,
): { ok: true; value: RunDocument; path: string } | RunToolFailure {
  const file_path = run_json_path(workspace_root, run_id);
  let text: string;
  try {
    text = readFileSync(file_path, "utf8");
  } catch (error) {
    const error_code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const code = error_code === "ENOENT" ? "RUN_NOT_FOUND" : "RUN_UNREADABLE";
    const label = code === "RUN_NOT_FOUND" ? "不存在" : "不可读";
    return run_failure(code, `run.json ${label}：${file_path}（${describe_error(error)}）`, {
      path: file_path,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return run_failure("RUN_INVALID_JSON", `run.json JSON 非法：${file_path}`, {
      path: file_path,
      reason: describe_error(error),
    });
  }

  const schema_result = validate_run_document(parsed);
  if (!schema_result.ok) {
    return run_failure("RUN_SCHEMA_INVALID", "run.json 不符合 schema。", {
      path: file_path,
      errors: schema_result.errors,
    });
  }

  const value = parsed as RunDocument;
  if (value.run_id !== run_id) {
    return run_failure("RUN_SCHEMA_INVALID", 'run.json 的 "run_id" 与目录名不一致。', {
      path: file_path,
      field: "run_id",
      expected: run_id,
      actual: value.run_id,
    });
  }

  return {
    ok: true,
    value: {
      ...value,
      warnings: value.warnings ?? [],
    },
    path: file_path,
  };
}

export function write_run_document(
  file_path: string,
  value: RunDocument,
): RunToolFailure | undefined {
  try {
    writeFileSync(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return undefined;
  } catch (error) {
    return run_failure("RUN_WRITE_FAILED", `写入 run.json 失败：${file_path}`, {
      path: file_path,
      reason: describe_error(error),
    });
  }
}

export function run_failure(
  code: RunToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RunToolFailure {
  return {
    ok: false,
    error:
      details === undefined
        ? { code, message }
        : { code, message, details },
  };
}

export function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function initial_stages(): Record<RunStage, RunStageState> {
  return {
    script_breakdown: { status: "pending", artifact: null, updated_at: null },
    shot_planning: { status: "pending", artifact: null, updated_at: null },
    shot_prompting: { status: "pending", artifact: null, updated_at: null },
  };
}

type RunDirectorySuccess = {
  ok: true;
  run_id: string;
  run_json_path: string;
};

function create_run_directory(
  outputs_dir: string,
  start: Date,
): RunDirectorySuccess | RunToolFailure {
  try {
    mkdirSync(outputs_dir, { recursive: true });
  } catch (error) {
    return run_failure("RUN_WRITE_FAILED", `创建运行目录失败：${outputs_dir}`, {
      path: outputs_dir,
      reason: describe_error(error),
    });
  }

  for (let offset = 0; offset < 366 * 24 * 60 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 1000);
    const run_id = format_run_id(candidate);
    const run_dir = path.join(outputs_dir, run_id);
    try {
      mkdirSync(run_dir);
    } catch (error) {
      if (is_eeexist(error)) {
        continue;
      }
      return run_failure("RUN_WRITE_FAILED", `创建运行目录失败：${run_dir}`, {
        path: run_dir,
        reason: describe_error(error),
      });
    }
    return {
      ok: true,
      run_id,
      run_json_path: path.join(run_dir, "run.json"),
    };
  }

  return run_failure("RUN_WRITE_FAILED", "无法在一年内找到可用的 run_id。", {
    path: outputs_dir,
  });
}

function format_run_id(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `run-${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function get_run_validator(): ValidateFunction {
  if (run_validator !== undefined) {
    return run_validator;
  }
  run_validator = ajv.compile(load_schema("run.schema.json"));
  return run_validator;
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
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Continue to the next source/dist candidate.
    }
  }
  return path.join(SCHEMA_DIR_CANDIDATES[0], file_name);
}

function to_run_schema_error(error: ErrorObject): RunSchemaError {
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

function is_eeexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
