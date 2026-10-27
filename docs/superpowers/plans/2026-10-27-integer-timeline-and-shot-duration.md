# Integer Timeline And Shot Duration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有 clip、shot、对白和 AudioCue 的时间边界统一为整数秒，并通过节拍估算和长镜头例外字段解决机械拉长镜头的问题。

**Architecture:** 保留现有 `process → clips[] → shots[]` 三阶段架构和七个运行文件。先在现有语义校验中建立整数秒硬约束，再增加可选的 `long_take_reason`，随后同步 PromptIR、渲染回归、Skills 和文档，不新增工具、阶段或依赖。

**Tech Stack:** TypeScript、Node.js 24、本地 MCP、Ajv、Vitest、Markdown Skills；不增加生产依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-integer-timeline-and-shot-duration-design.md`

## Global Constraints

- artifact 保持 `schema_version: 2`；不新增产物形态，不自动迁移旧 run。
- 所有 `clip.duration_sec`、shot / dialogue / AudioCue 的 `start_sec` 与 `end_sec` 必须使用整数秒。
- 时间字段在 JSON Schema 中继续使用 `type: number`，整数约束由 `server/src/artifact_semantics.ts` 的语义校验执行。
- 不允许自动四舍五入；发现小数时返回 `TIMELINE_INVALID`，回到 `shot-planning` 重做。
- 镜头时长超过 6 秒时，`long_take_reason` 必须是非空字符串；6 秒本身不需要。
- 每个 clip 的时长必须满足当前目标模型的 `min_sec..max_sec`；上限是约束，不是目标时长。
- clip 分批应优先落在自然边界；不得切出低于 `min_sec` 的尾段。
- 不新增阶段、MCP tool、数据库、服务端、外部服务或生产依赖。
- 面向人的文档和 Skill 使用中文；代码、标识符和路径使用英文。
- 不修改实际失败 run 的旧产物；实现完成后只在用户要求时从 `shot_planning` 重跑。
- 版本最终递增为 `0.2.2`，并同步 `plugin.json`、`server/package.json`、`server/package-lock.json` 和版本断言。

## Review Focus

1. **小数时间进入产物：** shot、对白或 AudioCue 带小数时，用户应得到 `TIMELINE_INVALID`，而不是静默取整；由 Task 1 和 Task 3 的测试覆盖。
2. **长镜头无说明或说明漂移：** 7 秒镜头缺少 `long_take_reason` 应失败，PromptIR 修改该字段应与上游不一致；由 Task 2 和 Task 3 覆盖。
3. **clip 分批留下非法尾段：** 2.5 的 `30+2` 或 2.0 的 `15+3` 不应通过；由 Task 1 的最小尾段测试和 Task 4 的 Skill 契约覆盖。
4. **对白跨 clip 或跨 shot 后 offset 失真：** 拼接必须逐字还原原文；由 Task 1 既有 offset 覆盖测试和 Task 3 的 PromptIR 一致性测试覆盖。
5. **渲染失败时覆盖旧文件：** 小数 PromptIR 被拒绝时，已有输出文件必须保持不变；由 Task 3 覆盖。

---

### Task 1: Enforce integer seconds in shot-plan semantics

**Files:**
- Modify: `server/src/artifact_semantics.ts`
- Modify: `server/tests/artifact_semantics.test.ts`
- Modify: `server/tests/validate_stage_artifact.test.ts`
- Modify: `tests/fixtures/shortdrama/shot_plan.v2.json`
- Modify: `tests/fixtures/shot_plan.sample.json`

**Interfaces:**
- Consumes: existing `validate_shot_plan_semantics(plan, rules, analysis?)` and `ArtifactSemanticError`.
- Produces: private helper `is_integer_second(value: unknown): boolean` in `server/src/artifact_semantics.ts`.
- Produces: `TIMELINE_INVALID` errors at the exact field path for fractional shot, dialogue and AudioCue times.
- Public MCP tool signatures do not change.

- [ ] **Step 1: Write failing shot-plan tests**

Add tests to `server/tests/artifact_semantics.test.ts` covering all shot-plan time layers. Use these exact paths and codes:

```ts
const analysis = analysisFixture();

