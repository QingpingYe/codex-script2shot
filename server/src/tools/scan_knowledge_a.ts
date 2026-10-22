import path from "node:path";
import type { KnowledgeScope } from "../base_mapping.js";
import { CONFIG_FILE_NAME, load_config, resolve_home } from "../config.js";
import {
  resolve_lark_cli,
  run_cli,
  STDERR_LIMIT,
  type LarkCliErrorCode,
} from "../lark_cli.js";

/**
 * `scan_knowledge_a` 工具（架构 §4.4、§6.1、§8）。
 *
 * - 只读：全程只发 `wiki nodes list`（Risk=read）的原始 API 调用，不读正文、不写
 *   原始库。
 * - 固定 `--page-size 50` 手动翻页 + BFS；不使用 `--page-all`（有上限），也不使用
 *   快捷命令 `wiki +node-list`（输出被裁剪，实测不含 `obj_edit_time`）。
 * - scope / project_id 按架构 §4.4：根节点标题为「通用知识」⇒ scope=general；
 *   其他 origin docx 根节点 ⇒ scope=project + `project_roots` 中的 project_id；
 *   未映射根节点、shortcut、非 docx 节点跳过并写 warning，不中断扫描。
 * - 返回值一律是结果对象，不抛异常；错误码为 SCREAMING_SNAKE。
 */

export const GENERAL_ROOT_TITLE = "通用知识";
/** `wiki nodes list` 单页上限（2026-10-21 `--help`：max 50）。 */
export const WIKI_PAGE_SIZE = 50;

export type ScanKnowledgeAErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "SCAN_FAILED";

export type ScanSkipCode =
  | "NON_DOC_NODE_SKIPPED"
  | "SHORTCUT_NODE_SKIPPED"
  | "UNMAPPED_ROOT_NODE_SKIPPED";

/** 扫描得到的可同步文档；`path` 只用作文档在原始库中的展示路径。 */
export interface ScannedNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  parent_node_token: string;
  title: string;
  obj_edit_time: string;
  path: string;
  scope: KnowledgeScope;
  project_id: string | null;
}

export interface ScanWarning {
  code: ScanSkipCode;
  message: string;
  node_token: string;
  title: string;
  path: string;
}

export interface SkippedNode {
  node_token: string;
  title: string;
  path: string;
  reason: ScanSkipCode;
}

export interface ScanKnowledgeASuccess {
  nodes: ScannedNode[];
  skipped: SkippedNode[];
  warnings: ScanWarning[];
}

