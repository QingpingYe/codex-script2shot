/**
 * 读取并核对运行目录（架构 §11.2、§13；Task 4d-1；最终复核 R21 身份对账）。
 *
 * `run.json` 的阶段状态是缓存；阶段产物存在且通过校验时，产物优先。读取时逐个调用
 * 既有阶段校验器，发现差异就修正 `run.json` 并返回 `RUN_STATE_RECONCILED` warning。
 * 同时核对通过校验的产物身份字段（`run_id` / `input_mode` / `project_id` /
 * `target_model`）与 `run.json` 及产物之间是否一致：任一冲突都把冲突产物所属阶段置
 * `failed`，在 warning 的 `details.conflicts[]` 中逐条报告，并且不重写身份字段。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  RUN_STAGE_ARTIFACTS,
  RUN_STAGE_VALUES,
  read_run_document,
  run_failure,
  validate_run_id,
  validate_run_document,
  validate_workspace_root,
  write_run_document,
  type RunDocument,
  type RunStage,
  type RunStageState,
  type RunToolFailure,
  type RunWarning,
} from "./init_run.js";
import {
  validate_stage_artifact,
  type StageArtifactValidationError,
} from "./validate_stage_artifact.js";
import {
  validate_prompt,
  type PromptValidationError,
} from "./validate_prompt.js";

export type { RunDocument } from "./init_run.js";

export interface ReadRunInput {
  workspace_root: string;
  run_id: string;
}

export interface RunArtifactError {
  code: string;
  message: string;
  path?: string;
  field?: string;
  shot_id?: string;
}

export interface RunArtifactStatus {
  artifact: string;
  path: string;
  exists: boolean;
  valid: boolean;
  errors: RunArtifactError[];
}

export type RunArtifacts = Record<RunStage, RunArtifactStatus>;

export type RunIdentityField = "run_id" | "input_mode" | "project_id" | "target_model";

/** identity 冲突条目：`reference_artifact` / `reference_value` 只在产物之间比对时出现。 */
export interface RunIdentityConflict {
  artifact: string;
  field: RunIdentityField;
  run_value: string;
  artifact_value: string;
  reference_artifact?: string;
  reference_value?: string;
}

type ArtifactIdentities = Record<RunStage, Partial<Record<RunIdentityField, string>>>;

interface CollectedArtifacts {
  artifacts: RunArtifacts;
  identities: ArtifactIdentities;
}

export interface ReadRunSuccess {
  run: RunDocument;
  artifacts: RunArtifacts;
  warnings: RunWarning[];
}

const RUN_IDENTITY_FIELDS: readonly RunIdentityField[] = [
  "run_id",
  "input_mode",
  "project_id",
  "target_model",
];

/** 每个阶段产物携带的身份字段（架构 §11.2 的阶段产物 schema）。 */
const STAGE_IDENTITY_FIELDS: Record<RunStage, readonly RunIdentityField[]> = {
  script_breakdown: ["run_id", "input_mode", "project_id", "target_model"],
  shot_planning: ["run_id", "project_id", "target_model"],
  shot_prompting: ["run_id", "target_model"],
};

