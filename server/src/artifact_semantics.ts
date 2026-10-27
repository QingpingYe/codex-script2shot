import { hash_artifact_document, hash_run_context } from "./artifact_hash.js";
import { check_artifact_version } from "./artifact_version.js";

/** v2 产物语义校验：补充 JSON Schema 无法表达的跨 ID、过程覆盖和参考素材约束。 */

export interface ArtifactSemanticError {
  path: string;
  code: string;
  message: string;
  clip_id?: string;
  shot_id?: string;
}

type JsonRecord = Record<string, unknown>;

const ENTITY_TYPES = ["character", "scene", "prop"] as const;
const MEDIA_TYPES = ["image", "video", "audio"] as const;
const ASSET_STATUSES = ["placeholder", "provided"] as const;

export function validate_script_analysis_semantics(document: unknown): ArtifactSemanticError[] {
  if (!is_record(document)) {
    return [semantic_error("", "STRUCTURE_INVALID", "解析产物必须是对象。")];
  }

  const errors: ArtifactSemanticError[] = [];
  const scenes = collect_scenes(document, errors);
  const scene_ids = new Set(scenes.map((scene) => scene.scene_id));
  const entities = collect_entities(document, scene_ids, errors);
  const entity_ids = new Set(entities.map((entity) => entity.entity_id));

  validate_scene_units(scenes, entity_ids, new Set<string>(), errors);
  validate_processes(scenes, entity_ids, new Set<string>(), errors);
  validate_reference_assets(document, entities, errors);

  return errors;
}

interface EntityRecord extends JsonRecord {
  entity_id: string;
}

interface SceneRecord {
  scene_id: string;
  path: string;
  characters: string[];
  units: Array<{ id: string; path: string; entity_ids: string[]; kind: string }>;
  processes: JsonRecord[];
}

function collect_scenes(
  document: JsonRecord,
  errors: ArtifactSemanticError[],
): SceneRecord[] {
  const scenes: SceneRecord[] = [];
  const seen = new Set<string>();
  const episodes = as_array(document.episodes);

  for (const [episode_index, episode] of episodes.entries()) {
    if (!is_record(episode)) {
      errors.push(
        semantic_error(
          `episodes[${episode_index}]`,
          "STRUCTURE_INVALID",
          "episode 条目必须是对象。",
        ),
      );
      continue;
    }
    const raw_scenes = as_array(episode.scenes);
    for (const [scene_index, scene] of raw_scenes.entries()) {
      const path = `episodes[${episode_index}].scenes[${scene_index}]`;
      if (!is_record(scene)) {
        errors.push(semantic_error(path, "STRUCTURE_INVALID", "scene 条目必须是对象。"));
        continue;
      }
      const scene_id = as_non_empty_string(scene.scene_id);
      if (scene_id === undefined) {
        errors.push(semantic_error(`${path}.scene_id`, "ID_INVALID", "scene_id 必须是非空字符串。"));
        continue;
      }
      if (seen.has(scene_id)) {
        errors.push(
          semantic_error(`${path}.scene_id`, "ID_DUPLICATE", `scene_id "${scene_id}" 重复。`),
        );
      }
      seen.add(scene_id);

      const units: SceneRecord["units"] = [];
      for (const kind of ["action_units", "emotion_units", "dialogue_units"] as const) {
        for (const [unit_index, raw_unit] of as_array(scene[kind]).entries()) {
          if (!is_record(raw_unit)) {
            continue;
          }
          const id = as_non_empty_string(raw_unit.id);
          if (id === undefined) {
            errors.push(
              semantic_error(
                `${path}.${kind}[${unit_index}].id`,
                "ID_INVALID",
                `${kind} 条目的 id 必须是非空字符串。`,
              ),
            );
            continue;
          }
          units.push({
            id,
            path: `${path}.${kind}[${unit_index}]`,
            entity_ids: as_string_array(raw_unit.entity_ids),
            kind,
          });
        }
      }

      scenes.push({
        scene_id,
        path,
        characters: as_string_array(scene.characters),
        units,
        processes: as_array(scene.processes).filter(is_record),
      });
    }
  }

  return scenes;
}

function collect_entities(
  document: JsonRecord,
  scene_ids: Set<string>,
  errors: ArtifactSemanticError[],
): EntityRecord[] {
  const entities: EntityRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entity] of as_array(document.entities).entries()) {
    const path = `entities[${index}]`;
    if (!is_record(entity)) {
      errors.push(semantic_error(path, "STRUCTURE_INVALID", "entity 条目必须是对象。"));
      continue;
    }
    const entity_id = as_non_empty_string(entity.entity_id);
    if (entity_id === undefined) {
      errors.push(semantic_error(`${path}.entity_id`, "ID_INVALID", "entity_id 必须是非空字符串。"));
      continue;
    }
    if (seen.has(entity_id)) {
      errors.push(
        semantic_error(`${path}.entity_id`, "ID_DUPLICATE", `entity_id "${entity_id}" 重复。`),
      );
    }
    seen.add(entity_id);
    entities.push({ ...entity, entity_id });

    if (!ENTITY_TYPES.includes(entity.entity_type as (typeof ENTITY_TYPES)[number])) {
      errors.push(
        semantic_error(
          `${path}.entity_type`,
          "ENTITY_INVALID",
          `entity_type 必须是 ${ENTITY_TYPES.join("|")}。`,
        ),
      );
    }
    if (as_non_empty_string(entity.name) === undefined) {
      errors.push(semantic_error(`${path}.name`, "ENTITY_INVALID", "实体 name 必须是非空字符串。"));
    }
    for (const [source_index, source_scene_id] of as_string_array(entity.source_scene_ids).entries()) {
      if (!scene_ids.has(source_scene_id)) {
        errors.push(
          semantic_error(
            `${path}.source_scene_ids[${source_index}]`,
            "REFERENCE_UNRESOLVED",
            `实体 "${entity_id}" 引用了不存在的场次 "${source_scene_id}"。`,
          ),
        );
      }
    }
  }
  return entities;
}

function validate_scene_units(
  scenes: SceneRecord[],
  entity_ids: Set<string>,
  seen_unit_ids: Set<string>,
  errors: ArtifactSemanticError[],
): void {
  for (const scene of scenes) {
    for (const unit of scene.units) {
      if (seen_unit_ids.has(unit.id)) {
        errors.push(
          semantic_error(unit.path, "ID_DUPLICATE", `原文单元 id "${unit.id}" 在运行内重复。`),
        );
      }
      seen_unit_ids.add(unit.id);
      for (const [index, entity_id] of unit.entity_ids.entries()) {
        if (!entity_ids.has(entity_id)) {
          errors.push(
            semantic_error(
              `${unit.path}.entity_ids[${index}]`,
              "REFERENCE_UNRESOLVED",
              `${unit.kind} "${unit.id}" 引用了不存在的实体 "${entity_id}"。`,
            ),
          );
        }
      }
    }

  }
}

function validate_processes(
  scenes: SceneRecord[],
  entity_ids: Set<string>,
  seen_process_ids: Set<string>,
  errors: ArtifactSemanticError[],
): void {
  for (const scene of scenes) {
    const units_by_id = new Map(scene.units.map((unit) => [unit.id, unit]));
    const covered = new Map<string, string[]>();

    for (const [process_index, process] of scene.processes.entries()) {
      const path = `${scene.path}.processes[${process_index}]`;
      const process_id = as_non_empty_string(process.process_id);
      if (process_id === undefined) {
        errors.push(semantic_error(`${path}.process_id`, "ID_INVALID", "process_id 必须是非空字符串。"));
        continue;
      }
      if (seen_process_ids.has(process_id)) {
        errors.push(
          semantic_error(`${path}.process_id`, "ID_DUPLICATE", `process_id "${process_id}" 在运行内重复。`),
        );
      }
      seen_process_ids.add(process_id);

      for (const key of ["action_unit_ids", "emotion_unit_ids", "dialogue_unit_ids"] as const) {
        for (const [index, unit_id] of as_string_array(process[key]).entries()) {
          const unit = units_by_id.get(unit_id);
          if (unit === undefined) {
            errors.push(
              semantic_error(
                `${path}.${key}[${index}]`,
                "REFERENCE_UNRESOLVED",
                `process "${process_id}" 引用了不存在的原文单元 "${unit_id}"。`,
              ),
            );
            continue;
          }
          const previous = covered.get(unit_id) ?? [];
          previous.push(process_id);
          covered.set(unit_id, previous);
        }
      }

      for (const [index, entity_id] of as_string_array(process.entity_ids).entries()) {
        if (!entity_ids.has(entity_id)) {
          errors.push(
            semantic_error(
              `${path}.entity_ids[${index}]`,
              "REFERENCE_UNRESOLVED",
              `process "${process_id}" 引用了不存在的实体 "${entity_id}"。`,
            ),
          );
        }
      }
    }

    for (const unit of scene.units) {
      const process_ids = covered.get(unit.id) ?? [];
      if (process_ids.length !== 1) {
        errors.push(
          semantic_error(
            unit.path,
            "SOURCE_COVERAGE_INVALID",
            `原文单元 "${unit.id}" 必须恰好归入一个过程，实际为 ${process_ids.length} 个。`,
          ),
        );
      }
    }
  }
}

