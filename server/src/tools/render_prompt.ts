import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load_model_rules, type ModelRules } from "../rules.js";
import {
  validate_prompt_document,
  type PromptValidationError,
} from "./validate_prompt.js";
import { check_artifact_version } from "../artifact_version.js";

export interface RenderPromptInput {
  prompt_ir_path: string;
  output_path: string;
  shot_plan_path?: string;
  script_analysis_path?: string;
}

export interface RenderPromptResult {
  ok: boolean;
  output_path?: string;
  errors: PromptValidationError[];
}

interface JsonReadResult {
  ok: true;
  value: unknown;
}

export function render_prompt(input: RenderPromptInput): RenderPromptResult {
  const loaded = read_json_file(input.prompt_ir_path, "prompt_ir_path");
  if (!loaded.ok) return loaded;
  const plan = read_optional_json_file(input.shot_plan_path, "shot_plan_path");
  if (!plan.ok) return plan;
  const analysis = read_optional_json_file(input.script_analysis_path, "script_analysis_path");
  if (!analysis.ok) return analysis;

  const validation = validate_prompt_document(loaded.value, {
    shot_plan: plan.value,
    script_analysis: analysis.value,
  });
  if (!validation.ok) return validation;

  if (!is_record(loaded.value) || typeof loaded.value.target_model !== "string") {
    return {
      ok: false,
      errors: [{ clip_id: "", shot_id: "", field: "target_model", code: "MISSING_FIELD", message: "PromptIR 缺少 target_model。" }],
    };
  }
  const rules_result = load_model_rules(loaded.value.target_model);
  if (!rules_result.ok) {
    return {
      ok: false,
      errors: [{ clip_id: "", shot_id: "", field: "target_model", code: "MODEL_RULES_UNAVAILABLE", message: rules_result.error.message }],
    };
  }
  try {
    const markdown = render_document(loaded.value, rules_result.rules, analysis.value);
    write_text(input.output_path, markdown);
    return { ok: true, output_path: input.output_path, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [{ clip_id: "", shot_id: "", field: "output_path", code: "RENDER_FAILED", message: `渲染失败：${describe_error(error)}` }],
    };
  }
}

