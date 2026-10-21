import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KnowledgeCard } from "../src/base_mapping.js";
import {
  CACHE_VERSION,
  save_cache,
  type DocMarker,
  type LocalCardCache,
} from "../src/cache.js";
import { index_file_path, open_index, replace_doc_rows } from "../src/index_store.js";
import {
  load_knowledge_pack,
  type LoadKnowledgePackInput,
  type LoadKnowledgePackResult,
  type LoadKnowledgePackSuccess,
} from "../src/tools/load_knowledge_pack.js";

/**
 * `load_knowledge_pack`（Task 5）测试。
 *
 * 数据全部本地造：索引用 `open_index()` + `replace_doc_rows()` 直接种，
 * `SCRIPT2SHOT_HOME` 指向 `mkdtempSync` 临时目录。不触发任何真实飞书操作。
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const LAUNCHER = path.join(
  REPO_ROOT,
  "scripts",
  IS_WINDOWS ? "launch_script2shot_mcp.cmd" : "launch_script2shot_mcp",
);

const DOC_A = "doccnPackA";
const SYNCED_AT = "2026-10-21T10:00:00+08:00";

let temp_root = "";
let home = "";
let previous_home: string | undefined;

beforeEach(() => {
  temp_root = mkdtempSync(path.join(os.tmpdir(), "script2shot-pack-"));
  home = path.join(temp_root, "home");
  mkdirSync(home, { recursive: true });
  previous_home = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = home;
});

afterEach(() => {
  if (previous_home === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previous_home;
  }
  rmSync(temp_root, { recursive: true, force: true });
});

function make_card(card_id: string, overrides: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return {
    card_id,
    scope: "general",
    project_id: null,
    category: "prompt_technique",
    title: `卡片 ${card_id}`,
    content: `内容 ${card_id}`,
    tags: [],
    entities: [],
    target_models: [],
    priority: 5,
    source_doc_token: DOC_A,
    source_node_token: `node-${DOC_A}`,
    source_path: `/通用知识/${DOC_A}`,
    source_title: `文档 ${DOC_A}`,
    source_revision: 1,
    source_block_id: null,
    updated_at: "2026-10-21T10:00:00+08:00",
    ...overrides,
  };
}

const DEFAULT_MARKER: DocMarker = { source_revision: 1, last_synced_at: SYNCED_AT };

function seed_index(cards: KnowledgeCard[], marker: DocMarker = DEFAULT_MARKER): void {
  const db = open_index();
  try {
    replace_doc_rows(db, DOC_A, cards, marker);
  } finally {
    db.close();
  }
}

/**
 * 知识包 fixture：覆盖 general / 当前项目 / 其他项目 / seedance 兼容性四类取样。
 * 两张 `scope=project` 的 `seedance_rule` 卡挂在 `prj-2` 下，用来观察
 * seedance 规则的模型兼容过滤（它们不属于请求项目，也不在 general 块）。
 */
function seed_pack_fixture(): void {
  seed_index([
    make_card("card-gen-prompt", {
      scope: "general",
      project_id: null,
      category: "prompt_technique",
      title: "通用提示词技巧",
    }),
    make_card("card-gen-visual", {
      scope: "general",
      project_id: null,
      category: "visual_style",
      title: "通用视觉风格",
    }),
    make_card("card-gen-seedance", {
      scope: "general",
      project_id: null,
      category: "seedance_rule",
      title: "通用 Seedance 软知识",
      target_models: [],
    }),
    make_card("card-prj1-scene", {
      scope: "project",
      project_id: "prj-1",
      category: "scene_description",
      title: "项目场景设定",
    }),
    make_card("card-prj1-seedance", {
      scope: "project",
      project_id: "prj-1",
      category: "seedance_rule",
      title: "项目 Seedance 规则",
      target_models: ["seedance-2.5"],
    }),
    make_card("card-prj2-char", {
      scope: "project",
      project_id: "prj-2",
      category: "character_bible",
      title: "其他项目角色圣经",
    }),
    make_card("card-seedance-20", {
      scope: "project",
      project_id: "prj-2",
      category: "seedance_rule",
      title: "Seedance 2.0 软知识",
      target_models: ["seedance-2.0"],
    }),
    make_card("card-seedance-25", {
      scope: "project",
      project_id: "prj-2",
      category: "seedance_rule",
      title: "Seedance 2.5 软知识",
      target_models: ["seedance-2.5"],
    }),
  ]);
}

function seed_cache(cards: KnowledgeCard[], marker: DocMarker = DEFAULT_MARKER): void {
  const cache: LocalCardCache = {
    version: CACHE_VERSION,
    docs: { [DOC_A]: { ...marker, cards: [...cards] } },
  };
  save_cache(cache);
}