function validate_reference_assets(
  document: JsonRecord,
  entities: JsonRecord[],
  errors: ArtifactSemanticError[],
): void {
  const entity_ids = new Set(entities.map((entity) => as_non_empty_string(entity.entity_id)));
  const entities_with_independent_image = new Set<string>();
  const seen_asset_ids = new Set<string>();

  for (const [index, asset] of as_array(document.reference_assets).entries()) {
    const path = `reference_assets[${index}]`;
    if (!is_record(asset)) {
      errors.push(semantic_error(path, "STRUCTURE_INVALID", "reference_asset 条目必须是对象。"));
      continue;
    }
    const asset_id = as_non_empty_string(asset.asset_id);
    if (asset_id === undefined) {
      errors.push(semantic_error(`${path}.asset_id`, "ID_INVALID", "asset_id 必须是非空字符串。"));
      continue;
    }
    if (seen_asset_ids.has(asset_id)) {
      errors.push(
        semantic_error(`${path}.asset_id`, "ID_DUPLICATE", `asset_id "${asset_id}" 重复。`),
      );
    }
    seen_asset_ids.add(asset_id);

    const media_type = asset.media_type;
    if (!MEDIA_TYPES.includes(media_type as (typeof MEDIA_TYPES)[number])) {
      errors.push(
        semantic_error(path, "REFERENCE_ASSET_INVALID", `asset "${asset_id}" 的 media_type 非法。`),
      );
    }
    const status = asset.status;
    if (!ASSET_STATUSES.includes(status as (typeof ASSET_STATUSES)[number])) {
      errors.push(
        semantic_error(path, "REFERENCE_ASSET_INVALID", `asset "${asset_id}" 的 status 非法。`),
      );
    }
    const source = as_non_empty_string(asset.source);
    if (status === "placeholder" && asset.source !== undefined) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `placeholder asset "${asset_id}" 不得伪造 source。`,
        ),
      );
    }
    if (status === "provided" && source === undefined) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `provided asset "${asset_id}" 必须保存用户提供的 source。`,
        ),
      );
    }
    if (source !== undefined && /^https?:\/\//i.test(source)) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `asset "${asset_id}" 的 source 不得写虚构 URL。`,
        ),
      );
    }

    if (as_non_empty_string_list(asset.adopt).length === 0) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `asset "${asset_id}" 必须说明采用的素材范围。`,
        ),
      );
    }
    if (as_non_empty_string_list(asset.exclude).length === 0) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `asset "${asset_id}" 必须说明排除的素材范围。`,
        ),
      );
    }

    const asset_entity_ids = as_string_array(asset.entity_ids);
    if (asset_entity_ids.length === 0) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `asset "${asset_id}" 必须绑定至少一个实体。`,
        ),
      );
    }
    for (const [entity_index, entity_id] of asset_entity_ids.entries()) {
      if (!entity_ids.has(entity_id)) {
        errors.push(
          semantic_error(
            `${path}.entity_ids[${entity_index}]`,
            "REFERENCE_UNRESOLVED",
            `asset "${asset_id}" 引用了不存在的实体 "${entity_id}"。`,
          ),
        );
      }
      if (media_type === "image" && asset_entity_ids.length === 1) {
        entities_with_independent_image.add(entity_id);
      }
    }
  }

  for (const entity of entities) {
    const entity_id = as_non_empty_string(entity.entity_id);
    if (entity_id !== undefined && !entities_with_independent_image.has(entity_id)) {
      errors.push(
        semantic_error(
          "reference_assets",
          "REFERENCE_ASSET_INVALID",
          `实体 "${entity_id}" 缺少独立的 image 参考图槽位。`,
        ),
      );
    }
  }
}

function semantic_error(
  path: string,
  code: string,
  message: string,
  clip_id?: string,
  shot_id?: string,
): ArtifactSemanticError {
  return {
    path,
    code,
    message,
    ...(clip_id === undefined ? {} : { clip_id }),
    ...(shot_id === undefined ? {} : { shot_id }),
  };
}

function as_array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function as_string_array(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function as_non_empty_string_list(value: unknown): string[] {
  return as_string_array(value).filter((entry) => entry.trim() !== "");
}

function as_non_empty_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function is_record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}






export interface SemanticModelRules {
  duration: { min_sec: number; max_sec: number };
  reference_limits: { max_images: number };
  timeline: { required_in_prompt: boolean };
}

const MAX_NORMAL_SHOT_SEC = 6;

