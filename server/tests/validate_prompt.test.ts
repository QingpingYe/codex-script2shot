import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { load_model_rules } from "../src/rules.js";
import { validate_prompt } from "../src/tools/validate_prompt.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");

interface PromptIrShot {
  shot_id: string;
  target_model: string;
  duration: number;
  aspect_ratio: string;
  subject: string;
  action: string;
  setting: string;
  time: string;
  camera_angle: string;
  camera_movement: string;
  lighting: string;
  color: string;
  style: string;
  continuity: {
    previous_shot?: string | null;
    character_state: string;
    environment_state: string;
  };
  negative_prompt: string[];
  knowledge_refs: unknown[];
}

interface PromptIr {
  run_id: string;
  target_model: string;
  shots: PromptIrShot[];
  generated_at: string;
}

function read_prompt_ir(file_name: string): PromptIr {
  return JSON.parse(
    readFileSync(path.join(fixturesDir, file_name), "utf8"),
  ) as PromptIr;
}

function error_keys(result: { errors: Array<{ shot_id: string; field: string; code: string }> }): string[] {
  return result.errors.map((error) => `${error.shot_id}|${error.field}|${error.code}`);
}

describe("prompt hard rule validation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-validate-prompt-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write_variant(ir: unknown): string {
    const file_path = path.join(tempDir, "prompts.ir.json");
    writeFileSync(file_path, JSON.stringify(ir, null, 2), "utf8");
    return file_path;
  }

  test("validate passes valid fixture", () => {
    const result = validate_prompt({
      prompt_ir_path: path.join(fixturesDir, "prompts_ir.sample.json"),
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("validate rejects missing required field", () => {
    const result = validate_prompt({
      prompt_ir_path: path.join(fixturesDir, "prompts_ir.invalid.missing_subject.json"),
    });

    expect(result.ok).toBe(false);
    expect(error_keys(result)).toEqual(["ep01-sc01-sh01|subject|MISSING_FIELD"]);
    expect(result.errors[0]?.message).toContain("subject");
  });

  test("validate rejects duration out of range", () => {
    const ir = read_prompt_ir("prompts_ir.sample.json");
    ir.shots[0].duration = 3;
    const below = validate_prompt({ prompt_ir_path: write_variant(ir) });

    ir.shots[0].duration = 31;
    const above = validate_prompt({ prompt_ir_path: write_variant(ir) });

    expect(error_keys(below)).toEqual(["ep01-sc01-sh01|duration|OUT_OF_RANGE"]);
    expect(below.errors[0]?.message).toContain("seedance-2.5");
    expect(error_keys(above)).toEqual(["ep01-sc01-sh01|duration|OUT_OF_RANGE"]);
    expect(above.errors[0]?.message).toContain("30");
  });

  test("validate rejects forbidden term", () => {
    const rules = load_model_rules("seedance-2.5");
    expect(rules.ok).toBe(true);
    if (!rules.ok) {
      throw new Error("expected seedance-2.5 rules to load");
    }
    // 非空转：断言命中项确实在规则文件词表里，而不是测试自造的词。
    const forbidden_term = "aspect_ratio";
    expect(rules.rules.forbidden).toContain(forbidden_term);

    const ir = read_prompt_ir("prompts_ir.sample.json");
    ir.shots[0].subject = `角色A（参数 ${forbidden_term}=16:9）`;
    const result = validate_prompt({ prompt_ir_path: write_variant(ir) });

    expect(error_keys(result)).toEqual(["ep01-sc01-sh01|subject|FORBIDDEN_TERM"]);
    expect(result.errors[0]?.message).toContain(forbidden_term);
  });

  test("validate rejects model mismatch", () => {
    const ir = read_prompt_ir("prompts_ir.sample.json");
    ir.shots[0].target_model = "seedance-2.0";
    const result = validate_prompt({ prompt_ir_path: write_variant(ir) });

    expect(error_keys(result)).toEqual(["ep01-sc01-sh01|target_model|MODEL_MISMATCH"]);
    expect(result.errors[0]?.message).toContain("seedance-2.0");
    expect(result.errors[0]?.message).toContain("seedance-2.5");
  });

  test("validate returns structured errors per shot", () => {
    const ir = read_prompt_ir("prompts_ir.sample.json");
    const second_shot: PromptIrShot = {
      ...read_prompt_ir("prompts_ir.sample.json").shots[0],
      shot_id: "ep01-sc02-sh01",
      target_model: "seedance-2.0",
      action: "以 resolution 参数改画质",
    };
    ir.shots[0].duration = 3;
    ir.shots[0].subject = "   ";
    ir.shots[0].style = "neo-noir cinematic realism, fps=24";
    ir.shots = [ir.shots[0], second_shot];

    const result = validate_prompt({ prompt_ir_path: write_variant(ir) });

    // 顺序固定：镜头顺序 → 镜头内字段顺序；同一字段内先 MISSING_FIELD 再 FORBIDDEN_TERM。
    expect(error_keys(result)).toEqual([
      "ep01-sc01-sh01|duration|OUT_OF_RANGE",
      "ep01-sc01-sh01|subject|MISSING_FIELD",
      "ep01-sc01-sh01|style|FORBIDDEN_TERM",
      "ep01-sc02-sh01|target_model|MODEL_MISMATCH",
      "ep01-sc02-sh01|action|FORBIDDEN_TERM",
    ]);
    for (const error of result.errors) {
      expect(Object.keys(error).sort()).toEqual(["code", "field", "message", "shot_id"]);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  test("validate reports unreadable prompt ir path", () => {
    const missing_path = path.join(tempDir, "does-not-exist.json");
    const result = validate_prompt({ prompt_ir_path: missing_path });

    expect(result.ok).toBe(false);
    expect(error_keys(result)).toEqual(["|prompt_ir_path|MISSING_FIELD"]);
    expect(result.errors[0]?.message).toContain("does-not-exist.json");

    const invalid_json_path = path.join(tempDir, "invalid.json");
    writeFileSync(invalid_json_path, "{", "utf8");
    const invalid_json = validate_prompt({ prompt_ir_path: invalid_json_path });

    expect(invalid_json.ok).toBe(false);
    expect(error_keys(invalid_json)).toEqual(["|prompt_ir_path|MISSING_FIELD"]);
  });
});