const shotPlan = planFixture();
shotPlan.scenes[0].clips[0].shots[0].end_sec = 2.5;
expect(validate_shot_plan_semantics(shotPlan, RULES_25, analysis)).toContainEqual(
  expect.objectContaining({
    path: "scenes[0].clips[0].shots[0].end_sec",
    code: "TIMELINE_INVALID",
  }),
);

const dialoguePlan = planFixture();
dialoguePlan.scenes[0].clips[0].dialogue[0].end_sec = 2.5;
expect(validate_shot_plan_semantics(dialoguePlan, RULES_25, analysis)).toContainEqual(
  expect.objectContaining({
    path: "scenes[0].clips[0].dialogue[0].end_sec",
    code: "TIMELINE_INVALID",
  }),
);

const audioPlan = planFixture();
audioPlan.scenes[0].clips[0].audio.sfx[0].end_sec = 5.5;
expect(validate_shot_plan_semantics(audioPlan, RULES_25, analysis)).toContainEqual(
  expect.objectContaining({
    path: "scenes[0].clips[0].audio.sfx[0].end_sec",
    code: "TIMELINE_INVALID",
  }),
);
```

Update the existing gap/overlap tests to use integer values:

- gap: second shot `start_sec = 3` while previous end is `2`;
- overlap: second shot `start_sec = 1` while previous end is `2`;
- out-of-bounds dialogue/audio: use `end_sec = 11` for a 10-second clip.

Replace the old “0.001 second tolerance” test with a test asserting `2.0005` is rejected. Add tests that a second clip with duration `2` and local shot `0..2` is rejected under `RULES_25`, and a second clip with duration `3` and local shot `0..3` is rejected under `RULES_20`, because each tail is below the model `min_sec: 4`.

- [ ] **Step 2: Write a failing integration test**

Add to `server/tests/validate_stage_artifact.test.ts`:

```ts
test("rejects fractional shot timeline through the stage validator", () => {
  const edited = read_json(path.join(shortdramaDir, "shot_plan.v2.json"));
  edited.scenes[0].clips[0].shots[0].end_sec = 2.5;
  const result = validate_stage_artifact({
    stage: "shot_planning",
    path: write_temp(edited),
    script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
  });
  expect(result.ok).toBe(false);
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "TIMELINE_INVALID" }));
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/validate_stage_artifact.test.ts
```

Expected: the new fractional-time tests fail because the current validator accepts decimals.

- [ ] **Step 4: Implement integer checks and exact timeline comparisons**

In `server/src/artifact_semantics.ts`:

- Add `is_integer_second(value: unknown): boolean` returning `typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)`.
- In `validate_clip_timeline`, reject non-integer `start_sec` / `end_sec` with `TIMELINE_INVALID` at the exact field path.
- Compare integer shot continuity with exact equality (`start_sec !== previous_end`) and clip bounds with exact `end_sec > duration`.
- In `validate_dialogue_segments`, reject non-integer dialogue `start_sec` / `end_sec` and use exact clip bounds.
- In `validate_clip_audio`, reject non-integer cue `start_sec` / `end_sec` and use exact bounds and exact full-coverage checks.
- Keep `TIME_TOLERANCE_SEC` temporarily if PromptIR code still references it; it will be removed in Task 3.

Migrate the two shot-plan fixtures to integer seconds:

- `0.5..2.5` dialogue becomes `1..2`;
- `5.2..5.7` sfx becomes `5..6`;
- `3.4..5.6` dialogue becomes `3..6`.

Do not add automatic rounding to production code.

- [ ] **Step 5: Run targeted tests and verify they pass**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/validate_stage_artifact.test.ts
```

Expected: PASS, including all existing source-coverage and dialogue-offset tests.

- [ ] **Step 6: Commit**

Use PowerShell:

```powershell
git add server/src/artifact_semantics.ts server/tests/artifact_semantics.test.ts server/tests/validate_stage_artifact.test.ts tests/fixtures/shortdrama/shot_plan.v2.json tests/fixtures/shot_plan.sample.json
git commit -m "feat: enforce integer seconds in shot plans"
```

---

### Task 2: Add the long-take exception to shot plans

**Files:**
- Modify: `schemas/shot_plan.schema.json`
- Modify: `server/src/artifact_semantics.ts`
- Modify: `server/tests/artifact_semantics.test.ts`
- Modify: `server/tests/validate_stage_artifact.test.ts`

