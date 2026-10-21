/**
 * 知识卡与 SyncState 的 JSON Schema 加载与校验（架构 §5.2、§5.3）。
 *
 * - schema 文件固定在插件根目录 `schemas/`。`server/src` 与构建产物
 *   `server/dist/server.mjs` 相对该目录的深度一致，开发和打包后走同一相对路径。
 * - 校验使用 Ajv 的 draft 2020-12 入口（`ajv/dist/2020.js`），schema 加载或编译
 *   失败属于插件安装损坏，直接抛错；数据校验失败返回结构化 `errors[]`，不抛异常。
 * - `errors[].path` 使用与逻辑模型一致的字段路径（如 `category`、`target_models[0]`），
 *   便于调用方直接定位问题字段。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export interface SchemaValidationError {
  path: string;
  message: string;
  keyword: string;
}

export type ValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: SchemaValidationError[] };

const SCHEMA_DIR = fileURLToPath(new URL("../../schemas/", import.meta.url));

const ajv = new Ajv2020({ allErrors: true });
const knowledge_card_validator = ajv.compile(load_schema("knowledge_card.schema.json"));
const sync_state_validator = ajv.compile(load_schema("sync_state.schema.json"));

export function validate_knowledge_card(value: unknown): ValidationResult {
  return run_validator(knowledge_card_validator, value);
}

export function validate_sync_state(value: unknown): ValidationResult {
  return run_validator(sync_state_validator, value);
}

function load_schema(file_name: string): object {
  const file_path = path.join(SCHEMA_DIR, file_name);
  try {
    return JSON.parse(readFileSync(file_path, "utf8")) as object;
  } catch (error) {
    throw new Error(`无法加载 schema 文件 ${file_path}：${describe_error(error)}`);
  }
}

function run_validator(validate: ValidateFunction, value: unknown): ValidationResult {
  if (validate(value)) {
    return { ok: true, errors: [] };
  }
  return { ok: false, errors: (validate.errors ?? []).map(to_validation_error) };
}

function to_validation_error(error: ErrorObject): SchemaValidationError {
  return {
    path: error_path(error),
    message: describe_validation_error(error),
    keyword: error.keyword,
  };
}

/** 把 ajv 的 instancePath（JSON Pointer）转成逻辑模型字段路径。 */
function error_path(error: ErrorObject): string {
  const base = pointer_to_path(error.instancePath);
  if (error.keyword === "required") {
    const missing = read_param_string(error, "missingProperty");
    return missing === undefined ? base : join_path(base, missing);
  }
  if (error.keyword === "additionalProperties") {
    const extra = read_param_string(error, "additionalProperty");
    return extra === undefined ? base : join_path(base, extra);
  }
  return base;
}

function pointer_to_path(pointer: string): string {
  const segments = pointer.split("/").slice(1).map(decode_pointer_segment);
  let result = "";
  for (const segment of segments) {
    result = /^\d+$/.test(segment) ? `${result}[${segment}]` : join_path(result, segment);
  }
  return result;
}

function decode_pointer_segment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function join_path(base: string, segment: string): string {
  return base === "" ? segment : `${base}.${segment}`;
}

function read_param_string(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function describe_validation_error(error: ErrorObject): string {
  switch (error.keyword) {
    case "required": {
      const missing = read_param_string(error, "missingProperty") ?? "未知字段";
      return `缺少必填字段 "${missing}"。`;
    }
    case "type": {
      const expected = (error.params as { type?: unknown }).type;
      return `字段类型不符合要求（期望 ${String(expected ?? "未知类型")}）。`;
    }
    case "enum": {
      const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return `取值不在允许范围内（允许：${allowed.join("、")}）。`;
    }
    case "additionalProperties": {
      const extra = read_param_string(error, "additionalProperty") ?? "未知字段";
      return `存在未定义的字段 "${extra}"。`;
    }
    case "pattern":
      return "取值不符合字段要求的格式。";
    default:
      return error.message ?? "字段校验失败。";
  }
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