function is_integer_second(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

interface PlanSceneRecord {
  scene_id: string;
  path: string;
  clips: JsonRecord[];
}

interface AnalysisContext {
  scene_ids: Set<string>;
  entity_ids: Set<string>;
  asset_by_id: Map<string, JsonRecord>;
  process_by_id: Map<string, JsonRecord & { scene_id: string }>;
  unit_by_id: Map<string, JsonRecord & { kind: string; scene_id: string }>;
  dialogue_by_id: Map<string, JsonRecord>;
  speaker_entity_by_name: Map<string, string>;
}

export function validate_shot_plan_semantics(
  plan: unknown,
  rules: SemanticModelRules,
  analysis?: unknown,
): ArtifactSemanticError[] {
  if (!is_record(plan)) {
    return [semantic_error("", "STRUCTURE_INVALID", "规划产物必须是对象。")];
  }

  const errors: ArtifactSemanticError[] = [];
  const context =
    analysis === undefined ? undefined : build_analysis_context(analysis, errors);
  const scenes = collect_plan_scenes(plan, errors);
  const all_clip_ids = new Set<string>();
  const all_shot_ids = new Set<string>();
  const segments_by_dialogue = new Map<string, Array<{ segment: JsonRecord; path: string; duration_sec: unknown }>>();
  const clips_by_process = new Map<string, JsonRecord[]>();
  const process_source_sets = new Map<
    string,
    { action: Set<string>; emotion: Set<string>; dialogue: Set<string> }
  >();
  const knowledge_ref_ids = collect_plan_knowledge_ref_ids(plan);

  for (const scene of scenes) {
    const seen_orders = new Set<number>();
    const previous_clip_by_process = new Map<string, string>();
    for (const [clip_index, clip] of scene.clips.entries()) {
      const path = `${scene.path}.clips[${clip_index}]`;
      const clip_id = as_non_empty_string(clip.clip_id) ?? "";
      const process_id = as_non_empty_string(clip.process_id) ?? "";
      const clip_reference = clip_id === "" ? undefined : clip_id;

      if (clip_id === "") {
        errors.push(semantic_error(`${path}.clip_id`, "ID_INVALID", "clip_id 必须是非空字符串。"));
      } else if (all_clip_ids.has(clip_id)) {
        errors.push(
          semantic_error(`${path}.clip_id`, "ID_DUPLICATE", `clip_id "${clip_id}" 重复。`),
        );
      }
      all_clip_ids.add(clip_id);

      const order = as_positive_integer(clip.order);
      if (order === undefined) {
        errors.push(semantic_error(`${path}.order`, "STRUCTURE_INVALID", "clip order 必须是正整数。"));
      } else if (seen_orders.has(order)) {
        errors.push(
          semantic_error(`${path}.order`, "ID_DUPLICATE", `clip order ${order} 在同一场次重复。`),
        );
      } else {
        seen_orders.add(order);
      }

      if (clip.scene_id !== scene.scene_id) {
        errors.push(
          semantic_error(
            `${path}.scene_id`,
            "REFERENCE_UNRESOLVED",
            `clip "${clip_id}" 的 scene_id 与父场次 "${scene.scene_id}" 不一致。`,
          ),
        );
      }

      validate_clip_duration(clip, rules, path, clip_reference, errors);
      validate_clip_reference_limit(clip, rules, path, clip_reference, context, errors);
      validate_clip_entities(clip, path, clip_reference, context, errors);
      validate_clip_continuity(
        clip,
        scene,
        previous_clip_by_process,
        path,
        clip_reference,
        errors,
      );
      validate_clip_timeline(
        clip,
        path,
        clip_reference,
        all_shot_ids,
        context,
        process_source_sets,
        errors,
      );
      validate_clip_audio(
        clip,
        path,
        clip_reference,
        context,
        knowledge_ref_ids,
        errors,
      );

      for (const [dialogue_index, segment] of as_array(clip.dialogue).entries()) {
        if (!is_record(segment)) {
          continue;
        }
        const dialogue_unit_id = as_non_empty_string(segment.dialogue_unit_id);
        if (dialogue_unit_id === undefined) {
          continue;
        }
        const entries = segments_by_dialogue.get(dialogue_unit_id) ?? [];
        entries.push({ segment, path: `${path}.dialogue[${dialogue_index}]`, duration_sec: clip.duration_sec });
        segments_by_dialogue.set(dialogue_unit_id, entries);
      }

      if (process_id !== "") {
        const clips = clips_by_process.get(process_id) ?? [];
        clips.push(clip);
        clips_by_process.set(process_id, clips);
        const previous = previous_clip_by_process.get(process_id);
        if (previous !== undefined && as_non_empty_string(is_record(clip.continuity) ? clip.continuity.previous_clip_id : undefined) !== previous) {
          errors.push(
            semantic_error(
              `${path}.continuity.previous_clip_id`,
              "SOURCE_COVERAGE_INVALID",
              `process "${process_id}" 的后继 clip 必须承接 "${previous}"。`,
              clip_reference,
            ),
          );
        }
        previous_clip_by_process.set(process_id, clip_id);
      }
    }
  }

  validate_dialogue_segments(segments_by_dialogue, context, errors);
  validate_process_coverage(context, clips_by_process, process_source_sets, errors);
  return errors;
}

function collect_plan_scenes(
  plan: JsonRecord,
  errors: ArtifactSemanticError[],
): PlanSceneRecord[] {
  const scenes: PlanSceneRecord[] = [];
  for (const [scene_index, scene] of as_array(plan.scenes).entries()) {
    const path = `scenes[${scene_index}]`;
    if (!is_record(scene)) {
      errors.push(semantic_error(path, "STRUCTURE_INVALID", "scene 条目必须是对象。"));
      continue;
    }
    const scene_id = as_non_empty_string(scene.scene_id);
    if (scene_id === undefined) {
      errors.push(semantic_error(`${path}.scene_id`, "ID_INVALID", "scene_id 必须是非空字符串。"));
      continue;
    }
    const clips = as_array(scene.clips).filter(is_record);
    scenes.push({ scene_id, path, clips });
  }
  return scenes;
}

function build_analysis_context(
  analysis: unknown,
  errors: ArtifactSemanticError[],
): AnalysisContext {
  const context: AnalysisContext = {
    scene_ids: new Set(),
    entity_ids: new Set(),
    asset_by_id: new Map(),
    process_by_id: new Map(),
    unit_by_id: new Map(),
    dialogue_by_id: new Map(),
    speaker_entity_by_name: new Map(),
  };
  if (!is_record(analysis)) {
    errors.push(semantic_error("", "STRUCTURE_INVALID", "解析产物必须是对象。"));
    return context;
  }

  for (const [scene_index, raw_scene] of collect_all_analysis_scenes(analysis).entries()) {
    const scene_id = as_non_empty_string(raw_scene.scene_id);
    if (scene_id === undefined) {
      continue;
    }
    context.scene_ids.add(scene_id);
    for (const [process_index, process] of as_array(raw_scene.processes).entries()) {
      if (!is_record(process)) {
        continue;
      }
      const process_id = as_non_empty_string(process.process_id);
      if (process_id !== undefined) {
        context.process_by_id.set(process_id, { ...process, process_id, scene_id });
      }
      void process_index;
    }
    for (const kind of ["action_units", "emotion_units", "dialogue_units"] as const) {
      for (const [unit_index, unit] of as_array(raw_scene[kind]).entries()) {
        if (!is_record(unit)) {
          continue;
        }
        const id = as_non_empty_string(unit.id);
        if (id !== undefined) {
          context.unit_by_id.set(id, { ...unit, id, kind, scene_id });
          if (kind === "dialogue_units") {
            context.dialogue_by_id.set(id, unit);
          }
        }
        void unit_index;
      }
    }
    void scene_index;
  }

  for (const entity of as_array(analysis.entities)) {
    if (!is_record(entity)) {
      continue;
    }
    const entity_id = as_non_empty_string(entity.entity_id);
    if (entity_id !== undefined) {
      context.entity_ids.add(entity_id);
      const name = as_non_empty_string(entity.name);
      if (name !== undefined && entity.entity_type === "character") {
        context.speaker_entity_by_name.set(name, entity_id);
      }
    }
  }
  for (const asset of as_array(analysis.reference_assets)) {
    if (!is_record(asset)) {
      continue;
    }
    const asset_id = as_non_empty_string(asset.asset_id);
    if (asset_id !== undefined) {
      context.asset_by_id.set(asset_id, asset);
    }
  }
  return context;
}

function collect_all_analysis_scenes(analysis: JsonRecord): JsonRecord[] {
  const scenes: JsonRecord[] = [];
  for (const episode of as_array(analysis.episodes)) {
    if (!is_record(episode)) {
      continue;
    }
    for (const scene of as_array(episode.scenes)) {
      if (is_record(scene)) {
        scenes.push(scene);
      }
    }
  }
  return scenes;
}

function validate_clip_duration(
  clip: JsonRecord,
  rules: SemanticModelRules,
  path: string,
  clip_id: string | undefined,
  errors: ArtifactSemanticError[],
): void {
  const duration = clip.duration_sec;
  if (typeof duration !== "number" || !Number.isInteger(duration)) {
    errors.push(
      semantic_error(
        `${path}.duration_sec`,
        "TIMELINE_INVALID",
        "clip duration_sec 必须是整数秒。",
        clip_id,
      ),
    );
    return;
  }
  if (duration < rules.duration.min_sec || duration > rules.duration.max_sec) {
    errors.push(
      semantic_error(
        `${path}.duration_sec`,
        "TIMELINE_INVALID",
        `clip 时长 ${duration} 秒超出模型允许的 ${rules.duration.min_sec}-${rules.duration.max_sec} 秒范围。`,
        clip_id,
      ),
    );
  }
}

function validate_clip_reference_limit(
  clip: JsonRecord,
  rules: SemanticModelRules,
  path: string,
  clip_id: string | undefined,
  context: AnalysisContext | undefined,
  errors: ArtifactSemanticError[],
): void {
  const reference_ids = as_string_array(clip.reference_asset_ids);
  const image_ids = new Set<string>();
  for (const reference_id of reference_ids) {
    if (context === undefined) {
      image_ids.add(reference_id);
      continue;
    }
    const asset = context.asset_by_id.get(reference_id);
    if (asset === undefined) {
      errors.push(
        semantic_error(
          `${path}.reference_asset_ids`,
          "REFERENCE_UNRESOLVED",
          `clip "${clip_id ?? ""}" 引用了不存在的素材 "${reference_id}"。`,
          clip_id,
        ),
      );
    } else if (asset.media_type === "image") {
      image_ids.add(reference_id);
    }
  }
  if (image_ids.size > rules.reference_limits.max_images) {
    errors.push(
      semantic_error(
        `${path}.reference_asset_ids`,
        "REFERENCE_LIMIT_EXCEEDED",
        `clip "${clip_id ?? ""}" 绑定 ${image_ids.size} 张图片，超过模型上限 ${rules.reference_limits.max_images}。`,
        clip_id,
      ),
    );
  }
}

function validate_clip_entities(
  clip: JsonRecord,
  path: string,
  clip_id: string | undefined,
  context: AnalysisContext | undefined,
  errors: ArtifactSemanticError[],
): void {
  if (context === undefined) {
    return;
  }
  const clip_entity_ids = as_string_array(clip.entity_ids);
  for (const entity_id of clip_entity_ids) {
    if (!context.entity_ids.has(entity_id)) {
      errors.push(
        semantic_error(
          `${path}.entity_ids`,
          "REFERENCE_UNRESOLVED",
          `clip "${clip_id ?? ""}" 引用了不存在的实体 "${entity_id}"。`,
          clip_id,
        ),
      );
    }
  }

  for (const entity_id of clip_entity_ids) {
    const has_image = as_string_array(clip.reference_asset_ids).some((asset_id) => {
      const asset = context.asset_by_id.get(asset_id);
      return (
        asset !== undefined &&
        asset.media_type === "image" &&
        as_string_array(asset.entity_ids).length === 1 &&
        as_string_array(asset.entity_ids).includes(entity_id)
      );
    });
    if (!has_image) {
      errors.push(
        semantic_error(
          `${path}.reference_asset_ids`,
          "REFERENCE_ASSET_INVALID",
          `clip "${clip_id ?? ""}" 的实体 "${entity_id}" 缺少本段图片绑定。`,
          clip_id,
        ),
      );
    }
  }
}

function validate_clip_continuity(
  clip: JsonRecord,
  scene: PlanSceneRecord,
  previous_clip_by_process: Map<string, string>,
  path: string,
  clip_id: string | undefined,
  errors: ArtifactSemanticError[],
): void {
  const process_id = as_non_empty_string(clip.process_id);
  if (process_id === undefined) {
    errors.push(semantic_error(`${path}.process_id`, "ID_INVALID", "clip 必须引用 process_id。", clip_id));
    return;
  }
  const previous_clip_id = previous_clip_by_process.get(process_id);
  const declared_previous = is_record(clip.continuity) ? clip.continuity.previous_clip_id : undefined;
  if (previous_clip_id === undefined && declared_previous !== null) {
    errors.push(
      semantic_error(
        `${path}.continuity.previous_clip_id`,
        "SOURCE_COVERAGE_INVALID",
        `process "${process_id}" 的首段 previous_clip_id 必须为 null。`,
        clip_id,
      ),
    );
  }
  if (clip.split_reason === "none" && previous_clip_id !== undefined) {
    errors.push(
      semantic_error(
        `${path}.split_reason`,
        "SOURCE_COVERAGE_INVALID",
        `process "${process_id}" 的后续段不得使用 split_reason=none。`,
        clip_id,
      ),
    );
  }
  if (clip.split_reason !== "none" && previous_clip_id === undefined) {
    errors.push(
      semantic_error(
        `${path}.split_reason`,
        "SOURCE_COVERAGE_INVALID",
        `process "${process_id}" 的首段 split_reason 必须为 none。`,
        clip_id,
      ),
    );
  }
  void scene;
}

function validate_shot_long_take_reason(
  shot: JsonRecord,
  duration_sec: number,
  path: string,
  clip_id: string | undefined,
  shot_id: string | undefined,
  errors: ArtifactSemanticError[],
): void {
  if (
    duration_sec > MAX_NORMAL_SHOT_SEC &&
    as_non_empty_string(shot.long_take_reason) === undefined
  ) {
    errors.push(
      semantic_error(
        `${path}.long_take_reason`,
        "TIMELINE_INVALID",
        "超过 6 秒的 shot 必须提供 long_take_reason。",
        clip_id,
        shot_id,
      ),
    );
  }
}
function validate_clip_timeline(
  clip: JsonRecord,
  path: string,
  clip_id: string | undefined,
  all_shot_ids: Set<string>,
  context: AnalysisContext | undefined,
  process_source_sets: Map<
    string,
    { action: Set<string>; emotion: Set<string>; dialogue: Set<string> }
  >,
  errors: ArtifactSemanticError[],
): void {
  const duration = clip.duration_sec;
  const shots = as_array(clip.shots);
  if (shots.length === 0) {
    errors.push(
      semantic_error(`${path}.shots`, "TIMELINE_INVALID", "clip 至少需要一个内部 shot。", clip_id),
    );
    return;
  }

  let previous_end = 0;
  for (const [shot_index, shot] of shots.entries()) {
    const shot_path = `${path}.shots[${shot_index}]`;
    if (!is_record(shot)) {
      errors.push(semantic_error(shot_path, "TIMELINE_INVALID", "shot 条目必须是对象。", clip_id));
      continue;
    }
    const shot_id = as_non_empty_string(shot.shot_id);
    const shot_reference = shot_id;
    if (shot_id === undefined) {
      errors.push(
        semantic_error(`${shot_path}.shot_id`, "ID_INVALID", "shot_id 必须是非空字符串。", clip_id),
      );
    } else if (all_shot_ids.has(shot_id)) {
      errors.push(
        semantic_error(
          `${shot_path}.shot_id`,
          "ID_DUPLICATE",
          `shot_id "${shot_id}" 重复。`,
          clip_id,
          shot_id,
        ),
      );
    }
    if (shot_id !== undefined) {
      all_shot_ids.add(shot_id);
    }

    if (as_positive_integer(shot.order) !== shot_index + 1) {
      errors.push(
        semantic_error(
          `${shot_path}.order`,
          "TIMELINE_INVALID",
          "shot order 必须从 1 开始连续递增。",
          clip_id,
          shot_reference,
        ),
      );
    }

    const start_sec = shot.start_sec;
    const end_sec = shot.end_sec;
    if (!is_integer_second(start_sec)) {
      errors.push(
        semantic_error(
          `${shot_path}.start_sec`,
          "TIMELINE_INVALID",
          "shot start_sec 必须使用整数秒。",
          clip_id,
          shot_reference,
        ),
      );
    }
    if (!is_integer_second(end_sec)) {
      errors.push(
        semantic_error(
          `${shot_path}.end_sec`,
          "TIMELINE_INVALID",
          "shot end_sec 必须使用整数秒。",
          clip_id,
          shot_reference,
        ),
      );
    }
    if (
      typeof start_sec !== "number" ||
      typeof end_sec !== "number" ||
      !Number.isFinite(start_sec) ||
      !Number.isFinite(end_sec) ||
      start_sec < 0 ||
      end_sec <= start_sec
    ) {
      errors.push(
        semantic_error(
          `${shot_path}`,
          "TIMELINE_INVALID",
          "shot 必须具有有效的正数秒区间。",
          clip_id,
          shot_reference,
        ),
      );
      continue;
    }
    if (start_sec !== previous_end) {
      errors.push(
        semantic_error(
          `${shot_path}.start_sec`,
          "TIMELINE_INVALID",
          `shot 起点 ${start_sec} 与上一镜结束 ${previous_end} 不连续。`,
          clip_id,
          shot_reference,
        ),
      );
    }
    if (typeof duration === "number" && end_sec > duration) {
      errors.push(
        semantic_error(
          `${shot_path}.end_sec`,
          "TIMELINE_INVALID",
          `shot 结束 ${end_sec} 超出 clip 总时长 ${duration}。`,
          clip_id,
          shot_reference,
        ),
      );
    }
    validate_shot_long_take_reason(
      shot,
      end_sec - start_sec,
      shot_path,
      clip_id,
      shot_reference,
      errors,
    );
    previous_end = end_sec;

    const process_id = as_non_empty_string(clip.process_id);
    if (process_id !== undefined) {
      let source_sets = process_source_sets.get(process_id);
      if (source_sets === undefined) {
        source_sets = { action: new Set(), emotion: new Set(), dialogue: new Set() };
        process_source_sets.set(process_id, source_sets);
      }
      for (const source_id of as_string_array(shot.source_action_unit_ids)) {
        source_sets.action.add(source_id);
        validate_unit_source(
          source_id,
          "action_units",
          process_id,
          context,
          shot_path,
          clip_id,
          shot_reference,
          errors,
        );
      }
      for (const source_id of as_string_array(shot.source_emotion_unit_ids)) {
        source_sets.emotion.add(source_id);
        validate_unit_source(
          source_id,
          "emotion_units",
          process_id,
          context,
          shot_path,
          clip_id,
          shot_reference,
          errors,
        );
      }
    }
  }

  if (typeof duration === "number" && previous_end !== duration) {
    errors.push(
      semantic_error(
        `${path}.shots`,
        "TIMELINE_INVALID",
        `shot 视觉轨结束于 ${previous_end}，与 clip 总时长 ${duration} 不一致。`,
        clip_id,
      ),
    );
  }
}

function validate_unit_source(
  source_id: string,
  expected_kind: "action_units" | "emotion_units",
  process_id: string,
  context: AnalysisContext | undefined,
  path: string,
  clip_id: string | undefined,
  shot_id: string | undefined,
  errors: ArtifactSemanticError[],
): void {
  if (context === undefined) {
    return;
  }
  const unit = context.unit_by_id.get(source_id);
  if (unit === undefined || unit.kind !== expected_kind) {
    errors.push(
      semantic_error(
        path,
        "SOURCE_COVERAGE_INVALID",
        `shot 引用了不存在的 ${expected_kind} 单元 "${source_id}"。`,
        clip_id,
        shot_id,
      ),
    );
    return;
  }
  const process = context.process_by_id.get(process_id);
  if (process === undefined || !as_string_array(process[expected_kind === "action_units" ? "action_unit_ids" : "emotion_unit_ids"]).includes(source_id)) {
    errors.push(
      semantic_error(
        path,
        "SOURCE_COVERAGE_INVALID",
        `单元 "${source_id}" 不属于 process "${process_id}"。`,
        clip_id,
        shot_id,
      ),
    );
  }
}

function validate_clip_audio(
  clip: JsonRecord,
  path: string,
  clip_id: string | undefined,
  context: AnalysisContext | undefined,
  knowledge_ref_ids: Set<string>,
  errors: ArtifactSemanticError[],
): void {
  const audio = clip.audio;
  if (!is_record(audio)) {
    return;
  }
  const duration = clip.duration_sec;
  for (const track of ["ambience", "sfx", "music"] as const) {
    for (const [cue_index, cue] of as_array(audio[track]).entries()) {
      const cue_path = `${path}.audio.${track}[${cue_index}]`;
      if (!is_record(cue)) {
        continue;
      }
      const start_sec = cue.start_sec;
      const end_sec = cue.end_sec;
      if (!is_integer_second(start_sec)) {
        errors.push(
          semantic_error(
            `${cue_path}.start_sec`,
            "TIMELINE_INVALID",
            "AudioCue start_sec 必须使用整数秒。",
            clip_id,
          ),
        );
      }
      if (!is_integer_second(end_sec)) {
        errors.push(
          semantic_error(
            `${cue_path}.end_sec`,
            "TIMELINE_INVALID",
            "AudioCue end_sec 必须使用整数秒。",
            clip_id,
          ),
        );
      }
      if (
        typeof start_sec !== "number" ||
        typeof end_sec !== "number" ||
        !Number.isFinite(start_sec) ||
        !Number.isFinite(end_sec) ||
        start_sec < 0 ||
        end_sec <= start_sec ||
        (typeof duration === "number" && end_sec > duration)
      ) {
        errors.push(
          semantic_error(
            cue_path,
            "TIMELINE_INVALID",
            "AudioCue 秒数区间无效或超出 clip。",
            clip_id,
          ),
        );
        continue;
      }
      if (
        (track === "ambience" || track === "music") &&
        typeof duration === "number" &&
        (start_sec !== 0 || end_sec !== duration)
      ) {
        errors.push(
          semantic_error(
            cue_path,
            "TIMELINE_INVALID",
            "全程环境声或音乐必须覆盖 0 到 clip 总时长。",
            clip_id,
          ),
        );
      }
      const source_refs = as_array(cue.source_refs);
      if (source_refs.length === 0) {
        errors.push(
          semantic_error(
            `${cue_path}.source_refs`,
            "SOURCE_COVERAGE_INVALID",
            "AudioCue 必须至少有一个可解析来源。",
            clip_id,
          ),
        );
      }
      for (const [ref_index, ref] of source_refs.entries()) {
        if (!is_record(ref)) {
          continue;
        }
        const kind = ref.kind;
        const id = as_non_empty_string(ref.id);
        const resolved =
          id !== undefined &&
          ((kind === "scene" && id === clip.scene_id) ||
            (kind === "unit" && context?.unit_by_id.has(id) === true) ||
            (kind === "knowledge" && knowledge_ref_ids.has(id)));
        if (!resolved) {
          errors.push(
            semantic_error(
              `${cue_path}.source_refs[${ref_index}]`,
              "SOURCE_COVERAGE_INVALID",
              `AudioCue 来源无法解析：${String(kind)}/${String(id)}。`,
              clip_id,
            ),
          );
        }
      }
    }
  }
}

function validate_dialogue_segments(
  segments_by_dialogue: Map<string, Array<{ segment: JsonRecord; path: string; duration_sec: unknown }>>,
  context: AnalysisContext | undefined,
  errors: ArtifactSemanticError[],
): void {
  for (const [dialogue_unit_id, entries] of segments_by_dialogue) {
    const source = context?.dialogue_by_id.get(dialogue_unit_id);
    const text = source === undefined ? undefined : as_non_empty_string(source.text);
    let previous_end = 0;
    let expected_speaker = context?.speaker_entity_by_name.get(
      source === undefined ? "" : String(source.speaker),
    );
    for (const [index, entry] of entries.entries()) {
      const start_offset = entry.segment.start_offset;
      const end_offset = entry.segment.end_offset;
      const speaker_id = entry.segment.speaker_id;
      const start_sec = entry.segment.start_sec;
      const end_sec = entry.segment.end_sec;
      if (!is_integer_second(start_sec)) {
        errors.push(
          semantic_error(
            `${entry.path}.start_sec`,
            "TIMELINE_INVALID",
            `对白 "${dialogue_unit_id}" 的 start_sec 必须使用整数秒。`,
          ),
        );
      }
      if (!is_integer_second(end_sec)) {
        errors.push(
          semantic_error(
            `${entry.path}.end_sec`,
            "TIMELINE_INVALID",
            `对白 "${dialogue_unit_id}" 的 end_sec 必须使用整数秒。`,
          ),
        );
      }
      if (
        typeof start_sec !== "number" ||
        typeof end_sec !== "number" ||
        !Number.isFinite(start_sec) ||
        !Number.isFinite(end_sec) ||
        start_sec < 0 ||
        end_sec <= start_sec ||
        (typeof entry.duration_sec === "number" && end_sec > entry.duration_sec)
      ) {
        errors.push(
          semantic_error(
            entry.path,
            "TIMELINE_INVALID",
            `对白 "${dialogue_unit_id}" 的时间区间无效或超出 clip。`,
          ),
        );
      }
      if (
        typeof start_offset !== "number" ||
        typeof end_offset !== "number" ||
        !Number.isInteger(start_offset) ||
        !Number.isInteger(end_offset) ||
        start_offset < 0 ||
        end_offset <= start_offset ||
        (text !== undefined && (start_offset > text.length || end_offset > text.length))
      ) {
        errors.push(
          semantic_error(
            `${entry.path}`,
            "SOURCE_COVERAGE_INVALID",
            `对白 "${dialogue_unit_id}" 的 UTF-16 offset 无效。`,
          ),
        );
        continue;
      }
      if (start_offset !== previous_end) {
        errors.push(
          semantic_error(
            `${entry.path}.start_offset`,
            "SOURCE_COVERAGE_INVALID",
            `对白 "${dialogue_unit_id}" 的 offset 必须连续覆盖，期望从 ${previous_end} 开始。`,
          ),
        );
      }
      previous_end = end_offset;
      if (text !== undefined && splits_surrogate_pair(text, start_offset, end_offset)) {
        errors.push(
          semantic_error(
            `${entry.path}`,
            "SOURCE_COVERAGE_INVALID",
            `对白 "${dialogue_unit_id}" 的 offset 不能切断代理对。`,
          ),
        );
      }
      if (
        expected_speaker !== undefined &&
        as_non_empty_string(speaker_id) !== expected_speaker
      ) {
        errors.push(
          semantic_error(
            `${entry.path}.speaker_id`,
            "SOURCE_COVERAGE_INVALID",
            `对白 "${dialogue_unit_id}" 的说话人不匹配原文。`,
          ),
        );
      }
      if (index === 0 && start_offset !== 0) {
        errors.push(
          semantic_error(
            `${entry.path}.start_offset`,
            "SOURCE_COVERAGE_INVALID",
            `对白 "${dialogue_unit_id}" 的首片 offset 必须从 0 开始。`,
          ),
        );
      }
    }
    if (text !== undefined && previous_end !== text.length) {
      errors.push(
        semantic_error(
          "dialogue",
          "SOURCE_COVERAGE_INVALID",
          `对白 "${dialogue_unit_id}" 未精确覆盖原文，结束 offset 为 ${previous_end}，期望 ${text.length}。`,
        ),
      );
    }
  }
}

function validate_process_coverage(
  context: AnalysisContext | undefined,
  clips_by_process: Map<string, JsonRecord[]>,
  process_source_sets: Map<
    string,
    { action: Set<string>; emotion: Set<string>; dialogue: Set<string> }
  >,
  errors: ArtifactSemanticError[],
): void {
  if (context === undefined) {
    return;
  }
  for (const [process_id, process] of context.process_by_id) {
    const clips = clips_by_process.get(process_id) ?? [];
    if (clips.length === 0) {
      errors.push(
        semantic_error(
          "scenes",
          "SOURCE_COVERAGE_INVALID",
          `process "${process_id}" 没有任何 clip。`,
        ),
      );
      continue;
    }
    const sources = process_source_sets.get(process_id) ?? {
      action: new Set<string>(),
      emotion: new Set<string>(),
      dialogue: new Set<string>(),
    };
    for (const key of ["action_unit_ids", "emotion_unit_ids"] as const) {
      const expected = new Set(as_string_array(process[key]));
      const actual = key === "action_unit_ids" ? sources.action : sources.emotion;
      for (const unit_id of expected) {
        if (!actual.has(unit_id)) {
          errors.push(
            semantic_error(
              "scenes",
              "SOURCE_COVERAGE_INVALID",
              `process "${process_id}" 的 ${key} 单元 "${unit_id}" 未被视觉镜头覆盖。`,
            ),
          );
        }
      }
    }
    for (const dialogue_id of as_string_array(process.dialogue_unit_ids)) {
      if (!clips.some((clip) =>
        as_array(clip.dialogue).some(
          (segment) =>
            is_record(segment) && segment.dialogue_unit_id === dialogue_id,
        ),
      )) {
        errors.push(
          semantic_error(
            "scenes",
            "SOURCE_COVERAGE_INVALID",
            `process "${process_id}" 的对白单元 "${dialogue_id}" 未被对白轨覆盖。`,
          ),
        );
      }
    }
  }
}

function collect_plan_knowledge_ref_ids(plan: JsonRecord): Set<string> {
  const result = new Set<string>();
  for (const ref of as_array(plan.knowledge_refs)) {
    if (is_record(ref)) {
      const card_id = as_non_empty_string(ref.card_id);
      if (card_id !== undefined) {
        result.add(card_id);
      }
    }
  }
  return result;
}

function splits_surrogate_pair(text: string, start: number, end: number): boolean {
  return (
    (start > 0 &&
      is_high_surrogate(text.charCodeAt(start - 1)) &&
      is_low_surrogate(text.charCodeAt(start))) ||
    (end > 0 &&
      end < text.length &&
      is_high_surrogate(text.charCodeAt(end - 1)) &&
      is_low_surrogate(text.charCodeAt(end)))
  );
}

function is_high_surrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function is_low_surrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function as_positive_integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}









