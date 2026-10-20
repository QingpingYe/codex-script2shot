import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ensure_local_dirs,
  load_config,
  resolve_home,
  save_config,
  type LoadConfigResult,
  type Script2ShotConfig,
} from "../src/config.js";

const FULL_CONFIG: Script2ShotConfig = {
  lark: {
    cli_path: "D:\\lark-cli\\lark-cli.exe",
    profile: "default",
    space_a: "wiki-space-a",
    base_b: "base-token-b",
    knowledge_cards_table_id: "tbl_cards",
    sync_state_table_id: "tbl_state",
  },
  retrieval: { default_top_k: 12 },
};

let tempRoot = "";
let previousOverride: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-config-"));
  previousOverride = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = tempRoot;
});

afterEach(() => {
  if (previousOverride === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previousOverride;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function configPath(home: string): string {
  return path.join(home, "config.toml");
}

function expect_loaded(result: LoadConfigResult): Extract<LoadConfigResult, { exists: true }> {
  if (!("exists" in result) || !result.exists) {
    throw new Error(`expected an existing config, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("config", () => {
  test("resolve_home honours SCRIPT2SHOT_HOME override", () => {
    const overrideHome = path.join(tempRoot, "override-home");
    process.env.SCRIPT2SHOT_HOME = overrideHome;
    expect(resolve_home()).toBe(overrideHome);

    delete process.env.SCRIPT2SHOT_HOME;
    expect(resolve_home()).toBe(path.join(os.homedir(), ".codex-script2shot"));

    process.env.SCRIPT2SHOT_HOME = "   ";
    expect(resolve_home()).toBe(path.join(os.homedir(), ".codex-script2shot"));
  });

  test("load_config reports missing file without creating it", () => {
    const home = path.join(tempRoot, "missing-home");
    process.env.SCRIPT2SHOT_HOME = home;

    expect(load_config()).toEqual({ exists: false, path: configPath(home) });
    expect(existsSync(home), "load_config must not create the home directory").toBe(false);
  });

  test("load_config reports invalid toml with file path", () => {
    const invalid = '[lark\ncli_path = "D:\\\\lark-cli\\\\lark-cli.exe"\n';
    writeFileSync(configPath(tempRoot), invalid, "utf8");

    const result = load_config();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.details.path).toBe(configPath(tempRoot));
      expect(result.error.message).toContain("TOML");
    }
    expect(readFileSync(configPath(tempRoot), "utf8"), "invalid config must not be rewritten").toBe(
      invalid,
    );
  });

  test("save_config dry run returns diff and writes nothing", () => {
    const home = path.join(tempRoot, "dry-run-home");
    process.env.SCRIPT2SHOT_HOME = home;

    const defaulted = save_config(FULL_CONFIG);
    expect(defaulted.dry_run).toBe(true);

    const missing = save_config(FULL_CONFIG, { dry_run: true });
    expect(missing.dry_run).toBe(true);
    expect(missing.path).toBe(configPath(home));
    expect(missing.diff).toContain("D:\\\\lark-cli");
    expect(existsSync(home), "dry run must not create the home directory").toBe(false);

    mkdirSync(home, { recursive: true });
    const before = '[lark]\ncli_path = "D:\\\\tools\\\\old-lark-cli.exe"\n';
    writeFileSync(configPath(home), before, "utf8");
    const updated: Script2ShotConfig = {
      ...FULL_CONFIG,
      lark: { ...FULL_CONFIG.lark, cli_path: "D:\\tools\\new-lark-cli.exe" },
    };

    const existing = save_config(updated, { dry_run: true });
    expect(existing.dry_run).toBe(true);
    expect(existing.diff).toContain("old-lark-cli");
    expect(existing.diff).toContain("new-lark-cli");
    expect(readFileSync(configPath(home), "utf8"), "dry run must not touch config.toml").toBe(before);
    expect(readdirSync(home), "dry run must not leave temp files").toEqual(["config.toml"]);
  });

  test("config roundtrip preserves lark and retrieval sections", () => {
    const saved = save_config(FULL_CONFIG, { dry_run: false });
    expect(saved.dry_run).toBe(false);
    expect(saved.path).toBe(configPath(tempRoot));
    expect(existsSync(configPath(tempRoot))).toBe(true);
    expect(readdirSync(tempRoot), "atomic replace must not leave temp files").toEqual(["config.toml"]);

    const loaded = expect_loaded(load_config());
    expect(loaded.config).toEqual(FULL_CONFIG);
    expect(loaded.warnings).toEqual([]);

    const updated: Script2ShotConfig = {
      ...FULL_CONFIG,
      lark: { ...FULL_CONFIG.lark, profile: "profile-2" },
    };
    expect(save_config(updated, { dry_run: false }).dry_run).toBe(false);
    expect(expect_loaded(load_config()).config).toEqual(updated);
    expect(readdirSync(tempRoot), "atomic replace must not leave temp files").toEqual([
      "config.toml",
    ]);
  });

  test("load_config fills retrieval default and warns on missing fields", () => {
    writeFileSync(
      configPath(tempRoot),
      '[lark]\ncli_path = "D:\\\\tools\\\\lark-cli.exe"\n',
      "utf8",
    );

    const loaded = expect_loaded(load_config());
    expect(loaded.config.lark.cli_path).toBe("D:\\tools\\lark-cli.exe");
    expect(loaded.config.lark.profile).toBeUndefined();
    expect(loaded.config.retrieval.default_top_k).toBe(12);

    const refs = loaded.warnings.flatMap((warning) => warning.refs ?? []);
    for (const key of [
      "profile",
      "space_a",
      "base_b",
      "knowledge_cards_table_id",
      "sync_state_table_id",
    ]) {
      expect(refs).toContain(`lark.${key}`);
    }
    expect(refs).toContain("retrieval.default_top_k");
    for (const warning of loaded.warnings) {
      expect(typeof warning.code).toBe("string");
      expect(warning.code.length).toBeGreaterThan(0);
      expect(warning.message.length).toBeGreaterThan(0);
    }

    writeFileSync(configPath(tempRoot), "", "utf8");
    const empty = expect_loaded(load_config());
    expect(empty.config.lark).toEqual({});
    expect(empty.config.retrieval.default_top_k).toBe(12);
    expect(empty.warnings.length).toBeGreaterThan(0);
  });

  test("load_config rejects mistyped known fields with CONFIG_INVALID", () => {
    writeFileSync(configPath(tempRoot), '[retrieval]\ndefault_top_k = "twelve"\n', "utf8");

    const result = load_config();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.details.path).toBe(configPath(tempRoot));
      expect(result.error.message).toContain("retrieval.default_top_k");
    }
  });

  test("ensure_local_dirs creates cache, index and logs once", () => {
    const home = path.join(tempRoot, "dirs-home");
    process.env.SCRIPT2SHOT_HOME = home;

    const first = ensure_local_dirs();
    expect(first.home).toBe(home);
    expect(first.created.map((created) => path.basename(created)).sort()).toEqual([
      "cache",
      "index",
      "logs",
    ]);
    for (const name of ["cache", "index", "logs"]) {
      expect(existsSync(path.join(home, name)), `${name} should exist after first call`).toBe(true);
    }

    const second = ensure_local_dirs();
    expect(second.home).toBe(home);
    expect(second.created).toEqual([]);
  });
});