function expect_success(result: LoadKnowledgePackResult): LoadKnowledgePackSuccess {
  if ("ok" in result && result.ok === false) {
    throw new Error(`load_knowledge_pack 失败：${JSON.stringify(result.error)}`);
  }
  return result as LoadKnowledgePackSuccess;
}

function card_ids(result: LoadKnowledgePackSuccess): string[] {
  return result.cards.map((card) => card.card_id);
}

function warning_codes(result: LoadKnowledgePackSuccess): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("load_knowledge_pack", () => {
  test("pack includes general project and compatible seedance cards", () => {
    seed_pack_fixture();

    const result = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );
    const ids = card_ids(result);

    // 正例：全部 general 卡、当前项目卡、模型兼容的 seedance 卡。
    expect(ids).toContain("card-gen-prompt");
    expect(ids).toContain("card-gen-visual");
    expect(ids).toContain("card-prj1-scene");
    expect(ids).toContain("card-seedance-25");

    // 反例：其他项目的普通卡与本模型不兼容的 seedance 卡都不进包。
    expect(ids).not.toContain("card-prj2-char");
    expect(ids).not.toContain("card-seedance-20");

    // 同一张卡命中多条规则也只输出一次（general 块与 seedance 规则重叠）。
    expect(ids.filter((id) => id === "card-gen-seedance")).toHaveLength(1);
    expect(ids.filter((id) => id === "card-prj1-seedance")).toHaveLength(1);

    expect(result.stats).toEqual({ general: 3, project: 2, seedance: 1 });
    expect(result.warnings).toEqual([]);
  });

  test("pack excludes other projects", () => {
    seed_pack_fixture();

    const for_prj1 = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" }),
    );
    expect(card_ids(for_prj1)).not.toContain("card-prj2-char");

    const for_prj2 = expect_success(
      load_knowledge_pack({ project_id: "prj-2", target_model: "seedance-2.0" }),
    );
    expect(card_ids(for_prj2)).toContain("card-prj2-char");
    expect(card_ids(for_prj2)).not.toContain("card-prj1-scene");
    expect(card_ids(for_prj2)).not.toContain("card-prj1-seedance");

    // general 块与请求项目无关，两次调用都包含同一批通用卡。
    expect(card_ids(for_prj2)).toContain("card-gen-prompt");
  });

  test("pack filters seedance target model", () => {
    seed_pack_fixture();

    const for_20 = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" }),
    );
    expect(card_ids(for_20)).toContain("card-seedance-20");
    expect(card_ids(for_20), "反例：seedance-2.5 的卡不得进入 2.0 的包").not.toContain(
      "card-seedance-25",
    );

    const for_25 = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );
    expect(card_ids(for_25)).toContain("card-seedance-25");
    expect(card_ids(for_25), "反例：seedance-2.0 的卡不得进入 2.5 的包").not.toContain(
      "card-seedance-20",
    );

    // 空数组 = 通用卡，两个目标模型都放行。
    expect(card_ids(for_20)).toContain("card-gen-seedance");
    expect(card_ids(for_25)).toContain("card-gen-seedance");

    // 缺失 target_models_json（旧索引行）同样按通用卡放行。
    const db = open_index();
    try {
      db.prepare("UPDATE cards SET target_models_json = NULL WHERE card_id = ?").run(
        "card-seedance-20",
      );
    } finally {
      db.close();
    }
    const legacy = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );
    expect(legacy.cards.some((card) => card.card_id === "card-seedance-20")).toBe(true);
  });

  test("pack warns when project knowledge empty", () => {
    // 只种项目卡，不种通用卡：请求一个不存在的项目时两个 warning 同时出现。
    seed_index([
      make_card("card-prj1-scene", {
        scope: "project",
        project_id: "prj-1",
        category: "scene_description",
      }),
    ]);

    const missing = expect_success(
      load_knowledge_pack({ project_id: "prj-none", target_model: "seedance-2.0" }),
    );
    expect(warning_codes(missing)).toEqual([
      "GENERAL_KNOWLEDGE_EMPTY",
      "PROJECT_KNOWLEDGE_EMPTY",
    ]);
    expect(missing.cards).toEqual([]);
    expect(missing.stats).toEqual({ general: 0, project: 0, seedance: 0 });
    for (const warning of missing.warnings) {
      expect(warning.message.length).toBeGreaterThan(0);
    }

    // 项目有卡但 general 为空：只给 GENERAL_KNOWLEDGE_EMPTY。
    const present = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" }),
    );
    expect(warning_codes(present)).toEqual(["GENERAL_KNOWLEDGE_EMPTY"]);
    expect(present.stats).toEqual({ general: 0, project: 1, seedance: 0 });
  });

  test("pack ordering is stable across runs", () => {
    seed_index([
      make_card("card-gen-z", { category: "visual_style", title: "Z" }),
      make_card("card-gen-b", { category: "camera_lexicon", title: "B" }),
      make_card("card-gen-a", { category: "camera_lexicon", title: "A" }),
      make_card("card-prj-c", {
        scope: "project",
        project_id: "prj-1",
        category: "visual_style",
      }),
      make_card("card-prj-b", {
        scope: "project",
        project_id: "prj-1",
        category: "character_bible",
      }),
      make_card("card-prj-a", {
        scope: "project",
        project_id: "prj-1",
        category: "character_bible",
      }),
      make_card("card-seed-hard", {
        scope: "project",
        project_id: "prj-2",
        category: "seedance_rule",
        title: "Seedance 硬知识",
        target_models: ["seedance-2.5"],
      }),
      make_card("card-seed-easy", {
        scope: "project",
        project_id: "prj-2",
        category: "seedance_rule",
        title: "Seedance 软知识",
        target_models: ["seedance-2.5"],
      }),
    ]);

    const first = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );
    const second = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );

    expect(card_ids(first)).toEqual([
      "card-gen-a",
      "card-gen-b",
      "card-gen-z",
      "card-prj-a",
      "card-prj-b",
      "card-prj-c",
      "card-seed-easy",
      "card-seed-hard",
    ]);
    expect(second).toEqual(first);
  });

  test("pack counts each card once and classifies by first matching rule", () => {
    seed_index([
      make_card("card-general-seedance", {
        scope: "general",
        project_id: null,
        category: "seedance_rule",
        target_models: ["seedance-2.5"],
      }),
      make_card("card-project-seedance", {
        scope: "project",
        project_id: "prj-1",
        category: "seedance_rule",
        target_models: ["seedance-2.5"],
      }),
    ]);

    const result = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );

    expect(card_ids(result)).toEqual(["card-general-seedance", "card-project-seedance"]);
    expect(result.stats).toEqual({ general: 1, project: 1, seedance: 0 });
  });

  test("pack returns the frozen card shape with source metadata", () => {
    seed_index(
      [
        make_card("card-shape", {
          title: "形状校验",
          content: "正文",
          tags: ["标签"],
          entities: ["实体"],
          priority: 7,
          source_path: "/通用知识/形状",
          source_revision: 3,
          updated_at: "2026-10-20T09:00:00+08:00",
        }),
      ],
      { source_revision: 3, last_synced_at: SYNCED_AT },
    );

    const result = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" }),
    );

    expect(result.cards).toEqual([
      {
        card_id: "card-shape",
        category: "prompt_technique",
        title: "形状校验",
        content: "正文",
        tags: ["标签"],
        entities: ["实体"],
        priority: 7,
        source_doc_token: DOC_A,
        source_path: "/通用知识/形状",
        source_revision: 3,
        last_synced_at: SYNCED_AT,
      },
    ]);
    expect(Object.keys(result.cards[0] as object).sort()).toEqual([
      "card_id",
      "category",
      "content",
      "entities",
      "last_synced_at",
      "priority",
      "source_doc_token",
      "source_path",
      "source_revision",
      "tags",
      "title",
    ]);
  });

  test("pack rejects invalid arguments with CONFIG_INVALID", () => {
    // 校验先于索引读取：索引还不存在也必须是 CONFIG_INVALID，而不是 INDEX_UNAVAILABLE。
    const cases: Array<[LoadKnowledgePackInput, string]> = [
      [{ target_model: "seedance-2.0" }, "project_id"],
      [{ project_id: "   ", target_model: "seedance-2.0" }, "project_id"],
      [{ project_id: 5, target_model: "seedance-2.0" }, "project_id"],
      [{ project_id: "prj-1" }, "target_model"],
      [{ project_id: "prj-1", target_model: "seedance-3.0" }, "target_model"],
      [{ project_id: "prj-1", target_model: 25 }, "target_model"],
      [{ project_id: "prj-1", target_model: "seedance-2.0", explain: "yes" }, "explain"],
    ];

    for (const [input, field] of cases) {
      expect(load_knowledge_pack(input), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field } },
      });
    }

    // 被拒绝的调用不留任何副作用：同一环境仍然可以正常加载知识包。
    seed_pack_fixture();
    const after = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" }),
    );
    expect(after.cards.length).toBeGreaterThan(0);
  });

  test("pack returns INDEX_UNAVAILABLE when the index is missing or corrupt", () => {
    // 没有缓存回退：即使本地缓存里有卡，索引缺失也直接报错。
    seed_cache([make_card("card-cache-only", { priority: 9 })]);

    expect(existsSync(index_file_path()), "前置：索引文件不存在").toBe(false);
    const missing = load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "INDEX_UNAVAILABLE", details: { index_path: index_file_path(), index_state: "missing" } },
    });
    expect(existsSync(index_file_path()), "加载路径不得创建索引文件").toBe(false);
    expect(existsSync(path.dirname(index_file_path())), "加载路径不得创建 index/ 目录").toBe(
      false,
    );

    // 损坏（0 字节）的索引同样报错，且不修复、不重写。
    mkdirSync(path.dirname(index_file_path()), { recursive: true });
    writeFileSync(index_file_path(), "", "utf8");
    const corrupt = load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" });
    expect(corrupt).toMatchObject({
      ok: false,
      error: { code: "INDEX_UNAVAILABLE", details: { index_state: "corrupt" } },
    });
    expect(statSync(index_file_path()).size).toBe(0);
  });

  test("pack reads a ready index without writing to it", () => {
    seed_index([make_card("card-ready", { title: "只读校验" })]);
    const index_path = index_file_path();
    const frozen_time = new Date("2000-01-01T00:00:00Z");
    utimesSync(index_path, frozen_time, frozen_time);
    const mtime_before = statSync(index_path).mtimeMs;
    const bytes_before = readFileSync(index_path);

    const result = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.0" }),
    );

    expect(card_ids(result)).toEqual(["card-ready"]);
    expect(statSync(index_path).mtimeMs, "加载知识包不得写索引文件").toBe(mtime_before);
    expect(readFileSync(index_path).equals(bytes_before), "索引字节不得变化").toBe(true);
  });

  test("pack accepts explain without changing cards and warns EXPLAIN_NOT_AVAILABLE", () => {
    seed_pack_fixture();

    const plain = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5" }),
    );
    const explained = expect_success(
      load_knowledge_pack({ project_id: "prj-1", target_model: "seedance-2.5", explain: true }),
    );

    expect(warning_codes(explained)).toEqual(["EXPLAIN_NOT_AVAILABLE"]);
    expect(explained.cards).toEqual(plain.cards);
    expect(explained.stats).toEqual(plain.stats);
  });
});

