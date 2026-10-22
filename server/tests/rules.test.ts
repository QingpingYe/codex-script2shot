import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  MODEL_RULE_IDS,
  load_model_rules,
  type ModelRuleId,
  type ModelRules,
} from "../src/rules.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RULES_DIR = path.join(REPO_ROOT, "rules", "models");

/** 规划子集的冻结值：两侧时长边界、默认时长与拆分上限（Task 4b-1 裁决）。 */
const EXPECTED: Record<
  ModelRuleId,
  { label: string; duration: ModelRules["duration"]; prefer_max_sec: number }
> = {
  "seedance-2.0": {
    label: "Seedance 2.0",
    duration: { min_sec: 4, max_sec: 15, default_sec: 5 },
    prefer_max_sec: 15,
  },
  "seedance-2.5": {
    label: "Seedance 2.5",
    duration: { min_sec: 4, max_sec: 30, default_sec: 5 },
    prefer_max_sec: 30,
  },
};

const ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];

function load_ok(model_id: ModelRuleId): ModelRules {
  const result = load_model_rules(model_id);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ${model_id} rules to load`);
  }
  return result.rules;
}

function read_rule_file(file_name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(RULES_DIR, file_name), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("model rules", () => {
  test("rules load both seedance models", () => {
    for (const model_id of MODEL_RULE_IDS) {
      const rules = load_ok(model_id);
      expect(rules.model).toBe(model_id);
      expect(rules.label).toBe(EXPECTED[model_id].label);
      expect(rules.duration).toEqual(EXPECTED[model_id].duration);
      expect(rules.aspect_ratios).toEqual(ASPECT_RATIOS);
      expect(rules.shot_split.prefer_max_sec).toBe(EXPECTED[model_id].prefer_max_sec);
      expect(rules.shot_split.multi_action_rule.trim().length).toBeGreaterThan(0);
    }
  });

  test("unknown model returns MODEL_UNKNOWN", () => {
    for (const model_id of ["seedance-3.0", "", "seedance-2.0 ", 42, null, undefined]) {
      const result = load_model_rules(model_id);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected unknown model to fail");
      }
      expect(result.error.code).toBe("MODEL_UNKNOWN");
      expect(result.error.message).toContain("seedance-2.0");
    }
  });

  test("every rule file declares source and checked at", () => {
    const file_names = readdirSync(RULES_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(file_names).toEqual(["seedance-2.0.json", "seedance-2.5.json"]);

    for (const file_name of file_names) {
      const rules = read_rule_file(file_name);
      const source = rules.source;
      expect(Array.isArray(source)).toBe(true);
      expect((source as unknown[]).length).toBeGreaterThan(0);
      for (const entry of source as unknown[]) {
        expect(typeof entry).toBe("string");
        expect(entry as string).toMatch(/^https:\/\//);
      }
      expect(rules.checked_at).toBe("2026-10-22");
    }
  });

  test("duration bounds are positive and ordered", () => {
    for (const model_id of MODEL_RULE_IDS) {
      const rules = load_ok(model_id);
      const { min_sec, max_sec, default_sec } = rules.duration;
      expect(min_sec).toBeGreaterThan(0);
      expect(max_sec).toBeGreaterThan(0);
      expect(min_sec).toBeLessThan(max_sec);
      expect(default_sec).toBeGreaterThanOrEqual(min_sec);
      expect(default_sec).toBeLessThanOrEqual(max_sec);
      expect(rules.shot_split.prefer_max_sec).toBeGreaterThan(0);
      expect(rules.shot_split.prefer_max_sec).toBeLessThanOrEqual(max_sec);
    }
  });

  test("missing or corrupt rule files are installation damage", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-rules-"));
    try {
      expect(() => load_model_rules("seedance-2.0", { rules_dir: tempDir })).toThrow(
        /模型规则文件不可用/,
      );

      const file_path = path.join(tempDir, "seedance-2.0.json");
      writeFileSync(file_path, "{", "utf8");
      expect(() => load_model_rules("seedance-2.0", { rules_dir: tempDir })).toThrow(
        /模型规则文件不可用/,
      );

      const mismatched = read_rule_file("seedance-2.0.json");
      writeFileSync(file_path, JSON.stringify({ ...mismatched, model: "seedance-9.9" }), "utf8");
      expect(() => load_model_rules("seedance-2.0", { rules_dir: tempDir })).toThrow(
        /模型规则文件不可用/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