function render_document(document: Record<string, unknown>, rules: ModelRules, analysis: unknown): string {
  const clips = as_array(document.clips).filter(is_record);
  const display_timeline = document.display_timeline === true;
  const lines: string[] = [rules.render.title, ""];

  for (const [clip_index, clip] of clips.entries()) {
    if (clip_index > 0) lines.push("");
    const clip_id = as_string(clip.clip_id);
    const duration = clip.duration_sec;
    const aspect_ratio = as_string(clip.aspect_ratio);
    lines.push(
      rules.render.clip_heading
        .replace("{clip_id}", clip_id)
        .replace("{duration}", String(duration))
        .replace("{aspect_ratio}", aspect_ratio),
    );
    const placeholders = as_array(clip.reference_bindings)
      .filter(is_record)
      .filter((binding) => binding.status === "placeholder");
    if (placeholders.length > 0) {
      lines.push("", `> 参考素材提示：本段有 ${placeholders.length} 张参考图待提供，正文只描述职责，不表示图片已就绪。`);
    }
    const references = as_array(clip.reference_bindings).filter(is_record);
    const sections: Record<string, string> = {
      generation_goal: as_string(clip.generation_goal),
      reference_duties: references.length === 0 ? "无参考素材绑定。" : references.map((binding) => render_reference_binding(binding, analysis)).join("\n"),
      subjects_relations: as_string(clip.subjects_and_relations),
      event_script: render_event_script(clip, display_timeline, analysis, rules).join("\n"),
      consistency: render_consistency(clip, rules),
    };
    for (const key of rules.render.section_order) {
      lines.push("", `【${rules.render.section_labels[key]}】`, sections[key] ?? "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function render_reference_binding(binding: Record<string, unknown>, analysis: unknown): string {
  const tag = as_string(binding.tag);
  const status = binding.status === "placeholder" ? "待提供" : "用户提供";
  const media = binding.media_type === "image" ? "参考图" : binding.media_type === "video" ? "参考视频" : "参考音频";
  const entity_names = entity_names_for_binding(binding, analysis);
  const target = entity_names.length === 0 ? "" : entity_names.join("、");
  const adopt = as_string_array(binding.adopt).join("、") || "仅采用已明确的部分";
  const exclude = as_string_array(binding.exclude).join("、") || "未参与本段的内容";
  return `${tag}（${status}：${target}${media}）用于${adopt}；不采用${exclude}。`;
}

function render_event_script(clip: Record<string, unknown>, display_timeline: boolean, analysis: unknown, rules: ModelRules): string[] {
  const lines: string[] = [];
  const shots = as_array(clip.shots).filter(is_record);
  for (const [index, shot] of shots.entries()) {
    const prefix = display_timeline
      ? `${format_seconds(shot.start_sec)}–${format_seconds(shot.end_sec)}秒：`
      : `镜头${index + 1}：`;
    const camera = [
      label_for(SHOT_SIZE_LABELS, as_string(shot.shot_size)),
      label_for(CAMERA_ANGLE_LABELS, as_string(shot.camera_angle)),
      label_for(CAMERA_MOVEMENT_LABELS, as_string(shot.camera_movement)),
    ].join("，");
    const subject = as_string(shot.subject);
    const action = as_string(shot.action);
    const emotion = as_string(shot.emotion).trim();
    const action_text = [subject, action, emotion === "" ? "" : `情绪：${emotion}`]
      .map(strip_terminal_punctuation)
      .filter((part) => part !== "")
      .join("；");
    lines.push(`${prefix}${camera}，${sentence(action_text)}`);
  }

  const dialogue = as_array(clip.dialogue).filter(is_record);
  if (dialogue.length > 0) {
    if (display_timeline) {
      for (const segment of dialogue) {
        lines.push(sentence(`${format_seconds(segment.start_sec)}–${format_seconds(segment.end_sec)}秒：${render_dialogue_segment(segment, analysis)}`));
      }
    } else {
      lines.push(sentence(`对白：${dialogue.map((segment) => render_dialogue_segment(segment, analysis)).join("；")}`));
    }
  } else {
    lines.push(rules.render.empty_dialogue);
  }

  const audio = is_record(clip.audio) ? clip.audio : undefined;
  const audio_parts: string[] = [];
  for (const track of ["ambience", "sfx", "music"] as const) {
    for (const cue of as_array(audio?.[track])) {
      if (!is_record(cue)) continue;
      const label = track === "ambience" ? "环境声" : track === "sfx" ? "音效" : "音乐";
      const text = track === "sfx" ? `<${as_string(cue.text)}>` : track === "music" ? `(${as_string(cue.text)})` : as_string(cue.text);
      const prefix = display_timeline ? `${format_seconds(cue.start_sec)}–${format_seconds(cue.end_sec)}秒：` : "";
      audio_parts.push(`${prefix}${label}：${text}`);
    }
  }
  if (audio_parts.length > 0) {
    lines.push(sentence(audio_parts.join("；")));
  }
  return lines;
}

function render_dialogue_segment(segment: Record<string, unknown>, analysis: unknown): string {
  const speaker = resolve_speaker_name(as_string(segment.speaker_id), analysis);
  const language = as_string(segment.language);
  const delivery = as_string(segment.delivery);
  const language_part = language === "" ? "" : `用${language}`;
  return `${speaker}${language_part}${delivery}说：{${as_string(segment.text)}}`;
}

function render_consistency(clip: Record<string, unknown>, rules: ModelRules): string {
  const continuity = is_record(clip.continuity) ? clip.continuity : undefined;
  const previous = continuity?.previous_clip_id;
  const parts = [
    previous === null || previous === undefined ? "承接：首段" : `承接：${String(previous)}`,
    `进入状态：${as_string(continuity?.enter_state)}`,
    `离开状态：${as_string(continuity?.exit_state)}`,
  ].map(strip_terminal_punctuation);
  const negative = as_string_array(clip.negative_prompt).filter((term) => term.trim() !== "");
  if (negative.length > 0) {
    parts.push(`限制：${negative.join("、")}`);
  } else {
    parts.push(`限制：${rules.render.empty_negative}`);
  }
  return sentence(parts.join("；"));
}

function entity_names_for_binding(binding: Record<string, unknown>, analysis: unknown): string[] {
  const ids = new Set(as_string_array(binding.entity_ids));
  const names: string[] = [];
  if (is_record(analysis)) {
    for (const entity of as_array(analysis.entities)) {
      if (is_record(entity) && ids.has(as_string(entity.entity_id))) {
        names.push(as_string(entity.name));
      }
    }
  }
  return names.length === 0 ? [...ids] : names;
}

function resolve_speaker_name(speaker_id: string, analysis: unknown): string {
  if (is_record(analysis)) {
    for (const entity of as_array(analysis.entities)) {
      if (is_record(entity) && as_string(entity.entity_id) === speaker_id) {
        return as_string(entity.name) || speaker_id;
      }
    }
  }
  return speaker_id;
}

const SHOT_SIZE_LABELS: Record<string, string> = {
  "extreme-long-shot": "大远景",
  "long-shot": "远景",
  "full-shot": "全景",
  "medium-full-shot": "中全景",
  "medium-shot": "中景",
  "medium-close-up": "中近景",
  "close-shot": "近景",
  "close-up": "特写",
  "insert-shot": "插入镜头",
};
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

function label_for(labels: Record<string, string>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value] : value;
}

function strip_terminal_punctuation(value: string): string {
  return value.trim().replace(/[。；;.!?！？]+$/u, "");
}

function sentence(value: string): string {
  return `${strip_terminal_punctuation(value)}。`;
}

function format_seconds(value: unknown): string {
  const number = value as number;
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(3)));
}


function read_optional_json_file(
  file_path: string | undefined,
  field: string,
): { ok: true; value: unknown | undefined } | { ok: false; errors: PromptValidationError[] } {
  if (file_path === undefined) return { ok: true, value: undefined };
  return read_json_file(file_path, field);
}

function read_json_file(
  file_path: string,
  field: string,
): { ok: true; value: unknown } | { ok: false; errors: PromptValidationError[] } {
  try {
    const value = JSON.parse(readFileSync(file_path, "utf8")) as unknown;
    const version = check_artifact_version(value);
    if (!version.ok) {
      return {
        ok: false,
        errors: [{ clip_id: "", shot_id: "", field: "schema_version", code: version.code, message: `${field} schema_version 不受支持。` }],
      };
    }
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      errors: [{ clip_id: "", shot_id: "", field, code: "MISSING_FIELD", message: `无法读取或解析文件：${file_path}（${describe_error(error)}）` }],
    };
  }
}

function write_text(file_path: string, content: string): void {
  mkdirSync(path.dirname(file_path), { recursive: true });
  writeFileSync(file_path, content, "utf8");
}

function as_array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function as_string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function as_string_array(value: unknown): string[] {
  return as_array(value).filter((entry): entry is string => typeof entry === "string");
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
