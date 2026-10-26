import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
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

type GuidanceTextKey = "shot_structure" | "dialogue" | "sound" | "negative";

const GUIDANCE_TEXT_KEYS: GuidanceTextKey[] = [
  "shot_structure",
  "dialogue",
  "sound",
  "negative",
];

const temp_rules_dirs: string[] = [];

afterEach(() => {
  for (const dir of temp_rules_dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/** 在临时规则目录里写一份只改 prompt_guidance 的规则文件，用于损坏场景。 */
function rule_dir_with_guidance(
  model_id: ModelRuleId,
  mutate: (guidance: Record<string, unknown>) => void,
): string {
  const temp_dir = mkdtempSync(path.join(os.tmpdir(), "script2shot-rules-guidance-"));
  temp_rules_dirs.push(temp_dir);
  const rules = read_rule_file(`${model_id}.json`);
  const guidance = { ...(rules.prompt_guidance as Record<string, unknown>) };
  mutate(guidance);
  writeFileSync(
    path.join(temp_dir, `${model_id}.json`),
    JSON.stringify({ ...rules, prompt_guidance: guidance }),
    "utf8",
  );
  return temp_dir;
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
      expect(rules.reference_limits.max_images).toBe(model_id === "seedance-2.0" ? 9 : 30);
      expect(rules.timeline.required_in_prompt).toBe(model_id === "seedance-2.5");
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
      expect(rules.checked_at).toBe("2026-10-26");
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

  test("rules reject missing empty dialogue", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-rules-dialogue-"));
    try {
      const rules = read_rule_file("seedance-2.5.json");
      const file_path = path.join(tempDir, "seedance-2.5.json");

      // 缺失 empty_dialogue：渲染层没有稳定的空对白占位，属安装损坏。
      const missing = { ...(rules.render as Record<string, unknown>) };
      delete missing.empty_dialogue;
      writeFileSync(file_path, JSON.stringify({ ...rules, render: missing }), "utf8");
      expect(() => load_model_rules("seedance-2.5", { rules_dir: tempDir })).toThrow(
        /render\.empty_dialogue/,
      );

      // 纯空白同属非法：占位必须是非空字符串。
      const blank = { ...(rules.render as Record<string, unknown>), empty_dialogue: "   " };
      writeFileSync(file_path, JSON.stringify({ ...rules, render: blank }), "utf8");
      expect(() => load_model_rules("seedance-2.5", { rules_dir: tempDir })).toThrow(
        /render\.empty_dialogue/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each(GUIDANCE_TEXT_KEYS)("rules reject missing guidance key %s", (key) => {
    const rules_dir = rule_dir_with_guidance("seedance-2.5", (guidance) => {
      delete guidance[key];
    });
    expect(() => load_model_rules("seedance-2.5", { rules_dir })).toThrow(
      new RegExp(`prompt_guidance\\.${key}`),
    );
  });

  test.each(GUIDANCE_TEXT_KEYS)("rules reject blank guidance key %s", (key) => {
    const rules_dir = rule_dir_with_guidance("seedance-2.5", (guidance) => {
      guidance[key] = "\t  ";
    });
    expect(() => load_model_rules("seedance-2.5", { rules_dir })).toThrow(
      new RegExp(`prompt_guidance\\.${key}`),
    );
  });

  test("rules reject missing staging threshold", () => {
    const rules_dir = rule_dir_with_guidance("seedance-2.5", (guidance) => {
      delete guidance.long_shot_staging_threshold_sec;
    });
    expect(() => load_model_rules("seedance-2.5", { rules_dir })).toThrow(
      /prompt_guidance\.long_shot_staging_threshold_sec/,
    );
  });

  test.each([0, -1])("rules reject non positive staging threshold %s", (threshold) => {
    const rules_dir = rule_dir_with_guidance("seedance-2.5", (guidance) => {
      guidance.long_shot_staging_threshold_sec = threshold;
    });
    expect(() => load_model_rules("seedance-2.5", { rules_dir })).toThrow(
      /prompt_guidance\.long_shot_staging_threshold_sec/,
    );
  });

  test.each([null, "15", true])(
    "rules reject non numeric staging threshold %s",
    (threshold) => {
      const rules_dir = rule_dir_with_guidance("seedance-2.5", (guidance) => {
        guidance.long_shot_staging_threshold_sec = threshold;
      });
      expect(() => load_model_rules("seedance-2.5", { rules_dir })).toThrow(
        /prompt_guidance\.long_shot_staging_threshold_sec/,
      );
    },
  );

  test("rules expose per model prompt guidance", () => {
    for (const model_id of MODEL_RULE_IDS) {
      const guidance = load_ok(model_id).prompt_guidance;
      expect(guidance.long_shot_staging_threshold_sec).toBe(model_id === "seedance-2.0" ? 15 : 30);
      expect(guidance.long_shot_staging_threshold_sec).toBeGreaterThan(0);
      expect(Number.isFinite(guidance.long_shot_staging_threshold_sec)).toBe(true);
      for (const key of GUIDANCE_TEXT_KEYS) {
        expect(guidance[key]).toBeTypeOf("string");
        expect(guidance[key].trim().length).toBeGreaterThan(0);
      }
    }
  });
});