**Interfaces:**
- Consumes: Task 1 integer-second checks and `ArtifactSemanticError`.
- Produces: optional shot field `long_take_reason?: string` with `minLength: 1`.
- Produces: private `MAX_NORMAL_SHOT_SEC = 6` and `validate_shot_long_take_reason(...)` in `server/src/artifact_semantics.ts`.
- The condition is `durationSec > MAX_NORMAL_SHOT_SEC`; 6 seconds does not require a reason.

- [ ] **Step 1: Write failing long-take tests**

Add a helper in `server/tests/artifact_semantics.test.ts` named
`rebuildFirstClipWithFirstShotDuration(plan, durationSec)`. Set the first clip’s
shots to `0..durationSec`, `durationSec..durationSec+1`, `durationSec+1..durationSec+2`,
and `durationSec+2..10`. This keeps the clip duration at `10` while making the first
shot 6 or 7 seconds in the tests below.

Add these assertions:

```ts
const missing = planFixture();
rebuildFirstClipWithFirstShotDuration(missing, 7);
expect(validate_shot_plan_semantics(missing, RULES_25, analysisFixture())).toContainEqual(
  expect.objectContaining({
    path: "scenes[0].clips[0].shots[0].long_take_reason",
    code: "TIMELINE_INVALID",
  }),
);

const blank = planFixture();
rebuildFirstClipWithFirstShotDuration(blank, 7);
blank.scenes[0].clips[0].shots[0].long_take_reason = "   ";
expect(validate_shot_plan_semantics(blank, RULES_25, analysisFixture())).toContainEqual(
  expect.objectContaining({
    path: "scenes[0].clips[0].shots[0].long_take_reason",
    code: "TIMELINE_INVALID",
  }),
);

const allowed = planFixture();
rebuildFirstClipWithFirstShotDuration(allowed, 7);
allowed.scenes[0].clips[0].shots[0].long_take_reason = "连续跟拍角色走到床边，中间没有新信息点。";
expect(validate_shot_plan_semantics(allowed, RULES_25, analysisFixture())).toEqual([]);

const sixSeconds = planFixture();
rebuildFirstClipWithFirstShotDuration(sixSeconds, 6);
expect(validate_shot_plan_semantics(sixSeconds, RULES_25, analysisFixture())).toEqual([]);
```
Add `validate_stage_artifact` tests that write a 7-second shot without the field (expect `TIMELINE_INVALID`) and with a non-empty field (expect `ok: true`).

- [ ] **Step 2: Run the tests and verify they fail**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/validate_stage_artifact.test.ts
```

Expected: FAIL because the schema rejects the new optional field or the semantics do not check the reason.

- [ ] **Step 3: Implement the optional field and semantic rule**

In `schemas/shot_plan.schema.json`, add under `shot.properties`:

```json
"long_take_reason": { "type": "string", "minLength": 1 }
```

In `server/src/artifact_semantics.ts`:

- Add `MAX_NORMAL_SHOT_SEC = 6`.
- After validating shot start/end, compute the integer duration.
- If duration is greater than `MAX_NORMAL_SHOT_SEC` and `as_non_empty_string(shot.long_take_reason)` is undefined, push one `TIMELINE_INVALID` error at `shots[i].long_take_reason`.
- If duration is 6 or less, allow the field to be absent or present.

- [ ] **Step 4: Run targeted tests and verify they pass**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/validate_stage_artifact.test.ts
```

Expected: PASS for missing/allowed/6-second cases.

- [ ] **Step 5: Commit**

```powershell
git add schemas/shot_plan.schema.json server/src/artifact_semantics.ts server/tests/artifact_semantics.test.ts server/tests/validate_stage_artifact.test.ts
git commit -m "feat: require long-take reasons in shot plans"
```

---

### Task 3: Enforce PromptIR integer seconds, long-take parity, and render fail-closed behavior

**Files:**
- Modify: `schemas/prompt_ir.schema.json`
- Modify: `server/src/artifact_semantics.ts`
- Modify: `server/tests/artifact_semantics.test.ts`
- Modify: `server/tests/validate_prompt.test.ts`
- Modify: `server/tests/render_prompt.test.ts`
- Modify: `tests/fixtures/shortdrama/prompts_ir.v2.json`
- Modify: `tests/fixtures/prompts_ir.sample.json`
- Modify: `tests/fixtures/prompts/seedance-2.0.ir.json`
- Modify: `tests/fixtures/prompts/seedance-2.5.ir.json`
- Modify: `tests/fixtures/prompts/seedance-2.0.golden.md`
- Modify: `tests/fixtures/prompts/seedance-2.5.golden.md`

