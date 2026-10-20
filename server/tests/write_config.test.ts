import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { load_config, type Script2ShotConfig } from "../src/config.js";
import { write_config, type WriteConfigResult } from "../src/tools/write_config.js";

const SPACE_A = "space-a-1";
const BASE_B = "basetoken-b-123456789";
const OLD_BASE_B = "oldtoken-b-987654321";
const MASKED_BASE_B = "baseto…";

const FULL_CONFIG: Script2ShotConfig = {
  lark: {
    cli_path: "D:\\lark-cli\\lark-cli.exe",
    profile: "default",
    space_a: SPACE_A,
    base_b: BASE_B,
    knowledge_cards_table_id: "tbl_cards",
    sync_state_table_id: "tbl_state",
  },
  retrieval: { default_top_k: 12 },
};

let tempRoot = "";
let home = "";
let previousOverride: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-write-config-"));
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

function expect_success(result: WriteConfigResult): Exclude<WriteConfigResult, { ok: false }> {
  if ("ok" in result) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result;
}

function expect_error(result: WriteConfigResult): Extract<WriteConfigResult, { ok: false }> {
  if (!("ok" in result)) {
    throw new Error(`expected error, got ${JSON.stringify(result)}`);
  }
  return result;
}

function config_path(): string {
  return path.join(home, "config.toml");
}

describe("write_config", () => {
  test("dry run previews diff and planned directories without writing", () => {
    const result = expect_success(write_config({ config: FULL_CONFIG }));

    expect(result.dry_run).toBe(true);
    expect(result.written).toBe(false);
    expect(result.config_path).toBe(config_path());
    expect(result.created_dirs).toEqual([
      path.join(home, "cache"),
      path.join(home, "index"),
      path.join(home, "logs"),
    ]);
    expect(result.diff).toContain(`base_b = "${MASKED_BASE_B}"`);
    expect(result.diff).toContain(SPACE_A);
    expect(JSON.stringify(result), "dry-run output must not leak the full base token").not.toContain(
      BASE_B,
    );
    expect(existsSync(home), "dry run must not create the home directory").toBe(false);
  });

  test("dry run honours create_local_dirs=false", () => {
    const result = expect_success(write_config({ config: FULL_CONFIG, create_local_dirs: false }));

    expect(result.dry_run).toBe(true);
    expect(result.created_dirs).toEqual([]);
    expect(existsSync(home), "dry run must not create the home directory").toBe(false);
  });

  test("real run writes the full config, creates directories and stays idempotent", () => {
    const result = expect_success(write_config({ config: FULL_CONFIG, dry_run: false }));

    expect(result.dry_run).toBe(false);
    expect(result.written).toBe(true);
    expect(result.created_dirs).toEqual([
      path.join(home, "cache"),
      path.join(home, "index"),
      path.join(home, "logs"),
    ]);
    expect(result.diff, "returned diff must stay masked").not.toContain(BASE_B);
    expect(readFileSync(config_path(), "utf8"), "the file itself keeps the full token").toContain(
      BASE_B,
    );
    expect(readdirSync(home).sort()).toEqual(["cache", "config.toml", "index", "logs"]);

    const loaded = load_config();
    expect("exists" in loaded && loaded.exists).toBe(true);
    if ("exists" in loaded && loaded.exists) {
      expect(loaded.config).toEqual(FULL_CONFIG);
      expect(loaded.warnings).toEqual([]);
    }

    const second = expect_success(write_config({ config: FULL_CONFIG, dry_run: false }));
    expect(second.created_dirs).toEqual([]);
    expect(second.diff).toContain("（无变化）");
  });

  test("real run can keep local directories untouched", () => {
    const result = expect_success(
      write_config({ config: FULL_CONFIG, create_local_dirs: false, dry_run: false }),
    );

    expect(result.dry_run).toBe(false);
    expect(result.created_dirs).toEqual([]);
    expect(readdirSync(home)).toEqual(["config.toml"]);
  });

  test("rejects missing required keys before touching the filesystem", () => {
    const result = expect_error(write_config({ config: {}, dry_run: false }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.missing_keys).toEqual(["lark.space_a", "lark.base_b"]);
    expect(existsSync(home), "invalid input must not create anything").toBe(false);
  });

  test("rejects blank required keys with the specific missing key list", () => {
    const blank: Script2ShotConfig = {
      ...FULL_CONFIG,
      lark: { ...FULL_CONFIG.lark, base_b: "   " },
    };
    const result = expect_error(write_config({ config: blank }));

    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.missing_keys).toEqual(["lark.base_b"]);
    expect(existsSync(home), "invalid input must not create anything").toBe(false);
  });

  test("rejects a mistyped default_top_k", () => {
    const result = expect_error(
      write_config({ config: { ...FULL_CONFIG, retrieval: { default_top_k: "12" } } }),
    );

    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(result.error.details)).toContain("retrieval.default_top_k");
    expect(existsSync(home)).toBe(false);
  });

  test("masks the previous base token in a diff against an existing config", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      config_path(),
      `[lark]\nspace_a = "${SPACE_A}"\nbase_b = "${OLD_BASE_B}"\n`,
      "utf8",
    );

    const result = expect_success(write_config({ config: FULL_CONFIG }));

    expect(result.diff).toContain(`base_b = "${MASKED_BASE_B}"`);
    expect(result.diff).toContain(`base_b = "${OLD_BASE_B.slice(0, 6)}…"`);
    expect(JSON.stringify(result), "no full token may appear in the returned diff").not.toContain(
      BASE_B,
    );
    expect(JSON.stringify(result)).not.toContain(OLD_BASE_B);
  });
});