const SHOT_SIZE_TO_PROMPT: Record<string, string> = {
  "大远景": "extreme-long-shot",
  "远景": "long-shot",
  "全景": "full-shot",
  "中全景": "medium-full-shot",
  "中景": "medium-shot",
  "中近景": "medium-close-up",
  "近景": "close-shot",
  "特写": "close-up",
  "插入镜头": "insert-shot",
};

const CAMERA_ANGLE_TO_PROMPT: Record<string, string> = {
  "平视": "eye-level",
  "仰视": "low-angle",
  "俯视": "high-angle",
  "鸟瞰": "bird's-eye",
  "虫视": "worm's-eye",
  "荷兰角": "dutch-angle",
  "过肩": "over-the-shoulder",
  "主观视角": "point-of-view",
  "反打": "reverse-angle",
  "侧面": "side-view",
  "四分之三侧面": "three-quarter-view",
  "背身": "back-view",
  "双人镜头": "two-shot",
};

const CAMERA_MOVEMENT_TO_PROMPT: Record<string, string> = {
  "固定": "static",
  "横摇": "pan",
  "竖摇": "tilt",
  "推近": "push-in",
  "拉远": "pull-out",
  "平移": "truck",
  "升降": "boom",
  "摇臂": "crane",
  "变焦": "zoom",
  "跟拍": "tracking",
  "环绕": "orbit",
  "手持": "handheld",
  "稳定器": "gimbal",
  "甩镜": "whip-pan",
  "滑动变焦": "dolly-zoom",
  "跟焦": "follow-focus",
};