**Interfaces:**
- Consumes: Task 1 `is_integer_second`, Task 2 `MAX_NORMAL_SHOT_SEC`, and the optional `long_take_reason` field.
- Produces: PromptIR shot properties including `long_take_reason?: string` with `minLength: 1`.
- Produces: exact field-path `TIMELINE_INVALID` errors in `validate_prompt_shots`, `validate_prompt_dialogue`, and `validate_prompt_audio`.
- Produces: `compare_prompt_plan_structure` compares `long_take_reason` with `same_json`.
- Public MCP tool signatures do not change.

- [ ] **Step 1: Write failing PromptIR tests**

Add tests in `server/tests/artifact_semantics.test.ts`:

```ts
test("rejects fractional PromptIR shot, dialogue and audio times", () => {
  const shot = promptFixture();
  shot.clips[0].shots[0].end_sec = 2.5;
  expect(validate_prompt_semantics(shot, RULES_25)).toContainEqual(
    expect.objectContaining({
      path: "clips[0].shots[0].end_sec",
      code: "TIMELINE_INVALID",
    }),
  );

  const dialogue = promptFixture();
  dialogue.clips[0].dialogue[0].end_sec = 2.5;
  expect(validate_prompt_semantics(dialogue, RULES_25)).toContainEqual(
    expect.objectContaining({
      path: "clips[0].dialogue[0].end_sec",
      code: "TIMELINE_INVALID",
    }),
  );

  const audio = promptFixture();
  audio.clips[0].audio.sfx[0].end_sec = 5.5;
  expect(validate_prompt_semantics(audio, RULES_25)).toContainEqual(
    expect.objectContaining({
      path: "clips[0].audio.sfx[0].end_sec",
      code: "TIMELINE_INVALID",
    }),
  );
});
```

Add tests that a 7-second PromptIR shot without `long_take_reason` fails when no upstream plan is supplied, and that a 7-second shot with the field passes. Add a plan/prompt drift test where both are otherwise valid but the PromptIR `long_take_reason` differs; expect `SOURCE_COVERAGE_INVALID`.

Add to `server/tests/render_prompt.test.ts` a fail-closed test:

```ts
const output_path = temp_path();
writeFileSync(output_path, "KEEP", "utf8");
bad.clips[0].shots[0].end_sec = 2.5;
const result = render_prompt({ prompt_ir_path: write_ir(bad), output_path });
expect(result.ok).toBe(false);
expect(readFileSync(output_path, "utf8")).toBe("KEEP");
```

Update existing render assertions and both golden Markdown files:

- `0.5–2.5秒` becomes `1–2秒`;
- `5.2–5.7秒` becomes `5–6秒`;
- `3.4–5.6秒` becomes `3–6秒`.

- [ ] **Step 2: Run targeted tests and verify they fail**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/validate_prompt.test.ts tests/render_prompt.test.ts
```

Expected: the new fractional and long-take tests fail; rendering expectations may fail until fixtures are migrated.

- [ ] **Step 3: Implement PromptIR checks and schema field**

In `schemas/prompt_ir.schema.json`, add the same optional `long_take_reason` property under `shot.properties`.

In `server/src/artifact_semantics.ts`:

- In `validate_prompt_shots`, reject fractional start/end with exact paths, use exact continuity/bounds comparisons, and require `long_take_reason` when duration is greater than 6.
- In `validate_prompt_dialogue`, reject fractional start/end with exact paths and exact clip bounds.
- In `validate_prompt_audio`, reject fractional start/end with exact paths, exact clip bounds, and exact ambience/music coverage.
- Add `same_json(prompt_shot.long_take_reason, plan_shot.long_take_reason)` to `same_shot_decision`.
- Remove `TIME_TOLERANCE_SEC` after the last reference is replaced.

Migrate all PromptIR fixtures and existing prompt fixture variants to integer seconds. Replace remaining fractional test mutations with integer mismatches:

- `shotDrift.clips[0].shots[0].end_sec = 3` for plan/prompt drift;
- `shotGap.clips[0].shots[0].end_sec = 1` for the no-upstream timeline test;
- dialogue/audio out-of-bounds use `end_sec = 11` for a 10-second clip.

Do not add a conversion helper to the renderer.

- [ ] **Step 4: Run targeted tests and verify they pass**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/validate_prompt.test.ts tests/render_prompt.test.ts
```

