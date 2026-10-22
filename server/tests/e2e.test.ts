/**
 * 离线端到端验收（Task 4d-3；架构 §11.2、§13，references/stage-conventions.md §1–§4）。
 *
 * 本文件用现有有效 fixture 模拟入口 Skill 的确定性编排步骤：
 * `init_run` → 放入三个阶段产物 fixture → 逐阶段校验 + `update_run_state`
 * → `render_prompt` → `aggregate_knowledge_refs` + `write_warnings` → 核对七个产物。
 *
 * 测试不接触真实模型、网络、知识库或本地索引；临时工作区全部用 `mkdtempSync`
 * 创建。测试里的「入口」步骤与 `skills/script2shot/SKILL.md` 描述的流程一一对应。
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { init_run, type InitRunInput, type RunDocument } from "../src/tools/init_run.js";
import { update_run_state } from "../src/tools/update_run_state.js";
import { validate_stage_artifact } from "../src/tools/validate_stage_artifact.js";
import { validate_prompt } from "../src/tools/validate_prompt.js";
import { render_prompt } from "../src/tools/render_prompt.js";
import { aggregate_knowledge_refs, write_warnings } from "../src/aggregate.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");
const entrySkillPath = path.join(repoRoot, "skills", "script2shot", "SKILL.md");

/** 运行目录的七个产物（架构 §11.5）。 */
const RUN_PRODUCTS = [
  "run.json",
  "script_analysis.json",
  "shot_plan.json",
  "prompts.ir.json",
  "prompts.seedance-2.5.md",
  "knowledge_refs.json",
  "warnings.md",
] as const;

/** stage-conventions §4 的引用字段与固定顺序。 */
const KNOWLEDGE_REF_FIELDS = [
  "card_id",
  "scene_id",
  "shot_id",
  "query",
  "usage",
  "source_doc_token",
  "source_path",
  "source_revision",
  "last_synced_at",
] as const;

/** 入口 Skill 的冻结小节（Task 4d-3 简报 Step 1）。 */
const ENTRY_SKILL_SECTIONS = [
  "## 适用时机",
  "## 新 run 流程",
  "## 续跑（from/only）",
  "## 阶段失败处理",
  "## 输出清单",
  "## 边界",
] as const;

/** 多集输入由入口写进首个阶段状态的 warning（架构 §11.1）。 */
const MULTIPLE_EPISODES_WARNING = {
  code: "MULTIPLE_EPISODES",
  message: "输入识别为多集剧本，本次保持单 run；建议按集运行以控制单次会话长度。",
};

type RuntimeStage = "script_breakdown" | "shot_planning" | "shot_prompting";

interface RunContext {
  workspaceRoot: string;
  runId: string;
  runDir: string;
  runJsonPath: string;
}

