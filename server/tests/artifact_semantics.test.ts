import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  validate_script_analysis_semantics,
  validate_shot_plan_semantics,
  validate_prompt_semantics,
  validate_run_artifact_links,
} from "../src/artifact_semantics.js";
import {
  hash_artifact_document,
  hash_run_context,
} from "../src/artifact_hash.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturePath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "shortdrama",
  "script_analysis.v2.json",
);

function fixture(): Record<string, any> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, any>;
}

function codes(document: unknown): string[] {
  return validate_script_analysis_semantics(document).map((error) => error.code);
}

describe("script analysis v2 semantics", () => {
  test("accepts a script-only analysis with one image placeholder per entity", () => {
    expect(validate_script_analysis_semantics(fixture())).toEqual([]);
  });

  test("reuses one scene entity across scenes without duplicating its asset", () => {
    const document = fixture();
    const sceneEntities = document.entities.filter(
      (entity: Record<string, unknown>) => entity.entity_type === "scene",
    );
    expect(sceneEntities).toHaveLength(1);
    expect(sceneEntities[0].source_scene_ids).toEqual(["ep01-sc01", "ep01-sc02"]);
    expect(
      document.reference_assets.filter(
        (asset: Record<string, any>) =>
          Array.isArray(asset.entity_ids) && asset.entity_ids.includes("scene-living-room"),
      ),
    ).toHaveLength(1);
  });

  test("does not invent a prop when the source has no key prop", () => {
    const document = fixture();
    document.entities = document.entities.filter(
      (entity: Record<string, unknown>) => entity.entity_type !== "prop",
    );
    document.reference_assets = document.reference_assets.filter(
      (asset: Record<string, any>) =>
        !asset.entity_ids.some((id: string) => id.startsWith("prop-")),
    );
    for (const scene of document.episodes[0].scenes) {
      for (const process of scene.processes) {
        process.entity_ids = process.entity_ids.filter((id: string) => !id.startsWith("prop-"));
      }
      for (const unit of [
        ...scene.action_units,
        ...scene.emotion_units,
        ...scene.dialogue_units,
      ]) {
        unit.entity_ids = unit.entity_ids.filter((id: string) => !id.startsWith("prop-"));
      }
    }
    expect(validate_script_analysis_semantics(document)).toEqual([]);
  });

  test("rejects unit and process IDs repeated across scenes", () => {
    const document = fixture();
    document.episodes[0].scenes[1].action_units[0].id = "ep01-sc01-a01";
    document.episodes[0].scenes[1].processes[0].process_id = "ep01-p01";
    expect(codes(document)).toContain("ID_DUPLICATE");
  });


  test("rejects duplicate entity and asset IDs", () => {
    const document = fixture();
    document.entities.push({ ...document.entities[0] });
    document.reference_assets.push({ ...document.reference_assets[0] });
    expect(codes(document)).toEqual(
      expect.arrayContaining(["ID_DUPLICATE", "ID_DUPLICATE"]),
    );
  });

  test("rejects unresolved entity and source scene references", () => {
    const document = fixture();
    document.episodes[0].scenes[0].action_units[0].entity_ids.push("missing-entity");
    document.entities[0].source_scene_ids.push("missing-scene");
    expect(codes(document)).toEqual(
      expect.arrayContaining(["REFERENCE_UNRESOLVED", "REFERENCE_UNRESOLVED"]),
    );
  });

  test("rejects an entity without its own image slot", () => {
    const document = fixture();
    document.reference_assets = document.reference_assets.filter(
      (asset: Record<string, any>) => asset.entity_ids[0] !== "prop-necklace",
    );
    const errors = validate_script_analysis_semantics(document);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: "REFERENCE_ASSET_INVALID",
        message: expect.stringContaining("prop-necklace"),
      }),
    );
  });

  test("rejects a group image as a substitute for independent entity slots", () => {
    const document = fixture();
    document.reference_assets = document.reference_assets.filter(
      (asset: Record<string, any>) => asset.asset_id !== "asset-character-b",
    );
    document.reference_assets[0].entity_ids = ["character-a", "character-b"];
    expect(codes(document)).toContain("REFERENCE_ASSET_INVALID");
  });


  test("rejects placeholder assets with a fabricated source", () => {
    const document = fixture();
    document.reference_assets[0].source = "C:/fake/character-a.png";
    expect(codes(document)).toContain("REFERENCE_ASSET_INVALID");
  });

  test("rejects provided assets without a source", () => {
    const document = fixture();
    document.reference_assets[0].status = "provided";
    delete document.reference_assets[0].source;
    expect(codes(document)).toContain("REFERENCE_ASSET_INVALID");
  });

  test("rejects action, emotion and dialogue units that are not grouped into a process", () => {
    const document = fixture();
    document.episodes[0].scenes[0].processes[0].action_unit_ids = [];
    const errors = validate_script_analysis_semantics(document);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_COVERAGE_INVALID",
        message: expect.stringContaining("ep01-sc01-a01"),
      }),
    );
  });

  test("rejects process entity references that are not resolved", () => {
    const document = fixture();
    document.episodes[0].scenes[0].processes[0].entity_ids.push("missing-process-entity");
    expect(codes(document)).toContain("REFERENCE_UNRESOLVED");
  });
});




const analysisPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "shortdrama",
  "script_analysis.v2.json",
);
const planPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "shortdrama",
  "shot_plan.v2.json",
);

function analysisFixture(): Record<string, any> {
  return JSON.parse(readFileSync(analysisPath, "utf8")) as Record<string, any>;
}

function planFixture(): Record<string, any> {
  return JSON.parse(readFileSync(planPath, "utf8")) as Record<string, any>;
}

const RULES_20 = {
  duration: { min_sec: 4, max_sec: 15 },
  reference_limits: { max_images: 9 },
  timeline: { required_in_prompt: false },
};
const RULES_25 = {
  duration: { min_sec: 4, max_sec: 30 },
  reference_limits: { max_images: 30 },
  timeline: { required_in_prompt: true },
};

function add_split_clip(
  plan: Record<string, any>,
  duration: number,
  dialogue: Record<string, any>[] = [],
): void {
  const first = plan.scenes[0].clips[0];
  const firstDialogue = dialogue.length === 0 ? first.dialogue : dialogue.slice(0, 1);
  const secondDialogue = dialogue.slice(1);

  first.duration_sec = duration;
  first.shots = [{ ...first.shots[0], start_sec: 0, end_sec: duration }];
  first.dialogue = firstDialogue.map((segment: Record<string, any>, index: number) => ({
    ...first.dialogue[index],
    ...segment,
    dialogue_segment_id: "ep01-sc01-d01-seg01",
    start_sec: 0,
    end_sec: Math.min(2, duration),
  }));
  first.audio.ambience[0].end_sec = duration;
  first.audio.sfx = [];

  const second = structuredClone(first);
  second.clip_id = "ep01-sc01-c02";
  second.order = 2;
  second.duration_sec = duration;
  second.continuity = {
    previous_clip_id: first.clip_id,
    enter_state: first.continuity.exit_state,
    exit_state: first.continuity.exit_state,
  };
  second.split_reason = "duration_limit";
  second.shots = [{
    ...second.shots[0],
    shot_id: "ep01-sc01-c02-s01",
    start_sec: 0,
    end_sec: duration,
    continuity: {
      enter_state: first.continuity.exit_state,
      exit_state: first.continuity.exit_state,
    },
  }];
  second.dialogue = secondDialogue.map((segment, index) => ({
    ...segment,
    dialogue_segment_id: `ep01-sc01-d01-seg${String(index + 2).padStart(2, "0")}`,
    start_sec: 0,
    end_sec: Math.min(2, duration),
  }));
  second.audio.ambience = [{
    ...first.audio.ambience[0],
    cue_id: "ep01-sc01-c02-amb01",
    start_sec: 0,
    end_sec: duration,
  }];
  plan.scenes[0].clips.push(second);
}

