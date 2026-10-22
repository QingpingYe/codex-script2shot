import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { init_run } from "../src/tools/init_run.js";
import { read_run, type RunArtifacts, type RunDocument } from "../src/tools/read_run.js";
import { update_run_state } from "../src/tools/update_run_state.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");
const runSchemaPath = path.join(repoRoot, "schemas", "run.schema.json");

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function readRunJson(filePath: string): RunDocument {
  return readJson(filePath) as unknown as RunDocument;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyFixture(fixtureName: string, outputPath: string): void {
  writeFileSync(outputPath, readFileSync(path.join(fixturesDir, fixtureName), "utf8"), "utf8");
}

/** 把 fixture 的 `run_id` 对齐到本次 run：产物属于该 run 时身份对账才不应报冲突。 */
function copyFixtureForRun(fixtureName: string, outputPath: string, runId: string): void {
  const document = readJson(path.join(fixturesDir, fixtureName));
  document.run_id = runId;
  writeJson(outputPath, document);
}

function successInit(result: ReturnType<typeof init_run>): { run_id: string; run_json_path: string } {
  if (!("run_id" in result)) {
    throw new Error(`expected init_run success: ${JSON.stringify(result)}`);
  }
  return result;
}

function successRead(result: ReturnType<typeof read_run>): {
  run: RunDocument;
  artifacts: RunArtifacts;
  warnings: Array<{
    code: string;
    message: string;
    refs?: string[];
    details?: Record<string, unknown>;
  }>;
} {
  if (!("run" in result)) {
    throw new Error(`expected read_run success: ${JSON.stringify(result)}`);
  }
  return result;
}

function successUpdate(result: ReturnType<typeof update_run_state>): { run: RunDocument } {
  if (!("run" in result)) {
    throw new Error(`expected update_run_state success: ${JSON.stringify(result)}`);
  }
  return result;
}

describe("run directory tools", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-run-tools-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function markAllStagesDone(runId: string): void {
    const artifacts = {
      script_breakdown: "script_analysis.json",
      shot_planning: "shot_plan.json",
      shot_prompting: "prompts.ir.json",
    } as const;
    for (const stage of ["script_breakdown", "shot_planning", "shot_prompting"] as const) {
      successUpdate(
        update_run_state({
          workspace_root: workspaceRoot,
          run_id: runId,
          stage,
          status: "done",
          artifact: artifacts[stage],
        }),
      );
    }
  }

  test("init run creates directory and schema valid run json", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );

    expect(created.run_id).toMatch(/^run-\d{8}-\d{6}$/);
    expect(created.run_json_path).toBe(
      path.join(workspaceRoot, ".script2shot", "outputs", created.run_id, "run.json"),
    );
    expect(existsSync(created.run_json_path)).toBe(true);

    const document = readJson(created.run_json_path);
    const schema = readJson(runSchemaPath);
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(document).toMatchObject({
      run_id: created.run_id,
      input_mode: "single_episode",
      project_id: "demo",
      target_model: "seedance-2.5",
      warnings: [],
      stages: {
        script_breakdown: { status: "pending", artifact: null, updated_at: null },
        shot_planning: { status: "pending", artifact: null, updated_at: null },
        shot_prompting: { status: "pending", artifact: null, updated_at: null },
      },
    });
    expect(document).not.toHaveProperty("aspect_ratio");
  });

  test("init run rejects unknown input mode and model", () => {
    const badMode = init_run({
      workspace_root: workspaceRoot,
      input_mode: "movie" as never,
      project_id: "demo",
      target_model: "seedance-2.5",
    });
    expect(badMode).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "input_mode" } },
    });

    const badModel = init_run({
      workspace_root: workspaceRoot,
      input_mode: "single_episode",
      project_id: "demo",
      target_model: "seedance-3.0" as never,
    });
    expect(badModel).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "target_model" } },
    });
    expect(existsSync(path.join(workspaceRoot, ".script2shot", "outputs"))).toBe(false);
  });

  test("run schema rejects an empty artifact string", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );

    const document = readJson(created.run_json_path);
    const schema = readJson(runSchemaPath);
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);

    // 工具层已拒绝空字符串 artifact；schema 层也必须 fail-closed，
    // 否则手工编辑 / 外部写入的 run.json 可以带空产物名通过校验。
    const stages = document.stages as Record<string, Record<string, unknown>>;
    stages.script_breakdown.artifact = "";
    expect(validate(document)).toBe(false);
    expect(
      (validate.errors ?? []).some(
        (error) => error.instancePath === "/stages/script_breakdown/artifact",
      ),
    ).toBe(true);
  });

  test("init run records optional aspect ratio", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
        aspect_ratio: "9:16",
      }),
    );
    expect(readRunJson(created.run_json_path).aspect_ratio).toBe("9:16");

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.run.aspect_ratio).toBe("9:16");

    const updated = successUpdate(
      update_run_state({
        workspace_root: workspaceRoot,
        run_id: created.run_id,
        stage: "script_breakdown",
        status: "running",
      }),
    );
    expect(updated.run.aspect_ratio).toBe("9:16");

    const invalid = init_run({
      workspace_root: workspaceRoot,
      input_mode: "single_episode",
      project_id: "demo",
      target_model: "seedance-2.5",
      aspect_ratio: "2:1" as never,
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "aspect_ratio" } },
    });
  });

  test("update run state transitions and stamps updated at", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );

    const running = successUpdate(
      update_run_state({
        workspace_root: workspaceRoot,
        run_id: created.run_id,
        stage: "script_breakdown",
        status: "running",
        warnings: [
          {
            code: "INDEX_UNAVAILABLE",
            message: "使用缓存",
            details: { index_state: "corrupt" },
          },
        ],
      }),
    );
    const runningState = running.run.stages.script_breakdown;
    expect(runningState.status).toBe("running");
    expect(runningState.updated_at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(runningState.updated_at ?? ""))).toBe(false);
    expect(running.run.warnings).toEqual([
      {
        code: "INDEX_UNAVAILABLE",
        message: "使用缓存",
        details: { index_state: "corrupt" },
      },
    ]);

    const done = successUpdate(
      update_run_state({
        workspace_root: workspaceRoot,
        run_id: created.run_id,
        stage: "script_breakdown",
        status: "done",
        artifact: "script_analysis.json",
      }),
    );
    const doneState = done.run.stages.script_breakdown;
    expect(doneState).toMatchObject({
      status: "done",
      artifact: "script_analysis.json",
    });
    expect(Date.parse(doneState.updated_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(runningState.updated_at ?? ""),
    );
    expect(done.run.warnings).toHaveLength(1);
    expect(readRunJson(created.run_json_path).stages.script_breakdown).toMatchObject({
      status: "done",
      artifact: "script_analysis.json",
    });
  });

  test("read run detects missing artifact as not done", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const document = readJson(created.run_json_path);
    const stages = document.stages as Record<string, Record<string, unknown>>;
    stages.script_breakdown = {
      status: "done",
      artifact: "script_analysis.json",
      updated_at: "2026-10-22T12:00:00+08:00",
    };
    writeJson(created.run_json_path, document);

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.run.stages.script_breakdown).toMatchObject({
      status: "pending",
      artifact: null,
    });
    expect(read.artifacts.script_breakdown).toMatchObject({
      exists: false,
      valid: false,
    });
    expect(read.warnings).toContainEqual(
      expect.objectContaining({ code: "RUN_STATE_RECONCILED" }),
    );
    expect(readRunJson(created.run_json_path).stages.script_breakdown).toMatchObject({
      status: "pending",
      artifact: null,
    });
  });

  test("run reconciles run json from artifacts", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const runDir = path.dirname(created.run_json_path);
    copyFixtureForRun(
      "script_analysis.sample.json",
      path.join(runDir, "script_analysis.json"),
      created.run_id,
    );
    successUpdate(
      update_run_state({
        workspace_root: workspaceRoot,
        run_id: created.run_id,
        stage: "script_breakdown",
        status: "done",
        artifact: "script_analysis.json",
      }),
    );

    const edited = readJson(created.run_json_path);
    const stages = edited.stages as Record<string, Record<string, unknown>>;
    stages.script_breakdown = {
      status: "pending",
      artifact: null,
      updated_at: null,
    };
    writeJson(created.run_json_path, edited);

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.run.stages.script_breakdown).toMatchObject({
      status: "done",
      artifact: "script_analysis.json",
      updated_at: expect.any(String),
    });
    expect(read.warnings).toContainEqual(
      expect.objectContaining({ code: "RUN_STATE_RECONCILED" }),
    );
    expect(readRunJson(created.run_json_path).stages.script_breakdown).toMatchObject({
      status: "done",
      artifact: "script_analysis.json",
    });
  });

  test("read run validates all three stage artifacts", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const runDir = path.dirname(created.run_json_path);
    copyFixtureForRun(
      "script_analysis.sample.json",
      path.join(runDir, "script_analysis.json"),
      created.run_id,
    );
    copyFixtureForRun(
      "shot_plan.sample.json",
      path.join(runDir, "shot_plan.json"),
      created.run_id,
    );
    copyFixtureForRun(
      "prompts_ir.sample.json",
      path.join(runDir, "prompts.ir.json"),
      created.run_id,
    );
    markAllStagesDone(created.run_id);

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.artifacts).toMatchObject({
      script_breakdown: { exists: true, valid: true, errors: [] },
      shot_planning: { exists: true, valid: true, errors: [] },
      shot_prompting: { exists: true, valid: true, errors: [] },
    });
    expect(read.run.stages).toMatchObject({
      script_breakdown: { status: "done" },
      shot_planning: { status: "done" },
      shot_prompting: { status: "done" },
    });
    expect(read.warnings).toEqual([]);
  });

  test("read run fails stages whose artifact identity conflicts with run json", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const runDir = path.dirname(created.run_json_path);
    copyFixtureForRun(
      "script_analysis.sample.json",
      path.join(runDir, "script_analysis.json"),
      created.run_id,
    );
    copyFixtureForRun(
      "shot_plan.sample.json",
      path.join(runDir, "shot_plan.json"),
      created.run_id,
    );
    copyFixtureForRun(
      "prompts_ir.sample.json",
      path.join(runDir, "prompts.ir.json"),
      created.run_id,
    );
    markAllStagesDone(created.run_id);

    // 手工改成另一个 schema 合法的目标模型：身份是运行上下文，冲突时必须 fail-closed。
    const edited = readJson(created.run_json_path);
    edited.target_model = "seedance-2.0";
    writeJson(created.run_json_path, edited);

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.run.stages).toMatchObject({
      script_breakdown: { status: "failed", artifact: "script_analysis.json" },
      shot_planning: { status: "failed", artifact: "shot_plan.json" },
      shot_prompting: { status: "failed", artifact: "prompts.ir.json" },
    });
    expect(read.warnings).toEqual([
      expect.objectContaining({
        code: "RUN_STATE_RECONCILED",
        refs: ["script_breakdown", "shot_planning", "shot_prompting"],
        details: {
          conflicts: [
            {
              artifact: "script_analysis.json",
              field: "target_model",
              run_value: "seedance-2.0",
              artifact_value: "seedance-2.5",
            },
            {
              artifact: "shot_plan.json",
              field: "target_model",
              run_value: "seedance-2.0",
              artifact_value: "seedance-2.5",
            },
            {
              artifact: "prompts.ir.json",
              field: "target_model",
              run_value: "seedance-2.0",
              artifact_value: "seedance-2.5",
            },
          ],
        },
      }),
    ]);

    // 冲突阶段写回 failed，但 run.json 的身份字段不被静默改写。
    const persisted = readRunJson(created.run_json_path);
    expect(persisted.target_model).toBe("seedance-2.0");
    expect(persisted.stages).toMatchObject({
      script_breakdown: { status: "failed" },
      shot_planning: { status: "failed" },
      shot_prompting: { status: "failed" },
    });
  });

  test("read run fails a stale artifact whose identity disagrees with its siblings", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const runDir = path.dirname(created.run_json_path);
    copyFixtureForRun(
      "script_analysis.sample.json",
      path.join(runDir, "script_analysis.json"),
      created.run_id,
    );
    copyFixtureForRun(
      "shot_plan.sample.json",
      path.join(runDir, "shot_plan.json"),
      created.run_id,
    );
    // prompts.ir.json 停留在另一次 run 的 run_id：与 run.json 和两个上游产物都不一致。
    copyFixture("prompts_ir.sample.json", path.join(runDir, "prompts.ir.json"));
    const stale_run_id = readJson(
      path.join(fixturesDir, "prompts_ir.sample.json"),
    ).run_id as string;
    expect(stale_run_id).not.toBe(created.run_id);
    markAllStagesDone(created.run_id);

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.run.stages).toMatchObject({
      script_breakdown: { status: "done" },
      shot_planning: { status: "done" },
      shot_prompting: { status: "failed", artifact: "prompts.ir.json" },
    });
    expect(read.warnings).toEqual([
      expect.objectContaining({
        code: "RUN_STATE_RECONCILED",
        refs: ["shot_prompting"],
        details: {
          conflicts: [
            {
              artifact: "prompts.ir.json",
              field: "run_id",
              run_value: created.run_id,
              artifact_value: stale_run_id,
            },
            {
              artifact: "prompts.ir.json",
              field: "run_id",
              run_value: created.run_id,
              artifact_value: stale_run_id,
              reference_artifact: "script_analysis.json",
              reference_value: created.run_id,
            },
          ],
        },
      }),
    ]);
  });

  test("read run marks an invalid artifact as failed", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const runDir = path.dirname(created.run_json_path);
    copyFixture(
      "script_analysis.invalid.bad_input_mode.json",
      path.join(runDir, "script_analysis.json"),
    );
    successUpdate(
      update_run_state({
        workspace_root: workspaceRoot,
        run_id: created.run_id,
        stage: "script_breakdown",
        status: "done",
        artifact: "script_analysis.json",
      }),
    );

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.artifacts.script_breakdown).toMatchObject({
      exists: true,
      valid: false,
      errors: [expect.objectContaining({ code: "enum", path: "/input_mode" })],
    });
    expect(read.run.stages.script_breakdown.status).toBe("failed");
    expect(read.warnings).toContainEqual(
      expect.objectContaining({ code: "RUN_STATE_RECONCILED" }),
    );
  });

  test("read run preserves a failed stage while its artifact is missing", () => {
    const created = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    successUpdate(
      update_run_state({
        workspace_root: workspaceRoot,
        run_id: created.run_id,
        stage: "script_breakdown",
        status: "failed",
        artifact: "script_analysis.json",
      }),
    );

    const read = successRead(
      read_run({ workspace_root: workspaceRoot, run_id: created.run_id }),
    );
    expect(read.run.stages.script_breakdown).toMatchObject({
      status: "failed",
      artifact: "script_analysis.json",
    });
    expect(read.warnings).toEqual([]);
  });

  test("init run advances run id on collision", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00"));

    const first = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );
    const second = successInit(
      init_run({
        workspace_root: workspaceRoot,
        input_mode: "single_episode",
        project_id: "demo",
        target_model: "seedance-2.5",
      }),
    );

    expect(first.run_id).toBe("run-20261022-120000");
    expect(second.run_id).toBe("run-20261022-120001");
  });
});
