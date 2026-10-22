/**
 * 更新一个运行阶段的 `run.json` 状态（架构 §11.2；Task 4d-1）。
 *
 * 只做确定性写入：校验阶段、状态、可选产物名和 warning 形状后，替换目标阶段的
 * 状态并把 `updated_at` 盖为当前时间；warning 只追加，不修改既有条目。
 */

import {
  RUN_STAGE_STATUS_VALUES,
  RUN_STAGE_VALUES,
  is_record,
  read_run_document,
  run_failure,
  validate_run_document,
  validate_run_id,
  validate_workspace_root,
  write_run_document,
  type RunDocument,
  type RunStage,
  type RunStageStatus,
  type RunToolFailure,
  type RunWarning,
} from "./init_run.js";

export interface UpdateRunStateInput {
  workspace_root: string;
  run_id: string;
  stage: RunStage;
  status: RunStageStatus;
  artifact?: string | null;
  warnings?: RunWarning[];
}

export interface UpdateRunStateSuccess {
  run: RunDocument;
}

export function update_run_state(
  input: UpdateRunStateInput,
): UpdateRunStateSuccess | RunToolFailure {
  try {
    const raw: Record<string, unknown> = is_record(input) ? input : {};
    const unknown_key = first_unknown_key(raw, [
      "workspace_root",
      "run_id",
      "stage",
      "status",
      "artifact",
      "warnings",
    ]);
    if (unknown_key !== undefined) {
      return run_failure(
        "CONFIG_INVALID",
        `入参包含不支持的字段 "${unknown_key}"。`,
        { field: unknown_key },
      );
    }

    const workspace_root = validate_workspace_root(raw.workspace_root);
    if (!workspace_root.ok) {
      return workspace_root;
    }
    const run_id = validate_run_id(raw.run_id);
    if (!run_id.ok) {
      return run_id;
    }
    const stage = validate_stage(raw.stage);
    if (!stage.ok) {
      return stage;
    }
    const status = validate_status(raw.status);
    if (!status.ok) {
      return status;
    }
    const artifact = validate_artifact(raw.artifact);
    if (!artifact.ok) {
      return artifact;
    }
    const warnings = validate_warnings(raw.warnings);
    if (!warnings.ok) {
      return warnings;
    }

    const loaded = read_run_document(workspace_root.value, run_id.value);
    if (!loaded.ok) {
      return loaded;
    }

    const current_stage = loaded.value.stages[stage.value];
    const updated: RunDocument = {
      ...loaded.value,
      stages: {
        ...loaded.value.stages,
        [stage.value]: {
          ...current_stage,
          status: status.value,
          ...(artifact.value === undefined ? {} : { artifact: artifact.value }),
          updated_at: new Date().toISOString(),
        },
      },
      warnings: [...(loaded.value.warnings ?? []), ...(warnings.value ?? [])],
    };

    const schema_result = validate_run_document(updated);
    if (!schema_result.ok) {
      return run_failure("RUN_SCHEMA_INVALID", "更新后的 run.json 不符合 schema。", {
        path: loaded.path,
        errors: schema_result.errors,
      });
    }

    const write_error = write_run_document(loaded.path, updated);
    if (write_error !== undefined) {
      return write_error;
    }

    return { run: updated };
  } catch (error) {
    return run_failure("INTERNAL", "更新运行状态失败。", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function validate_stage(
  value: unknown,
): { ok: true; value: RunStage } | RunToolFailure {
  if (typeof value !== "string" || !(RUN_STAGE_VALUES as readonly string[]).includes(value)) {
    return run_failure(
      "CONFIG_INVALID",
      `入参字段 "stage" 期望以下之一：${RUN_STAGE_VALUES.join("、")}。`,
      { field: "stage" },
    );
  }
  return { ok: true, value: value as RunStage };
}

export function validate_status(
  value: unknown,
): { ok: true; value: RunStageStatus } | RunToolFailure {
  if (
    typeof value !== "string" ||
    !(RUN_STAGE_STATUS_VALUES as readonly string[]).includes(value)
  ) {
    return run_failure(
      "CONFIG_INVALID",
      `入参字段 "status" 期望以下之一：${RUN_STAGE_STATUS_VALUES.join("、")}。`,
      { field: "status" },
    );
  }
  return { ok: true, value: value as RunStageStatus };
}

function validate_artifact(
  value: unknown,
): { ok: true; value: string | null | undefined } | RunToolFailure {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return run_failure(
      "CONFIG_INVALID",
      '入参字段 "artifact" 期望非空字符串或 null。',
      { field: "artifact" },
    );
  }
  return { ok: true, value };
}

function validate_warnings(
  value: unknown,
): { ok: true; value: RunWarning[] | undefined } | RunToolFailure {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return run_failure("CONFIG_INVALID", '入参字段 "warnings" 期望数组。', {
      field: "warnings",
    });
  }

  const warnings: RunWarning[] = [];
  for (const [index, entry] of value.entries()) {
    if (!is_record(entry)) {
      return run_failure("CONFIG_INVALID", `入参字段 "warnings[${index}]" 期望对象。`, {
        field: `warnings[${index}]`,
      });
    }
    const unknown_key = first_unknown_key(entry, ["code", "message", "refs"]);
    if (unknown_key !== undefined) {
      return run_failure(
        "CONFIG_INVALID",
        `warning[${index}] 包含不支持的字段 "${unknown_key}"。`,
        { field: `warnings[${index}].${unknown_key}` },
      );
    }
    if (typeof entry.code !== "string" || entry.code.trim() === "") {
      return run_failure("CONFIG_INVALID", `warning[${index}].code 期望非空字符串。`, {
        field: `warnings[${index}].code`,
      });
    }
    if (typeof entry.message !== "string" || entry.message.trim() === "") {
      return run_failure("CONFIG_INVALID", `warning[${index}].message 期望非空字符串。`, {
        field: `warnings[${index}].message`,
      });
    }
    if (entry.refs !== undefined) {
      if (!Array.isArray(entry.refs) || entry.refs.some((ref) => typeof ref !== "string")) {
        return run_failure("CONFIG_INVALID", `warning[${index}].refs 期望字符串数组。`, {
          field: `warnings[${index}].refs`,
        });
      }
    }
    warnings.push({
      code: entry.code,
      message: entry.message,
      ...(entry.refs === undefined ? {} : { refs: [...entry.refs] as string[] }),
    });
  }

  return { ok: true, value: warnings };
}

function first_unknown_key(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key));
}