const MEDIA_TAG_LABELS: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

export function validate_prompt_semantics(
  prompt: unknown,
  rules: SemanticModelRules,
  plan?: unknown,
  analysis?: unknown,
): ArtifactSemanticError[] {
  if (!is_record(prompt)) {
    return [semantic_error("", "STRUCTURE_INVALID", "PromptIR 必须是对象。")];
  }
  const errors: ArtifactSemanticError[] = [];
  const context =
    analysis === undefined ? undefined : build_analysis_context(analysis, errors);
  const plan_clips = plan === undefined ? undefined : collect_plan_clips(plan, errors);
  const prompt_clips = as_array(prompt.clips).filter(is_record);
  const display_timeline = prompt.display_timeline;

  if (typeof display_timeline !== "boolean") {
    errors.push(
      semantic_error("display_timeline", "TIMELINE_INVALID", "display_timeline 必须是布尔值。"),
    );
  }
  if (prompt.target_model === "seedance-2.5" && display_timeline !== true) {
    errors.push(
      semantic_error(
        "display_timeline",
        "TIMELINE_INVALID",
        "Seedance 2.5 必须显示结构化秒数时间轴。",
      ),
    );
  }

  if (plan_clips !== undefined) {
    compare_prompt_plan_structure(prompt_clips, plan_clips, context, errors);
  }

  const seen_clip_ids = new Set<string>();
  for (const [clip_index, clip] of prompt_clips.entries()) {
    const path = `clips[${clip_index}]`;
    const clip_id = as_non_empty_string(clip.clip_id) ?? "";
    if (clip_id === "") {
      errors.push(semantic_error(`${path}.clip_id`, "ID_INVALID", "clip_id 必须是非空字符串。"));
    } else if (seen_clip_ids.has(clip_id)) {
      errors.push(
        semantic_error(`${path}.clip_id`, "ID_DUPLICATE", `clip_id "${clip_id}" 重复。`),
      );
    }
    seen_clip_ids.add(clip_id);

    const duration = clip.duration_sec;
    if (
      typeof duration !== "number" ||
      !Number.isInteger(duration) ||
      duration < rules.duration.min_sec ||
      duration > rules.duration.max_sec
    ) {
      errors.push(
        semantic_error(
          `${path}.duration_sec`,
          "TIMELINE_INVALID",
          `clip "${clip_id}" 时长必须为 ${rules.duration.min_sec}-${rules.duration.max_sec} 的整数秒。`,
          clip_id,
        ),
      );
    }
    if (as_non_empty_string(clip.generation_goal) === undefined) {
      errors.push(
        semantic_error(
          `${path}.generation_goal`,
          "SOURCE_COVERAGE_INVALID",
          `clip "${clip_id}" 缺少生成目标。`,
          clip_id,
        ),
      );
    }
    if (as_non_empty_string(clip.subjects_and_relations) === undefined) {
      errors.push(
        semantic_error(
          `${path}.subjects_and_relations`,
          "SOURCE_COVERAGE_INVALID",
          `clip "${clip_id}" 缺少主体与关系。`,
          clip_id,
        ),
      );
    }

    validate_prompt_reference_bindings(
      clip,
      rules,
      context,
      plan_clips?.by_id.get(clip_id),
      `${path}.reference_bindings`,
      errors,
    );
    validate_prompt_shots(clip, context, `${path}.shots`, errors);
    validate_prompt_dialogue(clip, context, `${path}.dialogue`, errors);
    validate_prompt_audio(clip, context, `${path}.audio`, errors);
  }

  return errors;
}

