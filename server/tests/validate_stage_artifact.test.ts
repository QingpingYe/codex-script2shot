import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { validate_stage_artifact } from "../src/tools/validate_stage_artifact.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");

function fixture_path(file_name: string): string {
  return path.join(fixturesDir, file_name);
}

function read_fixture(file_name: string): unknown {
  return JSON.parse(readFileSync(fixture_path(file_name), "utf8")) as unknown;
}

describe("stage artifact validation", () => {
  test("valid script analysis fixture passes", () => {
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: fixture_path("script_analysis.sample.json"),
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("validate rejects missing scene summary", () => {
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: fixture_path("script_analysis.invalid.missing_scene_summary.json"),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject([
      {
        path: "/episodes/0/scenes/0/summary",
        keyword: "required",
      },
    ]);
  });

  test("validate rejects unknown input mode", () => {
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: fixture_path("script_analysis.invalid.bad_input_mode.json"),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject([
      {
        path: "/input_mode",
        keyword: "enum",
      },
    ]);
  });

  test("validate rejects hand edited missing field with json pointer", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-stage-artifact-"));
    try {
      const edited = read_fixture("script_analysis.sample.json") as {
        episodes: Array<{
          scenes: Array<{
            action_units: Array<Record<string, unknown>>;
          }>;
        }>;
      };
      delete edited.episodes[0].scenes[0].action_units[0].description;
      const editedPath = path.join(tempDir, "script_analysis.json");
      writeFileSync(editedPath, JSON.stringify(edited), "utf8");

      const result = validate_stage_artifact({
        stage: "script_breakdown",
        path: editedPath,
      });

      expect(result.ok).toBe(false);
      expect(result.errors).toMatchObject([
        {
          path: "/episodes/0/scenes/0/action_units/0/description",
          keyword: "required",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("validate reports missing file as STAGE_ARTIFACT_MISSING", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-stage-artifact-"));
    try {
      const result = validate_stage_artifact({
        stage: "script_breakdown",
        path: path.join(tempDir, "missing.json"),
      });

      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        path: "",
        code: "STAGE_ARTIFACT_MISSING",
      });
      expect(result.errors[0].message).toContain("missing.json");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("validate reports invalid json as STAGE_ARTIFACT_INVALID_JSON", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-stage-artifact-"));
    try {
      const invalidPath = path.join(tempDir, "invalid.json");
      writeFileSync(invalidPath, "{", "utf8");

      const result = validate_stage_artifact({
        stage: "script_breakdown",
        path: invalidPath,
      });

      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        path: "",
        code: "STAGE_ARTIFACT_INVALID_JSON",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("validate reports unreadable file as STAGE_ARTIFACT_UNREADABLE", () => {
    const result = validate_stage_artifact({
      stage: "script_breakdown",
      path: fixturesDir,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      path: "",
      code: "STAGE_ARTIFACT_UNREADABLE",
    });
  });

  test("validate appends additional property to json pointer", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-stage-artifact-"));
    try {
      const edited = read_fixture("script_analysis.sample.json") as Record<string, unknown>;
      edited["unexpected/field"] = true;
      const editedPath = path.join(tempDir, "script_analysis.json");
      writeFileSync(editedPath, JSON.stringify(edited), "utf8");

      const result = validate_stage_artifact({
        stage: "script_breakdown",
        path: editedPath,
      });

      expect(result.ok).toBe(false);
      expect(result.errors).toMatchObject([
        {
          path: "/unexpected~1field",
          keyword: "additionalProperties",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