Expected: PASS, including the fail-closed assertion that the pre-existing output file remains unchanged.

- [ ] **Step 5: Commit**

```powershell
git add schemas/prompt_ir.schema.json server/src/artifact_semantics.ts server/tests/artifact_semantics.test.ts server/tests/validate_prompt.test.ts server/tests/render_prompt.test.ts tests/fixtures/shortdrama/prompts_ir.v2.json tests/fixtures/prompts_ir.sample.json tests/fixtures/prompts/seedance-2.0.ir.json tests/fixtures/prompts/seedance-2.5.ir.json tests/fixtures/prompts/seedance-2.0.golden.md tests/fixtures/prompts/seedance-2.5.golden.md
git commit -m "feat: enforce integer prompt timelines"
```

---

### Task 4: Update Skills and documentation contracts

**Files:**
- Modify: `skills/shot-planning/SKILL.md`
- Modify: `skills/shot-prompting/SKILL.md`
- Modify: `skills/script2shot/SKILL.md`
- Modify: `docs/architecture.md`
- Modify: `references/stage-conventions.md`
- Modify: `docs/model-rules-notes.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-27-integer-timeline-and-shot-duration-design.md`
- Modify: `server/tests/skills_contract.test.ts`

**Interfaces:**
- Consumes: Task 1-3 behavior names and field names: `整数秒`, `long_take_reason`, `TIMELINE_INVALID`, `min_sec`, `max_sec`.
- Produces: Skill contract assertions that prevent the old “internal shot may use decimals” wording from returning.
- No runtime interface changes.

- [ ] **Step 1: Write failing Skill contract tests**

Extend the existing `planning documents clips, internal seconds and continuity` test in
`server/tests/skills_contract.test.ts` with:

```ts
const markdown = read("shot-planning");
expect(markdown).toContain("整数秒");
expect(markdown).toContain("节拍");
expect(markdown).toContain("long_take_reason");
expect(markdown).toContain("自然边界");
expect(markdown).toContain("min_sec");
expect(markdown).toContain("max_sec");
expect(markdown).toContain("本批 shot 整数时长之和");
expect(markdown).toContain("30+2");
expect(markdown).toContain("15+3");
expect(markdown).not.toContain("允许小数秒");
```

Extend the existing `prompting removes one-shot-per-prompt rules and documents five modules` test with:

```ts
const markdown = read("shot-prompting");
expect(markdown).toContain("整数秒");
expect(markdown).toContain("long_take_reason");
```


- [ ] **Step 2: Run the skill tests and verify they fail**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/skills_contract.test.ts
```

Expected: FAIL on the new integer/beat/long-take contract tokens.

- [ ] **Step 3: Update the Skills**

Update `skills/shot-planning/SKILL.md` to state:

- all clip, shot, dialogue and AudioCue times are integer seconds;
- the fixed planning order is beat estimation → integer shot durations → process shot sequence → capacity-aware clip partition → local clip timeline reset;
- the estimation table from the spec: Chinese/English speech rates, reaction/insert, simple/compound action, visible hold;
- dialogue over overlapping action uses `max`, not sum;
- one shot may contain multiple beats on the same setup; do not impose a fixed shot count;
- project knowledge or explicit user pacing can override the default speech-rate estimate;
- a shot longer than 6 seconds requires `long_take_reason`;
- clip partitions must use natural boundaries and ensure every clip is within `min_sec..max_sec`;
- `clip.duration_sec = 本批 shot 整数时长之和`;
- shots longer than 12 seconds must first be checked for a split at a natural boundary; if retained, the long-take reason remains required;
- the `30+2` / `15+3` tail examples;
- failure handling returns `TIMELINE_INVALID` and never auto-rounds.

Update `skills/shot-prompting/SKILL.md` to state:

- PromptIR copies integer shot, dialogue and AudioCue times unchanged;
- PromptIR copies `long_take_reason` from the plan;
- decimal times fail validation and must be fixed upstream;
- `long_take_reason` is planning metadata and need not be rendered in final Markdown.

Update `skills/script2shot/SKILL.md` only enough to say a clip is a batch of internal shots whose integer durations sum to the clip duration and must stay within the model range.

- [ ] **Step 4: Update authoritative docs**

Update:

- `docs/architecture.md` §3, §9.5, §11.4 and §13: replace “internal shot allows decimals” with integer-second rule; add the process shot sequence → clip partition order.
- `references/stage-conventions.md` §3, §5, §6 and §10: add integer invariant, `long_take_reason`, and capacity-aware clip partition.
- `docs/model-rules-notes.md` §1 and §3: cite the Seedance 2.5 prompt guide checked on 2026-10-27, distinguish official 2.5 integer timestamps from the plugin-wide integer rule, and remove “internal shot allows decimals”.
- `README.md`: add integer-second and beat-estimation wording.
- Change the design spec status from `Proposed` to `Approved`.

Do not add model-specific fixed shot counts or a new model rule file.

- [ ] **Step 5: Run skill tests and verify they pass**

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/skills_contract.test.ts
```