interface PlanClipCollection {
  ordered: JsonRecord[];
  by_id: Map<string, JsonRecord>;
}

function collect_plan_clips(
  plan: unknown,
  errors: ArtifactSemanticError[],
): PlanClipCollection {
  if (!is_record(plan)) {
    errors.push(semantic_error("", "STRUCTURE_INVALID", "规划产物必须是对象。"));
    return { ordered: [], by_id: new Map() };
  }
  const ordered: JsonRecord[] = [];
  const by_id = new Map<string, JsonRecord>();
  for (const scene of collect_plan_scenes(plan, errors)) {
    for (const clip of scene.clips) {
      ordered.push(clip);
      const clip_id = as_non_empty_string(clip.clip_id);
      if (clip_id !== undefined) {
        by_id.set(clip_id, clip);
      }
    }
  }
  return { ordered, by_id };
}

function compare_prompt_plan_structure(
  prompt_clips: JsonRecord[],
  plan_clips: PlanClipCollection,
  context: AnalysisContext | undefined,
  errors: ArtifactSemanticError[],
): void {
  if (prompt_clips.length !== plan_clips.ordered.length) {
    errors.push(
      semantic_error(
        "clips",
        "SOURCE_COVERAGE_INVALID",
        `PromptIR 有 ${prompt_clips.length} 个 clip，规划有 ${plan_clips.ordered.length} 个。`,
      ),
    );
  }

  for (const [index, prompt_clip] of prompt_clips.entries()) {
    const prompt_clip_id = as_non_empty_string(prompt_clip.clip_id);
    const plan_clip = plan_clips.ordered[index];
    if (plan_clip === undefined) {
      errors.push(
        semantic_error(
          `clips[${index}]`,
          "SOURCE_COVERAGE_INVALID",
          `PromptIR clip "${prompt_clip_id ?? ""}" 在上游规划中没有对应项。`,
          prompt_clip_id,
        ),
      );
      continue;
    }
    const plan_clip_id = as_non_empty_string(plan_clip.clip_id);
    if (prompt_clip_id !== plan_clip_id) {
      errors.push(
        semantic_error(
          `clips[${index}].clip_id`,
          "SOURCE_COVERAGE_INVALID",
          `PromptIR clip 顺序与规划不一致：期望 "${plan_clip_id ?? ""}"，实际 "${prompt_clip_id ?? ""}"。`,
          prompt_clip_id,
        ),
      );
    }
    const clip_id = prompt_clip_id ?? plan_clip_id;
    for (const field of ["scene_id", "process_id", "duration_sec"] as const) {
      if (!same_json(prompt_clip[field], plan_clip[field])) {
        errors.push(
          semantic_error(
            `clips[${index}].${field}`,
            "SOURCE_COVERAGE_INVALID",
            `clip "${clip_id ?? ""}" 的 ${field} 与规划不一致。`,
            clip_id,
          ),
        );
      }
    }

    const prompt_shots = as_array(prompt_clip.shots).filter(is_record);
    const plan_shots = as_array(plan_clip.shots).filter(is_record);
    if (prompt_shots.length !== plan_shots.length) {
      errors.push(
        semantic_error(
          `clips[${index}].shots`,
          "SOURCE_COVERAGE_INVALID",
          `clip "${clip_id ?? ""}" 的 shot 数与规划不一致。`,
          clip_id,
        ),
      );
    }
    for (const [shot_index, prompt_shot] of prompt_shots.entries()) {
      const plan_shot = plan_shots[shot_index];
      if (plan_shot === undefined) {
        continue;
      }
      const shot_id = as_non_empty_string(prompt_shot.shot_id) ?? undefined;
      if (as_non_empty_string(prompt_shot.shot_id) !== as_non_empty_string(plan_shot.shot_id)) {
        errors.push(
          semantic_error(
            `clips[${index}].shots[${shot_index}].shot_id`,
            "SOURCE_COVERAGE_INVALID",
            "PromptIR shot_id 与规划不一致。",
            clip_id,
            shot_id,
          ),
        );
      }
      const same_shot_decision =
        prompt_shot.order === plan_shot.order &&
        same_json(prompt_shot.start_sec, plan_shot.start_sec) &&
        same_json(prompt_shot.end_sec, plan_shot.end_sec) &&
        prompt_shot.shot_size === SHOT_SIZE_TO_PROMPT[String(plan_shot.shot_size)] &&
        prompt_shot.camera_angle === CAMERA_ANGLE_TO_PROMPT[String(plan_shot.camera_angle)] &&
        prompt_shot.camera_movement === CAMERA_MOVEMENT_TO_PROMPT[String(plan_shot.camera_movement)] &&
        prompt_shot.transition === plan_shot.transition &&
        same_json(prompt_shot.purpose, plan_shot.purpose) &&
        same_json(prompt_shot.source_action_unit_ids, plan_shot.source_action_unit_ids) &&
        same_json(prompt_shot.source_emotion_unit_ids, plan_shot.source_emotion_unit_ids) &&
        same_json(prompt_shot.continuity, plan_shot.continuity) &&
        same_json(prompt_shot.long_take_reason, plan_shot.long_take_reason);
      if (!same_shot_decision) {
        errors.push(
          semantic_error(
            `clips[${index}].shots[${shot_index}]`,
            "SOURCE_COVERAGE_INVALID",
            `shot "${shot_id ?? ""}" 的决策、时间或来源与规划不一致。`,
            clip_id,
            shot_id,
          ),
        );
      }
    }

    const prompt_dialogue = as_array(prompt_clip.dialogue).filter(is_record);
    const plan_dialogue = as_array(plan_clip.dialogue).filter(is_record);
    if (prompt_dialogue.length !== plan_dialogue.length) {
      errors.push(
        semantic_error(
          `clips[${index}].dialogue`,
          "SOURCE_COVERAGE_INVALID",
          `clip "${clip_id ?? ""}" 的对白片段数与规划不一致。`,
          clip_id,
        ),
      );
    }
    for (const [dialogue_index, prompt_segment] of prompt_dialogue.entries()) {
      const plan_segment = plan_dialogue[dialogue_index];
      if (plan_segment === undefined) {
        continue;
      }
      const prompt_without_text = { ...prompt_segment };
      delete prompt_without_text.text;
      delete prompt_without_text.language;
      delete prompt_without_text.delivery;
      if (!same_json(prompt_without_text, plan_segment)) {
        errors.push(
          semantic_error(
            `clips[${index}].dialogue[${dialogue_index}]`,
            "SOURCE_COVERAGE_INVALID",
            "PromptIR 对白片段与规划不一致。",
            clip_id,
          ),
        );
      }
      const source = context?.dialogue_by_id.get(
        String(prompt_segment.dialogue_unit_id),
      );
      if (source !== undefined) {
        const source_text = typeof source.text === "string" ? source.text : "";
        const start_offset = prompt_segment.start_offset;
        const end_offset = prompt_segment.end_offset;
        if (
          typeof start_offset === "number" &&
          typeof end_offset === "number" &&
          prompt_segment.text !== source_text.slice(start_offset, end_offset)
        ) {
          errors.push(
            semantic_error(
              `clips[${index}].dialogue[${dialogue_index}].text`,
              "SOURCE_COVERAGE_INVALID",
              "PromptIR 台词文字不是上游原文对应 offset 的切片。",
              clip_id,
            ),
          );
        }
      }
    }

    if (!same_json(prompt_clip.audio, plan_clip.audio)) {
      errors.push(
        semantic_error(
          `clips[${index}].audio`,
          "SOURCE_COVERAGE_INVALID",
          `clip "${clip_id ?? ""}" 的声音 cue 与规划不一致。`,
          clip_id,
        ),
      );
    }
    if (!same_json(prompt_clip.continuity, plan_clip.continuity)) {
      errors.push(
        semantic_error(
          `clips[${index}].continuity`,
          "SOURCE_COVERAGE_INVALID",
          `clip "${clip_id ?? ""}" 的连续性状态与规划不一致。`,
          clip_id,
        ),
      );
    }
  }
}

