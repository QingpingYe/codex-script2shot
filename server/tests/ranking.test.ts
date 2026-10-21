import { describe, expect, test } from "vitest";
import {
  assemble_context,
  card_passes_filters,
  compare_priority_rank,
  keyword_match_level,
  rank_matching_cards,
  type RankableCard,
} from "../src/ranking.js";

/**
 * `ranking` 纯函数（Task 4）测试。
 *
 * 只验证内存语义：过滤（`scope -> project_id -> category -> target_model`）、
 * 三级关键词命中与五级排序。模块本身不得读取文件系统或数据库，
 * 这里也不做任何落盘。
 */

function make_card(overrides: Partial<RankableCard> & { card_id: string }): RankableCard {
  return {
    scope: "general",
    project_id: null,
    category: "prompt_technique",
    title: "默认标题",
    content: "默认正文",
    tags: [],
    entities: [],
    target_models: [],
    priority: 5,
    updated_at: "2026-10-21T10:00:00+08:00",
    ...overrides,
  };
}

describe("ranking filters", () => {
  test("ranking filters by scope with positive and negative cases", () => {
    const general = make_card({ card_id: "card-general", scope: "general" });
    const project = make_card({ card_id: "card-project", scope: "project", project_id: "prj-1" });

    expect(card_passes_filters(general, { scope: "general" })).toBe(true);
    expect(card_passes_filters(project, { scope: "general" })).toBe(false);
    expect(card_passes_filters(project, { scope: "project" })).toBe(true);
    expect(card_passes_filters(general, { scope: "project" })).toBe(false);
    expect(card_passes_filters(general, {}), "未给过滤条件时全部放行").toBe(true);
  });

  test("ranking filters by project with positive and negative cases", () => {
    const prj_1 = make_card({ card_id: "card-prj-1", scope: "project", project_id: "prj-1" });
    const prj_2 = make_card({ card_id: "card-prj-2", scope: "project", project_id: "prj-2" });
    const general = make_card({ card_id: "card-general", project_id: null });

    expect(card_passes_filters(prj_1, { project_id: "prj-1" })).toBe(true);
    expect(card_passes_filters(prj_2, { project_id: "prj-1" })).toBe(false);
    expect(
      card_passes_filters(general, { project_id: "prj-1" }),
      "project_id 为 null 的通用卡不匹配具体项目",
    ).toBe(false);
  });

  test("ranking filters by category with positive and negative cases", () => {
    const technique = make_card({ card_id: "card-technique", category: "prompt_technique" });
    const scene = make_card({ card_id: "card-scene", category: "scene_description" });

    expect(card_passes_filters(technique, { categories: ["prompt_technique"] })).toBe(true);
    expect(card_passes_filters(scene, { categories: ["prompt_technique"] })).toBe(false);
    expect(
      card_passes_filters(scene, { categories: ["prompt_technique", "scene_description"] }),
    ).toBe(true);
    expect(card_passes_filters(scene, { categories: [] }), "空数组等价于不过滤").toBe(true);
  });

  test("ranking filters by target model with positive and negative cases", () => {
    const for_20 = make_card({ card_id: "card-20", target_models: ["seedance-2.0"] });
    const for_25 = make_card({ card_id: "card-25", target_models: ["seedance-2.5"] });
    const both = make_card({
      card_id: "card-both",
      target_models: ["seedance-2.0", "seedance-2.5"],
    });

    expect(card_passes_filters(for_20, { target_model: "seedance-2.0" })).toBe(true);
    expect(card_passes_filters(for_25, { target_model: "seedance-2.0" })).toBe(false);
    expect(card_passes_filters(for_25, { target_model: "seedance-2.5" })).toBe(true);
    expect(card_passes_filters(for_20, { target_model: "seedance-2.5" })).toBe(false);
    expect(card_passes_filters(both, { target_model: "seedance-2.5" })).toBe(true);
  });

  test("ranking treats empty and missing target models as universal", () => {
    const empty = make_card({ card_id: "card-empty", target_models: [] });
    const missing = make_card({ card_id: "card-missing", target_models: undefined });
    const null_models = make_card({ card_id: "card-null", target_models: null });

    for (const card of [empty, missing, null_models]) {
      expect(card_passes_filters(card, { target_model: "seedance-2.0" })).toBe(true);
      expect(card_passes_filters(card, { target_model: "seedance-2.5" })).toBe(true);
    }
  });
});