export interface ScanKnowledgeAFailure {
  ok: false;
  error: {
    code: ScanKnowledgeAErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ScanKnowledgeAResult = ScanKnowledgeASuccess | ScanKnowledgeAFailure;

export interface ScanKnowledgeAInput {
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

interface WalkTask {
  parent_node_token: string;
  /** 父节点路径（根层为空数组）；子节点继承根节点推导的 scope / project_id。 */
  path: string[];
  scope?: KnowledgeScope;
  project_id?: string | null;
}

interface WikiNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  node_type: string;
  parent_node_token: string;
  title: string;
  obj_edit_time: string;
  has_child: boolean;
}

interface WikiNodePage {
  items: unknown[];
  has_more: boolean;
  page_token?: string;
}

export async function scan_knowledge_a(
  input: ScanKnowledgeAInput = {},
): Promise<ScanKnowledgeAResult> {
  const loaded = load_config();
  if ("error" in loaded) {
    return failure("CONFIG_INVALID", loaded.error.message, loaded.error.details);
  }
  if (!loaded.exists) {
    return failure(
      "CONFIG_MISSING",
      `未找到配置文件：${loaded.path}。请先运行 $setup 或 write_config 初始化配置。`,
      { path: loaded.path },
    );
  }

  const config = loaded.config;
  const space_a = config.lark.space_a;
  if (!has_text(space_a)) {
    return failure("CONFIG_INVALID", "配置缺少 lark.space_a，无法扫描原始库。", {
      field: "lark.space_a",
      path: path.join(resolve_home(), CONFIG_FILE_NAME),
    });
  }

  const cli = resolve_lark_cli(config, { env: input.env, home_dir: input.home_dir });
  if (!cli.ok) {
    return { ok: false, error: cli.error };
  }

  const project_roots = new Map(
    config.lark.project_roots.map((root) => [root.node_token, root.project_id]),
  );
  const nodes: ScannedNode[] = [];
  const skipped: SkippedNode[] = [];
  const warnings: ScanWarning[] = [];
  const tasks: WalkTask[] = [{ parent_node_token: "", path: [] }];
  const seen_pages = new Set<string>();

  while (tasks.length > 0) {
    const task = tasks.shift() as WalkTask;
    let page_token: string | undefined;
    for (;;) {
      const page_key = `${task.parent_node_token}\u0000${page_token ?? ""}`;
      if (seen_pages.has(page_key)) {
        return failure(
          "SCAN_FAILED",
          "wiki nodes list 返回了重复的 page_token，已停止以免无限翻页。",
          { parent_node_token: task.parent_node_token, page_token },
        );
      }
      seen_pages.add(page_key);

      const page = await fetch_node_page(
        cli.path,
        space_a,
        task.parent_node_token,
        page_token,
        input.env,
      );
      if ("error" in page) {
        return page;
      }

      for (const [index, raw] of page.items.entries()) {
        const parsed = parse_wiki_node(raw, task.parent_node_token, index, task.path);
        if ("error" in parsed) {
          return parsed;
        }

        const node_path = [...task.path, parsed.title];
        const path_text = node_path.join("/");
        if (parsed.node_type === "shortcut") {
          record_skip("SHORTCUT_NODE_SKIPPED", parsed, path_text, skipped, warnings);
          continue;
        }
        if (parsed.obj_type !== "docx") {
          record_skip("NON_DOC_NODE_SKIPPED", parsed, path_text, skipped, warnings);
          continue;
        }

        let scope = task.scope;
        let project_id = task.project_id;
        if (task.parent_node_token === "") {
          if (parsed.title === GENERAL_ROOT_TITLE) {
            scope = "general";
            project_id = null;
          } else {
            const mapped_project_id = project_roots.get(parsed.node_token);
            if (mapped_project_id === undefined) {
              record_skip("UNMAPPED_ROOT_NODE_SKIPPED", parsed, path_text, skipped, warnings);
              continue;
            }
            scope = "project";
            project_id = mapped_project_id;
          }
        }
        if (scope === undefined) {
          return failure(
            "INTERNAL",
            `内部状态不一致：节点「${parsed.title}」没有推导出 scope。`,
            { node_token: parsed.node_token },
          );
        }

        nodes.push({
          node_token: parsed.node_token,
          obj_token: parsed.obj_token,
          obj_type: parsed.obj_type,
          parent_node_token: parsed.parent_node_token,
          title: parsed.title,
          obj_edit_time: parsed.obj_edit_time,
          path: path_text,
          scope,
          project_id: project_id ?? null,
        });
        if (parsed.has_child) {
          tasks.push({
            parent_node_token: parsed.node_token,
            path: node_path,
            scope,
            project_id: project_id ?? null,
          });
        }
      }

      if (!page.has_more) {
        break;
      }
      if (!has_text(page.page_token)) {
        return failure(
          "SCAN_FAILED",
          "wiki nodes list 返回 has_more=true 但没有 page_token，无法继续翻页。",
          { parent_node_token: task.parent_node_token },
        );
      }
      page_token = page.page_token;
    }
  }

  return { nodes, skipped, warnings };
}

async function fetch_node_page(
  cli_path: string,
  space_a: string,
  parent_node_token: string,
  page_token: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<WikiNodePage | ScanKnowledgeAFailure> {
  const args = ["wiki", "nodes", "list", "--space-id", space_a];
  if (parent_node_token !== "") {
    args.push("--parent-node-token", parent_node_token);
  }
  args.push("--page-size", String(WIKI_PAGE_SIZE));
  if (page_token !== undefined && page_token !== "") {
    args.push("--page-token", page_token);
  }
  args.push("--as", "user", "--format", "json");

  const run = await run_cli(cli_path, args, { env, expect_json: true });
  if (!run.ok) {
    return { ok: false, error: run.error };
  }
  if (run.code !== 0 || business_failed(run.json)) {
    return failure("SCAN_FAILED", business_failure_message(run.json, run.code), {
      command: "wiki nodes list",
      space_id: space_a,
      ...(parent_node_token === "" ? {} : { parent_node_token }),
      ...(page_token === undefined ? {} : { page_token }),
      exit_code: run.code,
      stderr: truncate(run.stderr),
      stderr_truncated: run.stderr.length > STDERR_LIMIT,
    });
  }

  const items = first_array(run.json, [
    ["data", "items"],
    ["items"],
    ["data", "nodes"],
    ["nodes"],
  ]);
  if (items === undefined) {
    return failure("SCAN_FAILED", "wiki nodes list 返回缺少节点数组（data.items）。", {
      command: "wiki nodes list",
      space_id: space_a,
      ...(parent_node_token === "" ? {} : { parent_node_token }),
    });
  }

  const has_more =
    read_path(run.json, ["data", "has_more"]) === true ||
    read_path(run.json, ["has_more"]) === true;
  const page_token_value = first_text(run.json, [["data", "page_token"], ["page_token"]]);
  return page_token_value === undefined
    ? { items, has_more }
    : { items, has_more, page_token: page_token_value };
}

function parse_wiki_node(
  value: unknown,
  fallback_parent_node_token: string,
  row_index: number,
  parent_path: readonly string[],
): WikiNode | ScanKnowledgeAFailure {
  if (!is_record(value)) {
    return failure("SCAN_FAILED", `wiki nodes list 返回的第 ${row_index + 1} 个节点不是对象。`, {
      row: row_index,
    });
  }
  const node_token = optional_text(value.node_token);
  const title = optional_text(value.title);
  if (node_token === undefined || title === undefined) {
    return failure(
      "SCAN_FAILED",
      `wiki nodes list 返回的第 ${row_index + 1} 个节点缺少 node_token 或 title。`,
      { row: row_index },
    );
  }

  // 缺字段时 fail closed：静默补空串会让文档永远停在 to_update（obj_edit_time）
  // 或被后续按空 obj_token 处理（obj_token），都不安全。
  const obj_token = optional_text(value.obj_token);
  if (obj_token === undefined) {
    return failure(
      "SCAN_FAILED",
      `wiki nodes list 返回的第 ${row_index + 1} 个节点缺少 obj_token，无法确定文档 token。`,
      {
        row: row_index,
        ...node_failure_details(node_token, title, parent_path),
      },
    );
  }
  const obj_edit_time = optional_text(value.obj_edit_time);
  if (obj_edit_time === undefined) {
    return failure(
      "SCAN_FAILED",
      `wiki nodes list 返回的第 ${row_index + 1} 个节点缺少 obj_edit_time，` +
        "无法判定同步状态。",
      {
        row: row_index,
        ...node_failure_details(node_token, title, parent_path),
      },
    );
  }

  return {
    node_token,
    obj_token,
    obj_type: optional_text(value.obj_type) ?? "",
    node_type: optional_text(value.node_type) ?? "",
    parent_node_token: optional_text(value.parent_node_token) ?? fallback_parent_node_token,
    title,
    obj_edit_time,
    has_child: value.has_child === true,
  };
}

/** failure details 里回带节点定位信息，便于对着 wiki nodes list 响应排错。 */
function node_failure_details(
  node_token: string,
  title: string,
  parent_path: readonly string[],
): Record<string, unknown> {
  return {
    node_token,
    title,
    path: [...parent_path, title].join("/"),
  };
}

function record_skip(
  code: ScanSkipCode,
  node: WikiNode,
  path: string,
  skipped: SkippedNode[],
  warnings: ScanWarning[],
): void {
  skipped.push({ node_token: node.node_token, title: node.title, path, reason: code });
  warnings.push({
    code,
    message: skip_message(code, node, path),
    node_token: node.node_token,
    title: node.title,
    path,
  });
}

function skip_message(code: ScanSkipCode, node: WikiNode, path: string): string {
  if (code === "SHORTCUT_NODE_SKIPPED") {
    return `跳过快捷方式节点「${node.title}」（${path}）：扫描只处理 origin docx 节点。`;
  }
  if (code === "NON_DOC_NODE_SKIPPED") {
    return (
      `跳过非 docx 节点「${node.title}」（${path}，obj_type=${node.obj_type}）：` +
      `第一版不下载、不解析二进制内容。`
    );
  }
  return (
    `跳过未映射根节点「${node.title}」（${path}）：请在 config.toml 的 ` +
    `lark.project_roots 中登记 node_token=${node.node_token}，` +
    `或把该根节点标题改为「${GENERAL_ROOT_TITLE}」。`
  );
}

function failure(
  code: ScanKnowledgeAErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ScanKnowledgeAFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function business_failed(payload: unknown): boolean {
  return is_record(payload) && payload.ok === false;
}

function business_failure_message(payload: unknown, exit_code: number): string {
  if (is_record(payload)) {
    const error = payload.error;
    if (is_record(error) && typeof error.message === "string" && error.message.trim() !== "") {
      return `lark-cli wiki nodes list 失败：${error.message}`;
    }
    if (typeof payload.message === "string" && payload.message.trim() !== "") {
      return `lark-cli wiki nodes list 失败：${payload.message}`;
    }
  }
  return `lark-cli wiki nodes list 失败（exit code ${exit_code}）。`;
}

function read_path(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!is_record(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function first_array(
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): unknown[] | undefined {
  for (const candidate_path of paths) {
    const candidate = read_path(value, candidate_path);
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function first_text(
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): string | undefined {
  for (const candidate_path of paths) {
    const candidate = optional_text(read_path(value, candidate_path));
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function optional_text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function has_text(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function truncate(text: string, limit = STDERR_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
