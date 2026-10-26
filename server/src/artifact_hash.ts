import { createHash } from "node:crypto";

const RUN_CONTEXT_FIELDS = [
  "input_mode",
  "project_id",
  "target_model",
  "aspect_ratio",
  "input_references",
  "display_timeline",
] as const;

/** 递归排序对象键、保留数组顺序后，用 Node 内置 SHA-256 生成十六进制指纹。 */
export function hash_artifact_document(value: unknown): string {
  return createHash("sha256").update(stable_stringify(value), "utf8").digest("hex");
}

/** 只散列会影响阶段失效判断的运行输入，不包含 stages / warnings 等状态。 */
export function hash_run_context(run: unknown): string {
  const context: Record<string, unknown> = {};
  if (is_record(run)) {
    for (const field of RUN_CONTEXT_FIELDS) {
      if (Object.hasOwn(run, field)) {
        context[field] = run[field];
      }
    }
  }
  return hash_artifact_document(context);
}

function stable_stringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (is_record(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) {
        result[key] = canonicalize(entry);
      }
    }
    return result;
  }
  if (value === undefined) {
    return null;
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