describe("shot plan v2 semantics", () => {
  test("accepts a ten-second four-shot clip for both models", () => {
    const plan = planFixture();
    const analysis = analysisFixture();
    expect(validate_shot_plan_semantics(plan, RULES_25, analysis)).toEqual([]);
    expect(validate_shot_plan_semantics(plan, RULES_20, analysis)).toEqual([]);
  });

  test("allows the same action source to span multiple internal shots", () => {
    const plan = planFixture();
    const clip = plan.scenes[0].clips[0];
    clip.shots[1].source_action_unit_ids = ["ep01-sc01-a01"];
    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture())).toEqual([]);
  });

  test("rejects timeline gaps, overlaps and out-of-order shots", () => {
    const gap = planFixture();
    gap.scenes[0].clips[0].shots[1].start_sec = 2.1;
    expect(validate_shot_plan_semantics(gap, RULES_25, analysisFixture()).map((e) => e.code))
      .toContain("TIMELINE_INVALID");

    const overlap = planFixture();
    overlap.scenes[0].clips[0].shots[1].start_sec = 1.9;
    expect(validate_shot_plan_semantics(overlap, RULES_25, analysisFixture()).map((e) => e.code))
      .toContain("TIMELINE_INVALID");

    const reverse = planFixture();
    reverse.scenes[0].clips[0].shots[1].end_sec = 1;
    expect(validate_shot_plan_semantics(reverse, RULES_25, analysisFixture()).map((e) => e.code))
      .toContain("TIMELINE_INVALID");
  });

  test("uses 0.001 second tolerance for internal shot boundaries", () => {
    const within = planFixture();
    within.scenes[0].clips[0].shots[1].start_sec = 2.0005;
    expect(validate_shot_plan_semantics(within, RULES_25, analysisFixture())).toEqual([]);

    const beyond = planFixture();
    beyond.scenes[0].clips[0].shots[1].start_sec = 2.002;
    expect(validate_shot_plan_semantics(beyond, RULES_25, analysisFixture()).map((e) => e.code))
      .toContain("TIMELINE_INVALID");
  });

  test("rejects duplicate shot IDs", () => {
    const plan = planFixture();
    plan.scenes[0].clips[0].shots[1].shot_id = plan.scenes[0].clips[0].shots[0].shot_id;
    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture()).map((e) => e.code))
      .toContain("ID_DUPLICATE");
  });

  test("requires a 20-second process to split for Seedance 2.0", () => {
    const plan = planFixture();
    const clip = plan.scenes[0].clips[0];
    clip.duration_sec = 20;
    clip.shots = [
      {
        ...clip.shots[0],
        start_sec: 0,
        end_sec: 20,
      },
    ];
    clip.audio.ambience[0].end_sec = 20;
    clip.audio.sfx = [];

    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture())).toEqual([]);
    expect(validate_shot_plan_semantics(plan, RULES_20, analysisFixture()).map((e) => e.code))
      .toContain("TIMELINE_INVALID");
  });

  test("accepts a 36-second process split into two 18-second clips with continuity", () => {
    const plan = planFixture();
    add_split_clip(plan, 18);
    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture())).toEqual([]);
  });

  test("allows a two-second action with a visible hold to reach the four-second lower bound", () => {
    const plan = planFixture();
    const clip = plan.scenes[0].clips[0];
    clip.duration_sec = 4;
    clip.shots = [
      { ...clip.shots[0], start_sec: 0, end_sec: 2 },
      {
        ...clip.shots[3],
        shot_id: "ep01-sc01-c01-s02",
        order: 2,
        start_sec: 2,
        end_sec: 4,
        source_action_unit_ids: ["ep01-sc01-a01"],
      },
    ];
    clip.audio.ambience[0].end_sec = 4;
    clip.audio.sfx = [];
    clip.dialogue[0].end_sec = 2;
    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture())).toEqual([]);
  });

  test("validates a long dialogue split across clips by UTF-16 offset coverage", () => {
    const analysis = analysisFixture();
    analysis.episodes[0].scenes[0].dialogue_units[0].text = "第一句。第二句。";
    const plan = planFixture();
    add_split_clip(plan, 18, [
      {
        dialogue_unit_id: "ep01-sc01-d01",
        speaker_id: "character-a",
        start_offset: 0,
        end_offset: 4,
      },
      {
        dialogue_unit_id: "ep01-sc01-d01",
        speaker_id: "character-a",
        start_offset: 4,
        end_offset: 8,
      },
    ]);
    expect(validate_shot_plan_semantics(plan, RULES_25, analysis)).toEqual([]);
  });

  test("rejects dialogue offsets that split a surrogate pair", () => {
    const analysis = analysisFixture();
    analysis.episodes[0].scenes[0].dialogue_units[0].text = "😀好";
    const plan = planFixture();
    add_split_clip(plan, 18, [
      {
        dialogue_unit_id: "ep01-sc01-d01",
        speaker_id: "character-a",
        start_offset: 0,
        end_offset: 1,
      },
      {
        dialogue_unit_id: "ep01-sc01-d01",
        speaker_id: "character-a",
        start_offset: 1,
        end_offset: 3,
      },
    ]);
    expect(validate_shot_plan_semantics(plan, RULES_25, analysis).map((e) => e.code))
      .toContain("SOURCE_COVERAGE_INVALID");
  });

  test("rejects dialogue time intervals outside the clip", () => {
    const plan = planFixture();
    plan.scenes[0].clips[0].dialogue[0].end_sec = 10.5;
    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture()).map((e) => e.code))
      .toContain("TIMELINE_INVALID");
  });


  test("validates ambience and sfx intervals and source refs", () => {
    const plan = planFixture();
    expect(validate_shot_plan_semantics(plan, RULES_25, analysisFixture())).toEqual([]);

    const out_of_bounds = planFixture();
    out_of_bounds.scenes[0].clips[0].audio.sfx[0].end_sec = 10.5;
    expect(
      validate_shot_plan_semantics(out_of_bounds, RULES_25, analysisFixture()).map(
        (e) => e.code,
      ),
    ).toContain("TIMELINE_INVALID");

    const dangling = planFixture();
    dangling.scenes[0].clips[0].audio.sfx[0].source_refs[0].id = "missing-unit";
    expect(
      validate_shot_plan_semantics(dangling, RULES_25, analysisFixture()).map((e) => e.code),
    ).toContain("SOURCE_COVERAGE_INVALID");
  });

  test("rejects a clip that exceeds the model image reference limit", () => {
    const analysis = analysisFixture();
    const plan = planFixture();
    const clip = plan.scenes[0].clips[0];
    for (let index = 0; index < 6; index += 1) {
      const asset_id = `asset-extra-${index}`;
      analysis.reference_assets.push({
        asset_id,
        media_type: "image",
        status: "placeholder",
        entity_ids: ["character-a"],
        adopt: ["面部"],
        exclude: ["背景"],
      });
      clip.reference_asset_ids.push(asset_id);
    }
    expect(validate_shot_plan_semantics(plan, RULES_20, analysis).map((e) => e.code))
      .toContain("REFERENCE_LIMIT_EXCEEDED");
  });
});







const promptPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "shortdrama",
  "prompts_ir.v2.json",
);

function promptFixture(): Record<string, any> {
  return JSON.parse(readFileSync(promptPath, "utf8")) as Record<string, any>;
}

function linkedDocuments(model: "seedance-2.0" | "seedance-2.5" = "seedance-2.5") {
  const run: Record<string, any> = {
    schema_version: 2,
    run_id: "run-20261026-120000",
    input_mode: "script_segment",
    project_id: "demo",
    target_model: model,
    aspect_ratio: "9:16",
    input_references: [],
    display_timeline: model === "seedance-2.5",
    warnings: [],
    stages: {
      script_breakdown: { status: "done", artifact: "script_analysis.json", updated_at: "2026-10-26T12:00:00+08:00" },
      shot_planning: { status: "done", artifact: "shot_plan.json", updated_at: "2026-10-26T12:01:00+08:00" },
      shot_prompting: { status: "done", artifact: "prompts.ir.json", updated_at: "2026-10-26T12:02:00+08:00" },
    },
  };
  const analysis = analysisFixture();
  analysis.target_model = model;
  analysis.input_hashes.run_context = hash_run_context(run);
  const plan = planFixture();
  plan.target_model = model;
  plan.input_hashes.script_analysis = hash_artifact_document(analysis);
  const prompt = promptFixture();
  prompt.target_model = model;
  prompt.display_timeline = model === "seedance-2.5";
  prompt.input_hashes = {
    script_analysis: hash_artifact_document(analysis),
    shot_plan: hash_artifact_document(plan),
  };
  return { run, analysis, plan, prompt };
}

