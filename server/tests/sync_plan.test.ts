import { describe, expect, test } from "vitest";
import type { SyncState } from "../src/base_mapping.js";
import { build_sync_plan } from "../src/sync_plan.js";

/**
 * 变化分类夹具（brief Step 1 矩阵）：
 * - 扫描结果里出现：新增、修改、仅移动、仅改名、修改+移动、未变化；
 * - 只在 SyncState 里出现（shortcut / 非 docx / 未映射根节点在扫描阶段被跳过，
 *   或文档已删除）：均在分类时归入 to_delete。
 * 这里只构造普通对象，分类函数本身不做任何 I/O。
 */

interface NodeFixture {
  node_token: string;
  obj_token: string;
  obj_type: string;
  parent_node_token: string;
  title: string;
  obj_edit_time: string;
  path: string;
  scope: "general" | "project";
  project_id: string | null;
}

const GENERAL_ROOT = "通用知识";

function node(
  overrides: Partial<NodeFixture> &
    Pick<NodeFixture, "node_token" | "obj_token" | "title" | "path" | "obj_edit_time">,
): NodeFixture {
  return {
    obj_type: "docx",
    parent_node_token: "",
    scope: "general",
    project_id: null,
    ...overrides,
  };
}

function state(overrides: Partial<SyncState> & Pick<SyncState, "source_doc_token">): SyncState {
  return {
    source_node_token: `wikcn-${overrides.source_doc_token}`,
    source_path: `${GENERAL_ROOT}/${overrides.source_doc_token}`,
    source_title: overrides.source_doc_token,
    scope: "general",
    project_id: null,
    obj_edit_time: "1000",
    source_revision: 1,
    card_count: 1,
    last_synced_at: "2026-10-20T12:00:00+08:00",
    last_sync_user: "测试用户",
    last_run_id: "sync-test",
    ...overrides,
  };
}

const MATRIX = {
  nodes: [
    node({
      node_token: "wikcn-new",
      obj_token: "doc-new",
      title: "新增文档",
      path: "通用知识/新增文档",
      obj_edit_time: "1000",
    }),
    node({
      node_token: "wikcn-edit",
      obj_token: "doc-edit",
      title: "修改文档",
      path: "通用知识/修改文档",
      obj_edit_time: "2100",
    }),
    node({
      node_token: "wikcn-move",
      obj_token: "doc-move",
      title: "移动文档",
      path: "通用知识/新目录/移动文档",
      obj_edit_time: "3000",
    }),
    node({
      node_token: "wikcn-rename",
      obj_token: "doc-rename",
      title: "改名后的标题",
      path: "通用知识/改名文档",
      obj_edit_time: "4000",
    }),
    node({
      node_token: "wikcn-edit-move",
      obj_token: "doc-edit-move",
      title: "修改并移动",
      path: "通用知识/新路径/修改并移动",
      obj_edit_time: "5500",
    }),
    node({
      node_token: "wikcn-same",
      obj_token: "doc-same",
      title: "未变化文档",
      path: "通用知识/未变化文档",
      obj_edit_time: "6000",
    }),
  ],
  states: [
    state({
      source_doc_token: "doc-edit",
      source_node_token: "wikcn-edit",
      source_path: "通用知识/修改文档",
      source_title: "修改文档",
      obj_edit_time: "2000",
    }),
    state({
      source_doc_token: "doc-move",
      source_node_token: "wikcn-move",
      source_path: "通用知识/旧目录/移动文档",
      source_title: "移动文档",
      obj_edit_time: "3000",
    }),
    state({
      source_doc_token: "doc-rename",
      source_node_token: "wikcn-rename",
      source_path: "通用知识/改名文档",
      source_title: "改名前的标题",
      obj_edit_time: "4000",
    }),
    state({
      source_doc_token: "doc-edit-move",
      source_node_token: "wikcn-edit-move",
      source_path: "通用知识/旧路径/修改并移动",
      source_title: "修改并移动",
      obj_edit_time: "5000",
    }),
    state({
      source_doc_token: "doc-same",
      source_node_token: "wikcn-same",
      source_path: "通用知识/未变化文档",
      source_title: "未变化文档",
      obj_edit_time: "6000",
    }),
    state({
      source_doc_token: "doc-shortcut",
      source_node_token: "wikcn-shortcut",
      source_path: "通用知识/旧版镜头语言",
      source_title: "旧版镜头语言（快捷方式）",
      obj_edit_time: "7000",
    }),
    state({
      source_doc_token: "doc-file",
      source_node_token: "wikcn-file",
      source_path: "通用知识/Seedance 指南.pdf",
      source_title: "Seedance 指南.pdf",
      obj_edit_time: "8000",
    }),
    state({
      source_doc_token: "doc-unmapped",
      source_node_token: "wikcn-unmapped",
      source_path: "未映射项目知识/项目概述",
      source_title: "未映射项目概述",
      scope: "project",
      project_id: "unmapped",
      obj_edit_time: "9000",
    }),
  ],
};

function tokens(items: ReadonlyArray<{ source_doc_token: string }>): string[] {
  return items.map((item) => item.source_doc_token);
}