function read_json(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function write_json(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copy_fixture(fixtureName: string, outputPath: string): void {
  writeFileSync(outputPath, readFileSync(path.join(fixturesDir, fixtureName), "utf8"), "utf8");
}

function clone_fixture(fixtureName: string): Record<string, unknown> {
  return read_json(path.join(fixturesDir, fixtureName));
}

function read_run_document(filePath: string): RunDocument {
  return read_json(filePath) as unknown as RunDocument;
}

function knowledge_ref(cardId: string): Record<string, unknown> {
  return {
    card_id: cardId,
    scene_id: "ep01-sc01",
    shot_id: "ep01-sc01-sh01",
    query: `${cardId} 查询`,
    usage: "used",
    source_doc_token: "doc-token",
    source_path: `项目知识/demo/${cardId}`,
    source_revision: 12,
    last_synced_at: "2026-10-20T12:00:00+08:00",
  };
}

function card_ids(entries: Array<Record<string, unknown>>): string[] {
  return entries.map((entry) => entry.card_id as string);
}

/**
 * 模拟入口的第一步：读入口 Skill 本身，确认它仍然描述本轮验收的编排契约。
 */
function expect_entry_skill_contract(): void {
  expect(existsSync(entrySkillPath), "入口 Skill skills/script2shot/SKILL.md 应存在").toBe(true);
  const text = readFileSync(entrySkillPath, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  expect(frontmatter, "入口 Skill 应以 YAML frontmatter 开头").not.toBeNull();
  expect(/^name:\s*script2shot\s*$/m.test(frontmatter?.[1] ?? "")).toBe(true);
  for (const section of ENTRY_SKILL_SECTIONS) {
    expect(text, `入口 Skill 应包含小节 ${section}`).toContain(section);
  }
}

function expect_knowledge_ref_entry(entry: Record<string, unknown>): void {
  expect(Object.keys(entry)).toEqual([...KNOWLEDGE_REF_FIELDS]);
  expect(typeof entry.card_id).toBe("string");
  expect(typeof entry.scene_id).toBe("string");
  expect(entry.shot_id === null || typeof entry.shot_id === "string").toBe(true);
  expect(typeof entry.query).toBe("string");
  expect(["used", "dropped_by_budget"]).toContain(entry.usage);
  expect(typeof entry.source_doc_token).toBe("string");
  expect(typeof entry.source_path).toBe("string");
  expect(Number.isInteger(entry.source_revision)).toBe(true);
  expect(String(entry.last_synced_at)).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  );
}

/** 核对 knowledge_refs.json 顶层形状与每个引用条目都符合 stage-conventions §4。 */
function expect_knowledge_refs_structure(
  document: Record<string, unknown>,
  runId: string,
): Record<string, Array<Record<string, unknown>>> {
  expect(Object.keys(document)).toEqual(["run_id", "stages"]);
  expect(document.run_id).toBe(runId);
  const stages = document.stages as Record<string, Array<Record<string, unknown>>>;
  expect(Object.keys(stages)).toEqual([
    "script_breakdown",
    "shot_planning",
    "shot_prompting",
  ]);
  for (const [stage, entries] of Object.entries(stages)) {
    expect(Array.isArray(entries), `${stage} 阶段引用应为数组`).toBe(true);
    for (const entry of entries) {
      expect_knowledge_ref_entry(entry);
    }
  }
  return stages;
}

describe("script2shot entry end to end", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-e2e-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function create_run(
    overrides: Partial<Omit<InitRunInput, "workspace_root">> = {},
  ): RunContext {
    const created = init_run({
      workspace_root: workspaceRoot,
      input_mode: "single_episode",
      project_id: "demo",
      target_model: "seedance-2.5",
      aspect_ratio: "16:9",
      ...overrides,
    });
    if (!("run_id" in created)) {
      throw new Error(`init_run 失败：${JSON.stringify(created)}`);
    }
    return {
      workspaceRoot,
      runId: created.run_id,
      runDir: path.dirname(created.run_json_path),
      runJsonPath: created.run_json_path,
    };
  }

  /** 模拟入口的「每阶段结束」步骤：校验通过后更新该阶段状态与产物名。 */
  function mark_stage_done(
    ctx: RunContext,
    stage: RuntimeStage,
    artifact: string,
    warnings?: Array<{ code: string; message: string; refs?: string[] }>,
  ): RunDocument {
    const updated = update_run_state({
      workspace_root: ctx.workspaceRoot,
      run_id: ctx.runId,
      stage,
      status: "done",
      artifact,
      ...(warnings === undefined ? {} : { warnings }),
    });
    if (!("run" in updated)) {
      throw new Error(`update_run_state 失败：${JSON.stringify(updated)}`);
    }
    return updated.run;
  }

  test("fixture run pipeline produces all seven artifacts", () => {
    // 入口第一步是读 SKILL.md 并按其中流程执行；这里先确认契约仍然成立。
    expect_entry_skill_contract();

    const ctx = create_run();
    const scriptAnalysisPath = path.join(ctx.runDir, "script_analysis.json");
    const shotPlanPath = path.join(ctx.runDir, "shot_plan.json");
    const promptIrPath = path.join(ctx.runDir, "prompts.ir.json");
    const promptMarkdownPath = path.join(ctx.runDir, "prompts.seedance-2.5.md");
    const knowledgeRefsPath = path.join(ctx.runDir, "knowledge_refs.json");
    const warningsPath = path.join(ctx.runDir, "warnings.md");

    // 三个阶段各自产出主产物（fixture 充当阶段 Skill 的产物）。
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);

    // 阶段 1：校验 → 更新状态。
    expect(validate_stage_artifact({ stage: "script_breakdown", path: scriptAnalysisPath })).toEqual(
      { ok: true, errors: [] },
    );
    mark_stage_done(ctx, "script_breakdown", "script_analysis.json");

    // 阶段 2：校验 → 更新状态。
    expect(validate_stage_artifact({ stage: "shot_planning", path: shotPlanPath })).toEqual({
      ok: true,
      errors: [],
    });
    mark_stage_done(ctx, "shot_planning", "shot_plan.json");

    // 阶段 3：PromptIR 硬规则校验 → 渲染 → 更新状态。
    expect(validate_prompt({ prompt_ir_path: promptIrPath })).toEqual({ ok: true, errors: [] });
    expect(
      render_prompt({ prompt_ir_path: promptIrPath, output_path: promptMarkdownPath }),
    ).toEqual({ ok: true, output_path: promptMarkdownPath });
    mark_stage_done(ctx, "shot_prompting", "prompts.ir.json");

    // 入口收尾：聚合知识引用与警告。两个工具成功时不含 ok:true，只带 output_path。
    const aggregated = aggregate_knowledge_refs({
      run_id: ctx.runId,
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: knowledgeRefsPath,
    });
    expect(aggregated).toHaveProperty("output_path");
    expect(aggregated).not.toHaveProperty("ok");

    const warningsResult = write_warnings({
      run_id: ctx.runId,
      run_path: ctx.runJsonPath,
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: warningsPath,
    });
    expect(warningsResult).toHaveProperty("output_path");
    expect(warningsResult).not.toHaveProperty("ok");

    // 七个运行产物齐备，且运行目录没有多余文件。
    for (const product of RUN_PRODUCTS) {
      expect(existsSync(path.join(ctx.runDir, product)), `缺少产物 ${product}`).toBe(true);
    }
    expect([...readdirSync(ctx.runDir)].sort()).toEqual([...RUN_PRODUCTS].sort());

    // knowledge_refs.json 结构符合 stage-conventions §4，并与 §4 fixture 的三阶段数组一致。
    const stages = expect_knowledge_refs_structure(read_json(knowledgeRefsPath), ctx.runId);
    expect(stages.script_breakdown.every((entry) => entry.shot_id === null)).toBe(true);
    expect(stages.shot_prompting.every((entry) => entry.shot_id === "ep01-sc01-sh01")).toBe(true);
    const expectedStages = read_json(
      path.join(fixturesDir, "knowledge_refs.sample.json"),
    ).stages;
    expect(stages).toEqual(expectedStages);

    // warnings.md 汇总 run.json 与阶段产物 missing_info 的警告。
    const warningsMarkdown = readFileSync(warningsPath, "utf8");
    expect(warningsMarkdown).toContain("# 警告汇总");
    expect(warningsMarkdown).toContain("SCENE_TIME_UNKNOWN");
    expect(warningsResult).toMatchObject({ count: 1 });

    // 七个产物齐备后，run.json 三个阶段都是 done。
    expect(read_run_document(ctx.runJsonPath).stages).toMatchObject({
      script_breakdown: { status: "done", artifact: "script_analysis.json" },
      shot_planning: { status: "done", artifact: "shot_plan.json" },
      shot_prompting: { status: "done", artifact: "prompts.ir.json" },
    });
  });

  test("entry refuses to run shot planning with invalid upstream", () => {
    const ctx = create_run();
    const scriptAnalysisPath = path.join(ctx.runDir, "script_analysis.json");
    const shotPlanPath = path.join(ctx.runDir, "shot_plan.json");

    // 情形一：上游是非法 fixture，校验必须失败。
    copy_fixture("script_analysis.invalid.missing_scene_summary.json", scriptAnalysisPath);
    const invalidUpstream = validate_stage_artifact({
      stage: "script_breakdown",
      path: scriptAnalysisPath,
    });
    expect(invalidUpstream.ok).toBe(false);
    expect(invalidUpstream.errors).toContainEqual(
      expect.objectContaining({
        path: "/episodes/0/scenes/0/summary",
        keyword: "required",
      }),
    );

    // 入口停止：不写 shot_plan.json，也不更新该阶段状态（阶段失败语义）。
    expect(existsSync(shotPlanPath)).toBe(false);
    expect(read_run_document(ctx.runJsonPath).stages).toMatchObject({
      script_breakdown: { status: "pending", artifact: null },
      shot_planning: { status: "pending", artifact: null },
    });

    // 情形二：上游先通过校验，被人工修改后必须重新校验并再次失败。
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    expect(validate_stage_artifact({ stage: "script_breakdown", path: scriptAnalysisPath })).toEqual(
      { ok: true, errors: [] },
    );

    const handEdited = read_json(scriptAnalysisPath);
    const episodes = handEdited.episodes as Array<Record<string, unknown>>;
    const scenes = episodes[0].scenes as Array<Record<string, unknown>>;
    delete scenes[0].summary;
    write_json(scriptAnalysisPath, handEdited);

    const revalidated = validate_stage_artifact({
      stage: "script_breakdown",
      path: scriptAnalysisPath,
    });
    expect(revalidated.ok).toBe(false);
    expect(revalidated.errors).toContainEqual(
      expect.objectContaining({ path: "/episodes/0/scenes/0/summary" }),
    );
    expect(existsSync(shotPlanPath)).toBe(false);
    expect(read_run_document(ctx.runJsonPath).stages.script_breakdown.status).toBe("pending");
  });

  test("entry warns on multiple episodes", () => {
    const ctx = create_run({ input_mode: "multiple_episodes" });
    const scriptAnalysisPath = path.join(ctx.runDir, "script_analysis.json");
    const shotPlanPath = path.join(ctx.runDir, "shot_plan.json");
    const promptIrPath = path.join(ctx.runDir, "prompts.ir.json");
    const warningsPath = path.join(ctx.runDir, "warnings.md");

    // 入口识别到多集：保持单 run，把 warning 记到首个阶段的状态上（只追加）。
    const recorded = update_run_state({
      workspace_root: ctx.workspaceRoot,
      run_id: ctx.runId,
      stage: "script_breakdown",
      status: "running",
      warnings: [MULTIPLE_EPISODES_WARNING],
    });
    expect(recorded).toHaveProperty("run");
    expect(read_run_document(ctx.runJsonPath).warnings).toContainEqual(
      expect.objectContaining(MULTIPLE_EPISODES_WARNING),
    );

    // 阶段照常跑完，脚本产物与第一阶段状态更新都不清除已记录的 warning。
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);
    mark_stage_done(ctx, "script_breakdown", "script_analysis.json");
    mark_stage_done(ctx, "shot_planning", "shot_plan.json");
    mark_stage_done(ctx, "shot_prompting", "prompts.ir.json");

    const warningsResult = write_warnings({
      run_id: ctx.runId,
      run_path: ctx.runJsonPath,
      script_analysis_path: scriptAnalysisPath,
      shot_plan_path: shotPlanPath,
      prompt_ir_path: promptIrPath,
      output_path: warningsPath,
    });
    expect(warningsResult).toHaveProperty("output_path");

    // write_warnings 没有 warnings 入参：告警只有在先经 update_run_state 持久化后才会出现。
    const warningsMarkdown = readFileSync(warningsPath, "utf8");
    expect(warningsMarkdown).toContain("MULTIPLE_EPISODES");
    expect(warningsMarkdown).toContain("建议按集运行");
    expect(warningsMarkdown).toContain("SCENE_TIME_UNKNOWN");
    expect(warningsResult).toMatchObject({ count: 2 });
    expect(read_run_document(ctx.runJsonPath).input_mode).toBe("multiple_episodes");
  });

  test("rerun replaces stage refs without duplicating", () => {
    const ctx = create_run();
    const scriptAnalysisPath = path.join(ctx.runDir, "script_analysis.json");
    const shotPlanPath = path.join(ctx.runDir, "shot_plan.json");
    const promptIrPath = path.join(ctx.runDir, "prompts.ir.json");
    const promptMarkdownPath = path.join(ctx.runDir, "prompts.seedance-2.5.md");
    const knowledgeRefsPath = path.join(ctx.runDir, "knowledge_refs.json");

    const aggregate = (): Record<string, Array<Record<string, unknown>>> => {
      const result = aggregate_knowledge_refs({
        run_id: ctx.runId,
        script_analysis_path: scriptAnalysisPath,
        shot_plan_path: shotPlanPath,
        prompt_ir_path: promptIrPath,
        output_path: knowledgeRefsPath,
      });
      expect(result).toHaveProperty("output_path");
      return expect_knowledge_refs_structure(read_json(knowledgeRefsPath), ctx.runId);
    };

    // 首次完整运行 + 聚合。
    copy_fixture("script_analysis.sample.json", scriptAnalysisPath);
    copy_fixture("shot_plan.sample.json", shotPlanPath);
    copy_fixture("prompts_ir.sample.json", promptIrPath);
    mark_stage_done(ctx, "script_breakdown", "script_analysis.json");
    mark_stage_done(ctx, "shot_planning", "shot_plan.json");
    mark_stage_done(ctx, "shot_prompting", "prompts.ir.json");
    const firstStages = aggregate();
    expect(card_ids(firstStages.script_breakdown)).toEqual([
      "src:doc-token:character_bible:001",
    ]);
    const scriptBreakdownUpdatedAt = read_run_document(ctx.runJsonPath).stages.script_breakdown
      .updated_at;

    // from shot-planning：复用上游 script_analysis（先重新校验），重跑本阶段与下游。
    expect(validate_stage_artifact({ stage: "script_breakdown", path: scriptAnalysisPath })).toEqual(
      { ok: true, errors: [] },
    );
    const rerunShotPlan = clone_fixture("shot_plan.sample.json");
    rerunShotPlan.knowledge_refs = [knowledge_ref("src:doc-token:storyboard:999")];
    write_json(shotPlanPath, rerunShotPlan);
    expect(validate_stage_artifact({ stage: "shot_planning", path: shotPlanPath })).toEqual({
      ok: true,
      errors: [],
    });
    mark_stage_done(ctx, "shot_planning", "shot_plan.json");

    const rerunPromptIr = clone_fixture("prompts_ir.sample.json");
    const rerunShots = rerunPromptIr.shots as Array<Record<string, unknown>>;
    rerunShots[0].knowledge_refs = [knowledge_ref("src:doc-token:prompt_technique:777")];
    write_json(promptIrPath, rerunPromptIr);
    expect(validate_prompt({ prompt_ir_path: promptIrPath })).toEqual({ ok: true, errors: [] });
    expect(
      render_prompt({ prompt_ir_path: promptIrPath, output_path: promptMarkdownPath }),
    ).toHaveProperty("output_path");
    mark_stage_done(ctx, "shot_prompting", "prompts.ir.json");

    const fromRerunStages = aggregate();
    expect(card_ids(fromRerunStages.shot_planning)).toEqual(["src:doc-token:storyboard:999"]);
    expect(card_ids(fromRerunStages.shot_prompting)).toEqual([
      "src:doc-token:prompt_technique:777",
    ]);
    expect(fromRerunStages.script_breakdown).toEqual(firstStages.script_breakdown);
    expect(read_run_document(ctx.runJsonPath).stages.script_breakdown.updated_at).toBe(
      scriptBreakdownUpdatedAt,
    );

    // only shot-prompting：只执行一个阶段，同样先重新校验上游产物。
    const shotPlanningUpdatedAt = read_run_document(ctx.runJsonPath).stages.shot_planning
      .updated_at;
    expect(validate_stage_artifact({ stage: "shot_planning", path: shotPlanPath })).toEqual({
      ok: true,
      errors: [],
    });
    expect(validate_stage_artifact({ stage: "script_breakdown", path: scriptAnalysisPath })).toEqual(
      { ok: true, errors: [] },
    );
    const onlyPromptIr = clone_fixture("prompts_ir.sample.json");
    const onlyShots = onlyPromptIr.shots as Array<Record<string, unknown>>;
    onlyShots[0].knowledge_refs = [knowledge_ref("src:doc-token:seedance_rule:555")];
    write_json(promptIrPath, onlyPromptIr);
    expect(validate_prompt({ prompt_ir_path: promptIrPath })).toEqual({ ok: true, errors: [] });
    expect(
      render_prompt({ prompt_ir_path: promptIrPath, output_path: promptMarkdownPath }),
    ).toHaveProperty("output_path");
    mark_stage_done(ctx, "shot_prompting", "prompts.ir.json");

    const onlyRerunStages = aggregate();
    expect(card_ids(onlyRerunStages.shot_prompting)).toEqual([
      "src:doc-token:seedance_rule:555",
    ]);
    expect(onlyRerunStages.shot_planning).toEqual(fromRerunStages.shot_planning);
    expect(read_run_document(ctx.runJsonPath).stages.shot_planning.updated_at).toBe(
      shotPlanningUpdatedAt,
    );

    // 重跑只整体替换对应阶段数组：总条目数保持 3，任何阶段内无重复。
    const flatStages = Object.values(onlyRerunStages);
    expect(flatStages.flat()).toHaveLength(3);
    for (const entries of flatStages) {
      const ids = card_ids(entries);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
