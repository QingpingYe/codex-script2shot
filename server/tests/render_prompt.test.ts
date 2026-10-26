import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { render_prompt } from "../src/tools/render_prompt.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = path.join(repoRoot, "tests", "fixtures");
const shortdramaDir = path.join(fixturesDir, "shortdrama");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp_path(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "script2shot-render-v2-"));
  tempDirs.push(dir);
  return path.join(dir, "prompts.md");
}

function read_json(file_path: string): Record<string, any> {
  return JSON.parse(readFileSync(file_path, "utf8")) as Record<string, any>;
}

function write_ir(value: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "script2shot-render-ir-"));
  tempDirs.push(dir);
  const file_path = path.join(dir, "prompts.ir.json");
  writeFileSync(file_path, JSON.stringify(value, null, 2), "utf8");
  return file_path;
}

function render_fixture(prompt: Record<string, any>): string {
  const output_path = temp_path();
  const tempDir = path.dirname(output_path);
  const plan = read_json(path.join(shortdramaDir, "shot_plan.v2.json"));
  const analysis = read_json(path.join(shortdramaDir, "script_analysis.v2.json"));
  plan.target_model = prompt.target_model;
  analysis.target_model = prompt.target_model;
  const planPath = path.join(tempDir, "shot_plan.json");
  const analysisPath = path.join(tempDir, "script_analysis.json");
  writeFileSync(planPath, JSON.stringify(plan), "utf8");
  writeFileSync(analysisPath, JSON.stringify(analysis), "utf8");
  const result = render_prompt({
    prompt_ir_path: write_ir(prompt),
    output_path,
    shot_plan_path: planPath,
    script_analysis_path: analysisPath,
  });
  expect(result).toMatchObject({ ok: true, output_path });
  return readFileSync(output_path, "utf8");
}

describe("render prompt v2", () => {
  test("renders one five-module prompt per video for Seedance 2.5", () => {
    const markdown = render_fixture(read_json(path.join(shortdramaDir, "prompts_ir.v2.json")));
    expect(markdown.match(/^## 视频 /gm)).toHaveLength(2);
    for (const label of ["生成目标", "参考素材职责", "主体与关系", "事件脚本", "保持一致"]) {
      expect(markdown).toContain(`【${label}】`);
    }
    expect(markdown).toContain("0–2秒：");
    expect(markdown).toContain("5.2–5.7秒：音效：<信封交接时纸张轻响。>");
    expect(markdown).toContain("@图片1（待提供：林岚参考图）");
    expect(markdown).toContain("0.5–2.5秒：林岚说：{给你。}");
    expect(markdown.match(/给你。/g)).toHaveLength(1);
  });

  test("Seedance 2.0 omits timestamps by default and shows them when enabled", () => {
    const prompt = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    prompt.target_model = "seedance-2.0";
    prompt.display_timeline = false;
    const no_timeline = render_fixture(prompt);
    expect(no_timeline).toContain("镜头1：中景，平视，固定");
    expect(no_timeline).not.toContain("0–2秒：");
    expect(no_timeline).not.toContain("0.5–2.5秒：");
    prompt.display_timeline = true;
    const timeline = render_fixture(prompt);
    expect(timeline).toContain("0–2秒：");
  });

  test("does not create or overwrite output when validation fails", () => {
    const bad = read_json(path.join(shortdramaDir, "prompts_ir.v2.json"));
    bad.clips[0].duration_sec = 3;
    const output_path = temp_path();
    const result = render_prompt({
      prompt_ir_path: write_ir(bad),
      output_path,
      shot_plan_path: path.join(shortdramaDir, "shot_plan.v2.json"),
      script_analysis_path: path.join(shortdramaDir, "script_analysis.v2.json"),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(output_path)).toBe(false);
  });
});