export function read_run(input: ReadRunInput): ReadRunSuccess | RunToolFailure {
  try {
    const workspace_root = validate_workspace_root(input?.workspace_root);
    if (!workspace_root.ok) {
      return workspace_root;
    }
    const run_id = validate_run_id(input?.run_id);
    if (!run_id.ok) {
      return run_id;
    }

    const loaded = read_run_document(workspace_root.value, run_id.value);
    if (!loaded.ok) {
      return loaded;
    }

    const collected = collect_artifacts(loaded.path);
    const identity = compare_identities(loaded.value, collected.identities);
    const reconciled = reconcile_stages(
      loaded.value,
      collected.artifacts,
      identity.conflicted_stages,
    );
    const has_conflicts = identity.conflicts.length > 0;
    if (reconciled.changed_stages.length === 0 && !has_conflicts) {
      return {
        run: loaded.value,
        artifacts: collected.artifacts,
        warnings: [],
      };
    }

    let next_run = loaded.value;
    if (reconciled.changed_stages.length > 0) {
      next_run = {
        ...loaded.value,
        stages: reconciled.stages,
      };
      const schema_result = validate_run_document(next_run);
      if (!schema_result.ok) {
        return run_failure("RUN_SCHEMA_INVALID", "修正后的 run.json 不符合 schema。", {
          path: loaded.path,
          errors: schema_result.errors,
        });
      }

      const write_error = write_run_document(loaded.path, next_run);
      if (write_error !== undefined) {
        return write_error;
      }
    }

    return {
      run: next_run,
      artifacts: collected.artifacts,
      warnings: [
        {
          code: "RUN_STATE_RECONCILED",
          message: reconciliation_message(
            reconciled.changed_stages,
            identity.conflicted_stages,
          ),
          refs: reconciliation_refs(
            reconciled.changed_stages,
            identity.conflicted_stages,
          ),
          ...(has_conflicts ? { details: { conflicts: identity.conflicts } } : {}),
        },
      ],
    };
  } catch (error) {
    return run_failure("INTERNAL", "读取运行目录失败。", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function collect_artifacts(run_json_path: string): CollectedArtifacts {
  const run_dir = path.dirname(run_json_path);
  const artifacts = {} as RunArtifacts;
  const identities = {} as ArtifactIdentities;

  for (const stage of RUN_STAGE_VALUES) {
    const artifact = RUN_STAGE_ARTIFACTS[stage];
    const artifact_path = path.join(run_dir, artifact);
    const exists = existsSync(artifact_path);
    const validation = validate_artifact(stage, artifact_path);
    artifacts[stage] = {
      artifact,
      path: artifact_path,
      exists,
      valid: validation.ok,
      errors: validation.errors,
    };
    identities[stage] = validation.ok ? read_identities(artifact_path, stage) : {};
  }

  return { artifacts, identities };
}

/**
 * 只读取通过校验的产物身份字段：对应的 schema 已保证这些字段存在且为字符串。读失败或
 * 解析失败按「身份未知」处理，不把读取异常升级成身份冲突。
 */
function read_identities(
  artifact_path: string,
  stage: RunStage,
): Partial<Record<RunIdentityField, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifact_path, "utf8")) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const identities: Partial<Record<RunIdentityField, string>> = {};
  for (const field of STAGE_IDENTITY_FIELDS[stage]) {
    const value = record[field];
    if (typeof value === "string") {
      identities[field] = value;
    }
  }
  return identities;
}

type ArtifactValidation = {
  ok: boolean;
  errors: RunArtifactError[];
};

function validate_artifact(stage: RunStage, artifact_path: string): ArtifactValidation {
  if (stage === "shot_prompting") {
    const result = validate_prompt({ prompt_ir_path: artifact_path });
    return {
      ok: result.ok,
      errors: result.errors.map(to_prompt_error),
    };
  }

  const result = validate_stage_artifact({ stage, path: artifact_path });
  return {
    ok: result.ok,
    errors: result.errors.map(to_stage_artifact_error),
  };
}

function to_stage_artifact_error(error: StageArtifactValidationError): RunArtifactError {
  return {
    code: error.code ?? error.keyword ?? "SCHEMA_INVALID",
    message: error.message,
    ...(error.path === "" ? {} : { path: error.path }),
  };
}

function to_prompt_error(error: PromptValidationError): RunArtifactError {
  return {
    code: error.code,
    message: error.message,
    ...(error.field === "" ? {} : { field: error.field }),
    ...(error.shot_id === "" ? {} : { shot_id: error.shot_id }),
  };
}

interface ReconciledStages {
  stages: Record<RunStage, RunStageState>;
  changed_stages: RunStage[];
}

interface IdentityComparison {
  conflicts: RunIdentityConflict[];
  conflicted_stages: RunStage[];
}

/**
 * 身份字段是运行上下文而不是阶段状态，因此任一不一致都算冲突：先逐产物对照
 * `run.json`；同一字段在多个产物之间不一致时，以固定阶段顺序最先出现的产物为对照，
 * 只把取值不同的产物判为冲突。冲突产物所属阶段按 fail-closed 处理。
 */
