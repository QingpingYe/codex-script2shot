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
  cache_file_path,
  save_cache,
  type DocMarker,
  type LocalCardCache,
} from "../src/cache.js";
import { index_file_path, open_index, replace_doc_rows } from "../src/index_store.js";
import {
  search_knowledge,
  type SearchKnowledgeResult,
  type SearchKnowledgeSuccess,
} from "../src/tools/search_knowledge.js";

/**
 * `search_knowledge`（Task 4）测试。
 *
 * 数据全部本地造：索引用 `open_index()` + `replace_doc_rows()` 直接种，
 * 缓存回退用 `save_cache()` 直接写，`SCRIPT2SHOT_HOME` 指向 `mkdtempSync`
 * 临时目录。不触发任何真实飞书操作。
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const LAUNCHER = path.join(
  REPO_ROOT,
  "scripts",
  IS_WINDOWS ? "launch_script2shot_mcp.cmd" : "launch_script2shot_mcp",
);

const DOC_A = "doccnSearchA";
const SYNCED_AT = "2026-10-21T10:00:00+08:00";

let temp_root = "";
let home = "";
let previous_home: string | undefined;

beforeEach(() => {
  temp_root = mkdtempSync(path.join(os.tmpdir(), "script2shot-search-"));
  home = path.join(temp_root, "home");
  mkdirSync(home, { recursive: true });
  previous_home = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = home;
  write_config_file();
});

afterEach(() => {
  if (previous_home === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previous_home;
  }
  rmSync(temp_root, { recursive: true, force: true });
});

function write_config_file(options: { default_top_k?: number } = {}): void {
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "[lark]",
      'profile = "default"',
      'space_a = "space-a-1"',
      'base_b = "base-token-b-123456789"',
      'knowledge_cards_table_id = "tbl_cards"',
      'sync_state_table_id = "tbl_state"',
      "",
      "[retrieval]",
      `default_top_k = ${options.default_top_k ?? 12}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

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

function seed_cache(cards: KnowledgeCard[], marker: DocMarker = DEFAULT_MARKER): void {
  const cache: LocalCardCache = {
    version: CACHE_VERSION,
    docs: { [DOC_A]: { ...marker, cards: [...cards] } },
  };
  save_cache(cache);
}

/** 四个过滤条件共用一份 fixture：同一分类两张命中/不命中的卡。 */
function seed_filter_fixture(): void {
  seed_index([
    make_card("card-general", {
      scope: "general",
      project_id: null,
      category: "prompt_technique",
      title: "夜景通用技巧",
      target_models: [],
      priority: 5,
    }),
    make_card("card-prj-1", {
      scope: "project",
      project_id: "prj-1",
      category: "scene_description",
      title: "夜景场景设定",
      target_models: ["seedance-2.5"],
      priority: 7,
    }),
    make_card("card-prj-2", {
      scope: "project",
      project_id: "prj-2",
      category: "character_bible",
      title: "夜景角色设定",
      target_models: ["seedance-2.0"],
      priority: 9,
    }),
  ]);
}

function expect_success(result: SearchKnowledgeResult): SearchKnowledgeSuccess {
  if ("ok" in result && result.ok === false) {
    throw new Error(`search_knowledge 失败：${JSON.stringify(result.error)}`);
  }
  return result as SearchKnowledgeSuccess;
}

function candidate_ids(result: SearchKnowledgeSuccess): string[] {
  return result.candidates.map((candidate) => candidate.card_id);
}

