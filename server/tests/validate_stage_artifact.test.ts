import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { validate_stage_artifact } from "../src/tools/validate_stage_artifact.js";

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

function write_temp(value: unknown, name = "artifact.json"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "script2shot-stage-v2-"));
  tempDirs.push(dir);
  const file_path = path.join(dir, name);
  writeFileSync(file_path, JSON.stringify(value, null, 2), "utf8");
  return file_path;
}

function make_first_clip_long_shot(value: Record<string, any>, duration_sec: number): Record<string, any> {
  const clip = value.scenes[0].clips[0];
  clip.duration_sec = 10;
  clip.shots = [
    { ...clip.shots[0], start_sec: 0, end_sec: duration_sec },
    { ...clip.shots[1], start_sec: duration_sec, end_sec: duration_sec + 1 },
    { ...clip.shots[2], start_sec: duration_sec + 1, end_sec: duration_sec + 2 },
    { ...clip.shots[3], start_sec: duration_sec + 2, end_sec: 10 },
  ];
  return value;
}
describe("stage artifact v2 validation", () => {
  test("valid script analysis returns content_hash", () => {
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result.ok).toBe(true);
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("valid shot plan returns content_hash with analysis link", () => {
    const result = validate_stage_artifact({
      stage: "shot_planning",
      path: path.join(shortdramaDir, "shot_plan.v2.json"),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result.ok).toBe(true);
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("legacy artifact version is rejected before schema validation", () => {
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: path.join(fixturesDir, "legacy_script_analysis.v1.json"),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "ARTIFACT_VERSION_UNSUPPORTED" }),
    );
  });

  test("reports schema path for a missing nested field", () => {
    const edited = read_json(path.join(shortdramaDir, "script_analysis.v2.json"));
    delete edited.episodes[0].scenes[0].summary;
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: write_temp(edited),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: "/episodes/0/scenes/0/summary" }),
    );
  });

  test("requires a long-take reason for a seven-second shot", () => {
    const missing = make_first_clip_long_shot(
      read_json(path.join(shortdramaDir, "shot_plan.v2.json")),
      7,
    );
    const missingResult = validate_stage_artifact({
      stage: "shot_planning",
      path: write_temp(missing),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors).toContainEqual(
      expect.objectContaining({ code: "TIMELINE_INVALID" }),
    );

    const allowed = make_first_clip_long_shot(
      read_json(path.join(shortdramaDir, "shot_plan.v2.json")),
      7,
    );
    allowed.scenes[0].clips[0].shots[0].long_take_reason = "连续跟拍角色走到床边。";
    const allowedResult = validate_stage_artifact({
      stage: "shot_planning",
      path: write_temp(allowed),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(allowedResult.ok).toBe(true);
  });
  test("rejects an internal shot timeline gap", () => {
    const edited = read_json(path.join(shortdramaDir, "shot_plan.v2.json"));
    edited.scenes[0].clips[0].shots[1].start_sec = 2.1;
    const result = validate_stage_artifact({
      stage: "shot_planning",
      path: write_temp(edited),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "TIMELINE_INVALID" }));
  });

  test("rejects fractional shot timeline through the stage validator", () => {
    const edited = read_json(path.join(shortdramaDir, "shot_plan.v2.json"));
    edited.scenes[0].clips[0].shots[0].end_sec = 2.5;
    const result = validate_stage_artifact({
      stage: "shot_planning",
      path: write_temp(edited),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "TIMELINE_INVALID" }));
  });
  test("reports missing and invalid JSON files structurally", () => {
    const missing = validate_stage_artifact({ stage: "script_breakdown", path: path.join(os.tmpdir(), "missing.json") });
    expect(missing).toMatchObject({ ok: false, errors: [{ code: "STAGE_ARTIFACT_MISSING" }] });

    const invalid_path = write_temp({}, "invalid.json");
    writeFileSync(invalid_path, "{", "utf8");
    const invalid = validate_stage_artifact({ stage: "script_breakdown", path: invalid_path });
    expect(invalid).toMatchObject({ ok: false, errors: [{ code: "STAGE_ARTIFACT_INVALID_JSON" }] });
  });
});
