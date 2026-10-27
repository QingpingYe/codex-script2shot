import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hash_artifact_document, hash_run_context } from "../src/artifact_hash.js";
import { init_run } from "../src/tools/init_run.js";
import { read_run, type RunDocument } from "../src/tools/read_run.js";
import { update_run_state } from "../src/tools/update_run_state.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");
const shortdramaDir = path.join(fixturesDir, "shortdrama");
const runSchemaPath = path.join(repoRoot, "schemas", "run.schema.json");

function read_json(file_path: string): Record<string, any> {
  return JSON.parse(readFileSync(file_path, "utf8")) as Record<string, any>;
}

function write_json(file_path: string, value: unknown): void {
  writeFileSync(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function success_init(result: ReturnType<typeof init_run>): { run_id: string; run_json_path: string; run_context_hash: string } {
  if (!("run_id" in result)) throw new Error(`expected init success: ${JSON.stringify(result)}`);
  return result;
}

function success_read(result: ReturnType<typeof read_run>): any {
  if (!("run" in result)) throw new Error(`expected read success: ${JSON.stringify(result)}`);
  return result;
}

describe("run directory tools v2", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-run-tools-v2-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function init_v2(): { run_id: string; run_json_path: string; run_context_hash: string } {
    return success_init(init_run({
      workspace_root: workspaceRoot,
      input_mode: "script_segment",
      project_id: "demo",
      target_model: "seedance-2.5",
      aspect_ratio: "9:16",
      input_references: [],
      display_timeline: true,
    }));
  }

  function copy_v2_artifacts(run_id: string): string {
    const created = init_v2();
    const runDir = path.dirname(created.run_json_path);
    for (const [name, source] of [
      ["script_analysis.json", path.join(shortdramaDir, "script_analysis.v2.json")],
      ["shot_plan.json", path.join(shortdramaDir, "shot_plan.v2.json")],
      ["prompts.ir.json", path.join(shortdramaDir, "prompts_ir.v2.json")],
    ] as const) {
      const document = read_json(source);
      document.run_id = run_id;
      write_json(path.join(runDir, name), document);
    }
    return runDir;
  }

  test("init run creates v2 run json with context hash", () => {
    const created = init_v2();
    const document = read_json(created.run_json_path);
    const validate = new Ajv2020({ allErrors: true }).compile(read_json(runSchemaPath));
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(document).toMatchObject({
      schema_version: 2,
      run_id: created.run_id,
      input_mode: "script_segment",
      project_id: "demo",
      target_model: "seedance-2.5",
      aspect_ratio: "9:16",
      input_references: [],
      display_timeline: true,
    });
    expect(created.run_context_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("init run defaults an omitted aspect ratio to 9:16", () => {
    const created = success_init(init_run({
      workspace_root: workspaceRoot,
      input_mode: "script_segment",
      project_id: "demo",
      target_model: "seedance-2.0",
    }));
    const document = read_json(created.run_json_path);

    expect(document.aspect_ratio).toBe("9:16");
  });

  test("init run defaults an omitted display timeline preference to false", () => {
    const created = success_init(init_run({
      workspace_root: workspaceRoot,
      input_mode: "script_segment",
      project_id: "demo",
      target_model: "seedance-2.0",
    }));
    const document = read_json(created.run_json_path);

    expect(document.display_timeline).toBe(false);
  });

  test("run schema rejects an empty artifact string", () => {
    const created = init_v2();
    const document = read_json(created.run_json_path);
    document.stages.script_breakdown.artifact = "";
    const validate = new Ajv2020({ allErrors: true }).compile(read_json(runSchemaPath));
    expect(validate(document)).toBe(false);
  });

  test("update run state preserves v2 context", () => {
    const created = init_v2();
    const result = update_run_state({ workspace_root: workspaceRoot, run_id: created.run_id, stage: "script_breakdown", status: "running" });
    if (!("run" in result)) throw new Error("expected update success");
    expect(result.run).toMatchObject({ schema_version: 2, display_timeline: true });
    expect(result.run.stages.script_breakdown.status).toBe("running");
  });

  test("read run validates all three v2 artifacts and returns context hash", () => {
    const created = init_v2();
    const runDir = path.dirname(created.run_json_path);
    const run = read_json(created.run_json_path);
    const analysis = read_json(path.join(shortdramaDir, "script_analysis.v2.json"));
    analysis.run_id = created.run_id;
    analysis.input_hashes.run_context = hash_run_context(run);
    const plan = read_json(path.join(shortdramaDir, "shot_plan.v2.json"));
    plan.run_id = created.run_id;
    plan.input_hashes.script_analysis = hash_artifact_document(analysis);
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.run_id = created.run_id;
    prompt.input_hashes = { script_analysis: hash_artifact_document(analysis), shot_plan: hash_artifact_document(plan) };
    write_json(path.join(runDir, "script_analysis.json"), analysis);
    write_json(path.join(runDir, "shot_plan.json"), plan);
    write_json(path.join(runDir, "prompts.ir.json"), prompt);

    const read = success_read(read_run({ workspace_root: workspaceRoot, run_id: created.run_id }));
    expect(read.run_context_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(read.artifacts).toMatchObject({
      script_breakdown: { exists: true, valid: true },
      shot_planning: { exists: true, valid: true },
      shot_prompting: { exists: true, valid: true },
    });
    expect(read.run.stages).toMatchObject({
      script_breakdown: { status: "done" },
      shot_planning: { status: "done" },
      shot_prompting: { status: "done" },
    });
  });

  test("does not mark a downstream artifact done without valid upstream", () => {
    const created = init_v2();
    const runDir = path.dirname(created.run_json_path);
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.run_id = created.run_id;
    write_json(path.join(runDir, "prompts.ir.json"), prompt);
    const read = success_read(read_run({ workspace_root: workspaceRoot, run_id: created.run_id }));
    expect(read.run.stages.shot_prompting.status).toBe("pending");
  });


  test("read run rejects unsupported artifact versions before writing run state", () => {
    const created = init_v2();
    const runDir = path.dirname(created.run_json_path);
    const legacy = read_json(path.join(fixturesDir, "legacy_script_analysis.v1.json"));
    write_json(path.join(runDir, "script_analysis.json"), legacy);
    const before = readFileSync(created.run_json_path, "utf8");
    const result = read_run({ workspace_root: workspaceRoot, run_id: created.run_id });
    expect(result).toMatchObject({ ok: false, error: { code: "ARTIFACT_VERSION_UNSUPPORTED" } });
    expect(readFileSync(created.run_json_path, "utf8")).toBe(before);
  });

  test("read run marks identity conflicts failed", () => {
    const created = init_v2();
    const runDir = path.dirname(created.run_json_path);
    const analysis = read_json(path.join(shortdramaDir, "script_analysis.v2.json"));
    analysis.run_id = "run-20261026-120001";
    write_json(path.join(runDir, "script_analysis.json"), analysis);
    const read = success_read(read_run({ workspace_root: workspaceRoot, run_id: created.run_id }));
    expect(read.run.stages.script_breakdown.status).toBe("failed");
    expect(read.warnings[0]).toMatchObject({ code: "RUN_STATE_RECONCILED" });
  });
});
