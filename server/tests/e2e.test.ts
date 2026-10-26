import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { init_run } from "../src/tools/init_run.js";
import { read_run } from "../src/tools/read_run.js";
import { update_run_state } from "../src/tools/update_run_state.js";
import { aggregate_knowledge_refs, write_warnings } from "../src/aggregate.js";
import { hash_artifact_document, hash_run_context } from "../src/artifact_hash.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const shortdramaDir = path.join(repoRoot, "tests", "fixtures", "shortdrama");

function read_json(file_path: string): Record<string, any> {
  return JSON.parse(readFileSync(file_path, "utf8")) as Record<string, any>;
}

function write_json(file_path: string, value: unknown): void {
  writeFileSync(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("script2shot v2 end to end", () => {
  let workspaceRoot: string;
  let runDir: string;
  let runId: string;
  let runJsonPath: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-e2e-v2-"));
    const init = init_run({
      workspace_root: workspaceRoot,
      input_mode: "script_segment",
      project_id: "demo",
      target_model: "seedance-2.5",
      aspect_ratio: "9:16",
      display_timeline: true,
    });
    if (!("run_id" in init)) throw new Error("init_run failed");
    runId = init.run_id;
    runJsonPath = init.run_json_path;
    runDir = path.dirname(runJsonPath);
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function write_linked_artifacts(edit?: (analysis: Record<string, any>) => void): void {
    const run = read_json(runJsonPath);
    const analysis = read_json(path.join(shortdramaDir, "script_analysis.v2.json"));
    analysis.run_id = runId;
    analysis.input_hashes.run_context = hash_run_context(run);
    edit?.(analysis);
    const plan = read_json(path.join(shortdramaDir, "shot_plan.v2.json"));
    plan.run_id = runId;
    plan.input_hashes.script_analysis = hash_artifact_document(analysis);
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.run_id = runId;
    prompt.input_hashes = {
      script_analysis: hash_artifact_document(analysis),
      shot_plan: hash_artifact_document(plan),
    };
    write_json(path.join(runDir, "script_analysis.json"), analysis);
    write_json(path.join(runDir, "shot_plan.json"), plan);
    write_json(path.join(runDir, "prompts.ir.json"), prompt);
  }

  function mark_all_done(): void {
    for (const [stage, artifact] of [
      ["script_breakdown", "script_analysis.json"],
      ["shot_planning", "shot_plan.json"],
      ["shot_prompting", "prompts.ir.json"],
    ] as const) {
      const result = update_run_state({ workspace_root: workspaceRoot, run_id: runId, stage, status: "done", artifact });
      if (!("run" in result)) throw new Error("update_run_state failed");
    }
  }

  test("builds all seven artifacts from a valid v2 run", () => {
    write_linked_artifacts();
    mark_all_done();
    const read = read_run({ workspace_root: workspaceRoot, run_id: runId });
    expect(read).toMatchObject({
      run_context_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifacts: {
        script_breakdown: { valid: true },
        shot_planning: { valid: true },
        shot_prompting: { valid: true },
      },
    });
    const knowledge = aggregate_knowledge_refs({
      run_id: runId,
      script_analysis_path: path.join(runDir, "script_analysis.json"),
      shot_plan_path: path.join(runDir, "shot_plan.json"),
      prompt_ir_path: path.join(runDir, "prompts.ir.json"),
      output_path: path.join(runDir, "knowledge_refs.json"),
    });
    const warnings = write_warnings({
      run_id: runId,
      run_path: runJsonPath,
      script_analysis_path: path.join(runDir, "script_analysis.json"),
      shot_plan_path: path.join(runDir, "shot_plan.json"),
      prompt_ir_path: path.join(runDir, "prompts.ir.json"),
      output_path: path.join(runDir, "warnings.md"),
    });
    expect(knowledge).toMatchObject({ output_path: path.join(runDir, "knowledge_refs.json") });
    expect(warnings).toMatchObject({ output_path: path.join(runDir, "warnings.md") });
    for (const name of ["run.json", "script_analysis.json", "shot_plan.json", "prompts.ir.json", "knowledge_refs.json", "warnings.md"]) {
      expect(existsSync(path.join(runDir, name))).toBe(true);
    }
  });

  test("rejects legacy artifacts before reconciliation", () => {
    copyFileSync(path.join(repoRoot, "tests", "fixtures", "legacy_script_analysis.v1.json"), path.join(runDir, "script_analysis.json"));
    const result = read_run({ workspace_root: workspaceRoot, run_id: runId });
    expect(result).toMatchObject({ ok: false, error: { code: "ARTIFACT_VERSION_UNSUPPORTED" } });
  });

  test("marks downstream stages stale when upstream text changes without updating hashes", () => {
    write_linked_artifacts();
    mark_all_done();
    const analysis = read_json(path.join(runDir, "script_analysis.json"));
    analysis.episodes[0].scenes[0].action_units[0].description = "林岚把信封收回。";
    write_json(path.join(runDir, "script_analysis.json"), analysis);

    const read = read_run({ workspace_root: workspaceRoot, run_id: runId });
    if (!("run" in read)) throw new Error("expected read_run success");
    expect(read.warnings.some((warning) => warning.code === "RUN_ARTIFACT_STALE")).toBe(true);
    expect(read.run.stages.shot_planning.status).toBe("pending");
    expect(read.run.stages.shot_prompting.status).toBe("pending");
  });
});
