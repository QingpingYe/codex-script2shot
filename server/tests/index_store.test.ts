import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KnowledgeCard } from "../src/base_mapping.js";
import {
  delete_doc_rows,
  index_file_path,
  index_status,
  list_doc_markers,
  open_index,
  replace_doc_rows,
} from "../src/index_store.js";

const CARD_COLUMNS = [
  "card_id",
  "source_doc_token",
  "scope",
  "project_id",
  "category",
  "title",
  "title_norm",
  "content",
  "content_norm",
  "tags_json",
  "entities_json",
  "target_models_json",
  "priority",
  "updated_at",
  "source_path",
  "source_revision",
  "last_synced_at",
];

let tempRoot = "";
let home = "";
let previousOverride: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-index-"));
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
    tags: ["夜景", "Rain"],
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

function query_values(db: ReturnType<typeof open_index>, sql: string, ...params: string[]) {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => Object.values(row)[0]);
}

describe("index_store", () => {
  test("index rebuilds schema on empty file", () => {
    const file_path = index_file_path();
    expect(file_path).toBe(path.join(home, "index", "knowledge.sqlite"));

    // 探测缺失文件不创建任何内容。
    expect(index_status(file_path)).toEqual({ state: "missing", card_count: 0 });
    expect(existsSync(file_path)).toBe(false);
    expect(existsSync(path.join(home, "index"))).toBe(false);

    // open_index 自己创建 index/ 与数据库文件。
    const db = open_index();
    try {
      expect(existsSync(file_path)).toBe(true);
      expect(
        query_values(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
      ).toEqual(["cards", "doc_state"]);
      expect(
        query_values(db, "SELECT name FROM pragma_table_info('cards') ORDER BY cid"),
      ).toEqual(CARD_COLUMNS);
      const indexes = query_values(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cards' " +
          "AND name NOT LIKE 'sqlite_%'",
      );
      expect(indexes).toHaveLength(1);
      expect(
        query_values(
          db,
          "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
          indexes[0] as string,
        ),
      ).toEqual(["scope", "project_id", "category"]);
      expect(index_status(file_path)).toEqual({ state: "ready", card_count: 0 });
    } finally {
      db.close();
    }

    // 空（0 字节）文件按空库处理：再次打开自动重建 schema。
    writeFileSync(file_path, "");
    const reopened = open_index();
    try {
      expect(
        query_values(reopened, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
      ).toEqual(["cards", "doc_state"]);
      expect(index_status(file_path)).toEqual({ state: "ready", card_count: 0 });
    } finally {
      reopened.close();
    }
  });

  test("replace doc rows removes stale rows for same token", () => {
    const db = open_index();
    try {
      replace_doc_rows(
        db,
        "doccn-a",
        [
          make_card("card-a-1", "doccn-a", {
            title: "  雨夜　ＶＩＳＵＡＬ  ",
            content: "低照度\t冷色\n反光",
          }),
          make_card("card-a-2", "doccn-a", { priority: 9 }),
        ],
        { source_revision: 3, last_synced_at: "2026-10-21T10:00:00+08:00" },
      );
      replace_doc_rows(db, "doccn-b", [make_card("card-b-1", "doccn-b")], {
        source_revision: 4,
        last_synced_at: "2026-10-21T11:00:00+08:00",
      });

      const row = db.prepare("SELECT * FROM cards WHERE card_id = ?").get("card-a-1");
      expect(row?.title, "原始文本必须保留").toBe("  雨夜　ＶＩＳＵＡＬ  ");
      expect(row?.title_norm).toBe("雨夜 visual");
      expect(row?.content).toBe("低照度\t冷色\n反光");
      expect(row?.content_norm).toBe("低照度 冷色 反光");
      expect(row?.source_doc_token).toBe("doccn-a");
      expect(row?.scope).toBe("general");
      expect(row?.project_id).toBeNull();
      expect(row?.category).toBe("prompt_technique");
      expect(row?.tags_json).toBe(JSON.stringify(["夜景", "Rain"]));
      expect(row?.entities_json).toBe(JSON.stringify(["角色A"]));
      expect(row?.target_models_json).toBe("[]");
      expect(row?.priority).toBe(5);
      expect(row?.updated_at).toBe("2026-10-21T10:00:00+08:00");
      expect(row?.source_path).toBe("/五夫临门/doccn-a");
      expect(row?.source_revision).toBe(3);
      expect(row?.last_synced_at).toBe("2026-10-21T10:00:00+08:00");

      // 同一 token 再次替换：旧行删除，其他 token 不受影响。
      const marker = { source_revision: 5, last_synced_at: "2026-10-21T12:00:00+08:00" };
      replace_doc_rows(db, "doccn-a", [make_card("card-a-3", "doccn-a")], marker);
      expect(
        query_values(
          db,
          "SELECT card_id FROM cards WHERE source_doc_token = ? ORDER BY card_id",
          "doccn-a",
        ),
      ).toEqual(["card-a-3"]);
      expect(
        query_values(
          db,
          "SELECT card_id FROM cards WHERE source_doc_token = ? ORDER BY card_id",
          "doccn-b",
        ),
      ).toEqual(["card-b-1"]);

      // 重复替换同一份卡片不产生重复行。
      replace_doc_rows(db, "doccn-a", [make_card("card-a-3", "doccn-a")], marker);
      expect(
        query_values(db, "SELECT COUNT(*) FROM cards WHERE source_doc_token = ?", "doccn-a"),
      ).toEqual([1]);
    } finally {
      db.close();
    }
  });

  test("delete doc rows removes cards and marker", () => {
    const db = open_index();
    try {
      replace_doc_rows(
        db,
        "doccn-a",
        [make_card("card-a-1", "doccn-a"), make_card("card-a-2", "doccn-a")],
        { source_revision: 3, last_synced_at: "2026-10-21T10:00:00+08:00" },
      );
      replace_doc_rows(db, "doccn-b", [make_card("card-b-1", "doccn-b")], {
        source_revision: 4,
        last_synced_at: "2026-10-21T11:00:00+08:00",
      });

      delete_doc_rows(db, "doccn-a");

      expect(
        query_values(db, "SELECT COUNT(*) FROM cards WHERE source_doc_token = ?", "doccn-a"),
      ).toEqual([0]);
      expect(query_values(db, "SELECT COUNT(*) FROM cards WHERE source_doc_token = ?", "doccn-b")).toEqual(
        [1],
      );
      expect(list_doc_markers(db)).toEqual([
        {
          source_doc_token: "doccn-b",
          source_revision: 4,
          last_synced_at: "2026-10-21T11:00:00+08:00",
        },
      ]);

      // 重复删除是幂等的。
      delete_doc_rows(db, "doccn-a");
      expect(list_doc_markers(db).map((item) => item.source_doc_token)).toEqual(["doccn-b"]);
    } finally {
      db.close();
    }
  });

  test("index reports corrupt file instead of throwing", () => {
    const file_path = index_file_path();
    mkdirSync(path.dirname(file_path), { recursive: true });
    writeFileSync(file_path, Buffer.from("this is not a sqlite database file", "utf8"));

    expect(() => index_status(file_path)).not.toThrow();
    expect(index_status(file_path)).toEqual({ state: "corrupt", card_count: 0 });
  });

  test("doc state marker roundtrips revision and sync time", () => {
    const db = open_index();
    try {
      replace_doc_rows(db, "doccn-a", [make_card("card-a-1", "doccn-a")], {
        source_revision: 3,
        last_synced_at: "2026-10-21T10:00:00+08:00",
      });
      replace_doc_rows(db, "doccn-b", [make_card("card-b-1", "doccn-b")], {
        source_revision: 4,
        last_synced_at: "2026-10-21T11:00:00+08:00",
      });
      expect(list_doc_markers(db)).toEqual([
        {
          source_doc_token: "doccn-a",
          source_revision: 3,
          last_synced_at: "2026-10-21T10:00:00+08:00",
        },
        {
          source_doc_token: "doccn-b",
          source_revision: 4,
          last_synced_at: "2026-10-21T11:00:00+08:00",
        },
      ]);

      // 同一 token 再次替换：标记被更新而不是新增。
      replace_doc_rows(db, "doccn-a", [], {
        source_revision: 5,
        last_synced_at: "2026-10-21T12:00:00+08:00",
      });
      expect(list_doc_markers(db)).toEqual([
        {
          source_doc_token: "doccn-a",
          source_revision: 5,
          last_synced_at: "2026-10-21T12:00:00+08:00",
        },
        {
          source_doc_token: "doccn-b",
          source_revision: 4,
          last_synced_at: "2026-10-21T11:00:00+08:00",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("replace doc rows rolls back the whole document on insert failure", () => {
    const db = open_index();
    try {
      replace_doc_rows(db, "doccn-a", [make_card("card-a-1", "doccn-a")], {
        source_revision: 3,
        last_synced_at: "2026-10-21T10:00:00+08:00",
      });
      replace_doc_rows(db, "doccn-b", [make_card("card-b-1", "doccn-b")], {
        source_revision: 4,
        last_synced_at: "2026-10-21T11:00:00+08:00",
      });

      // card_id 是全表主键：跨 token 撞 ID 时整次替换失败并回滚。
      expect(() =>
        replace_doc_rows(
          db,
          "doccn-a",
          [make_card("card-a-2", "doccn-a"), make_card("card-b-1", "doccn-b")],
          { source_revision: 9, last_synced_at: "2026-10-21T23:00:00+08:00" },
        ),
      ).toThrow();

      expect(
        query_values(
          db,
          "SELECT card_id FROM cards WHERE source_doc_token = ? ORDER BY card_id",
          "doccn-a",
        ),
      ).toEqual(["card-a-1"]);
      expect(list_doc_markers(db)).toEqual([
        {
          source_doc_token: "doccn-a",
          source_revision: 3,
          last_synced_at: "2026-10-21T10:00:00+08:00",
        },
        {
          source_doc_token: "doccn-b",
          source_revision: 4,
          last_synced_at: "2026-10-21T11:00:00+08:00",
        },
      ]);
    } finally {
      db.close();
    }
  });
});
