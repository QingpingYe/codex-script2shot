import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { validate_knowledge_card, validate_sync_state } from "../src/schemas.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read_fixture(file_name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "tests", "fixtures", file_name), "utf8"),
  ) as unknown;
}

function error_paths(result: { errors: Array<{ path: string }> }): string[] {
  return result.errors.map((error) => error.path);
}

describe("schema validation", () => {
  test("valid knowledge card fixture passes", () => {
    const result = validate_knowledge_card(read_fixture("knowledge_card.valid.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("knowledge card rejects missing required field with path", () => {
    const result = validate_knowledge_card(
      read_fixture("knowledge_card.invalid.missing_required.json"),
    );
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["title"]);
  });

  test("knowledge card rejects unknown category enum", () => {
    const result = validate_knowledge_card(
      read_fixture("knowledge_card.invalid.bad_category.json"),
    );
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["category"]);
  });

  test("knowledge card rejects invalid target model entry", () => {
    const result = validate_knowledge_card(
      read_fixture("knowledge_card.invalid.bad_target_model.json"),
    );
    expect(result.ok).toBe(false);
    expect(error_paths(result)).toEqual(["target_models[0]"]);
  });

  test("valid sync state fixture passes", () => {
    const result = validate_sync_state(read_fixture("sync_state.valid.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("sync state rejects a fixture missing a required field", () => {
    const missing = validate_sync_state(
      read_fixture("sync_state.invalid.missing_required.json"),
    );
    expect(missing.ok).toBe(false);
    expect(error_paths(missing)).toEqual(["last_run_id"]);
  });

  test("sync state rejects non-integer card count", () => {
    const valid = read_fixture("sync_state.valid.json") as Record<string, unknown>;
    const fractional = validate_sync_state({ ...valid, card_count: 1.5 });
    expect(fractional.ok).toBe(false);
    expect(error_paths(fractional)).toEqual(["card_count"]);
  });
});