describe("load_knowledge_pack mcp dispatch", () => {
  test("tools/list exposes load_knowledge_pack with a closed input schema", async () => {
    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const result = await client.listTools();
      const tool = result.tools.find((entry) => entry.name === "load_knowledge_pack");
      expect(tool, "tools/list 应包含 load_knowledge_pack").toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["project_id", "target_model"],
        properties: {
          project_id: { type: "string" },
          target_model: { type: "string", enum: ["seedance-2.0", "seedance-2.5"] },
          explain: { type: "boolean" },
        },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("dispatching load_knowledge_pack rejects invalid arguments fail-closed", async () => {
    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const unknown = parse_tool_json(
        await client.callTool({
          name: "load_knowledge_pack",
          arguments: { project_id: "prj-1", target_model: "seedance-2.0", unexpected: true },
        }),
      );
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const bad_project = parse_tool_json(
        await client.callTool({
          name: "load_knowledge_pack",
          arguments: { project_id: 5, target_model: "seedance-2.0" },
        }),
      );
      expect(bad_project).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "project_id" } },
      });

      const bad_model = parse_tool_json(
        await client.callTool({
          name: "load_knowledge_pack",
          arguments: { project_id: "prj-1", target_model: 25 },
        }),
      );
      expect(bad_model).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "target_model" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("dispatching load_knowledge_pack returns the pack from the local index", async () => {
    seed_index([make_card("card-mcp", { title: "端到端校验", priority: 4 })]);

    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const payload = parse_tool_json(
        await client.callTool({
          name: "load_knowledge_pack",
          arguments: { project_id: "prj-1", target_model: "seedance-2.0" },
        }),
      );
      expect(payload).toMatchObject({
        cards: [
          {
            card_id: "card-mcp",
            title: "端到端校验",
            source_doc_token: DOC_A,
            last_synced_at: SYNCED_AT,
          },
        ],
        stats: { general: 1, project: 0, seedance: 0 },
        warnings: [{ code: "PROJECT_KNOWLEDGE_EMPTY" }],
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);
});

async function connect_mcp(
  overrides: Record<string, string>,
): Promise<{ client: Client; errors: string[] }> {
  const inherited_env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const command = IS_WINDOWS ? "cmd.exe" : "sh";
  const args = IS_WINDOWS ? ["/d", "/c", LAUNCHER] : [LAUNCHER];
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: REPO_ROOT,
    env: { ...inherited_env, ...overrides },
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8")));
  const client = new Client({ name: "script2shot-pack-dispatch-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, errors };
}

function parse_tool_json(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  )?.text;
  if (text === undefined) {
    throw new Error(`tool result is missing text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}
