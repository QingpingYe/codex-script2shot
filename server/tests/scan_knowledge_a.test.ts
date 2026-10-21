import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { to_base_fields, type SyncState } from "../src/base_mapping.js";
import { build_sync_plan } from "../src/sync_plan.js";
import { read_sync_state, type ReadSyncStateResult } from "../src/tools/read_sync_state.js";
import {
  scan_knowledge_a,
  type ScanKnowledgeAResult,
  type ScannedNode,
} from "../src/tools/scan_knowledge_a.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const SPACE_A = "EXAMPLESPACE0001";
const BASE_B = "base-token-b-123456789";
const SYNC_STATE_TABLE_ID = "tbl_state";
const PROJECT_ROOT_NODE_TOKEN = "wikcnSAMPLEPROJ0";
const PROJECT_ID = "wufu-linmen";
const LENS_DOC_TOKEN = "doccnSAMPLEGENLENS";
const WIKI_PAGES_MANIFEST = path.join(FIXTURES_DIR, "lark-wiki-nodes-list.pages.sample.json");

const SYNC_STATE_FIELDS = [
  { name: "source_doc_token", type: "text" },
  { name: "source_node_token", type: "text" },
  { name: "source_path", type: "text" },
  { name: "source_title", type: "text" },
  { name: "scope", type: "text" },
  { name: "project_id", type: "text" },
  { name: "obj_edit_time", type: "text" },
  { name: "source_revision", type: "number" },
  { name: "card_count", type: "number" },
  { name: "last_synced_at", type: "datetime" },
  { name: "last_sync_user", type: "text" },
  { name: "last_run_id", type: "text" },
];

let tempRoot = "";
let home = "";
let cliPath = "";
let statePath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-scan-a-"));
  home = path.join(tempRoot, "home");
  cliPath = install_fake_cli(path.join(tempRoot, "bin"));
  statePath = path.join(tempRoot, "base-state.json");
  logPath = path.join(tempRoot, "calls.jsonl");
  env = {
    ...process.env,
    LARK_CLI_PATH: cliPath,
    FAKE_SCENARIO: "ok",
    FAKE_BASE_STATE_FILE: statePath,
    FAKE_LOG_FILE: logPath,
    FAKE_WIKI_NODES_FILE: WIKI_PAGES_MANIFEST,
  };
  previousHome = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = home;
  write_raw_state_rows([]);
  write_config_file();
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previousHome;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

/** 把假 CLI 装进指定目录，返回可直接执行的包装脚本路径（Windows 为 .cmd）。 */
function install_fake_cli(dir: string, name = "lark-cli"): string {
  mkdirSync(dir, { recursive: true });
  const wrapper_name = IS_WINDOWS ? `${name}.cmd` : name;
  cpSync(
    path.join(FIXTURES_DIR, IS_WINDOWS ? "fake-lark-cli.cmd" : "fake-lark-cli"),
    path.join(dir, wrapper_name),
  );
  cpSync(path.join(FIXTURES_DIR, "fake-lark-cli.mjs"), path.join(dir, `${name}.mjs`));
  const wrapper_path = path.join(dir, wrapper_name);
  if (!IS_WINDOWS) {
    chmodSync(wrapper_path, 0o755);
  }
  return wrapper_path;
}

function write_config_file(): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "[lark]",
      'profile = "default"',
      `space_a = "${SPACE_A}"`,
      `base_b = "${BASE_B}"`,
      `sync_state_table_id = "${SYNC_STATE_TABLE_ID}"`,
      "",
      "[[lark.project_roots]]",
      `node_token = "${PROJECT_ROOT_NODE_TOKEN}"`,
      `project_id = "${PROJECT_ID}"`,
      "",
      "[retrieval]",
      "default_top_k = 12",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 直接写入 Base 字段映射，供负数路径用例构造坏记录。 */