function warning_codes(result: SearchKnowledgeSuccess): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("search_knowledge", () => {
  test("search filters by scope with positive and negative cases", () => {
    seed_filter_fixture();

    const general = expect_success(search_knowledge({ query: "夜景", scope: "general" }));
    expect(candidate_ids(general)).toEqual(["card-general"]);
    expect(general.degraded).toBe(false);

    const project = expect_success(search_knowledge({ query: "夜景", scope: "project" }));
    expect(candidate_ids(project)).toEqual(["card-prj-2", "card-prj-1"]);
  });

  test("search filters by project with positive and negative cases", () => {
    seed_filter_fixture();

    const prj_1 = expect_success(search_knowledge({ query: "夜景", project_id: "prj-1" }));
    expect(candidate_ids(prj_1)).toEqual(["card-prj-1"]);

    const prj_2 = expect_success(search_knowledge({ query: "夜景", project_id: "prj-2" }));
    expect(candidate_ids(prj_2)).toEqual(["card-prj-2"]);
  });

  test("search filters by category with positive and negative cases", () => {
    seed_filter_fixture();

    const scene = expect_success(
      search_knowledge({ query: "夜景", categories: ["scene_description"] }),
    );
    expect(candidate_ids(scene)).toEqual(["card-prj-1"]);

    const character = expect_success(
      search_knowledge({ query: "夜景", categories: ["character_bible"] }),
    );
    expect(candidate_ids(character)).toEqual(["card-prj-2"]);

    const no_filter = expect_success(search_knowledge({ query: "夜景", categories: [] }));
    expect(candidate_ids(no_filter)).toEqual(["card-prj-2", "card-prj-1", "card-general"]);
  });

  test("search filters by target model with positive and negative cases", () => {
    seed_filter_fixture();

    const model_20 = expect_success(
      search_knowledge({ query: "夜景", target_model: "seedance-2.0" }),
    );
    expect(candidate_ids(model_20)).toEqual(["card-prj-2", "card-general"]);

    const model_25 = expect_success(
      search_knowledge({ query: "夜景", target_model: "seedance-2.5" }),
    );
    expect(candidate_ids(model_25)).toEqual(["card-prj-1", "card-general"]);
  });

  test("search treats empty target models as universal", () => {
    const universal = make_card("card-universal", { target_models: [] });
    const for_25 = make_card("card-model-25", { target_models: ["seedance-2.5"] });
    const { target_models: _omitted, ...rest } = make_card("card-legacy");
    const legacy = { ...rest, priority: 8 } as unknown as KnowledgeCard;
    seed_cache([universal, for_25, legacy]);

    const result = expect_success(
      search_knowledge({ query: "内容", target_model: "seedance-2.0" }),
    );

    expect(result.degraded, "索引缺失时走缓存回退").toBe(true);
    expect(candidate_ids(result).sort()).toEqual(["card-legacy", "card-universal"]);
    expect(result.candidates.map((candidate) => candidate.match_level)).toEqual([null, null]);
  });

  test("search matches exact title and entity first", () => {
    seed_index([
      make_card("card-exact-title", { title: "夜景布光", priority: 1 }),
      make_card("card-exact-entity", {
        title: "光源手册",
        entities: ["夜景布光"],
        priority: 9,
      }),
      make_card("card-partial", { title: "夜景布光补充说明", priority: 99 }),
      make_card("card-content", { title: "别的标题", content: "正文提到夜景布光", priority: 99 }),
    ]);

    const result = expect_success(search_knowledge({ query: "夜景布光" }));

    expect(candidate_ids(result)).toEqual([
      "card-exact-entity",
      "card-exact-title",
      "card-partial",
      "card-content",
    ]);
    expect(result.candidates.map((candidate) => candidate.match_level)).toEqual([1, 1, 2, 3]);
  });

  test("search matches partial title and tags second", () => {
    seed_index([
      make_card("card-exact", { title: "布光", priority: 1 }),
      make_card("card-partial-title", { title: "布光基础", priority: 9 }),
      make_card("card-tag", { title: "光线笔记", tags: ["布光"], priority: 3 }),
    ]);

    const result = expect_success(search_knowledge({ query: "布光" }));

    expect(candidate_ids(result)).toEqual(["card-exact", "card-partial-title", "card-tag"]);
    expect(result.candidates.map((candidate) => candidate.match_level)).toEqual([1, 2, 2]);
  });

  test("search matches content last", () => {
    seed_index([
      make_card("card-partial-title", { title: "运动镜头基础", priority: 1 }),
      make_card("card-content", {
        title: "无关键词标题",
        content: "正文里提到运动镜头",
        priority: 99,
      }),
    ]);

    const result = expect_success(search_knowledge({ query: "运动镜头" }));

    expect(candidate_ids(result)).toEqual(["card-partial-title", "card-content"]);
    expect(result.candidates.map((candidate) => candidate.match_level)).toEqual([2, 3]);
  });

  test("search sorts by priority then updated at then card id", () => {
    const title = "排序校验";
    seed_index([
      make_card("card-p9-new", {
        title,
        priority: 9,
        updated_at: "2026-10-21T11:00:00+08:00",
      }),
      make_card("card-p9-old-b", {
        title,
        priority: 9,
        updated_at: "2026-10-21T10:00:00+08:00",
      }),
      make_card("card-p9-old-a", {
        title,
        priority: 9,
        updated_at: "2026-10-21T10:00:00+08:00",
      }),
      make_card("card-p7-new", {
        title,
        priority: 7,
        updated_at: "2026-10-21T12:00:00+08:00",
      }),
    ]);

    const result = expect_success(search_knowledge({ query: title }));

    expect(candidate_ids(result)).toEqual([
      "card-p9-new",
      "card-p9-old-a",
      "card-p9-old-b",
      "card-p7-new",
    ]);
    expect(result.candidates.map((candidate) => candidate.match_level)).toEqual([1, 1, 1, 1]);
  });

  test("search drops lowest ranked when over budget", () => {
    seed_index([
      make_card("card-1", { title: "预算校验", content: "内容一", priority: 9 }),
      make_card("card-2", { title: "预算校验", content: "内容二", priority: 8 }),
      make_card("card-3", { title: "预算校验", content: "内容三", priority: 7 }),
    ]);

    const result = expect_success(search_knowledge({ query: "预算校验", char_budget: 8 }));

    expect(candidate_ids(result)).toEqual(["card-1", "card-2"]);
    expect(result.dropped_by_budget).toEqual(["card-3"]);
    expect(result.context).toBe("内容一\n\n内容二");
    expect(result.context.length).toBeLessThanOrEqual(8);
  });

  test("search rejects negative limits", () => {
    seed_filter_fixture();

    expect(search_knowledge({ query: "夜景", max_cards: -1 })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "max_cards" } },
    });
    expect(search_knowledge({ query: "夜景", char_budget: -1 })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "char_budget" } },
    });
    expect(search_knowledge({ query: "夜景", max_cards: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "max_cards" } },
    });
    expect(search_knowledge({ query: "夜景", max_cards: "2" })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "max_cards" } },
    });
    expect(search_knowledge({ query: "夜景", char_budget: "10" })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", details: { field: "char_budget" } },
    });

    // 被拒绝的调用不留任何副作用：同一 fixture 仍然可正常检索。
    const after = expect_success(search_knowledge({ query: "夜景", max_cards: 1 }));
    expect(after.candidates).toHaveLength(1);
  });

  test("search returns empty with warning for empty query", () => {
    seed_filter_fixture();

    const blank = expect_success(search_knowledge({ query: "   ", scope: "project" }));
    expect(blank).toMatchObject({
      candidates: [],
      dropped_by_budget: [],
      degraded: false,
      context: "",
    });
    expect(warning_codes(blank)).toEqual(["EMPTY_QUERY"]);

    const empty = expect_success(search_knowledge({ query: "" }));
    expect(empty.candidates).toEqual([]);
    expect(warning_codes(empty)).toEqual(["EMPTY_QUERY"]);

    // 索引不可用时同样短路：不探测索引、不给降级候选、不带 INDEX_UNAVAILABLE。
    mkdirSync(path.dirname(index_file_path()), { recursive: true });
    writeFileSync(index_file_path(), "", "utf8");
    seed_cache([make_card("card-cached", { priority: 9 })]);
    const degraded_blank = expect_success(search_knowledge({ query: "   " }));
    expect(degraded_blank).toMatchObject({
      candidates: [],
      dropped_by_budget: [],
      degraded: false,
      context: "",
    });
    expect(warning_codes(degraded_blank)).toEqual(["EMPTY_QUERY"]);
  });

  test("search falls back to priority when index unavailable", () => {
    seed_cache([
      make_card("card-low", { priority: 1, updated_at: "2026-10-21T10:00:00+08:00" }),
      make_card("card-high", { priority: 9, updated_at: "2026-10-21T12:00:00+08:00" }),
      make_card("card-mid", { priority: 5, updated_at: "2026-10-21T11:00:00+08:00" }),
    ]);

    // 索引缺失：关键词匹配不重跑，命中级别为 null。
    const missing = expect_success(search_knowledge({ query: "根本匹配不到的关键词" }));
    expect(missing.degraded).toBe(true);
    expect(candidate_ids(missing)).toEqual(["card-high", "card-mid", "card-low"]);
    expect(missing.candidates.map((candidate) => candidate.match_level)).toEqual([
      null,
      null,
      null,
    ]);
    expect(warning_codes(missing)).toEqual(["INDEX_UNAVAILABLE"]);

    // 索引损坏：同样回退。
    mkdirSync(path.dirname(index_file_path()), { recursive: true });
    writeFileSync(index_file_path(), "", "utf8");
    const corrupt = expect_success(search_knowledge({ query: "夜景" }));
    expect(corrupt.degraded).toBe(true);
    expect(candidate_ids(corrupt)).toEqual(["card-high", "card-mid", "card-low"]);

    // 空查询在任何索引状态下都短路（见空查询用例）：不会给出降级候选。
    const blank = expect_success(search_knowledge({ query: "   " }));
    expect(blank).toMatchObject({ candidates: [], degraded: false });
    expect(warning_codes(blank)).toEqual(["EMPTY_QUERY"]);

    // 连缓存都没有：返回 INDEX_UNAVAILABLE 错误。
    rmSync(cache_file_path(), { force: true });
    const failed = search_knowledge({ query: "夜景" });
    expect(failed).toMatchObject({ ok: false, error: { code: "INDEX_UNAVAILABLE" } });
  });

  test("search never creates an index file when the index is absent", () => {
    seed_cache([make_card("card-cache-only", { priority: 4 })]);

    expect(existsSync(index_file_path()), "前置：索引文件不存在").toBe(false);
    expect(existsSync(path.dirname(index_file_path())), "前置：index/ 目录不存在").toBe(false);

    const result = expect_success(search_knowledge({ query: "内容" }));

    expect(result.degraded).toBe(true);
    expect(warning_codes(result)).toEqual(["INDEX_UNAVAILABLE"]);
    expect(candidate_ids(result)).toEqual(["card-cache-only"]);
    expect(existsSync(index_file_path()), "检索路径不得创建索引文件").toBe(false);
    expect(existsSync(path.dirname(index_file_path())), "检索路径不得创建 index/ 目录").toBe(
      false,
    );
  });

  test("search reads a ready index without writing to it", () => {
    seed_index([make_card("card-ready", { title: "只读校验" })]);
    const index_path = index_file_path();
    const frozen_time = new Date("2000-01-01T00:00:00Z");
    utimesSync(index_path, frozen_time, frozen_time);
    const mtime_before = statSync(index_path).mtimeMs;
    const bytes_before = readFileSync(index_path);

    const result = expect_success(search_knowledge({ query: "只读校验" }));

    expect(candidate_ids(result)).toEqual(["card-ready"]);
    expect(result.degraded).toBe(false);
    expect(statSync(index_path).mtimeMs, "检索不得写索引文件").toBe(mtime_before);
    expect(readFileSync(index_path).equals(bytes_before), "索引字节不得变化").toBe(true);
  });

  test("search returns the frozen candidate shape with source metadata", () => {
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

    const result = expect_success(search_knowledge({ query: "形状校验" }));

    expect(result.candidates).toEqual([
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
        match_level: 1,
      },
    ]);
    expect(result.context).toBe("正文");
    expect(result.warnings).toEqual([]);
  });

  test("search defaults to the configured top k and records the overflow", () => {
    write_config_file({ default_top_k: 2 });
    const title = "容量校验";
    seed_index([
      make_card("card-1", { title, priority: 9 }),
      make_card("card-2", { title, priority: 8 }),
      make_card("card-3", { title, priority: 7 }),
    ]);

    const result = expect_success(search_knowledge({ query: title }));

    expect(candidate_ids(result)).toEqual(["card-1", "card-2"]);
    expect(result.dropped_by_budget).toEqual(["card-3"]);
  });

  test("search caps candidates at max cards and records every dropped card", () => {
    const title = "上限校验";
    seed_index([
      make_card("card-1", { title, priority: 9 }),
      make_card("card-2", { title, priority: 8 }),
      make_card("card-3", { title, priority: 7 }),
    ]);

    const zero = expect_success(search_knowledge({ query: title, max_cards: 0 }));
    expect(zero.candidates).toEqual([]);
    expect(zero.dropped_by_budget).toEqual(["card-3", "card-2", "card-1"]);
    expect(zero.context).toBe("");

    const one = expect_success(search_knowledge({ query: title, max_cards: 1 }));
    expect(candidate_ids(one)).toEqual(["card-1"]);
    expect(one.dropped_by_budget).toEqual(["card-3", "card-2"]);
  });

  test("search reports explain as not available without changing candidates", () => {
    seed_filter_fixture();

    const plain = expect_success(search_knowledge({ query: "夜景" }));
    const explained = expect_success(search_knowledge({ query: "夜景", explain: true }));

    expect(warning_codes(explained)).toEqual(["EXPLAIN_NOT_AVAILABLE"]);
    expect(explained.candidates).toEqual(plain.candidates);
    expect(explained.dropped_by_budget).toEqual(plain.dropped_by_budget);
    expect(explained.context).toBe(plain.context);
  });

  test("search returns empty candidates when nothing matches", () => {
    seed_filter_fixture();

    const result = expect_success(search_knowledge({ query: "不存在关键词" }));

    expect(result.candidates).toEqual([]);
    expect(result.dropped_by_budget).toEqual([]);
    expect(result.context).toBe("");
    expect(result.warnings).toEqual([]);
    expect(result.degraded).toBe(false);
  });
});

