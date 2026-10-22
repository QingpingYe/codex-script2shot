import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CAMERA_ANGLE_LABELS,
  CAMERA_MOVEMENT_LABELS,
  SHOT_SIZE_LABELS,
  TIME_LABELS,
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

  test("time label table matches the frozen mapping", () => {
    // 时间词映射是 Task A2 的插件设计裁决（docs/model-rules-notes.md §4.3）：
    // 键 === PromptIR 英文术语与冻结顺序，值 === 渲染正文使用的中文标签。
    // schema 不收录时间词枚举，因此这张表由本测试单独钉住。
    expect(Object.entries(TIME_LABELS)).toEqual([
      ["night", "夜晚"],
      ["day", "白天"],
      ["dawn", "清晨"],
      ["dusk", "黄昏"],
      ["morning", "早晨"],
      ["noon", "正午"],
      ["afternoon", "下午"],
      ["evening", "傍晚"],
    ]);
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

  test("render localizes english time terms", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.time.md",
    );

    expect(result).toEqual({ ok: true, output_path });

    // 收录词渲染为中文标签；空 time 仍不生成「时间」子标签（节骨架不变）。
    const setting_time_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 环境与时间："));
    expect(setting_time_lines).toEqual([
      "- 环境与时间：环境：狭窄巷道，湿润砖墙，霓虹灯反射；时间：夜晚",
      "- 环境与时间：环境：巷道尽头的灯牌墙，积水地面",
    ]);
  });

  test("render passes through unknown time term", () => {
    const mutated = JSON.parse(
      readFileSync(path.join(promptFixturesDir, "seedance-2.5.ir.json"), "utf8"),
    ) as { shots: Array<{ time: string }> };
    mutated.shots[0].time = "holographic-noon";
    const prompt_ir_path = path.join(tempDir, "seedance-2.5.unknown-time.ir.json");
    writeFileSync(prompt_ir_path, JSON.stringify(mutated, null, 2), "utf8");
    const output_path = path.join(tempDir, "prompts.seedance-2.5.unknown-time.md");

    const result = render_prompt({ prompt_ir_path, output_path });

    expect(result).toEqual({ ok: true, output_path });

    // 未收录词不猜译、不丢弃：原样进入正文。
    const setting_time_line = readFileSync(output_path, "utf8")
      .split("\n")
      .find((line) => line.startsWith("- 环境与时间："));
    expect(setting_time_line).toBe(
      "- 环境与时间：环境：狭窄巷道，湿润砖墙，霓虹灯反射；时间：holographic-noon",
    );
  });

  test("render formats dialogue with optional language and delivery", () => {
    // 固定拼接顺序：`{speaker}用{language}{delivery}说：{text}`（text 用 {} 包裹）；
    // language / delivery 缺失或纯空白串时省略对应片段，条目间用「；」连接。
    const mutated = JSON.parse(
      readFileSync(path.join(promptFixturesDir, "seedance-2.5.ir.json"), "utf8"),
    ) as { shots: Array<{ dialogue: unknown[] }> };
    mutated.shots[0].dialogue = [
      { speaker: "角色A", text: "你一个外人" },
      { speaker: "角色B", language: "日语", delivery: "轻声", text: "もう大丈夫です" },
      { speaker: "角色C", language: "粤语", delivery: "   ", text: "顶住啊" },
      { speaker: "角色D", delivery: "压低声音", text: "别回头" },
    ];
    const prompt_ir_path = path.join(tempDir, "seedance-2.5.dialogue.ir.json");
    writeFileSync(prompt_ir_path, JSON.stringify(mutated, null, 2), "utf8");
    const output_path = path.join(tempDir, "prompts.seedance-2.5.dialogue.md");

    const result = render_prompt({ prompt_ir_path, output_path });

    expect(result).toEqual({ ok: true, output_path });
    const dialogue_line = readFileSync(output_path, "utf8")
      .split("\n")
      .find((line) => line.startsWith("- 对白："));
    expect(dialogue_line).toBe(
      "- 对白：角色A说：{你一个外人}；角色B用日语轻声说：{もう大丈夫です}；" +
        "角色C用粤语说：{顶住啊}；角色D压低声音说：{别回头}",
    );
  });

  test("render marks silent shots with empty dialogue placeholder", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.silent.md",
    );

    expect(result).toEqual({ ok: true, output_path });

    // 空数组不省略节：渲染规则文件的 empty_dialogue 占位，明确无对白、无旁白。
    const dialogue_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 对白："));
    expect(dialogue_lines).toEqual([
      "- 对白：角色A说：{你一个外人}；角色B用日语轻声说：{もう大丈夫です}",
      "- 对白：无对白；人物自然闭口，无旁白",
    ]);
  });

  test("render preserves verbatim dialogue text", () => {
    // 裁决：dialogue 是原文保真豁免区。台词原文含禁止项词（fps / duration）时，
    // 渲染前复校验仍通过，且渲染正文逐字保留原文，不做删改。
    const verbatim = "把 fps 与 duration 原样写进台词";
    const mutated = JSON.parse(
      readFileSync(path.join(promptFixturesDir, "seedance-2.5.ir.json"), "utf8"),
    ) as { shots: Array<{ dialogue: unknown[] }> };
    mutated.shots[0].dialogue = [{ speaker: "角色A", text: verbatim }];
    const prompt_ir_path = path.join(tempDir, "seedance-2.5.verbatim-dialogue.ir.json");
    writeFileSync(prompt_ir_path, JSON.stringify(mutated, null, 2), "utf8");
    const output_path = path.join(tempDir, "prompts.seedance-2.5.verbatim-dialogue.md");

    const result = render_prompt({ prompt_ir_path, output_path });

    expect(result).toEqual({ ok: true, output_path });
    const dialogue_line = readFileSync(output_path, "utf8")
      .split("\n")
      .find((line) => line.startsWith("- 对白："));
    expect(dialogue_line).toBe(`- 对白：角色A说：{${verbatim}}`);
  });

  test("render shows emotion when present", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.emotion.md",
    );

    expect(result).toEqual({ ok: true, output_path });

    // 情绪非空：「主体与动作」节按「主体：…；动作：…；情绪：…」追加子标签，
    // 动作文本原样保留，不因追加情绪而改写。
    const subject_action_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 主体与动作："));
    expect(subject_action_lines[0]).toBe(
      "- 主体与动作：主体：角色A；动作：在雨夜穿过旧城区巷道；情绪：握伞的手收紧，视线扫过巷道暗处",
    );
  });

  test("render omits emotion when empty", () => {
    const { result, output_path } = render_fixture(
      "seedance-2.5.ir.json",
      "prompts.seedance-2.5.empty-emotion.md",
    );

    expect(result).toEqual({ ok: true, output_path });

    // 空情绪沿用 field() 的空值省略语义：不生成「情绪」子标签，也不输出空冒号。
    const subject_action_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 主体与动作："));
    expect(subject_action_lines[1]).toBe(
      "- 主体与动作：主体：角色A；动作：抬头迎向巷道尽头的灯牌",
    );
  });

  test("render formats audio labels with angle and round brackets", () => {
    const mutated = JSON.parse(
      readFileSync(path.join(promptFixturesDir, "seedance-2.5.ir.json"), "utf8"),
    ) as {
      shots: Array<{
        audio: { ambience: string[]; sfx: string[]; music: string };
      }>;
    };
    mutated.shots[0].audio = {
      ambience: ["雨声"],
      sfx: ["远处雷声"],
      music: "低沉弦乐",
    };
    mutated.shots[1].audio = { ambience: [], sfx: ["远处雷声"], music: "" };
    const prompt_ir_path = path.join(tempDir, "seedance-2.5.audio.ir.json");
    writeFileSync(prompt_ir_path, JSON.stringify(mutated, null, 2), "utf8");
    const output_path = path.join(tempDir, "prompts.seedance-2.5.audio.md");

    const result = render_prompt({ prompt_ir_path, output_path });

    expect(result).toEqual({ ok: true, output_path });
    const audio_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 声音："));
    expect(audio_lines).toEqual([
      "- 声音：环境声：雨声；音效：<远处雷声>；音乐：(低沉弦乐)",
      "- 声音：音效：<远处雷声>",
    ]);
  });

  test("render omits audio section when all buffers empty", () => {
    const mutated = JSON.parse(
      readFileSync(path.join(promptFixturesDir, "seedance-2.5.ir.json"), "utf8"),
    ) as {
      shots: Array<{
        audio: { ambience: string[]; sfx: string[]; music: string };
      }>;
    };
    for (const shot of mutated.shots) {
      shot.audio = { ambience: [], sfx: [], music: "" };
    }
    const prompt_ir_path = path.join(tempDir, "seedance-2.5.no-audio.ir.json");
    writeFileSync(prompt_ir_path, JSON.stringify(mutated, null, 2), "utf8");
    const output_path = path.join(tempDir, "prompts.seedance-2.5.no-audio.md");

    const result = render_prompt({ prompt_ir_path, output_path });

    expect(result).toEqual({ ok: true, output_path });
    const audio_lines = readFileSync(output_path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- 声音："));
    expect(audio_lines).toEqual([]);
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
