/**
 * 读取并核对运行目录（架构 §11.2、§13；Task 4d-1）。
 *
 * `run.json` 的阶段状态是缓存；阶段产物存在且通过校验时，产物优先。读取时
 * 逐个调用既有阶段校验器，发现差异就修正 `run.json` 并返回
 * `RUN_STATE_RECONCILED` warning。
 */

import { existsSync } from "node:fs";
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

export interface ReadRunSuccess {
  run: RunDocument;
  artifacts: RunArtifacts;
  warnings: RunWarning[];
}

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

    const artifacts = collect_artifacts(loaded.path);
    const reconciled = reconcile_stages(loaded.value, artifacts);
    if (reconciled.changed_stages.length === 0) {
      return {
        run: loaded.value,
        artifacts,
        warnings: [],
      };
    }

    const next_run: RunDocument = {
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

    return {
      run: next_run,
      artifacts,
      warnings: [
        {
          code: "RUN_STATE_RECONCILED",
          message: `run.json 与阶段产物不一致，已按产物修正阶段：${reconciled.changed_stages.join("、")}。`,
          refs: reconciled.changed_stages,
        },
      ],
    };
  } catch (error) {
    return run_failure("INTERNAL", "读取运行目录失败。", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function collect_artifacts(run_json_path: string): RunArtifacts {
  const run_dir = path.dirname(run_json_path);
  const artifacts = {} as RunArtifacts;

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
  }

  return artifacts;
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

function reconcile_stages(
  run: RunDocument,
  artifacts: RunArtifacts,
): ReconciledStages {
  const now = new Date().toISOString();
  const stages = {} as Record<RunStage, RunStageState>;
  const changed_stages: RunStage[] = [];

  for (const stage of RUN_STAGE_VALUES) {
    const current = run.stages[stage];
    const artifact = artifacts[stage];
    const desired = desired_stage_state(stage, artifact, current, now);
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
): RunStageState {
  const canonical_artifact = RUN_STAGE_ARTIFACTS[stage];

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

function same_stage_state(left: RunStageState, right: RunStageState): boolean {
  return (
    left.status === right.status &&
    left.artifact === right.artifact &&
    left.updated_at === right.updated_at
  );
}