describe("prompt IR v2 semantics", () => {
  test("accepts a valid multi-shot video prompt bound to plan and analysis", () => {
    expect(
      validate_prompt_semantics(promptFixture(), RULES_25, planFixture(), analysisFixture()),
    ).toEqual([]);
  });

  test("keeps stable asset IDs while local tags are unique and continuous per media type", () => {
    const prompt = promptFixture();
    const firstClipAsset = prompt.clips[0].reference_bindings[0];
    const secondClipAsset = prompt.clips[1].reference_bindings[0];
    expect(firstClipAsset.asset_id).toBe(secondClipAsset.asset_id);

    secondClipAsset.tag = prompt.clips[1].reference_bindings[1].tag;
    expect(
      validate_prompt_semantics(prompt, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("REFERENCE_ASSET_INVALID");
  });

  test("rejects a binding whose media type does not match the upstream asset", () => {
    const prompt = promptFixture();
    prompt.clips[0].reference_bindings[0].media_type = "video";
    expect(
      validate_prompt_semantics(prompt, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("REFERENCE_ASSET_INVALID");
  });

  test("rejects a missing entity binding and a fabricated asset", () => {
    const missing = promptFixture();
    missing.clips[1].reference_bindings = missing.clips[1].reference_bindings.filter(
      (binding: Record<string, unknown>) => binding.asset_id !== "asset-prop-necklace",
    );
    expect(
      validate_prompt_semantics(missing, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("REFERENCE_ASSET_INVALID");

    const fabricated = promptFixture();
    fabricated.clips[0].reference_bindings.push({
      asset_id: "asset-fabricated",
      media_type: "image",
      entity_ids: ["character-a"],
      tag: "@图片5",
      status: "provided",
      source: "input-fabricated",
      adopt: ["面部"],
      exclude: ["背景"],
    });
    expect(
      validate_prompt_semantics(fabricated, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("REFERENCE_UNRESOLVED");
  });

  test("requires display_timeline for Seedance 2.5 and allows either value for 2.0", () => {
    const invalid = promptFixture();
    invalid.display_timeline = false;
    expect(
      validate_prompt_semantics(invalid, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("TIMELINE_INVALID");

    const model20 = promptFixture();
    model20.target_model = "seedance-2.0";
    model20.display_timeline = false;
    const plan20 = planFixture();
    plan20.target_model = "seedance-2.0";
    expect(validate_prompt_semantics(model20, RULES_20, plan20, analysisFixture())).toEqual([]);
    model20.display_timeline = true;
    expect(validate_prompt_semantics(model20, RULES_20, plan20, analysisFixture())).toEqual([]);
  });

  test("rejects prompt structure that drifts from the plan or original dialogue slice", () => {
    const shotDrift = promptFixture();
    shotDrift.clips[0].shots[0].end_sec = 2.5;
    expect(
      validate_prompt_semantics(shotDrift, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("SOURCE_COVERAGE_INVALID");

    const dialogueDrift = promptFixture();
    dialogueDrift.clips[0].dialogue[0].text = "给你";
    expect(
      validate_prompt_semantics(dialogueDrift, RULES_25, planFixture(), analysisFixture()).map(
        (error) => error.code,
      ),
    ).toContain("SOURCE_COVERAGE_INVALID");
  });
});

describe("run artifact links", () => {
  test("accepts matching versions, identities, run context and content hashes", () => {
    const { run, analysis, plan, prompt } = linkedDocuments();
    expect(
      validate_run_artifact_links({
        run,
        script_analysis: analysis,
        shot_plan: plan,
        prompt_ir: prompt,
      }),
    ).toEqual([]);
  });

  test("rejects legacy and mixed artifact versions before semantic checks", () => {
    const { run, analysis, plan, prompt } = linkedDocuments();
    plan.schema_version = 1;
    expect(
      validate_run_artifact_links({
        run,
        script_analysis: analysis,
        shot_plan: plan,
        prompt_ir: prompt,
      }).map((error) => error.code),
    ).toContain("ARTIFACT_VERSION_UNSUPPORTED");
  });

  test("rejects action, entity and reference-duty edits even when IDs and times stay unchanged", () => {
    const { run, analysis, plan, prompt } = linkedDocuments();
    const editedAction = structuredClone(analysis);
    editedAction.episodes[0].scenes[0].action_units[0].description = "林岚把信封收回。";
    expect(
      validate_run_artifact_links({
        run,
        script_analysis: editedAction,
        shot_plan: plan,
        prompt_ir: prompt,
      }).map((error) => error.code),
    ).toContain("INPUT_HASH_MISMATCH");

    const editedEntity = structuredClone(analysis);
    editedEntity.entities[0].description = "不同服装描述。";
    expect(
      validate_run_artifact_links({
        run,
        script_analysis: editedEntity,
        shot_plan: plan,
        prompt_ir: prompt,
      }).map((error) => error.code),
    ).toContain("INPUT_HASH_MISMATCH");

    const editedReference = structuredClone(analysis);
    editedReference.reference_assets[0].adopt = ["服装"];
    expect(
      validate_run_artifact_links({
        run,
        script_analysis: editedReference,
        shot_plan: plan,
        prompt_ir: prompt,
      }).map((error) => error.code),
    ).toContain("INPUT_HASH_MISMATCH");
  });

  test("run input reference or timeline preference changes invalidate run context, while state changes do not", () => {
    const { run, analysis, plan, prompt } = linkedDocuments();
    const changedReferences = structuredClone(run);
    changedReferences.input_references = [{ asset_id: "asset-a", adopt: ["服装"] }];
    expect(
      validate_run_artifact_links({
        run: changedReferences,
        script_analysis: analysis,
        shot_plan: plan,
        prompt_ir: prompt,
      }).map((error) => error.code),
    ).toContain("INPUT_HASH_MISMATCH");

    const stateOnly = structuredClone(run);
    stateOnly.warnings = [{ code: "W", message: "status" }];
    stateOnly.stages.shot_prompting.status = "failed";
    expect(
      validate_run_artifact_links({
        run: stateOnly,
        script_analysis: analysis,
        shot_plan: plan,
        prompt_ir: prompt,
      }),
    ).toEqual([]);
  });

  test("rejects a plan/prompt clip order mismatch", () => {
    const { run, analysis, plan, prompt } = linkedDocuments();
    prompt.clips.reverse();
    expect(
      validate_run_artifact_links({
        run,
        script_analysis: analysis,
        shot_plan: plan,
        prompt_ir: prompt,
      }).map((error) => error.code),
    ).toContain("SOURCE_COVERAGE_INVALID");
  });
});
