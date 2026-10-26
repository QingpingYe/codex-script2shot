import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { validate_prompt, validate_prompt_document } from "../src/tools/validate_prompt.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");
const shortdramaDir = path.join(fixturesDir, "shortdrama");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read_json(file_path: string): Record<string, any> {
  return JSON.parse(readFileSync(file_path, "utf8")) as Record<string, any>;
}

function write_temp(value: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "script2shot-prompt-v2-"));
  tempDirs.push(dir);
  const file_path = path.join(dir, "prompts.ir.json");
  writeFileSync(file_path, JSON.stringify(value, null, 2), "utf8");
  return file_path;
}

function keys(result: { errors: Array<{ clip_id: string; shot_id: string; field: string; code: string }> }): string[] {
  return result.errors.map((error) => `${error.clip_id}|${error.shot_id}|${error.field}|${error.code}`);
}

describe("prompt validation v2", () => {
  test("valid prompt passes with plan and analysis links", () => {
    const result = validate_prompt({
      prompt_ir_path: path.join(shortdramaDir, "prompts_ir.v2.json"),
      shot_plan_path: path.join(shortdramaDir, "shot_plan.v2.json"),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("schema errors retain clip and shot attribution", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    delete prompt.clips[0].shots[0].subject;
    expect(keys(validate_prompt_document(prompt))).toContain("ep01-sc01-c01|ep01-sc01-c01-s01|subject|MISSING_FIELD");
  });


  test("returns clip and shot attribution for missing content", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.clips[1].shots[0].action = "   ";
    const result = validate_prompt_document(prompt);
    expect(result.ok).toBe(false);
    expect(keys(result)).toContain("ep01-sc02-c01|ep01-sc02-c01-s01|action|MISSING_FIELD");
  });

  test("duration validation applies to a clip, not each shot", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.clips[0].duration_sec = 3;
    const result = validate_prompt_document(prompt);
    expect(keys(result)).toContain("ep01-sc01-c01||duration_sec|OUT_OF_RANGE");
  });

  test("dialogue remains exempt from forbidden term scanning", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.clips[0].dialogue[0].text = "duration fps";
    const result = validate_prompt_document(prompt);
    expect(result.errors.some((error) => error.field === "text")).toBe(false);
  });

  test("rejects unknown model and disabled Seedance 2.5 timeline", () => {
    const mismatch = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    mismatch.target_model = "seedance-9.9";
    expect(keys(validate_prompt_document(mismatch))).toContain("||target_model|SCHEMA_INVALID");

    const no_timeline = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    no_timeline.display_timeline = false;
    expect(keys(validate_prompt_document(no_timeline))).toContain("||display_timeline|MISSING_FIELD");
  });

  test("rejects upstream shot drift when plan is provided", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.clips[0].shots[0].end_sec = 2.5;
    const result = validate_prompt({
      prompt_ir_path: write_temp(prompt),
      shot_plan_path: path.join(shortdramaDir, "shot_plan.v2.json"),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "SOURCE_COVERAGE_INVALID")).toBe(true);
  });

  test("validates structured timeline without requiring upstream paths", () => {
    const shotGap = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    shotGap.clips[0].shots[0].end_sec = 2.5;
    expect(validate_prompt_document(shotGap).errors.map((error) => error.code)).toContain("TIMELINE_INVALID");
    const dialogueOut = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    dialogueOut.clips[0].dialogue[0].end_sec = 10.5;
    expect(validate_prompt_document(dialogueOut).errors.map((error) => error.code)).toContain("TIMELINE_INVALID");
    const audioOut = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    audioOut.clips[0].audio.sfx[0].end_sec = 10.5;
    expect(validate_prompt_document(audioOut).errors.map((error) => error.code)).toContain("TIMELINE_INVALID");
  });

  test("enforces all model-required non-empty fields", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.clips[0].setting = "";
    expect(keys(validate_prompt_document(prompt))).toContain("ep01-sc01-c01||setting|MISSING_FIELD");
  });


  test("reports unsupported versions and unreadable paths structurally", () => {
    const legacy = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    legacy.schema_version = 1;
    expect(keys(validate_prompt_document(legacy))).toContain("||schema_version|ARTIFACT_VERSION_UNSUPPORTED");

    const missing = validate_prompt({ prompt_ir_path: path.join(os.tmpdir(), "missing.json") });
    expect(keys(missing)).toEqual(["||prompt_ir_path|MISSING_FIELD"]);
  });
});
