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
import { SETUP_DEFAULTS } from "../src/setup_defaults.js";
import {
  write_config,
  type WriteConfigInput,
  type WriteConfigResult,
} from "../src/tools/write_config.js";

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
    project_roots: [{ node_token: "wikcn-project-root-a", project_id: "demo" }],
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

  test("rejects explicit blank required keys before touching the filesystem", () => {
    const result = expect_error(
      write_config({ config: { lark: { space_a: "", base_b: "" } }, dry_run: false }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.missing_keys).toEqual(["lark.space_a", "lark.base_b"]);
    expect(existsSync(home), "invalid input must not create anything").toBe(false);
  });

  test("write_config applies setup defaults when omitted", () => {
    const preview = expect_success(write_config({ config: { lark: {} } }));

    expect(preview.applied_defaults).toEqual([
      "lark.profile",
      "lark.space_a",
      "lark.base_b",
      "lark.project_roots",
      "retrieval.default_top_k",
    ]);
    expect(preview.diff).toContain(SETUP_DEFAULTS.lark.space_a);
    expect(preview.diff).toContain(`base_b = "${SETUP_DEFAULTS.lark.base_b.slice(0, 6)}…"`);
    expect(preview.diff).toContain(SETUP_DEFAULTS.lark.project_roots[0].node_token);
    expect(
      JSON.stringify(preview),
      "默认 base_b 在返回值里同样必须掩码",
    ).not.toContain(SETUP_DEFAULTS.lark.base_b);
    expect(existsSync(home), "dry run must not create the home directory").toBe(false);

    const written = expect_success(write_config({ config: {}, dry_run: false }));
    expect(written.applied_defaults).toEqual(preview.applied_defaults);

    const loaded = load_config();
    if (!("exists" in loaded) || !loaded.exists) {
      throw new Error(`expected an existing config, got ${JSON.stringify(loaded)}`);
    }
    expect(loaded.config.lark).toEqual({
      profile: SETUP_DEFAULTS.lark.profile,
      space_a: SETUP_DEFAULTS.lark.space_a,
      base_b: SETUP_DEFAULTS.lark.base_b,
      project_roots: SETUP_DEFAULTS.lark.project_roots,
    });
    expect(loaded.config.retrieval.default_top_k).toBe(SETUP_DEFAULTS.retrieval.default_top_k);
  });

  test("setup defaults pin the shipped knowledge bases", () => {
    expect(SETUP_DEFAULTS.lark.profile).toBe("cli_aa20f40faa785d11");
    expect(SETUP_DEFAULTS.lark.space_a).toBe("7695983197091302359");
    expect(SETUP_DEFAULTS.lark.base_b).toBe("WRrVblDbqaEFOSs39P0cFzilnfd");
    expect(SETUP_DEFAULTS.lark.project_roots).toEqual([
      { node_token: "Ou9Vw0emviJajPklYjQc4fqjnie", project_id: "wufu-linmen" },
    ]);
    expect(SETUP_DEFAULTS.retrieval.default_top_k).toBe(12);
  });

  test("write_config reports the retrieval default only when it applies", () => {
    const omitted = expect_success(write_config({ config: { lark: {} } }));
    expect(omitted.applied_defaults).toContain("retrieval.default_top_k");
    expect(omitted.diff).toContain(`default_top_k = ${SETUP_DEFAULTS.retrieval.default_top_k}`);

    const empty_table = expect_success(write_config({ config: { retrieval: {} } }));
    expect(
      empty_table.applied_defaults,
      "retrieval 表存在但 default_top_k 缺省时，该值仍是默认填充",
    ).toContain("retrieval.default_top_k");

    const explicit = expect_success(
      write_config({ config: { retrieval: { default_top_k: 20 } } }),
    );
    expect(explicit.applied_defaults).not.toContain("retrieval.default_top_k");
    expect(explicit.diff).toContain("default_top_k = 20");
  });

  test("rejects non-object config containers as CONFIG_INVALID", () => {
    const cases: Array<{ input: unknown; field: string }> = [
      { input: { config: null }, field: "config" },
      { input: { config: [] }, field: "config" },
      { input: { config: "config" }, field: "config" },
      { input: { config: { lark: null } }, field: "lark" },
      { input: { config: { lark: [] } }, field: "lark" },
      { input: { config: { retrieval: null } }, field: "retrieval" },
      { input: { config: { retrieval: [] } }, field: "retrieval" },
    ];

    for (const { input, field } of cases) {
      const result = expect_error(write_config(input as WriteConfigInput));

      expect(result.error.code, `${field} 应被拒绝`).toBe("CONFIG_INVALID");
      expect(result.error.details?.field).toBe(field);
      expect(result.error.message).toContain(field);
      expect(existsSync(home), "invalid input must not create anything").toBe(false);
    }
  });

  test("rejects missing config before any filesystem work", () => {
    const result = expect_error(write_config({} as WriteConfigInput));

    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.field).toBe("config");
    expect(existsSync(home)).toBe(false);
  });

  test("rejects non-boolean dry_run and create_local_dirs", () => {
    for (const field of ["dry_run", "create_local_dirs"] as const) {
      for (const value of [0, "false"]) {
        const result = expect_error(
          write_config({
            config: FULL_CONFIG,
            [field]: value,
          } as unknown as WriteConfigInput),
        );

        expect(result.error.code).toBe("CONFIG_INVALID");
        expect(result.error.details?.field).toBe(field);
        expect(existsSync(home), "invalid input must not create anything").toBe(false);
      }
    }
  });

  test("write_config explicit values override defaults", () => {
    const explicit: Script2ShotConfig = {
      lark: {
        profile: "profile-2",
        space_a: SPACE_A,
        base_b: BASE_B,
        project_roots: [],
      },
      retrieval: { default_top_k: 5 },
    };

    const result = expect_success(write_config({ config: explicit, dry_run: false }));

    expect(result.applied_defaults).toEqual([]);
    const text = readFileSync(config_path(), "utf8");
    expect(text, "显式值优先，默认 base_b 不得写入").not.toContain(SETUP_DEFAULTS.lark.base_b);
    expect(text).toContain('profile = "profile-2"');

    const loaded = load_config();
    if (!("exists" in loaded) || !loaded.exists) {
      throw new Error(`expected an existing config, got ${JSON.stringify(loaded)}`);
    }
    expect(loaded.config).toEqual(explicit);
    expect(loaded.config.lark.project_roots).toEqual([]);
  });

  test("write_config trims every string field before writing", () => {
    const result = expect_success(
      write_config({
        config: {
          lark: {
            cli_path: "  D:\\lark-cli\\lark-cli.exe  ",
            profile: "  profile-2  ",
            space_a: "  space-a  ",
            base_b: "  base-token-b  ",
            knowledge_cards_table_id: "  tbl_cards  ",
            sync_state_table_id: "  tbl_state  ",
            project_roots: [{ node_token: "  wikcn-root  ", project_id: "  demo  " }],
          },
          retrieval: { default_top_k: 12 },
        },
        dry_run: false,
      }),
    );

    expect(result.written).toBe(true);
    expect(result.diff).toContain('profile = "profile-2"');
    expect(result.diff).toContain('space_a = "space-a"');

    const loaded = load_config();
    if (!("exists" in loaded) || !loaded.exists) {
      throw new Error(`expected an existing config, got ${JSON.stringify(loaded)}`);
    }
    expect(loaded.config.lark).toEqual({
      cli_path: "D:\\lark-cli\\lark-cli.exe",
      profile: "profile-2",
      space_a: "space-a",
      base_b: "base-token-b",
      knowledge_cards_table_id: "tbl_cards",
      sync_state_table_id: "tbl_state",
      project_roots: [{ node_token: "wikcn-root", project_id: "demo" }],
    });
  });

  test("write_config reports applied defaults", () => {
    const result = expect_success(
      write_config({
        config: { lark: { space_a: SPACE_A, base_b: BASE_B }, retrieval: { default_top_k: 12 } },
      }),
    );

    expect(result.applied_defaults).toEqual(["lark.profile", "lark.project_roots"]);
    expect(result.diff).toContain(`profile = "${SETUP_DEFAULTS.lark.profile}"`);
    expect(result.diff).toContain(SETUP_DEFAULTS.lark.project_roots[0].node_token);
  });

  test("rejects invalid project_roots entries with CONFIG_INVALID", () => {
    for (const [roots, field] of [
      ["wikcn-root", "lark.project_roots"],
      [[{ node_token: "", project_id: "demo" }], "lark.project_roots[0].node_token"],
      [[{ node_token: "wikcn-root", project_id: "" }], "lark.project_roots[0].project_id"],
      [[{ node_token: "wikcn-root" }], "lark.project_roots[0].project_id"],
    ] as Array<[unknown, string]>) {
      const result = expect_error(
        write_config({
          config: { ...FULL_CONFIG, lark: { ...FULL_CONFIG.lark, project_roots: roots } },
        }),
      );

      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.details?.field).toBe(field);
      expect(existsSync(home), "invalid input must not create anything").toBe(false);
    }
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

  test("masks the previous base token when the old config uses single quotes", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      config_path(),
      `[lark]\nspace_a = '${SPACE_A}'\nbase_b = '${OLD_BASE_B}'\n`,
      "utf8",
    );

    const result = expect_success(write_config({ config: FULL_CONFIG }));

    expect(result.diff).toContain(`base_b = '${OLD_BASE_B.slice(0, 6)}…'`);
    expect(JSON.stringify(result), "no full token may appear in the returned diff").not.toContain(
      BASE_B,
    );
    expect(JSON.stringify(result)).not.toContain(OLD_BASE_B);
  });
});
