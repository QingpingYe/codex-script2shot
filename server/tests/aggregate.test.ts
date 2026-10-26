import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  aggregate_knowledge_refs,
  write_warnings,
  type AggregateKnowledgeRefsSuccess,
  type WriteWarningsSuccess,
} from "../src/aggregate.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");
const runId = "run-20261026-120000";

function read_json(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
}

function write_json(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copy_fixture(fixtureName: string, outputPath: string): void {
  writeFileSync(outputPath, readFileSync(path.join(fixturesDir, fixtureName), "utf8"), "utf8");
}

function aggregate_success(result: ReturnType<typeof aggregate_knowledge_refs>): AggregateKnowledgeRefsSuccess {
  if (!("output_path" in result)) throw new Error(`expected aggregate success: ${JSON.stringify(result)}`);
  return result;
}

function warnings_success(result: ReturnType<typeof write_warnings>): WriteWarningsSuccess {
  if (!("output_path" in result)) throw new Error(`expected warnings success: ${JSON.stringify(result)}`);
  return result;
}

function reference(cardId: string, clipId: string | null, shotId: string | null): Record<string, unknown> {
  return {
    card_id: cardId,
    scene_id: "ep01-sc01",
    clip_id: clipId,
    shot_id: shotId,
    query: `${cardId} 查询`,
    usage: "used",
    source_doc_token: "doc-token",
    source_path: `项目知识/demo/${cardId}`,
    source_revision: 12,
    last_synced_at: "2026-10-26T12:00:00+08:00",
  };
}

describe("knowledge refs and warnings aggregation v2", () => {
  let tempDir: string;
  let runDir: string;
  let scriptAnalysisPath: string;
  let shotPlanPath: string;
  let promptIrPath: string;
  let knowledgeRefsPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-aggregate-v2-"));
    runDir = path.join(tempDir, "run");
    mkdirSync(runDir, { recursive: true });
    scriptAnalysisPath = path.join(runDir, "script_analysis.json");
    shotPlanPath = path.join(runDir, "shot_plan.json");
    promptIrPath = path.join(runDir, "prompts.ir.json");
    knowledgeRefsPath = path.join(runDir, "knowledge_refs.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("aggregates empty refs from v2 fixtures", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    const result = aggregate_success(aggregate_knowledge_refs({
      run_id: runId,
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: knowledgeRefsPath,
    }));

    expect(result.counts).toEqual({ script_breakdown: 0, shot_planning: 0, shot_prompting: 0 });
    expect(read_json(knowledgeRefsPath)).toEqual({
      run_id: runId,
      stages: { script_breakdown: [], shot_planning: [], shot_prompting: [] },
    });
  });

  test("flattens prompt clip refs in clip order and preserves clip_id", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    const prompt = read_json(path.join(fixturesDir, "prompts_ir.sample.json"));
    prompt.clips[0].knowledge_refs = [
      reference("card-clip-1-a", "ep01-sc01-c01", "ep01-sc01-c01-s01"),
      reference("card-clip-1-b", "ep01-sc01-c01", null),
    ];
    prompt.clips[1].knowledge_refs = [
      reference("card-clip-2-a", "ep01-sc02-c01", "ep01-sc02-c01-s02"),
    ];
    write_json(promptIrPath, prompt);

    const result = aggregate_success(aggregate_knowledge_refs({
      run_id: runId,
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: knowledgeRefsPath,
    }));

    expect(result.counts.shot_prompting).toBe(3);
    const stages = read_json(knowledgeRefsPath).stages as Record<string, Array<Record<string, unknown>>>;
    expect(stages.shot_prompting.map((entry) => [entry.card_id, entry.clip_id, entry.shot_id])).toEqual([
      ["card-clip-1-b", "ep01-sc01-c01", null],
      ["card-clip-1-a", "ep01-sc01-c01", "ep01-sc01-c01-s01"],
      ["card-clip-2-a", "ep01-sc02-c01", "ep01-sc02-c01-s02"],
    ]);
  });

  test("rejects prompt refs whose clip_id or shot_id does not belong to the clip", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    const prompt = read_json(path.join(fixturesDir, "prompts_ir.sample.json"));
    prompt.clips[0].knowledge_refs = [reference("bad-ref", "ep01-sc02-c01", null)];
    write_json(promptIrPath, prompt);
    const result = aggregate_knowledge_refs({ run_id: runId, script_analysis_path: scriptAnalysisPath, shot_plan_path: shotPlanPath, prompt_ir_path: promptIrPath, output_path: knowledgeRefsPath });
    expect(result).toMatchObject({ ok: false, error: { code: "STAGE_ARTIFACT_INVALID" } });
  });


  test("replaces a stage array on rerun", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    const plan = read_json(path.join(fixturesDir, "shot_plan.sample.json"));
    plan.knowledge_refs = [reference("card-plan-old", "ep01-sc01-c01", null)];
    write_json(shotPlanPath, plan);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    aggregate_success(aggregate_knowledge_refs({ run_id: runId, script_analysis_path: scriptAnalysisPath, shot_plan_path: shotPlanPath, prompt_ir_path: promptIrPath, output_path: knowledgeRefsPath }));
    plan.knowledge_refs = [reference("card-plan-new", "ep01-sc01-c01", null)];
    write_json(shotPlanPath, plan);
    const rerun = aggregate_success(aggregate_knowledge_refs({ run_id: runId, script_analysis_path: scriptAnalysisPath, shot_plan_path: shotPlanPath, prompt_ir_path: promptIrPath, output_path: knowledgeRefsPath }));

    expect(rerun.counts.shot_planning).toBe(1);
    const stages = read_json(knowledgeRefsPath).stages as Record<string, Array<Record<string, unknown>>>;
    expect(stages.shot_planning.map((entry) => entry.card_id)).toEqual(["card-plan-new"]);
  });

  test("warns and sanitizes warning markdown", () => {
    const runPath = path.join(runDir, "run.json");
    const warningsPath = path.join(runDir, "warnings.md");
    write_json(runPath, {
      schema_version: 2,
      run_id: runId,
      input_mode: "single_episode",
      project_id: "demo",
      target_model: "seedance-2.5",
      warnings: [{ code: "INJECT", message: "---\n# 伪造小节\n第二行", refs: ["ref`a\n# b"] }],
      stages: {},
    });
    write_json(scriptAnalysisPath, { missing_info: [] });
    write_json(shotPlanPath, { missing_info: [] });
    write_json(promptIrPath, { missing_info: [] });

    const result = warnings_success(write_warnings({ run_id: runId, run_path: runPath, script_analysis_path: scriptAnalysisPath, shot_plan_path: shotPlanPath, prompt_ir_path: promptIrPath, output_path: warningsPath }));
    expect(result.count).toBe(1);
    const markdown = readFileSync(warningsPath, "utf8");
    expect(markdown).not.toMatch(/^---$/m);
    expect(markdown).toContain("\\--- # 伪造小节 第二行");
  });

  test("reports missing artifacts without writing output", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);
    const result = aggregate_knowledge_refs({ run_id: runId, script_analysis_path: scriptAnalysisPath, shot_plan_path: shotPlanPath, prompt_ir_path: promptIrPath, output_path: knowledgeRefsPath });
    expect(result).toMatchObject({ ok: false, error: { code: "STAGE_ARTIFACT_MISSING" } });
    expect(existsSync(knowledgeRefsPath)).toBe(false);
  });
});
