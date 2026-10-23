import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KnowledgeCard } from "../src/base_mapping.js";
import {
  CACHE_VERSION,
  cache_file_path,
  get_doc_marker,
  load_cache,
  remove_doc,
  save_cache,
  set_doc,
  type LocalCardCache,
} from "../src/cache.js";

let tempRoot = "";
let home = "";
let previousOverride: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-cache-"));
  home = path.join(tempRoot, "home");
  previousOverride = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = home;
});

afterEach(() => {
  if (previousOverride === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previousOverride;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function cache_dir(): string {
  return path.join(home, "cache");
}

function cards_path(): string {
  return path.join(cache_dir(), "cards.json");
}

function temp_files(): string[] {
  if (!existsSync(cache_dir())) {
    return [];
  }
  return readdirSync(cache_dir()).filter((name) => name.endsWith(".tmp"));
}

function make_card(
  card_id: string,
  token: string,
  overrides: Partial<KnowledgeCard> = {},
): KnowledgeCard {
  return {
    card_id,
    scope: "general",
    project_id: null,
    category: "prompt_technique",
    title: `卡片 ${card_id}`,
    content: `内容 ${card_id}`,
    tags: ["运镜", "构图"],
    entities: ["角色A"],
    target_models: [],
    priority: 5,
    source_doc_token: token,
    source_node_token: `node-${token}`,
    source_path: `/五夫临门/${token}`,
    source_title: `文档 ${token}`,
    source_revision: 3,
    source_block_id: null,
    updated_at: "2026-10-21T10:00:00+08:00",
    ...overrides,
  };
}

function empty_cache(): LocalCardCache {
  return { version: CACHE_VERSION, docs: {} };
}

describe("cache", () => {
  test("cache roundtrips docs cards and markers", () => {
    const cache = empty_cache();
    set_doc(
      cache,
      "doccn-a",
      { source_revision: 3, last_synced_at: "2026-10-21T10:00:00+08:00" },
      [make_card("card-a-1", "doccn-a"), make_card("card-a-2", "doccn-a", { priority: 8 })],
    );
    set_doc(
      cache,
      "doccn-b",
      { source_revision: 7, last_synced_at: "2026-10-21T11:30:00+08:00" },
      [make_card("card-b-1", "doccn-b", { scope: "project", project_id: "wufu-linmen" })],
    );

    save_cache(cache);

    expect(cache_file_path()).toBe(cards_path());
    const loaded = load_cache();
    expect(loaded.version).toBe(CACHE_VERSION);
    expect(loaded.rebuild_needed ?? false).toBe(false);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.docs).toEqual(cache.docs);

    expect(get_doc_marker("doccn-b")).toEqual({
      source_revision: 7,
      last_synced_at: "2026-10-21T11:30:00+08:00",
    });
    expect(get_doc_marker("missing-doc")).toBeUndefined();

    // 内存辅助函数直接改写传入的缓存对象，可再次保存。
    set_doc(
      loaded,
      "doccn-a",
      { source_revision: 4, last_synced_at: "2026-10-22T09:00:00+08:00" },
      [make_card("card-a-3", "doccn-a")],
    );
    remove_doc(loaded, "doccn-b");
    expect(Object.keys(loaded.docs)).toEqual(["doccn-a"]);
    expect(loaded.docs["doccn-a"]?.cards.map((card) => card.card_id)).toEqual(["card-a-3"]);

    save_cache(loaded);
    const reloaded = load_cache();
    expect(Object.keys(reloaded.docs)).toEqual(["doccn-a"]);
    expect(reloaded.docs["doccn-a"]?.source_revision).toBe(4);

    if (process.platform !== "win32") {
      expect(statSync(cards_path()).mode & 0o777, "缓存保存知识正文，权限须为 0600").toBe(0o600);
    }
  });

  test("cache reports missing file as empty cache", () => {
    expect(existsSync(cards_path())).toBe(false);

    const loaded = load_cache();

    expect(loaded).toEqual({ version: CACHE_VERSION, docs: {}, warnings: [] });
    expect(loaded.rebuild_needed).toBeUndefined();
    expect(get_doc_marker("doccn-a")).toBeUndefined();
    expect(existsSync(cache_dir()), "load 不得创建缓存目录").toBe(false);
  });

  test("cache reports corrupt file as rebuild needed", () => {
    mkdirSync(cache_dir(), { recursive: true });

    writeFileSync(cards_path(), "{ not json", "utf8");
    const unparseable = load_cache();
    expect(unparseable.rebuild_needed).toBe(true);
    expect(unparseable.version).toBe(CACHE_VERSION);
    expect(unparseable.docs).toEqual({});
    expect(unparseable.warnings.map((warning) => warning.code)).toEqual(["CACHE_CORRUPT"]);
    expect(readFileSync(cards_path(), "utf8"), "load 不得覆盖损坏文件").toBe("{ not json");

    const malformed = JSON.stringify({
      version: 1,
      docs: { "doccn-a": { source_revision: "3" } },
    });
    writeFileSync(cards_path(), malformed, "utf8");
    const malformed_result = load_cache();
    expect(malformed_result.rebuild_needed).toBe(true);
    expect(malformed_result.warnings.map((warning) => warning.code)).toEqual(["CACHE_CORRUPT"]);
    expect(readFileSync(cards_path(), "utf8"), "load 不得覆盖结构非法的文件").toBe(malformed);

    const unsupported_text = JSON.stringify({ version: 2, docs: {} });
    writeFileSync(cards_path(), unsupported_text, "utf8");
    const unsupported = load_cache();
    expect(unsupported.rebuild_needed).toBe(true);
    expect(unsupported.warnings.map((warning) => warning.code)).toEqual([
      "CACHE_VERSION_UNSUPPORTED",
    ]);
    expect(readFileSync(cards_path(), "utf8"), "不支持版本也不得被覆盖").toBe(unsupported_text);
  });

  test("cache classifies missing version, non-object roots, and missing docs", () => {
    mkdirSync(cache_dir(), { recursive: true });
    const cases: Array<{ raw: string; code: string }> = [
      {
        raw: JSON.stringify({ docs: {} }),
        code: "CACHE_VERSION_UNSUPPORTED",
      },
      {
        raw: JSON.stringify([]),
        code: "CACHE_CORRUPT",
      },
      {
        raw: JSON.stringify({ version: CACHE_VERSION }),
        code: "CACHE_CORRUPT",
      },
    ];

    for (const entry of cases) {
      writeFileSync(cards_path(), entry.raw, "utf8");
      const loaded = load_cache();
      expect(loaded.rebuild_needed, entry.raw).toBe(true);
      expect(loaded.docs, entry.raw).toEqual({});
      expect(loaded.warnings.map((warning) => warning.code), entry.raw).toEqual([entry.code]);
      expect(readFileSync(cards_path(), "utf8"), "load 不得覆盖非法规格").toBe(entry.raw);
    }
  });

  test("cache atomic write leaves no partial json", () => {
    const cache = empty_cache();
    set_doc(
      cache,
      "doccn-a",
      { source_revision: 1, last_synced_at: "2026-10-21T10:00:00+08:00" },
      [make_card("card-a-1", "doccn-a")],
    );
    save_cache(cache);
    const before = readFileSync(cards_path(), "utf8");
    expect(temp_files()).toEqual([]);

    // 序列化失败：旧文件保持原样，且不留下临时文件。
    const broken = empty_cache();
    set_doc(
      broken,
      "doccn-a",
      { source_revision: 2, last_synced_at: "2026-10-21T12:00:00+08:00" },
      [make_card("card-a-broken", "doccn-a", { priority: 1n as unknown as number })],
    );
    expect(() => save_cache(broken)).toThrow();
    expect(readFileSync(cards_path(), "utf8")).toBe(before);

    // 替换失败（目标位置被目录占用）：临时文件被清理，缓存目录仍可再次保存。
    rmSync(cards_path());
    mkdirSync(cards_path());
    const unreadable = load_cache();
    expect(unreadable.rebuild_needed).toBe(true);
    expect(unreadable.warnings.map((warning) => warning.code)).toEqual(["CACHE_UNREADABLE"]);
    expect(() => save_cache(cache)).toThrow();
    expect(temp_files()).toEqual([]);
    rmSync(cards_path(), { recursive: true, force: true });
    save_cache(cache);
    expect(load_cache().docs).toEqual(cache.docs);
  });

  test("cache ignores stray temp files in cache dir", () => {
    mkdirSync(cache_dir(), { recursive: true });
    const stray = path.join(cache_dir(), "cards.json.999.deadbeef.tmp");
    writeFileSync(stray, JSON.stringify({ version: 999, docs: { stray: {} } }), "utf8");

    const loaded = load_cache();
    expect(loaded).toEqual({ version: CACHE_VERSION, docs: {}, warnings: [] });

    const cache = empty_cache();
    set_doc(
      cache,
      "doccn-a",
      { source_revision: 1, last_synced_at: "2026-10-21T10:00:00+08:00" },
      [make_card("card-a-1", "doccn-a")],
    );
    save_cache(cache);

    const reloaded = load_cache();
    expect(Object.keys(reloaded.docs)).toEqual(["doccn-a"]);
    expect(existsSync(stray), "遗留临时文件必须原样保留").toBe(true);
    expect(temp_files(), "save 只清理自己的临时文件").toEqual([
      "cards.json.999.deadbeef.tmp",
    ]);
  });
});