function validate_prompt_reference_bindings(
  clip: JsonRecord,
  rules: SemanticModelRules,
  context: AnalysisContext | undefined,
  plan_clip: JsonRecord | undefined,
  path: string,
  errors: ArtifactSemanticError[],
): void {
  const clip_id = as_non_empty_string(clip.clip_id);
  const bindings = as_array(clip.reference_bindings).filter(is_record);
  const seen_assets = new Set<string>();
  const counts: Record<string, number> = { image: 0, video: 0, audio: 0 };
  const image_assets = new Set<string>();

  for (const [index, binding] of bindings.entries()) {
    const binding_path = `${path}[${index}]`;
    const asset_id = as_non_empty_string(binding.asset_id);
    const media_type = String(binding.media_type ?? "");
    if (asset_id === undefined) {
      errors.push(
        semantic_error(`${binding_path}.asset_id`, "ID_INVALID", "素材绑定必须有 asset_id。", clip_id),
      );
      continue;
    }
    if (seen_assets.has(asset_id)) {
      errors.push(
        semantic_error(
          `${binding_path}.asset_id`,
          "REFERENCE_ASSET_INVALID",
          `clip "${clip_id ?? ""}" 重复绑定素材 "${asset_id}"。`,
          clip_id,
        ),
      );
    }
    seen_assets.add(asset_id);

    const expected_tag_prefix = MEDIA_TAG_LABELS[media_type];
    const tag = as_non_empty_string(binding.tag);
    counts[media_type] = (counts[media_type] ?? 0) + 1;
    if (
      expected_tag_prefix === undefined ||
      tag === undefined ||
      tag !== `@${expected_tag_prefix}${counts[media_type]}`
    ) {
      errors.push(
        semantic_error(
          `${binding_path}.tag`,
          "REFERENCE_ASSET_INVALID",
          `clip "${clip_id ?? ""}" 的素材标签必须按媒体类型连续编号。`,
          clip_id,
        ),
      );
    }
    if (media_type === "image") {
      image_assets.add(asset_id);
    }

    if (context !== undefined) {
      const asset = context.asset_by_id.get(asset_id);
      if (asset === undefined) {
        errors.push(
          semantic_error(
            `${binding_path}.asset_id`,
            "REFERENCE_UNRESOLVED",
            `clip "${clip_id ?? ""}" 绑定了不存在的素材 "${asset_id}"。`,
            clip_id,
          ),
        );
      } else {
        if (
          binding.media_type !== asset.media_type ||
          binding.status !== asset.status ||
          !same_json(binding.entity_ids, asset.entity_ids) ||
          !same_json(binding.adopt, asset.adopt) ||
          !same_json(binding.exclude, asset.exclude)
        ) {
          errors.push(
            semantic_error(
              binding_path,
              "REFERENCE_ASSET_INVALID",
              `素材 "${asset_id}" 的媒体类型、状态或职责与解析产物不一致。`,
              clip_id,
            ),
          );
        }
      }
    }
  }

  if (image_assets.size > rules.reference_limits.max_images) {
    errors.push(
      semantic_error(
        path,
        "REFERENCE_LIMIT_EXCEEDED",
        `clip "${clip_id ?? ""}" 绑定 ${image_assets.size} 张图片，超过模型上限 ${rules.reference_limits.max_images}。`,
        clip_id,
      ),
    );
  }

  if (plan_clip !== undefined) {
    const expected = new Set(as_string_array(plan_clip.reference_asset_ids));
    if (
      expected.size !== seen_assets.size ||
      [...expected].some((asset_id) => !seen_assets.has(asset_id))
    ) {
      errors.push(
        semantic_error(
          path,
          "REFERENCE_ASSET_INVALID",
          `clip "${clip_id ?? ""}" 的素材绑定与规划不一致。`,
          clip_id,
        ),
      );
    }
  }

  if (context !== undefined) {
    for (const entity_id of as_string_array(clip.entity_ids)) {
      const resolved_asset = bindings.some((binding) => {
        const asset_id = as_non_empty_string(binding.asset_id);
        const asset = asset_id === undefined ? undefined : context.asset_by_id.get(asset_id);
        return (
          asset?.media_type === "image" &&
          as_string_array(asset.entity_ids).length === 1 &&
          as_string_array(asset.entity_ids).includes(entity_id)
        );
      });
      if (!resolved_asset) {
        errors.push(
          semantic_error(
            path,
            "REFERENCE_ASSET_INVALID",
            `clip "${clip_id ?? ""}" 的实体 "${entity_id}" 缺少图片绑定。`,
            clip_id,
          ),
        );
      }
    }
  }
}

function validate_prompt_shots(
  clip: JsonRecord,
  context: AnalysisContext | undefined,
  path: string,
  errors: ArtifactSemanticError[],
): void {
  const clip_id = as_non_empty_string(clip.clip_id);
  const duration = clip.duration_sec;
  const shots = as_array(clip.shots);
  if (shots.length === 0) {
    errors.push(semantic_error(path, "TIMELINE_INVALID", "PromptIR clip 至少需要一个 shot。", clip_id));
    return;
  }
  let previous_end = 0;
  for (const [index, shot] of shots.entries()) {
    if (!is_record(shot)) continue;
    const shot_id = as_non_empty_string(shot.shot_id);
    const start_sec = shot.start_sec;
    const end_sec = shot.end_sec;
    if (!is_integer_second(start_sec)) {
      errors.push(
        semantic_error(
          `${path}[${index}].start_sec`,
          "TIMELINE_INVALID",
          `shot "${shot_id ?? ""}" 的 start_sec 必须使用整数秒。`,
          clip_id,
          shot_id,
        ),
      );
    }
    if (!is_integer_second(end_sec)) {
      errors.push(
        semantic_error(
          `${path}[${index}].end_sec`,
          "TIMELINE_INVALID",
          `shot "${shot_id ?? ""}" 的 end_sec 必须使用整数秒。`,
          clip_id,
          shot_id,
        ),
      );
    }
    if (
      as_positive_integer(shot.order) !== index + 1 ||
      typeof start_sec !== "number" ||
      typeof end_sec !== "number" ||
      !Number.isFinite(start_sec) ||
      !Number.isFinite(end_sec) ||
      start_sec < 0 ||
      end_sec <= start_sec ||
      start_sec !== previous_end ||
      (typeof duration === "number" && end_sec > duration)
    ) {
      errors.push(
        semantic_error(
          `${path}[${index}]`,
          "TIMELINE_INVALID",
          `shot "${shot_id ?? ""}" 的时间轴无效或不连续。`,
          clip_id,
          shot_id,
        ),
      );
    }
    if (
      typeof start_sec === "number" &&
      typeof end_sec === "number" &&
      is_integer_second(start_sec) &&
      is_integer_second(end_sec)
    ) {
      validate_shot_long_take_reason(
        shot,
        end_sec - start_sec,
        `${path}[${index}]`,
        clip_id,
        shot_id,
        errors,
      );
    }
    if (typeof end_sec === "number") previous_end = end_sec;
    if (as_non_empty_string(shot.subject) === undefined || as_non_empty_string(shot.action) === undefined) {
      errors.push(semantic_error(`${path}[${index}]`, "SOURCE_COVERAGE_INVALID", `shot "${shot_id ?? ""}" 缺少有依据的主体或动作。`, clip_id, shot_id));
    }
    if (context !== undefined) {
      for (const source_id of as_string_array(shot.source_action_unit_ids)) {
        if (context.unit_by_id.get(source_id)?.kind !== "action_units") errors.push(semantic_error(`${path}[${index}].source_action_unit_ids`, "SOURCE_COVERAGE_INVALID", `shot "${shot_id ?? ""}" 的动作来源 "${source_id}" 无法解析。`, clip_id, shot_id));
      }
      for (const source_id of as_string_array(shot.source_emotion_unit_ids)) {
        if (context.unit_by_id.get(source_id)?.kind !== "emotion_units") errors.push(semantic_error(`${path}[${index}].source_emotion_unit_ids`, "SOURCE_COVERAGE_INVALID", `shot "${shot_id ?? ""}" 的情绪来源 "${source_id}" 无法解析。`, clip_id, shot_id));
      }
    }
  }
  if (typeof duration === "number" && previous_end !== duration) {
    errors.push(semantic_error(path, "TIMELINE_INVALID", `PromptIR 视觉轨结束于 ${previous_end}，与 clip 总时长 ${duration} 不一致。`, clip_id));
  }
}

