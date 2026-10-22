/**
 * PromptIR → Seedance 提示词文档渲染（架构 §11.4、§9.6；Task 4c-3）。
 *
 * 固定流程：
 * 1. 先调用 `validate_prompt`；结构或硬规则不通过时返回 `HARD_RULE_VIOLATION`
 *    （`{ ok: false, error: { code, message, details } }`），且不创建目录、不写文件。
 * 2. 通过后读取 PromptIR 与目标模型规则文件，按规则文件的 `render` 模板渲染。
 *    模板只承载人可见的中文标题、节标签与节顺序；字段到节内容的组装在渲染层。
 * 3. 输出为 Markdown：整篇标题 → 每个镜头一节（分节标题行 + 固定顺序的七条节内容）。
 *    正文不含时间戳 / run 元数据，行尾统一 `\n`，同输入逐字节一致。
 *
 * 节顺序（与 brief 冻结的 镜头号与时长 → 主体与动作 → 环境与时间 → 机位与运镜 →
 * 光线与色彩 → 风格 → 连续性 → 负面约束 一致）：「镜头号与时长」由分节标题行
 * `## 镜头 {shot_id}（时长 {duration} 秒，画幅 {aspect_ratio}）` 承载，其余七节
 * 是节内条目，顺序由规则文件 `render.section_order` 给出。
 *
 * 冻结英文枚举 `camera_angle` / `camera_movement` 渲染为中文标签（映射表与
 * `schemas/prompt_ir.schema.json` 描述、`schemas/shot_plan.schema.json` 的中文词表
 * 一一对应）；其余自由文本字段原样输出，渲染层不翻译、不补写内容。
 *
 * 空 `negative_prompt` 的裁决：不省略节，稳定输出「负面约束：{empty_negative}」
 * （当前规则文件取值为「无」），保证每个镜头都是同一套节骨架。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load_model_rules, type ModelRules, type ModelRulesRender } from "../rules.js";
import { validate_prompt } from "./validate_prompt.js";

export interface RenderPromptInput {
  prompt_ir_path: string;
  output_path: string;
}

export interface RenderPromptSuccess {
  ok: true;
  output_path: string;
}

export type RenderPromptErrorCode = "HARD_RULE_VIOLATION" | "RENDER_FAILED";

export interface RenderPromptFailure {
  ok: false;
  error: {
    code: RenderPromptErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RenderPromptResult = RenderPromptSuccess | RenderPromptFailure;

/** 节 key：与规则文件 `render.section_labels` / `render.section_order` 一一对应。 */
const SECTION_KEYS = [
  "subject_action",
  "setting_time",
  "camera",
  "light_color",
  "style",
  "continuity",
  "negative",
] as const;

type RenderSectionKey = (typeof SECTION_KEYS)[number];

interface RenderTemplate {
  title: string;
  shot_heading: string;
  section_order: RenderSectionKey[];
  section_labels: Record<RenderSectionKey, string>;
  empty_negative: string;
}

/**
 * `camera_angle` 冻结英文枚举 → 中文标签。与
 * `schemas/prompt_ir.schema.json` 的描述、`schemas/shot_plan.schema.json` 的
 * `camera_angle` 中文枚举按顺序一一对应。
 */
const CAMERA_ANGLE_LABELS: Record<string, string> = {
  "eye-level": "平视",
  "low-angle": "仰视",
  "high-angle": "俯视",
  "bird's-eye": "鸟瞰",
  "worm's-eye": "虫视",
  "dutch-angle": "荷兰角",
  "over-the-shoulder": "过肩",
  "point-of-view": "主观视角",
  "reverse-angle": "反打",
  "side-view": "侧面",
  "three-quarter-view": "四分之三侧面",
  "back-view": "背身",
  "two-shot": "双人镜头",
};

/**
 * `camera_movement` 冻结英文枚举 → 中文标签。与
 * `schemas/prompt_ir.schema.json` 的描述、`schemas/shot_plan.schema.json` 的
 * `camera_movement` 中文枚举按顺序一一对应。
 */
const CAMERA_MOVEMENT_LABELS: Record<string, string> = {
  static: "固定",
  pan: "横摇",
  tilt: "竖摇",
  "push-in": "推近",
  "pull-out": "拉远",
  truck: "平移",
  boom: "升降",
  crane: "摇臂",
  zoom: "变焦",
  tracking: "跟拍",
  orbit: "环绕",
  handheld: "手持",
  gimbal: "稳定器",
  "whip-pan": "甩镜",
  "dolly-zoom": "滑动变焦",
  "follow-focus": "跟焦",
};