describe("search_knowledge mcp dispatch", () => {
  test("tools/list exposes search_knowledge with a closed input schema", async () => {
    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const result = await client.listTools();
      const tool = result.tools.find((entry) => entry.name === "search_knowledge");
      expect(tool, "tools/list 应包含 search_knowledge").toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          scope: { type: "string" },
          project_id: { type: "string" },
          categories: { type: "array" },
          target_model: { type: "string" },
          max_cards: { type: "integer" },
          char_budget: { type: "integer" },
          explain: { type: "boolean" },
        },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("dispatching search_knowledge rejects invalid arguments fail-closed", async () => {
    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const unknown = parse_tool_json(
        await client.callTool({
          name: "search_knowledge",
          arguments: { query: "夜景", unexpected: true },
        }),
      );
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const bad_type = parse_tool_json(
        await client.callTool({
          name: "search_knowledge",
          arguments: { query: 5 },
        }),
      );
      expect(bad_type).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "query" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("dispatching search_knowledge returns candidates from the local index", async () => {
    seed_index([make_card("card-mcp", { title: "端到端校验", priority: 4 })]);

    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const payload = parse_tool_json(
        await client.callTool({
          name: "search_knowledge",
          arguments: { query: "端到端校验" },
        }),
      );
      expect(payload).toMatchObject({
        degraded: false,
        candidates: [
          {
            card_id: "card-mcp",
            title: "端到端校验",
            source_doc_token: DOC_A,
            match_level: 1,
          },
        ],
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
  const client = new Client({ name: "script2shot-search-dispatch-test", version: "0.0.0" });
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