function write_raw_state_rows(rows: Array<Record<string, unknown>>): void {
  const state = {
    tables: [
      {
        id: SYNC_STATE_TABLE_ID,
        name: "SyncState",
        fields: SYNC_STATE_FIELDS.map((field, index) => ({
          id: `fld_state_${index + 1}`,
          ...field,
        })),
      },
    ],
    records: {
      [SYNC_STATE_TABLE_ID]: rows.map((row, index) => ({
        record_id: `rec_state_${index + 1}`,
        fields: row,
      })),
    },
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function write_base_state(states: SyncState[]): void {
  write_raw_state_rows(states.map((state) => to_base_fields(state)));
}

function state_from_node(node: ScannedNode): SyncState {
  return {
    source_doc_token: node.obj_token,
    source_node_token: node.node_token,
    source_path: node.path,
    source_title: node.title,
    scope: node.scope,
    project_id: node.project_id,
    obj_edit_time: node.obj_edit_time,
    source_revision: 1,
    card_count: 1,
    last_synced_at: "2026-10-20T12:00:00+08:00",
    last_sync_user: "测试用户",
    last_run_id: "sync-test",
  };
}

function read_calls(): Array<{ scenario: string; args: string[] }> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { scenario: string; args: string[] });
}

function flag_value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function wiki_calls(): Array<{ parent_node_token: string; page_token: string; args: string[] }> {
  return read_calls()
    .filter((call) => call.args[0] === "wiki" && call.args[1] === "nodes" && call.args[2] === "list")
    .map((call) => ({
      parent_node_token: flag_value(call.args, "--parent-node-token") ?? "",
      page_token: flag_value(call.args, "--page-token") ?? "",
      args: call.args,
    }));
}

function run_scan(): Promise<ScanKnowledgeAResult> {
  return scan_knowledge_a({ env });
}

function expect_scan_ok(result: ScanKnowledgeAResult): Exclude<ScanKnowledgeAResult, { ok: false }> {
  if ("ok" in result) {
    throw new Error(`期望扫描成功，实际失败：${JSON.stringify(result)}`);
  }
  return result;
}

function expect_sync_ok(result: ReadSyncStateResult): Exclude<ReadSyncStateResult, { ok: false }> {
  if ("ok" in result) {
    throw new Error(`期望 SyncState 读取成功，实际失败：${JSON.stringify(result)}`);
  }
  return result;
}