export function render_prompt(input: RenderPromptInput): RenderPromptResult {
  const validation = validate_prompt({ prompt_ir_path: input.prompt_ir_path });
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "HARD_RULE_VIOLATION",
        message:
          `PromptIR 未通过校验（${validation.errors.length} 条错误），` +
          "已停止渲染且未写入任何文件。",
        details: {
          prompt_ir_path: input.prompt_ir_path,
          errors: validation.errors,
        },
      },
    };
  }

  try {
    const document = read_prompt_ir(input.prompt_ir_path);
    const loaded = load_model_rules(document.target_model);
    if (!loaded.ok) {
      throw new Error(loaded.error.message);
    }
    const content = render_document(document, loaded.rules);
    write_text(input.output_path, content);
    return { ok: true, output_path: input.output_path };
  } catch (error) {
    // 校验通过后的失败只剩渲染 / 写盘问题：模板结构不符、文件在校验后被改动、
    // 输出目录不可写等。统一返回结构化 RENDER_FAILED，不穿透 MCP 边界。
    return {
      ok: false,
      error: {
        code: "RENDER_FAILED",
        message: `渲染提示词失败：${describe_error(error)}`,
        details: {
          prompt_ir_path: input.prompt_ir_path,
          output_path: input.output_path,
        },
      },
    };
  }
}

interface PromptIrShot {
  shot_id: string;
  duration: number;
  aspect_ratio: string;
  subject: string;
  action: string;
  setting: string;
  time: string;
  camera_angle: string;
  camera_movement: string;
  lighting: string;
  color: string;
  style: string;
  continuity: {
    previous_shot?: string | null;
    character_state: string;
    environment_state: string;
  };
  negative_prompt: string[];
}

interface PromptIrDocument {
  target_model: string;
  shots: PromptIrShot[];
}

function render_document(document: PromptIrDocument, rules: ModelRules): string {
  const template = resolve_template(rules.render);
  const lines: string[] = [template.title];

  for (const shot of document.shots) {
    lines.push("", render_shot_heading(template, shot), "");
    for (const key of template.section_order) {
      const label = template.section_labels[key];
      lines.push(`- ${label}：${render_section(key, shot, template)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * 规则文件模板 → 渲染层可用的节顺序与标签。规则文件只校验「section_order ⊆
 * section_labels」，节 key 全集属于渲染层知识：多 / 少节都按插件安装损坏处理。
 */
function resolve_template(render: ModelRulesRender): RenderTemplate {
  const unsupported = render.section_order.filter((key) => !is_section_key(key));
  if (unsupported.length > 0) {
    throw new Error(
      `规则文件 render.section_order 含渲染层不支持的节 key：${unsupported.join("、")}`,
    );
  }
  const missing = SECTION_KEYS.filter((key) => !render.section_order.includes(key));
  if (missing.length > 0) {
    throw new Error(
      `规则文件 render.section_order 缺少节 key：${missing.join("、")}`,
    );
  }

  const section_labels = Object.fromEntries(
    SECTION_KEYS.map((key) => [key, render.section_labels[key] as string]),
  ) as Record<RenderSectionKey, string>;

  return {
    title: render.title,
    shot_heading: render.shot_heading,
    section_order: render.section_order as RenderSectionKey[],
    section_labels,
    empty_negative: render.empty_negative,
  };
}

function is_section_key(value: string): value is RenderSectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

function render_shot_heading(template: RenderTemplate, shot: PromptIrShot): string {
  return template.shot_heading
    .replaceAll("{shot_id}", shot.shot_id)
    .replaceAll("{duration}", String(shot.duration))
    .replaceAll("{aspect_ratio}", shot.aspect_ratio);
}

function render_section(
  key: RenderSectionKey,
  shot: PromptIrShot,
  template: RenderTemplate,
): string {
  switch (key) {
    case "subject_action":
      return join_parts([field("主体", shot.subject), field("动作", shot.action)]);
    case "setting_time":
      return join_parts([field("环境", shot.setting), field("时间", shot.time)]);
    case "camera":
      return join_parts([
        field("机位", label_for(CAMERA_ANGLE_LABELS, shot.camera_angle)),
        field("运镜", label_for(CAMERA_MOVEMENT_LABELS, shot.camera_movement)),
      ]);
    case "light_color":
      return join_parts([field("光线", shot.lighting), field("色彩", shot.color)]);
    case "style":
      return shot.style;
    case "continuity":
      return join_parts([
        field("承接镜头", shot.continuity.previous_shot ?? ""),
        field("角色状态", shot.continuity.character_state),
        field("环境状态", shot.continuity.environment_state),
      ]);
    case "negative":
      return render_negative(shot.negative_prompt, template.empty_negative);
  }
}

/** 自由文本 / 可选子字段：空白值不生成子标签，避免输出空冒号。 */
function field(label: string, value: string): string | undefined {
  return value.trim() === "" ? undefined : `${label}：${value}`;
}

function join_parts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined).join("；");
}

/** 冻结枚举查表；schema 校验保证取值合法，查不到时原样透传（防御式兜底）。 */
function label_for(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value;
}

/** 空 `negative_prompt`（含全空白条目）不省略节，渲染模板里的稳定占位。 */
function render_negative(entries: string[], empty_negative: string): string {
  const terms = entries.filter((entry) => entry.trim() !== "");
  return terms.length === 0 ? empty_negative : terms.join("、");
}

function read_prompt_ir(file_path: string): PromptIrDocument {
  const text = readFileSync(file_path, "utf8");
  return JSON.parse(text) as PromptIrDocument;
}

function write_text(output_path: string, content: string): void {
  mkdirSync(path.dirname(output_path), { recursive: true });
  writeFileSync(output_path, content, "utf8");
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