describe("sync_plan", () => {
  test("classify detects every change kind", () => {
    const plan = build_sync_plan(MATRIX.nodes, MATRIX.states);

    expect(tokens(plan.to_add)).toEqual(["doc-new"]);
    expect(tokens(plan.to_update)).toEqual(["doc-edit", "doc-edit-move"]);
    expect(tokens(plan.to_move)).toEqual(["doc-move", "doc-rename"]);
    expect(tokens(plan.to_delete)).toEqual(["doc-shortcut", "doc-file", "doc-unmapped"]);
    expect(tokens(plan.unchanged)).toEqual(["doc-same"]);
    expect(plan.warnings).toEqual([]);

    expect(plan.to_add[0]).toEqual({
      source_doc_token: "doc-new",
      source_node_token: "wikcn-new",
      title: "新增文档",
      path: "通用知识/新增文档",
      reason: expect.any(String),
    });
  });

  test("classify treats edit plus move as update", () => {
    const nodes = [
      node({
        node_token: "wikcn-edit-move",
        obj_token: "doc-edit-move",
        title: "修改并移动",
        path: "通用知识/新路径/修改并移动",
        obj_edit_time: "5500",
      }),
    ];
    const states = [
      state({
        source_doc_token: "doc-edit-move",
        source_node_token: "wikcn-edit-move",
        source_path: "通用知识/旧路径/修改并移动",
        source_title: "修改并移动",
        obj_edit_time: "5000",
      }),
    ];

    const plan = build_sync_plan(nodes, states);

    expect(tokens(plan.to_update)).toEqual(["doc-edit-move"]);
    expect(plan.to_move).toEqual([]);
    expect(plan.to_update[0].reason).toContain("obj_edit_time");
  });

  test("classify treats move or rename as metadata only", () => {
    const nodes = [
      node({
        node_token: "wikcn-move",
        obj_token: "doc-move",
        title: "移动文档",
        path: "通用知识/新目录/移动文档",
        obj_edit_time: "3000",
      }),
      node({
        node_token: "wikcn-rename",
        obj_token: "doc-rename",
        title: "改名后的标题",
        path: "通用知识/改名文档",
        obj_edit_time: "4000",
      }),
    ];
    const states = [
      state({
        source_doc_token: "doc-move",
        source_node_token: "wikcn-move",
        source_path: "通用知识/旧目录/移动文档",
        source_title: "移动文档",
        obj_edit_time: "3000",
      }),
      state({
        source_doc_token: "doc-rename",
        source_node_token: "wikcn-rename",
        source_path: "通用知识/改名文档",
        source_title: "改名前的标题",
        obj_edit_time: "4000",
      }),
    ];

    const plan = build_sync_plan(nodes, states);

    expect(tokens(plan.to_move)).toEqual(["doc-move", "doc-rename"]);
    expect(plan.to_update).toEqual([]);
    expect(plan.unchanged).toEqual([]);
    for (const item of plan.to_move) {
      expect(item.reason).toContain("只更新元数据");
    }
  });

  test("classify reports deleted docs missing from scan", () => {
    const plan = build_sync_plan([], MATRIX.states);

    expect(tokens(plan.to_delete)).toEqual([
      "doc-edit",
      "doc-move",
      "doc-rename",
      "doc-edit-move",
      "doc-same",
      "doc-shortcut",
      "doc-file",
      "doc-unmapped",
    ]);
    expect(plan.to_add).toEqual([]);
    expect(plan.to_update).toEqual([]);
    expect(plan.to_move).toEqual([]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.to_delete[0]).toEqual({
      source_doc_token: "doc-edit",
      source_node_token: "wikcn-edit",
      title: "修改文档",
      path: "通用知识/修改文档",
      reason: expect.stringContaining("不在本次扫描结果"),
    });
  });

  test("sync plan lists counts for batch confirmation", () => {
    const plan = build_sync_plan(MATRIX.nodes, MATRIX.states);

    const counts = {
      to_add: plan.to_add.length,
      to_update: plan.to_update.length,
      to_move: plan.to_move.length,
      to_delete: plan.to_delete.length,
      unchanged: plan.unchanged.length,
    };

    expect(counts).toEqual({
      to_add: 1,
      to_update: 2,
      to_move: 2,
      to_delete: 3,
      unchanged: 1,
    });
    const all_items = [
      ...plan.to_add,
      ...plan.to_update,
      ...plan.to_move,
      ...plan.to_delete,
      ...plan.unchanged,
    ];
    // 每个文档只出现一次：6 个扫描节点 + 3 条只存在于 SyncState 的记录。
    expect(all_items).toHaveLength(9);
    for (const item of all_items) {
      expect(item.source_doc_token).not.toBe("");
      expect(item.reason).not.toBe("");
    }
  });

  test("sync plan warns when the same document appears twice in the input", () => {
    const duplicated_node = node({
      node_token: "wikcn-dup",
      obj_token: "doc-dup",
      title: "重复文档",
      path: "通用知识/重复文档",
      obj_edit_time: "1000",
    });
    const duplicated_state = state({
      source_doc_token: "doc-dup",
      source_node_token: "wikcn-dup",
      source_path: "通用知识/重复文档",
      source_title: "重复文档",
      obj_edit_time: "1000",
    });

    const plan = build_sync_plan(
      [duplicated_node, { ...duplicated_node, path: "通用知识/另一处/重复文档" }],
      [duplicated_state, { ...duplicated_state, source_path: "通用知识/旧记录" }],
    );

    // 重复项只按第一条分类，避免同一文档被处理两次。
    expect(tokens(plan.unchanged)).toEqual(["doc-dup"]);
    expect(plan.to_add).toEqual([]);
    expect(plan.to_delete).toEqual([]);
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      "DUPLICATE_SCAN_NODE",
      "DUPLICATE_SYNC_STATE",
    ]);
    for (const warning of plan.warnings) {
      expect(warning.source_doc_token).not.toBe("");
      expect(warning.message).not.toBe("");
    }
  });
});