describe("scan_knowledge_a", () => {
  test("scan pages through nested nodes and builds full paths", async () => {
    const result = expect_scan_ok(await run_scan());

    expect(result.nodes.map((node) => node.path)).toEqual([
      "通用知识",
      "《五夫临门》影游项目知识",
      "通用知识/镜头语言",
      "通用知识/提示词技巧",
      "《五夫临门》影游项目知识/项目概述",
      "《五夫临门》影游项目知识/视觉风格",
      "通用知识/镜头语言/景别与机位",
    ]);
    expect(result.nodes.map((node) => node.obj_edit_time)).toEqual([
      "1760007200",
      "1760010800",
      "1760008000",
      "1760009000",
      "1760011000",
      "1760012000",
      "1760008500",
    ]);

    // 手动翻页 + BFS：根页两页，随后按遇到顺序递归到两级子节点。
    expect(wiki_calls().map((call) => [call.parent_node_token, call.page_token])).toEqual([
      ["", ""],
      ["", "pt-sample-roots-2"],
      ["wikcnSAMPLEGEN00", ""],
      ["wikcnSAMPLEPROJ0", ""],
      ["wikcnSAMPLEGENLENS", ""],
    ]);
    expect(wiki_calls()[0].args).toEqual([
      "wiki",
      "nodes",
      "list",
      "--space-id",
      SPACE_A,
      "--page-size",
      "50",
      "--as",
      "user",
      "--format",
      "json",
    ]);
    expect(wiki_calls()[1].args).toEqual([
      "wiki",
      "nodes",
      "list",
      "--space-id",
      SPACE_A,
      "--page-size",
      "50",
      "--page-token",
      "pt-sample-roots-2",
      "--as",
      "user",
      "--format",
      "json",
    ]);
    expect(wiki_calls()[2].args).toEqual([
      "wiki",
      "nodes",
      "list",
      "--space-id",
      SPACE_A,
      "--parent-node-token",
      "wikcnSAMPLEGEN00",
      "--page-size",
      "50",
      "--as",
      "user",
      "--format",
      "json",
    ]);
  });

  test("scan skips non doc shortcut and unclassified with warnings", async () => {
    const result = expect_scan_ok(await run_scan());

    expect(result.skipped.map((entry) => [entry.title, entry.reason])).toEqual([
      ["未映射项目知识", "UNMAPPED_ROOT_NODE_SKIPPED"],
      ["Seedance 2.0 系列提示词指南.pdf", "NON_DOC_NODE_SKIPPED"],
      ["旧版镜头语言（快捷方式）", "SHORTCUT_NODE_SKIPPED"],
    ]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "UNMAPPED_ROOT_NODE_SKIPPED",
      "NON_DOC_NODE_SKIPPED",
      "SHORTCUT_NODE_SKIPPED",
    ]);
    for (const warning of result.warnings) {
      expect(warning.message).not.toBe("");
      expect(warning.path).not.toBe("");
    }

    const doc_tokens = result.nodes.map((node) => node.obj_token);
    expect(doc_tokens).not.toContain("filecnSAMPLEGENPDF");
    expect(doc_tokens).not.toContain("doccnSAMPLEFREE00");
    // shortcut 指向的文档只通过 origin 节点出现一次，不重复计数。
    expect(doc_tokens.filter((token) => token === LENS_DOC_TOKEN)).toHaveLength(1);
  });

  test("scan derives scope and project id from root mapping", async () => {
    const result = expect_scan_ok(await run_scan());
    const by_path = new Map(result.nodes.map((node) => [node.path, node]));

    expect(by_path.get("通用知识")).toMatchObject({ scope: "general", project_id: null });
    expect(by_path.get("通用知识/镜头语言/景别与机位")).toMatchObject({
      scope: "general",
      project_id: null,
    });
    expect(by_path.get("《五夫临门》影游项目知识")).toMatchObject({
      scope: "project",
      project_id: PROJECT_ID,
    });
    expect(by_path.get("《五夫临门》影游项目知识/视觉风格")).toMatchObject({
      scope: "project",
      project_id: PROJECT_ID,
    });
  });

  test("move only doc triggers no fetch", async () => {
    const scan = expect_scan_ok(await run_scan());
    const states = scan.nodes.map((node) => state_from_node(node));
    const moved = states.find((state) => state.source_doc_token === LENS_DOC_TOKEN);
    if (moved === undefined) {
      throw new Error(`fixture 缺少文档 ${LENS_DOC_TOKEN}`);
    }
    moved.source_path = "通用知识/旧版镜头语言";
    write_base_state(states);

    const sync = expect_sync_ok(await read_sync_state({ env }));
    expect(sync.records).toHaveLength(scan.nodes.length);
    expect(sync.records.map((record) => record.record_id)).toEqual(
      scan.nodes.map((_, index) => `rec_state_${index + 1}`),
    );
    expect(sync.records[0]).toMatchObject({
      source_doc_token: scan.nodes[0].obj_token,
      source_path: scan.nodes[0].path,
      obj_edit_time: scan.nodes[0].obj_edit_time,
    });

    const plan = build_sync_plan(scan.nodes, sync.records);

    expect(plan.to_move.map((item) => item.source_doc_token)).toEqual([LENS_DOC_TOKEN]);
    expect(plan.to_update).toEqual([]);
    expect(plan.to_add).toEqual([]);
    expect(plan.to_delete).toEqual([]);
    expect(plan.unchanged).toHaveLength(scan.nodes.length - 1);

    // 「扫描 → 读取 SyncState → 生成 dry-run 清单」只允许只读元数据调用，不读取正文。
    const calls = read_calls().map((call) => call.args);
    expect(calls.some((args) => args[0] === "docs")).toBe(false);
    expect(
      calls.every(
        (args) =>
          (args[0] === "wiki" && args[1] === "nodes") ||
          (args[0] === "base" && args[1] === "+record-list"),
      ),
    ).toBe(true);
  });

  test("scan reports SCAN_FAILED when knowledge base a is unreachable", async () => {
    env.FAKE_SCENARIO = "space-unreachable";

    const result = await run_scan();

    if (!("ok" in result)) {
      throw new Error("期望扫描失败");
    }
    expect(result.error.code).toBe("SCAN_FAILED");
    expect(result.error.details?.exit_code).toBe(1);
    expect(wiki_calls()).toHaveLength(1);
  });

  test("read sync state rejects rows that are not sync state records", async () => {
    write_raw_state_rows([{ source_doc_token: "doc-x", card_id: "card-x" }]);

    const result = await read_sync_state({ env });

    if (!("ok" in result)) {
      throw new Error("期望读取失败");
    }
    expect(result.error.code).toBe("SYNC_STATE_INVALID");
    expect(result.error.details?.row).toBe(0);
  });
});