function compare_identities(
  run: RunDocument,
  identities: ArtifactIdentities,
): IdentityComparison {
  const conflicts: RunIdentityConflict[] = [];
  const conflicted = new Set<RunStage>();

  for (const stage of RUN_STAGE_VALUES) {
    const artifact = RUN_STAGE_ARTIFACTS[stage];
    for (const field of STAGE_IDENTITY_FIELDS[stage]) {
      const artifact_value = identities[stage][field];
      if (artifact_value === undefined || artifact_value === run[field]) {
        continue;
      }
      conflicts.push({ artifact, field, run_value: run[field], artifact_value });
      conflicted.add(stage);
    }
  }

  for (const field of RUN_IDENTITY_FIELDS) {
    const carriers = RUN_STAGE_VALUES.filter(
      (stage) => identities[stage][field] !== undefined,
    );
    const reference_stage = carriers[0];
    if (reference_stage === undefined) {
      continue;
    }
    const reference_value = identities[reference_stage][field] as string;
    for (const stage of carriers.slice(1)) {
      const artifact_value = identities[stage][field] as string;
      if (artifact_value === reference_value) {
        continue;
      }
      conflicts.push({
        artifact: RUN_STAGE_ARTIFACTS[stage],
        field,
        run_value: run[field],
        artifact_value,
        reference_artifact: RUN_STAGE_ARTIFACTS[reference_stage],
        reference_value,
      });
      conflicted.add(stage);
    }
  }

  return {
    conflicts,
    conflicted_stages: RUN_STAGE_VALUES.filter((stage) => conflicted.has(stage)),
  };
}

function reconcile_stages(
  run: RunDocument,
  artifacts: RunArtifacts,
  conflicted_stages: readonly RunStage[],
): ReconciledStages {
  const now = new Date().toISOString();
  const stages = {} as Record<RunStage, RunStageState>;
  const changed_stages: RunStage[] = [];
  const conflicted = new Set(conflicted_stages);

  for (const stage of RUN_STAGE_VALUES) {
    const current = run.stages[stage];
    const artifact = artifacts[stage];
    const desired = desired_stage_state(
      stage,
      artifact,
      current,
      now,
      conflicted.has(stage),
    );
    stages[stage] = desired;
    if (!same_stage_state(current, desired)) {
      changed_stages.push(stage);
    }
  }

  return { stages, changed_stages };
}

function desired_stage_state(
  stage: RunStage,
  artifact: RunArtifactStatus,
  current: RunStageState,
  now: string,
  identity_conflict: boolean,
): RunStageState {
  const canonical_artifact = RUN_STAGE_ARTIFACTS[stage];

  if (identity_conflict) {
    return failed_stage_state(current, canonical_artifact, now);
  }

  if (artifact.valid) {
    return {
      status: "done",
      artifact: canonical_artifact,
      updated_at:
        current.status === "done" &&
        current.artifact === canonical_artifact &&
        current.updated_at !== null
          ? current.updated_at
          : now,
    };
  }

  if (artifact.exists) {
    return failed_stage_state(current, canonical_artifact, now);
  }

  // 没有产物不能证明阶段完成；但 failed / running 是运行中的真实状态，不能因为
  // 暂时没有文件就被读操作改写。只有 done 与“无有效产物”明确矛盾时才降级。
  if (current.status !== "done") {
    return current;
  }
  return {
    status: "pending",
    artifact: null,
    updated_at: null,
  };
}

/** 已是 failed 且产物名未变时保留原 `updated_at`，避免读操作反复改写时间戳。 */
function failed_stage_state(
  current: RunStageState,
  canonical_artifact: string,
  now: string,
): RunStageState {
  return {
    status: "failed",
    artifact: canonical_artifact,
    updated_at:
      current.status === "failed" &&
      current.artifact === canonical_artifact &&
      current.updated_at !== null
        ? current.updated_at
        : now,
  };
}

function reconciliation_refs(
  changed_stages: readonly RunStage[],
  conflicted_stages: readonly RunStage[],
): RunStage[] {
  const stages = new Set<RunStage>([...changed_stages, ...conflicted_stages]);
  return RUN_STAGE_VALUES.filter((stage) => stages.has(stage));
}

function reconciliation_message(
  changed_stages: readonly RunStage[],
  conflicted_stages: readonly RunStage[],
): string {
  if (conflicted_stages.length === 0) {
    return `run.json 与阶段产物不一致，已按产物修正阶段：${changed_stages.join("、")}。`;
  }

  const messages = [
    "run.json 与阶段产物身份字段冲突，已把冲突产物所属阶段标记为 failed：" +
      `${conflicted_stages.join("、")}，不重写身份字段。`,
  ];
  if (changed_stages.length > 0) {
    messages.push(`已按产物修正阶段状态：${changed_stages.join("、")}。`);
  }
  return messages.join("");
}

function same_stage_state(left: RunStageState, right: RunStageState): boolean {
  return (
    left.status === right.status &&
    left.artifact === right.artifact &&
    left.updated_at === right.updated_at
  );
}
