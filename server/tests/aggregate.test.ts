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
const runId = "run-20261020-120000";

function read_json(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function write_json(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copy_fixture(fixtureName: string, outputPath: string): void {
  writeFileSync(outputPath, readFileSync(path.join(fixturesDir, fixtureName), "utf8"), "utf8");
}

function aggregate_success(
  result: ReturnType<typeof aggregate_knowledge_refs>,
): AggregateKnowledgeRefsSuccess {
  if (!("output_path" in result)) {
    throw new Error(`expected aggregate success: ${JSON.stringify(result)}`);
  }
  return result;
}

function warnings_success(
  result: ReturnType<typeof write_warnings>,
): WriteWarningsSuccess {
  if (!("output_path" in result)) {
    throw new Error(`expected warnings success: ${JSON.stringify(result)}`);
  }
  return result;
}

function reference(cardId: string, shotId: string | null): Record<string, unknown> {
  return {
    card_id: cardId,
    scene_id: "ep01-sc01",
    shot_id: shotId,
    query: `${cardId} 查询`,
    usage: "used",
    source_doc_token: "doc-token",
    source_path: `项目知识/demo/${cardId}`,
    source_revision: 12,
    last_synced_at: "2026-10-20T12:00:00+08:00",
  };
}

function run_document(warnings: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    run_id: runId,
    input_mode: "single_episode",
    project_id: "demo",
    target_model: "seedance-2.5",
    warnings,
    stages: {
      script_breakdown: { status: "done", artifact: "script_analysis.json", updated_at: null },
      shot_planning: { status: "done", artifact: "shot_plan.json", updated_at: null },
      shot_prompting: { status: "done", artifact: "prompts.ir.json", updated_at: null },
    },
  };
}

describe("knowledge refs and warnings aggregation", () => {
  let tempDir: string;
  let runDir: string;
  let scriptAnalysisPath: string;
  let shotPlanPath: string;
  let promptIrPath: string;
  let knowledgeRefsPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-aggregate-"));
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

  test("aggregate collects refs from three artifacts", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    const result = aggregate_success(
      aggregate_knowledge_refs({
        run_id: runId,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: knowledgeRefsPath,
      }),
    );

    expect(result).toEqual({
      output_path: knowledgeRefsPath,
      counts: {
        script_breakdown: 1,
        shot_planning: 1,
        shot_prompting: 1,
      },
    });

    const document = read_json(knowledgeRefsPath);
    const stages = document.stages as Record<string, Array<Record<string, unknown>>>;
    expect(document.run_id).toBe(runId);
    expect(stages.script_breakdown.map((entry) => entry.card_id)).toEqual([
      "src:doc-token:character_bible:001",
    ]);
    expect(stages.shot_planning.map((entry) => entry.card_id)).toEqual([
      "src:doc-token:camera_lexicon:001",
    ]);
    expect(stages.shot_prompting.map((entry) => entry.card_id)).toEqual([
      "src:doc-token:camera_lexicon:001",
    ]);
  });

  test("aggregate replaces stage refs on rerun", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    aggregate_success(
      aggregate_knowledge_refs({
        run_id: runId,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: knowledgeRefsPath,
      }),
    );

    const changedShotPlan = read_json(shotPlanPath);
    changedShotPlan.knowledge_refs = [
      reference("src:doc-token:storyboard:999", "ep01-sc01-sh01"),
    ];
    write_json(shotPlanPath, changedShotPlan);

    const rerun = aggregate_success(
      aggregate_knowledge_refs({
        run_id: runId,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: knowledgeRefsPath,
      }),
    );
    expect(rerun.counts.shot_planning).toBe(1);

    const stages = read_json(knowledgeRefsPath).stages as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(stages.shot_planning.map((entry) => entry.card_id)).toEqual([
      "src:doc-token:storyboard:999",
    ]);
    expect(stages.shot_planning.map((entry) => entry.card_id)).not.toContain(
      "src:doc-token:camera_lexicon:001",
    );
  });

  test("aggregate flattens prompt refs in shot order", () => {
    write_json(scriptAnalysisPath, { knowledge_refs: [] });
    write_json(shotPlanPath, { knowledge_refs: [] });
    write_json(promptIrPath, {
      shots: [
        {
          shot_id: "ep01-sc01-sh02",
          knowledge_refs: [
            reference("src:doc-token:prompt_technique:002", "ep01-sc01-sh02"),
            reference("src:doc-token:seedance_rule:002", "ep01-sc01-sh02"),
          ],
        },
        {
          shot_id: "ep01-sc01-sh01",
          knowledge_refs: [
            reference("src:doc-token:prompt_technique:001", "ep01-sc01-sh01"),
          ],
        },
      ],
    });

    const result = aggregate_success(
      aggregate_knowledge_refs({
        run_id: runId,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: knowledgeRefsPath,
      }),
    );

    expect(result.counts.shot_prompting).toBe(3);
    const stages = read_json(knowledgeRefsPath).stages as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(stages.shot_prompting.map((entry) => entry.card_id)).toEqual([
      "src:doc-token:prompt_technique:002",
      "src:doc-token:seedance_rule:002",
      "src:doc-token:prompt_technique:001",
    ]);
  });

  test("aggregate output matches stage conventions fixture shape", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    aggregate_success(
      aggregate_knowledge_refs({
        run_id: runId,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: knowledgeRefsPath,
      }),
    );

    const outputText = readFileSync(knowledgeRefsPath, "utf8");
    expect(JSON.parse(outputText)).toEqual(read_json(path.join(fixturesDir, "knowledge_refs.sample.json")));
    expect(outputText.endsWith("\n")).toBe(true);
    expect(outputText).not.toContain("\r");
  });

  test("warnings deduplicate identical entries and keep order", () => {
    const runPath = path.join(runDir, "run.json");
    const warningsPath = path.join(runDir, "warnings.md");
    write_json(
      runPath,
      run_document([
        { code: "INDEX_UNAVAILABLE", message: "索引不可用", refs: ["index"] },
        { code: "MULTI_EPISODE", message: "建议按集运行" },
      ]),
    );
    write_json(scriptAnalysisPath, {
      missing_info: [
        { code: "INDEX_UNAVAILABLE", message: "索引不可用", scene_id: "ep01-sc01" },
        {
          code: "SCENE_TIME_UNKNOWN",
          message: "场景时间未在原文交代",
          scene_id: "ep01-sc01",
        },
      ],
    });
    write_json(shotPlanPath, { missing_info: [] });
    write_json(promptIrPath, { missing_info: [] });

    const result = warnings_success(
      write_warnings({
        run_id: runId,
        run_path: runPath,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: warningsPath,
      }),
    );

    expect(result).toEqual({ output_path: warningsPath, count: 3 });
    const markdown = readFileSync(warningsPath, "utf8");
    expect(markdown).toBe(
      [
        "# 警告汇总",
        "",
        `- 运行：\`${runId}\``,
        "- 警告数：3",
        "",
        "## 1. INDEX_UNAVAILABLE",
        "",
        "索引不可用",
        "",
        "引用：`index`",
        "",
        "## 2. MULTI_EPISODE",
        "",
        "建议按集运行",
        "",
        "## 3. SCENE_TIME_UNKNOWN",
        "",
        "场景时间未在原文交代",
        "",
        "引用：`ep01-sc01`",
        "",
      ].join("\n"),
    );
    expect(markdown.split("索引不可用")).toHaveLength(2);
    expect(markdown).not.toContain("\r");
  });

  test("warnings markdown flattens newlines and escapes block prefixes", () => {
    const runPath = path.join(runDir, "run.json");
    const warningsPath = path.join(runDir, "warnings.md");
    write_json(
      runPath,
      run_document([
        {
          code: "INJECT",
          message: "---\n# 伪造小节\n第二行",
          refs: ["ref`a\n# b"],
        },
      ]),
    );
    write_json(scriptAnalysisPath, { missing_info: [] });
    write_json(shotPlanPath, { missing_info: [] });
    write_json(promptIrPath, { missing_info: [] });

    const result = warnings_success(
      write_warnings({
        run_id: runId,
        run_path: runPath,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: warningsPath,
      }),
    );
    expect(result).toEqual({ output_path: warningsPath, count: 1 });

    // 自由文本来自 update_run_state / 阶段产物：压平换行并转义块级前缀后，
    // 结构应与无危险字符的同类渲染完全一致（标题、小节、条目行数都不漂移）。
    const markdown = readFileSync(warningsPath, "utf8");
    const lines = markdown.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines.filter((line) => line.startsWith("# "))).toEqual(["# 警告汇总"]);
    expect(lines.filter((line) => line.startsWith("## "))).toEqual(["## 1. INJECT"]);
    expect(lines).not.toContain("---");
    expect(lines[7]).toBe("\\--- # 伪造小节 第二行");
    expect(lines[9]).toBe("引用：`ref\\`a # b`");
    expect(markdown).not.toContain("\r");
  });

  test("aggregate reports missing artifacts without writing output", () => {
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    const result = aggregate_knowledge_refs({
      run_id: runId,
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: knowledgeRefsPath,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "STAGE_ARTIFACT_MISSING",
        details: { path: shotPlanPath },
      },
    });
    expect(existsSync(knowledgeRefsPath)).toBe(false);
  });

  test("warnings reports missing run json without writing output", () => {
    const warningsPath = path.join(runDir, "warnings.md");
    write_json(scriptAnalysisPath, { missing_info: [] });
    write_json(shotPlanPath, { missing_info: [] });
    write_json(promptIrPath, { missing_info: [] });

    const result = write_warnings({
      run_id: runId,
      run_path: path.join(runDir, "missing-run.json"),
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: warningsPath,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RUN_NOT_FOUND",
        details: { path: path.join(runDir, "missing-run.json") },
      },
    });
    expect(existsSync(warningsPath)).toBe(false);
  });
});
