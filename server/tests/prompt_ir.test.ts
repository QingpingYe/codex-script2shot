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
  shots: Array<Record<string, unknown>>;
}

describe("prompt ir schema validation", () => {
  test("valid prompt ir fixture passes", () => {
    const result = validate_prompt_ir(read_fixture("prompts_ir.sample.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("prompt ir rejects missing subject", () => {
    const result = validate_prompt_ir(
      read_fixture("prompts_ir.invalid.missing_subject.json"),
    );
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].subject"]);
  });

  test("prompt ir rejects continuity without exit state", () => {
    const result = validate_prompt_ir(
      read_fixture("prompts_ir.invalid.bad_continuity.json"),
    );
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].continuity.environment_state"]);
  });

  test("prompt ir rejects dialogue entry with empty text", () => {
    const result = validate_prompt_ir(
      read_fixture("prompts_ir.invalid.bad_dialogue.json"),
    );
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].dialogue[0].text"]);
  });

  test("prompt ir requires dialogue field per shot", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete edited.shots[0].dialogue;

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].dialogue"]);
  });

  test("prompt ir requires emotion per shot", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete edited.shots[0].emotion;

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].emotion"]);
  });

  test("prompt ir requires audio object per shot", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete edited.shots[0].audio;

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].audio"]);
  });

  test("prompt ir requires knowledge refs field per shot", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    delete edited.shots[0].knowledge_refs;

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].knowledge_refs"]);
  });

  test("prompt ir rejects unknown camera angle", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    edited.shots[0].camera_angle = "low_angle";

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].camera_angle"]);
  });

  test("prompt ir rejects unknown shot size", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    edited.shots[0].shot_size = "medium_shot";

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].shot_size"]);
  });

  test("prompt ir rejects empty continuity exit state", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    const continuity = edited.shots[0].continuity as Record<string, unknown>;
    continuity.environment_state = "";

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].continuity.environment_state"]);
  });

  test("prompt ir rejects knowledge ref without string shot id", () => {
    const edited = read_fixture("prompts_ir.sample.json") as PromptIrFixture;
    const refs = edited.shots[0].knowledge_refs as Array<Record<string, unknown>>;
    refs[0].shot_id = null;

    const result = validate_prompt_ir(edited);

    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["shots[0].knowledge_refs[0].shot_id"]);
  });
});
