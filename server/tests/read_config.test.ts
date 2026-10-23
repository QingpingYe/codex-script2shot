import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { read_config, type ReadConfigResult } from "../src/tools/read_config.js";

const SPACE_A = "space-a-1";
const BASE_B = "basetoken-b-123456789";
const MASKED_BASE_B = "baseto…";

let tempRoot = "";
let home = "";
let previousOverride: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-read-config-"));
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

function config_path(): string {
  return path.join(home, "config.toml");
}

function write_config_file(text: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(config_path(), text, "utf8");
}

function expect_success(result: ReadConfigResult): Exclude<ReadConfigResult, { ok: false }> {
  if ("ok" in result) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result;
}

function expect_error(result: ReadConfigResult): Extract<ReadConfigResult, { ok: false }> {
  if (!("ok" in result)) {
    throw new Error(`expected error, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("read_config", () => {
  test("reports a missing config without creating anything", () => {
    const result = expect_success(read_config());

    expect(result.exists).toBe(false);
    expect(result.path).toBe(config_path());
    expect(result.warnings).toEqual([]);
    expect("config" in result, "missing config must not carry a snapshot").toBe(false);
    expect(existsSync(home), "read_config must stay read-only").toBe(false);
  });

  test("returns a masked snapshot of an existing config", () => {
    write_config_file(
      [
        "[lark]",
        'cli_path = "D:\\\\lark-cli\\\\lark-cli.exe"',
        'profile = "default"',
        `space_a = "${SPACE_A}"`,
        `base_b = "${BASE_B}"`,
        'knowledge_cards_table_id = "tbl_cards"',
        'sync_state_table_id = "tbl_state"',
        "",
        "[[lark.project_roots]]",
        'node_token = "node-1"',
        'project_id = "demo"',
        "",
        "[retrieval]",
        "default_top_k = 12",
        "",
      ].join("\n"),
    );

    const result = expect_success(read_config());

    expect(result.exists).toBe(true);
    expect(result.path).toBe(config_path());
    expect(result.config?.lark.base_b_prefix).toBe(MASKED_BASE_B);
    expect(
      result.config?.lark,
      "the snapshot must replace base_b instead of echoing it",
    ).not.toHaveProperty("base_b");
    expect(JSON.stringify(result), "no full base token may appear in the result").not.toContain(
      BASE_B,
    );
    expect(result.config?.lark.cli_path).toBe("D:\\lark-cli\\lark-cli.exe");
    expect(result.config?.lark.profile).toBe("default");
    expect(result.config?.lark.space_a).toBe(SPACE_A);
    expect(result.config?.lark.knowledge_cards_table_id).toBe("tbl_cards");
    expect(result.config?.lark.sync_state_table_id).toBe("tbl_state");
    expect(result.config?.lark.project_roots).toEqual([
      { node_token: "node-1", project_id: "demo" },
    ]);
    expect(result.config?.retrieval).toEqual({ default_top_k: 12 });
    expect(result.warnings).toEqual([]);
  });

  test("reports broken TOML as CONFIG_INVALID with the config path", () => {
    write_config_file(`[lark\nspace_a = "${SPACE_A}"\n`);

    const result = expect_error(read_config());

    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details.path).toBe(config_path());
    expect(result.error.message.length).toBeGreaterThan(0);
  });
});