function validate_prompt_dialogue(
  clip: JsonRecord,
  context: AnalysisContext | undefined,
  path: string,
  errors: ArtifactSemanticError[],
): void {
  const clip_id = as_non_empty_string(clip.clip_id);
  const duration = clip.duration_sec;
  for (const [index, segment] of as_array(clip.dialogue).entries()) {
    if (!is_record(segment)) continue;
    const start_sec = segment.start_sec;
    const end_sec = segment.end_sec;
    if (!is_integer_second(start_sec)) {
      errors.push(
        semantic_error(
          `${path}[${index}].start_sec`,
          "TIMELINE_INVALID",
          "对白 start_sec 必须使用整数秒。",
          clip_id,
        ),
      );
    }
    if (!is_integer_second(end_sec)) {
      errors.push(
        semantic_error(
          `${path}[${index}].end_sec`,
          "TIMELINE_INVALID",
          "对白 end_sec 必须使用整数秒。",
          clip_id,
        ),
      );
    }
    if (
      typeof start_sec !== "number" ||
      typeof end_sec !== "number" ||
      !Number.isFinite(start_sec) ||
      !Number.isFinite(end_sec) ||
      start_sec < 0 ||
      end_sec <= start_sec ||
      (typeof duration === "number" && end_sec > duration)
    ) {
      errors.push(
        semantic_error(
          `${path}[${index}]`,
          "TIMELINE_INVALID",
          "对白时间区间无效或超出 clip。",
          clip_id,
        ),
      );
    }
    const dialogue_unit_id = as_non_empty_string(segment.dialogue_unit_id);
    const source = dialogue_unit_id === undefined ? undefined : context?.dialogue_by_id.get(dialogue_unit_id);
    if (source !== undefined) {
      const text = typeof source.text === "string" ? source.text : "";
      const start = segment.start_offset;
      const end = segment.end_offset;
      if (typeof start !== "number" || typeof end !== "number" || segment.text !== text.slice(start, end)) {
        errors.push(semantic_error(`${path}[${index}].text`, "SOURCE_COVERAGE_INVALID", `对白 "${dialogue_unit_id ?? ""}" 的文字不是原文切片。`, clip_id));
      }
    }
  }
}

function validate_prompt_audio(
  clip: JsonRecord,
  context: AnalysisContext | undefined,
  path: string,
  errors: ArtifactSemanticError[],
): void {
  if (!is_record(clip.audio)) return;
  const clip_id = as_non_empty_string(clip.clip_id);
  const duration = clip.duration_sec;
  for (const track of ["ambience", "sfx", "music"] as const) {
    for (const [index, cue] of as_array(clip.audio[track]).entries()) {
      if (!is_record(cue)) continue;
      const start_sec = cue.start_sec;
      const end_sec = cue.end_sec;
      if (!is_integer_second(start_sec)) {
        errors.push(
          semantic_error(
            `${path}.${track}[${index}].start_sec`,
            "TIMELINE_INVALID",
            "AudioCue start_sec 必须使用整数秒。",
            clip_id,
          ),
        );
      }
      if (!is_integer_second(end_sec)) {
        errors.push(
          semantic_error(
            `${path}.${track}[${index}].end_sec`,
            "TIMELINE_INVALID",
            "AudioCue end_sec 必须使用整数秒。",
            clip_id,
          ),
        );
      }
      if (
        typeof start_sec !== "number" ||
        typeof end_sec !== "number" ||
        !Number.isFinite(start_sec) ||
        !Number.isFinite(end_sec) ||
        start_sec < 0 ||
        end_sec <= start_sec ||
        (typeof duration === "number" && end_sec > duration)
      ) {
        errors.push(
          semantic_error(
            `${path}.${track}[${index}]`,
            "TIMELINE_INVALID",
            "AudioCue 时间区间无效或超出 clip。",
            clip_id,
          ),
        );
      }
      if (
        (track === "ambience" || track === "music") &&
        typeof duration === "number" &&
        (start_sec !== 0 || end_sec !== duration)
      ) {
        errors.push(
          semantic_error(
            `${path}.${track}[${index}]`,
            "TIMELINE_INVALID",
            "全程环境声或音乐必须覆盖 0 到 clip 总时长。",
            clip_id,
          ),
        );
      }
      if (context !== undefined) {
        for (const [ref_index, ref] of as_array(cue.source_refs).entries()) {
          if (!is_record(ref)) continue;
          const kind = ref.kind;
          const id = as_non_empty_string(ref.id);
          const resolved = id !== undefined && ((kind === "scene" && id === clip.scene_id) || (kind === "unit" && context.unit_by_id.has(id)) || kind === "knowledge");
          if (!resolved) errors.push(semantic_error(`${path}.${track}[${index}].source_refs[${ref_index}]`, "SOURCE_COVERAGE_INVALID", `AudioCue 来源无法解析：${String(kind)}/${String(id)}。`, clip_id));
        }
      }
    }
  }
}

export function validate_run_artifact_links(input: {
  run: unknown;
  script_analysis: unknown;
  shot_plan: unknown;
  prompt_ir: unknown;
}): ArtifactSemanticError[] {
  if (!is_record(input)) {
    return [semantic_error("", "STRUCTURE_INVALID", "链接校验输入必须是对象。")];
  }
  const entries = [
    ["run", input.run],
    ["script_analysis", input.script_analysis],
    ["shot_plan", input.shot_plan],
    ["prompt_ir", input.prompt_ir],
  ] as const;
  const errors: ArtifactSemanticError[] = [];
  for (const [name, value] of entries) {
    const version = check_artifact_version(value);
    if (!version.ok) {
      errors.push(
        semantic_error(
          name,
          version.code,
          `${name} 的 schema_version 不受支持：${String(version.found_version)}。`,
        ),
      );
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  const run = input.run as JsonRecord;
  const analysis = input.script_analysis as JsonRecord;
  const plan = input.shot_plan as JsonRecord;
  const prompt = input.prompt_ir as JsonRecord;

  compare_link_field(run, analysis, "run_id", "script_analysis.run_id", errors);
  compare_link_field(run, plan, "run_id", "shot_plan.run_id", errors);
  compare_link_field(run, prompt, "run_id", "prompt_ir.run_id", errors);
  compare_link_field(run, analysis, "project_id", "script_analysis.project_id", errors);
  compare_link_field(run, plan, "project_id", "shot_plan.project_id", errors);
  compare_link_field(run, analysis, "target_model", "script_analysis.target_model", errors);
  compare_link_field(run, plan, "target_model", "shot_plan.target_model", errors);
  compare_link_field(run, prompt, "target_model", "prompt_ir.target_model", errors);
  compare_link_field(run, analysis, "input_mode", "script_analysis.input_mode", errors);

  const analysis_hashes = is_record(analysis.input_hashes) ? analysis.input_hashes : undefined;
  const expected_run_hash = hash_run_context(run);
  if (analysis_hashes?.run_context !== expected_run_hash) {
    errors.push(
      semantic_error(
        "script_analysis.input_hashes.run_context",
        "INPUT_HASH_MISMATCH",
        "解析产物的 run_context 指纹与当前运行输入不一致。",
      ),
    );
  }
  const plan_hashes = is_record(plan.input_hashes) ? plan.input_hashes : undefined;
  const expected_analysis_hash = hash_artifact_document(analysis);
  if (plan_hashes?.script_analysis !== expected_analysis_hash) {
    errors.push(
      semantic_error(
        "shot_plan.input_hashes.script_analysis",
        "INPUT_HASH_MISMATCH",
        "规划产物保存的解析指纹已过期。",
      ),
    );
  }
  const prompt_hashes = is_record(prompt.input_hashes) ? prompt.input_hashes : undefined;
  if (
    prompt_hashes?.script_analysis !== expected_analysis_hash ||
    prompt_hashes?.shot_plan !== hash_artifact_document(plan)
  ) {
    errors.push(
      semantic_error(
        "prompt_ir.input_hashes",
        "INPUT_HASH_MISMATCH",
        "PromptIR 保存的上游内容指纹已过期。",
      ),
    );
  }

  const expected_display =
    run.target_model === "seedance-2.5" ? true : run.display_timeline === true;
  if (prompt.display_timeline !== expected_display) {
    errors.push(
      semantic_error(
        "prompt_ir.display_timeline",
        "TIMELINE_INVALID",
        "PromptIR 的 display_timeline 与目标模型和运行偏好不一致。",
      ),
    );
  }

  const plan_clips = collect_plan_clips(plan, errors);
  const prompt_clips = as_array(prompt.clips).filter(is_record);
  compare_prompt_plan_structure(prompt_clips, plan_clips, undefined, errors);
  return errors;
}

function compare_link_field(
  run: JsonRecord,
  artifact: JsonRecord,
  field: string,
  path: string,
  errors: ArtifactSemanticError[],
): void {
  if (run[field] !== artifact[field]) {
    errors.push(
      semantic_error(
        path,
        "ARTIFACT_IDENTITY_MISMATCH",
        `${path} 与 run.json 的 ${field} 不一致。`,
      ),
    );
  }
}

function same_json(left: unknown, right: unknown): boolean {
  return hash_artifact_document(left) === hash_artifact_document(right);
}