Expected: PASS; the old decimal wording is absent from `shot-planning`.

- [ ] **Step 6: Commit**

```powershell
git add skills/shot-planning/SKILL.md skills/shot-prompting/SKILL.md skills/script2shot/SKILL.md docs/architecture.md references/stage-conventions.md docs/model-rules-notes.md README.md docs/superpowers/specs/2026-10-27-integer-timeline-and-shot-duration-design.md server/tests/skills_contract.test.ts
git commit -m "docs: define integer timeline and beat planning"
```

---

### Task 5: Bump release version and run full verification

**Files:**
- Modify: `plugin.json`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Modify: `server/tests/plugin_manifest.test.ts`

**Interfaces:**
- Consumes: all Tasks 1-4.
- Produces: release `0.2.2` with matching manifest/package assertions.
- Does not rewrite `run-20261027-105658` artifacts.

- [ ] **Step 1: Write the failing version assertion**

Change the existing assertion in `server/tests/plugin_manifest.test.ts` from `0.2.1` to `0.2.2`.

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/plugin_manifest.test.ts
```

Expected: FAIL on the old manifest version.

- [ ] **Step 2: Update release versions**

Change the version to `0.2.2` in:

- `plugin.json`
- `server/package.json`
- `server/package-lock.json` (both top-level and root package version entries)

Run from `server/`:

```text
node node_modules/vitest/vitest.mjs run tests/plugin_manifest.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run from `server/`:

```text
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Run the full test suite**

Run from `server/`:

```text
npm test
```

Expected: build succeeds and all Vitest tests pass.

- [ ] **Step 5: Verify old-run fail-closed behavior**

Against `E:\视频提示词\.script2shot\outputs\run-20261027-105658`:

- call `validate_stage_artifact` for `shot_planning`; expected `ok: false` with `TIMELINE_INVALID` because the old artifact contains decimals;
- call `validate_prompt`; expected `ok: false` with `TIMELINE_INVALID`;
- do not modify or overwrite the old run.

If the old artifacts appear valid, stop and investigate the integer checks before accepting the implementation.

- [ ] **Step 6: Rerun acceptance scenario only after user approval**

After explicit approval to operate on the workspace:

- rerun `run-20261027-105658` from `shot_planning`;
- regenerate the prompt;
- verify all clip/shot/dialogue/AudioCue times are integers;
- verify every clip is within the model range;
- verify 7-second-or-longer shots have non-empty `long_take_reason`;
- verify dialogue offset coverage is unchanged and Markdown renders without decimals.

- [ ] **Step 7: Commit**

```powershell
git add plugin.json server/package.json server/package-lock.json server/tests/plugin_manifest.test.ts
git commit -m "chore: release script2shot 0.2.2"
```

## Self-Review

- Spec coverage: Tasks 1-3 implement integer hard constraints, long-take exceptions, PromptIR parity and render fail-closed behavior; Task 4 implements the beat estimator, clip partition and documentation contract; Task 5 covers release and old-run migration behavior.
- Type consistency: `is_integer_second`, `MAX_NORMAL_SHOT_SEC = 6`, `long_take_reason`, `validate_shot_plan_semantics`, `validate_prompt_semantics` and existing public tool signatures are named consistently across tasks.
- No new runtime interface: no new MCP tool, stage, artifact, database, or production dependency is introduced.
- Tests are placed with the code they validate; each task ends with a targeted passing command and a commit.
- Manual run rerun is explicitly separated from code changes and requires user approval.