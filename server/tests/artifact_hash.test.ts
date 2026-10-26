import { describe, expect, test } from "vitest";
import { hash_artifact_document, hash_run_context } from "../src/artifact_hash.js";

const base_document = {
  schema_version: 2,
  action: { text: "角色A推开门", entity_ids: ["character-a", "prop-door"] },
  reference_assets: [{ asset_id: "asset-a", adopt: ["面部"], exclude: ["背景"] }],
};

describe("artifact hash", () => {
  test("is stable across object key order", () => {
    const reordered = {
      reference_assets: [{ exclude: ["背景"], adopt: ["面部"], asset_id: "asset-a" }],
      action: { entity_ids: ["character-a", "prop-door"], text: "角色A推开门" },
      schema_version: 2,
    };
    expect(hash_artifact_document(reordered)).toBe(hash_artifact_document(base_document));
  });

  test("changes when action text changes", () => {
    expect(hash_artifact_document({ ...base_document, action: { ...base_document.action, text: "角色A推开门后停下" } }))
      .not.toBe(hash_artifact_document(base_document));
  });

  test("changes when entity description changes", () => {
    expect(hash_artifact_document({ ...base_document, entity_description: "旧描述" }))
      .not.toBe(hash_artifact_document({ ...base_document, entity_description: "新描述" }));
  });

  test("changes when reference adopt or exclude changes", () => {
    const changed = {
      ...base_document,
      reference_assets: [{ ...base_document.reference_assets[0], exclude: ["人物"] }],
    };
    expect(hash_artifact_document(changed)).not.toBe(hash_artifact_document(base_document));
  });

  test("preserves array order", () => {
    expect(hash_artifact_document({ values: ["a", "b"] }))
      .not.toBe(hash_artifact_document({ values: ["b", "a"] }));
  });
});

describe("run context hash", () => {
  const run = {
    run_id: "run-20261026-120000",
    input_mode: "script_segment",
    project_id: "demo",
    target_model: "seedance-2.5",
    aspect_ratio: "9:16",
    input_references: [{ asset_id: "asset-a", adopt: ["面部"] }],
    display_timeline: false,
    warnings: [],
    stages: { script_breakdown: { status: "pending" } },
  };

  test("ignores stage and warning state changes", () => {
    const changed = {
      ...run,
      warnings: [{ code: "W", message: "state" }],
      stages: { script_breakdown: { status: "done" } },
    };
    expect(hash_run_context(changed)).toBe(hash_run_context(run));
  });

  test("changes when input reference duties change", () => {
    const changed = {
      ...run,
      input_references: [{ asset_id: "asset-a", adopt: ["服装"] }],
    };
    expect(hash_run_context(changed)).not.toBe(hash_run_context(run));
  });

  test("changes when display timeline changes", () => {
    expect(hash_run_context({ ...run, display_timeline: true })).not.toBe(hash_run_context(run));
  });

  test("ignores identity fields not included in the run context", () => {
    expect(hash_run_context({ ...run, run_id: "run-20261026-120001" })).toBe(hash_run_context(run));
  });
});
