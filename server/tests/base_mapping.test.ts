import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  base_cell_to_iso8601,
  from_base_record,
  iso8601_to_base_cell,
  to_base_fields,
  type KnowledgeCard,
  type SyncState,
} from "../src/base_mapping.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read_fixture(file_name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "tests", "fixtures", file_name), "utf8"),
  ) as unknown;
}

describe("base mapping", () => {
  test("card arrays serialise to json text fields", () => {
    const card = read_fixture("knowledge_card.valid.json") as KnowledgeCard;
    const fields = to_base_fields(card);
    expect(fields.tags).toBe(JSON.stringify(card.tags));
    expect(fields.entities).toBe(JSON.stringify(card.entities));
    expect(fields.target_models).toBe(JSON.stringify(card.target_models));
    expect(fields.priority).toBe(card.priority);
    expect(fields.source_revision).toBe(card.source_revision);
  });

  test("base record roundtrips card losslessly", () => {
    const card = read_fixture("knowledge_card.valid.json") as KnowledgeCard;
    const fields = to_base_fields(card);
    expect(from_base_record(fields)).toEqual(card);
    expect(from_base_record({ record_id: "recDEMO0001", fields })).toEqual(card);
  });

  test("datetime converts between iso8601 and base cell format", () => {
    expect(iso8601_to_base_cell("2026-10-20T12:00:00+08:00")).toBe("2026-10-20 12:00");
    expect(iso8601_to_base_cell("2026-10-20T04:00:00Z")).toBe("2026-10-20 12:00");
    expect(iso8601_to_base_cell("2026-10-20T20:00:00Z")).toBe("2026-10-21 04:00");
    expect(base_cell_to_iso8601("2026-10-20 12:00")).toBe("2026-10-20T12:00:00+08:00");
    expect(base_cell_to_iso8601("2026-10-20 23:59")).toBe("2026-10-20T23:59:00+08:00");
  });

  test("base cell accepts iso8601 readback values and truncates milliseconds", () => {
    expect(base_cell_to_iso8601("2026-10-21T16:59:00.000+08:00")).toBe(
      "2026-10-21T16:59:00+08:00",
    );
    expect(base_cell_to_iso8601("2026-10-21T16:59:00.999+08:00")).toBe(
      "2026-10-21T16:59:00+08:00",
    );
  });

  test("base cell normalizes equivalent iso8601 offsets to +08:00", () => {
    expect(base_cell_to_iso8601("2026-10-21T08:59:00Z")).toBe(
      "2026-10-21T16:59:00+08:00",
    );
    expect(base_cell_to_iso8601("2026-10-21T19:59:00+11:00")).toBe(
      "2026-10-21T16:59:00+08:00",
    );
    expect(base_cell_to_iso8601("2026-10-20T21:59:00-11:00")).toBe(
      "2026-10-21T16:59:00+08:00",
    );
  });

  test("base cell rejects invalid datetime values", () => {
    expect(() => base_cell_to_iso8601("not-a-date")).toThrow(
      /Base datetime 单元格.*"not-a-date"/,
    );
    expect(() => base_cell_to_iso8601("2026-02-30 12:00")).toThrow(
      /Base datetime 单元格.*"2026-02-30 12:00"/,
    );
    expect(() => base_cell_to_iso8601("2026-10-21T16:59:00")).toThrow(
      /Base datetime 单元格.*"2026-10-21T16:59:00"/,
    );
  });

  test("obj_edit_time stays an opaque string", () => {
    const state = read_fixture("sync_state.valid.json") as SyncState;
    const fields = to_base_fields(state);
    expect(typeof fields.obj_edit_time).toBe("string");
    expect(fields.obj_edit_time).toBe(state.obj_edit_time);
    expect(from_base_record(fields)).toEqual(state);
  });
});
