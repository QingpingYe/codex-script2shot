import type { SyncState } from "./base_mapping.js";
import type { ScannedNode } from "./tools/scan_knowledge_a.js";

/**
 * 变化分类纯函数（架构 §6.1、§6.2；brief Task 3 Step 3）。
 *
 * - 输入输出都是普通对象，不做任何 I/O；调用方传入 `scan_knowledge_a` 的节点和
 *   `read_sync_state` 的记录。
 * - 判定按固定优先级：SyncState 有、当前节点列表没有 ⇒ 删除；节点有、SyncState
 *   没有 ⇒ 新增；`obj_edit_time` 不同 ⇒ 修改（即使同时移动/改名）；`obj_edit_time`
 *   相同但 `path` 或 `title` 不同 ⇒ 移动/改名（只更新元数据）；其余 ⇒ 未变化。
 * - 结果直接用作整批 dry-run 确认清单：每条含 `source_doc_token` /
 *   `source_node_token` / `title` / `path` / `reason`；`reason` 面向人工确认展示。
 */

export interface SyncPlanItem {
  source_doc_token: string;
  source_node_token: string;
  title: string;
  path: string;
  reason: string;
}

export interface SyncPlanWarning {
  code: "DUPLICATE_SCAN_NODE" | "DUPLICATE_SYNC_STATE";
  message: string;
  source_doc_token: string;
}

export interface SyncPlan {
  to_add: SyncPlanItem[];
  to_update: SyncPlanItem[];
  to_move: SyncPlanItem[];
  to_delete: SyncPlanItem[];
  unchanged: SyncPlanItem[];
  warnings: SyncPlanWarning[];
}

const REASON_ADD = "新增文档：不在 SyncState 中。";
const REASON_UPDATE = "内容已修改：obj_edit_time 与 SyncState 不同。";
const REASON_MOVE = "仅移动或改名：path 或 title 不同，只更新元数据。";
const REASON_DELETE = "文档已移除：不在本次扫描结果中。";
const REASON_UNCHANGED = "未变化：obj_edit_time 与元数据都相同。";

export function build_sync_plan(
  nodes: readonly ScannedNode[],
  sync_records: readonly SyncState[],
): SyncPlan {
  const plan: SyncPlan = {
    to_add: [],
    to_update: [],
    to_move: [],
    to_delete: [],
    unchanged: [],
    warnings: [],
  };

  const nodes_by_doc = new Map<string, ScannedNode>();
  for (const node of nodes) {
    const previous = nodes_by_doc.get(node.obj_token);
    if (previous !== undefined) {
      plan.warnings.push({
        code: "DUPLICATE_SCAN_NODE",
        source_doc_token: node.obj_token,
        message:
          `扫描结果中文档 ${node.obj_token} 出现多次（${previous.path}、${node.path}）；` +
          `只按第一条分类，请确认知识库 A 中的重复节点。`,
      });
      continue;
    }
    nodes_by_doc.set(node.obj_token, node);
  }

  const state_by_doc = new Map<string, SyncState>();
  for (const record of sync_records) {
    const previous = state_by_doc.get(record.source_doc_token);
    if (previous !== undefined) {
      plan.warnings.push({
        code: "DUPLICATE_SYNC_STATE",
        source_doc_token: record.source_doc_token,
        message:
          `SyncState 中 source_doc_token=${record.source_doc_token} 有多条记录` +
          `（${previous.source_path}、${record.source_path}）；只按第一条分类，` +
          `请人工清理重复的 SyncState 记录。`,
      });
      continue;
    }
    state_by_doc.set(record.source_doc_token, record);
  }

  for (const node of nodes_by_doc.values()) {
    const state = state_by_doc.get(node.obj_token);
    if (state === undefined) {
      plan.to_add.push(from_node(node, REASON_ADD));
      continue;
    }
    // 优先级 3：正文有变化时按修改处理，不因为同时移动/改名降级为 to_move。
    if (state.obj_edit_time !== node.obj_edit_time) {
      plan.to_update.push(from_node(node, REASON_UPDATE));
      continue;
    }
    if (state.source_path !== node.path || state.source_title !== node.title) {
      plan.to_move.push(from_node(node, REASON_MOVE));
      continue;
    }
    plan.unchanged.push(from_node(node, REASON_UNCHANGED));
  }

  for (const state of state_by_doc.values()) {
    if (nodes_by_doc.has(state.source_doc_token)) {
      continue;
    }
    plan.to_delete.push({
      source_doc_token: state.source_doc_token,
      source_node_token: state.source_node_token,
      title: state.source_title,
      path: state.source_path,
      reason: REASON_DELETE,
    });
  }

  return plan;
}

function from_node(node: ScannedNode, reason: string): SyncPlanItem {
  return {
    source_doc_token: node.obj_token,
    source_node_token: node.node_token,
    title: node.title,
    path: node.path,
    reason,
  };
}
