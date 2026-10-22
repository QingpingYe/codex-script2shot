import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CAMERA_ANGLE_LABELS,
  CAMERA_MOVEMENT_LABELS,
  SHOT_SIZE_LABELS,
  render_prompt,
} from "../src/tools/render_prompt.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const promptFixturesDir = path.join(repoRoot, "tests", "fixtures", "prompts");

function read_camera_enum(schema_name: string, field: string): string[] {
  const schema = JSON.parse(
    readFileSync(path.join(repoRoot, "schemas", schema_name), "utf8"),
  ) as {
    $defs?: {
      shot?: {
        properties?: Record<string, { enum?: unknown }>;
      };
    };
  };
  const values = schema.$defs?.shot?.properties?.[field]?.enum;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    throw new Error(`${schema_name} 的 shot.properties.${field}.enum 不是字符串数组`);
  }
  return values as string[];
}

describe("prompt rendering", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "script2shot-render-prompt-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function render_fixture(
    fixture_name: string,
    output_name: string,
  ): { result: ReturnType<typeof render_prompt>; output_path: string } {
    const output_path = path.join(tempDir, output_name);
    return {
      result: render_prompt({
        prompt_ir_path: path.join(promptFixturesDir, fixture_name),
        output_path,
      }),
      output_path,
    };
  }

  function read_golden(file_name: string): string {
    return readFileSync(path.join(promptFixturesDir, file_name), "utf8");
  }

  test("render matches golden for seedance 2 0", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.0.ir.json",
      "prompts.seedance-2.0.md",
    );

    expect(result).toEqual({ ok: true, output_path });
    expect(readFileSync(output_path, "utf8")).toBe(read_golden("seedance-2.0.golden.md"));
  });

  test("render matches golden for seedance 2 5", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.md",
    );

    expect(result).toEqual({ ok: true, output_path });
    expect(readFileSync(output_path, "utf8")).toBe(read_golden("seedance-2.5.golden.md"));
  });

  test("render is deterministic across runs", () => {
    const first = render_fixture("seedance-2.5.ir.json", "prompts.seedance-2.5.first.md");
    const second = render_fixture("seedance-2.5.ir.json", "prompts.seedance-2.5.second.md");

    expect(first.result).toEqual({ ok: true, output_path: first.output_path });
    expect(second.result).toEqual({ ok: true, output_path: second.output_path });

    const first_bytes = readFileSync(first.output_path);
    const second_bytes = readFileSync(second.output_path);
    expect(first_bytes.equals(second_bytes)).toBe(true);

    const text = first_bytes.toString("utf8");
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    // 渲染产物不携带 run 元数据或时间戳。
    expect(text).not.toContain("2026-10-22");
    expect(text).not.toContain("run-");
  });

  test("render handles empty negative prompt", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.empty-negative.md",
    );

    expect(result).toEqual({ ok: true, output_path });

    // 空 negative_prompt 不省略节：每个镜头都固定输出负面约束行，空数组渲染为「无」。
    const negative_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 负面约束："));
    expect(negative_lines).toEqual([
      "- 负面约束：画面抖动、人物变形、多余手指",
      "- 负面约束：无",
    ]);
  });

  test("camera label tables match the frozen english and chinese enums", () => {
    const prompt_ir_angles = read_camera_enum("prompt_ir.schema.json", "camera_angle");
    const prompt_ir_movements = read_camera_enum("prompt_ir.schema.json", "camera_movement");
    const shot_plan_angles = read_camera_enum("shot_plan.schema.json", "camera_angle");
    const shot_plan_movements = read_camera_enum("shot_plan.schema.json", "camera_movement");

    // 键 === prompt_ir 英文枚举（数量与顺序一致）；值 === shot_plan 中文枚举
    // （沿用 4c-1 的映射裁决）。schema 增删枚举成员而表格未跟随时会在此失败。
    expect(prompt_ir_angles).toHaveLength(13);
    expect(prompt_ir_movements).toHaveLength(16);
    expect(Object.keys(CAMERA_ANGLE_LABELS)).toEqual(prompt_ir_angles);
    expect(Object.values(CAMERA_ANGLE_LABELS)).toEqual(shot_plan_angles);
    expect(Object.keys(CAMERA_MOVEMENT_LABELS)).toEqual(prompt_ir_movements);
    expect(Object.values(CAMERA_MOVEMENT_LABELS)).toEqual(shot_plan_movements);
  });

  test("shot size label table matches the frozen english and chinese enums", () => {
    const prompt_ir_sizes = read_camera_enum("prompt_ir.schema.json", "shot_size");
    const shot_plan_sizes = read_camera_enum("shot_plan.schema.json", "shot_size");

    // 键 === prompt_ir 英文枚举（数量与顺序一致）；值 === shot_plan 中文枚举。
    expect(prompt_ir_sizes).toHaveLength(9);
    expect(shot_plan_sizes).toHaveLength(9);
    expect(Object.keys(SHOT_SIZE_LABELS)).toEqual(prompt_ir_sizes);
    expect(Object.values(SHOT_SIZE_LABELS)).toEqual(shot_plan_sizes);
  });

  test("render includes shot size in camera section", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.shot-size.md",
    );

    expect(result).toEqual({ ok: true, output_path });

    const camera_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 景别、机位与运镜："));
    expect(camera_lines).toEqual([
      "- 景别、机位与运镜：景别：中景；机位：仰视；运镜：手持",
      "- 景别、机位与运镜：景别：中近景；机位：背身；运镜：滑动变焦",
    ]);
  });

  test("render reports failure when output directory cannot be created", () => {
    // 把 output_path 的父路径做成普通文件：mkdirSync 会失败，写盘未发生。
    const blocked_parent = path.join(tempDir, "blocked-parent");
    writeFileSync(blocked_parent, "not a directory", "utf8");
    const output_path = path.join(blocked_parent, "prompts.md");
    const prompt_ir_path = path.join(promptFixturesDir, "seedance-2.5.ir.json");

    const result = render_prompt({ prompt_ir_path, output_path });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RENDER_FAILED",
        details: { prompt_ir_path, output_path },
      },
    });
    expect(existsSync(output_path)).toBe(false);
    expect(readFileSync(blocked_parent, "utf8")).toBe("not a directory");
  });

  test("render refuses invalid prompt ir", () => {
    const invalid_output = path.join(tempDir, "prompts.invalid.md");
    const invalid = render_prompt({
      prompt_ir_path: path.join(
        repoRoot,
        "tests",
        "fixtures",
        "prompts_ir.invalid.missing_subject.json",
      ),
      output_path: invalid_output,
    });

    expect(invalid.ok).toBe(false);
    if (invalid.ok) {
      throw new Error("expected render_prompt to refuse an invalid PromptIR");
    }
    expect(invalid.error.code).toBe("HARD_RULE_VIOLATION");
    expect(invalid.error.details?.errors).toContainEqual(
      expect.objectContaining({
        shot_id: "ep01-sc01-sh01",
        field: "subject",
        code: "MISSING_FIELD",
      }),
    );
    expect(existsSync(invalid_output)).toBe(false);

    const missing_output = path.join(tempDir, "prompts.missing.md");
    const missing = render_prompt({
      prompt_ir_path: path.join(tempDir, "does-not-exist.json"),
      output_path: missing_output,
    });

    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: "HARD_RULE_VIOLATION",
        details: { errors: [{ field: "prompt_ir_path" }] },
      },
    });
    expect(existsSync(missing_output)).toBe(false);
  });
});
