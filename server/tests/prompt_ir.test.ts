import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { validate_prompt_ir } from "../src/schemas.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read_fixture(file_name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "tests", "fixtures", file_name), "utf8"),
  ) as unknown;
}

function error_paths(result: { errors: Array<{ path: string }> }): string[] {
  return result.errors.map((error) => error.path);
}

interface PromptIrFixture {
  clips: Array<Record<string, any>>;
}

describe("prompt ir v2 schema validation", () => {
  test("valid prompt ir fixture passes", () => {
    expect(validate_prompt_ir(read_fixture("prompts_ir.sample.json"))).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("rejects missing subject inside a shot", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete edited.clips[0].shots[0].subject;
    const result = validate_prompt_ir(edited);
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["clips[0].shots[0].subject"]);
  });

  test("rejects continuity without exit state", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete edited.clips[0].shots[0].continuity.exit_state;
    const result = validate_prompt_ir(edited);
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["clips[0].shots[0].continuity.exit_state"]);
  });

  test("rejects dialogue entry fields required by v2", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    edited.clips[0].dialogue[0].text = "";
    const result = validate_prompt_ir(edited);
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["clips[0].dialogue[0].text"]);
  });

  test("requires clip-level dialogue, audio, knowledge refs and display timeline", () => {
    for (const field of ["dialogue", "audio", "knowledge_refs"] as const) {
      const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
      delete edited.clips[0][field];
      const result = validate_prompt_ir(edited);
      expect(result.ok).toBe(false);
      expect(error_paths(result)).toContain(`clips[0].${field}`);
    }
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete (edited as unknown as Record<string, unknown>).display_timeline;
    const result = validate_prompt_ir(edited);
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toContain("display_timeline");
  });

  test("rejects unknown camera angle and shot size", () => {
    const bad_angle = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    bad_angle.clips[0].shots[0].camera_angle = "low_angle";
    expect(error_paths(validate_prompt_ir(bad_angle))).toEqual(["clips[0].shots[0].camera_angle"]);

    const bad_size = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    bad_size.clips[0].shots[0].shot_size = "medium_shot";
    expect(error_paths(validate_prompt_ir(bad_size))).toEqual(["clips[0].shots[0].shot_size"]);
  });

  test("allows clip-level knowledge refs with shot_id null", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    edited.clips[0].knowledge_refs = [{
      card_id: "card-1",
      scene_id: "ep01-sc01",
      clip_id: "ep01-sc01-c01",
      shot_id: null,
      query: "clip 共用",
      usage: "used",
      source_doc_token: "doc",
      source_path: "path",
      source_revision: 1,
      last_synced_at: "2026-10-26T12:00:00+08:00",
    }];
    expect(validate_prompt_ir(edited).ok).toBe(true);
  });
});