describe("keyword match levels", () => {
  test("keyword match level 1 covers exact title and exact entity matches", () => {
    const exact_title = make_card({ card_id: "card-title", title: "夜景布光" });
    const exact_entity = make_card({
      card_id: "card-entity",
      title: "光源手册",
      entities: ["夜景布光"],
    });
    const unmatched = make_card({ card_id: "card-none", title: "无关标题", content: "完全无关" });

    expect(keyword_match_level(exact_title, "夜景布光")).toBe(1);
    expect(keyword_match_level(exact_entity, "夜景布光")).toBe(1);
    expect(keyword_match_level(unmatched, "夜景布光")).toBeNull();
  });

  test("keyword match level 2 covers partial title and tag matches", () => {
    const partial_title = make_card({ card_id: "card-partial", title: "夜景布光基础" });
    const tagged = make_card({ card_id: "card-tag", title: "光线笔记", tags: ["布光"] });
    const content_only = make_card({
      card_id: "card-content",
      title: "光线笔记",
      content: "这里提到布光的小技巧",
    });

    expect(keyword_match_level(partial_title, "布光")).toBe(2);
    expect(keyword_match_level(tagged, "布光")).toBe(2);
    expect(
      keyword_match_level(content_only, "布光"),
      "正文命中是第 3 级，不提前到第 2 级",
    ).toBe(3);
  });

  test("keyword match level 3 covers content matches", () => {
    const content_only = make_card({
      card_id: "card-content",
      title: "运镜笔记",
      tags: ["镜头"],
      entities: ["角色A"],
      content: "正文里提到运动镜头",
    });
    const unmatched = make_card({ card_id: "card-none", title: "运镜笔记", content: "正文" });

    expect(keyword_match_level(content_only, "运动镜头")).toBe(3);
    expect(keyword_match_level(unmatched, "运动镜头")).toBeNull();
  });

  test("keyword matching normalizes case width and whitespace on both sides", () => {
    const title = make_card({ card_id: "card-title", title: "  Ｎｉｇｈｔ　　布光 " });
    const entity = make_card({
      card_id: "card-entity",
      title: "无关标题",
      entities: ["NIGHT 布光"],
    });
    const tagged = make_card({ card_id: "card-tag", title: "无关标题", tags: ["DAY 布光"] });

    expect(keyword_match_level(title, "night 布光")).toBe(1);
    expect(keyword_match_level(entity, "ｎｉｇｈｔ　布光")).toBe(1);
    expect(keyword_match_level(tagged, "布光")).toBe(2);
  });

  test("keyword matching returns null for blank queries and unmatched cards", () => {
    const card = make_card({ card_id: "card-1", title: "标题" });

    expect(keyword_match_level(card, "")).toBeNull();
    expect(keyword_match_level(card, "   ")).toBeNull();
    expect(keyword_match_level(card, "不存在的关键词")).toBeNull();
  });
});

describe("ranking order", () => {
  test("rank_matching_cards applies filters then returns level ordered matches", () => {
    const cards: RankableCard[] = [
      make_card({ card_id: "card-exact-low", title: "夜景布光", priority: 1 }),
      make_card({
        card_id: "card-exact-high",
        title: "无关标题",
        entities: ["夜景布光"],
        priority: 9,
      }),
      make_card({ card_id: "card-partial", title: "夜景布光补充", priority: 99 }),
      make_card({
        card_id: "card-content",
        title: "无关标题",
        content: "正文提到夜景布光",
        priority: 99,
      }),
      make_card({ card_id: "card-none", title: "无关标题", content: "完全无关" }),
      make_card({
        card_id: "card-filtered",
        title: "夜景布光",
        scope: "project",
        project_id: "prj-9",
      }),
    ];

    const ranked = rank_matching_cards(cards, { scope: "general" }, "夜景布光");

    expect(ranked.map((entry) => entry.card.card_id)).toEqual([
      "card-exact-high",
      "card-exact-low",
      "card-partial",
      "card-content",
    ]);
    expect(ranked.map((entry) => entry.match_level)).toEqual([1, 1, 2, 3]);
  });

  test("compare_priority_rank sorts by priority then updated at then card id", () => {
    const cards: RankableCard[] = [
      make_card({
        card_id: "card-p7-new",
        priority: 7,
        updated_at: "2026-10-21T12:00:00+08:00",
      }),
      make_card({
        card_id: "card-p9-old-b",
        priority: 9,
        updated_at: "2026-10-21T10:00:00+08:00",
      }),
      make_card({
        card_id: "card-p9-new",
        priority: 9,
        updated_at: "2026-10-21T11:00:00+08:00",
      }),
      make_card({
        card_id: "card-p9-old-a",
        priority: 9,
        updated_at: "2026-10-21T10:00:00+08:00",
      }),
    ];

    const sorted = [...cards].sort(compare_priority_rank).map((card) => card.card_id);
    expect(sorted).toEqual([
      "card-p9-new",
      "card-p9-old-a",
      "card-p9-old-b",
      "card-p7-new",
    ]);
    expect(
      [...cards].reverse().sort(compare_priority_rank).map((card) => card.card_id),
      "排序与输入顺序无关",
    ).toEqual(sorted);
  });

  test("assemble_context concatenates card contents without source annotations", () => {
    expect(assemble_context([])).toBe("");
    expect(assemble_context(["内容一"])).toBe("内容一");
    expect(assemble_context(["内容一", "内容二"])).toBe("内容一\n\n内容二");
  });
});
