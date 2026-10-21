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
import {
  fetch_knowledge_a_doc,
  type FetchKnowledgeADocResult,
} from "../src/tools/fetch_knowledge_a_doc.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const SPACE_A = "EXAMPLESPACE0001";
const RECORDED_DOC_TOKEN = "doccnEXAMPLEFIXTURE";
const LENS_NODE_TOKEN = "wikcnSAMPLEGENLENS";
const LENS_DOC_TOKEN = "doccnSAMPLEGENLENS";
const WIKI_URL = `https://feishu.cn/wiki/${LENS_NODE_TOKEN}`;
const FALLBACK_INPUT_TOKEN = "OBJTOKENFALLBACK0001";
const FALLBACK_OBJ_TOKEN = "doccnSAMPLEFALLBACK";
const TIPS_DOC_TOKEN = "doccnSAMPLEWITHTIPS";
const TIPS_TEXT = "正文可能被上游裁剪；重放本次读取请固定 revision_id=21。";
const NO_HEADING_NODE_TOKEN = "wikcnNOHEADING01";
const NO_HEADING_DOC_TOKEN = "doccnNOHEADING01";

let tempRoot = "";
let home = "";
let cliPath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-fetch-doc-"));
  home = path.join(tempRoot, "home");
  cliPath = install_fake_cli(path.join(tempRoot, "bin"));
  logPath = path.join(tempRoot, "calls.jsonl");
  env = {
    ...process.env,
    LARK_CLI_PATH: cliPath,
    FAKE_SCENARIO: "ok",
    FAKE_LOG_FILE: logPath,
    FAKE_DOCS_FETCH_FILE: write_docs_fetch_map(),
    FAKE_WIKI_NODE_GET_FILE: write_wiki_node_get_map(),
  };
  previousHome = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = home;
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
      "",
      "[retrieval]",
      "default_top_k = 12",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** docs +fetch 的录制索引：请求的 document token → 原始响应 payload。 */
function write_docs_fetch_map(): string {
  const recorded = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, "lark-docs-fetch.sample.json"), "utf8"),
  ) as unknown;
  const map_path = path.join(tempRoot, "docs-fetch-map.json");
  writeFileSync(
    map_path,
    `${JSON.stringify(
      {
        [RECORDED_DOC_TOKEN]: recorded,
        [LENS_DOC_TOKEN]: document_payload(
          LENS_DOC_TOKEN,
          7,
          "# 景别与机位\n\n镜头语言示例正文。\n",
        ),
        [FALLBACK_OBJ_TOKEN]: document_payload(
          FALLBACK_OBJ_TOKEN,
          9,
          "# 回退解析标题\n\n通过节点解析读取的正文。\n",
        ),
        [TIPS_DOC_TOKEN]: document_payload(
          TIPS_DOC_TOKEN,
          21,
          "# 带提示的示例标题\n\n带 tips 的示例正文。\n",
          TIPS_TEXT,
        ),
        [NO_HEADING_DOC_TOKEN]: document_payload(
          NO_HEADING_DOC_TOKEN,
          4,
          "没有标题行的正文段落。\n",
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return map_path;
}

/**
 * wiki +node-get 的录制索引：请求的 node token → 原始响应 payload。
 * 真实响应形状待 Task 7 live 核对，这里同时覆盖 `data.node` 嵌套与 `data` 平铺两种信封。
 */
function write_wiki_node_get_map(): string {
  const map_path = path.join(tempRoot, "wiki-node-get-map.json");
  writeFileSync(
    map_path,
    `${JSON.stringify(
      {
        [LENS_NODE_TOKEN]: {
          ok: true,
          identity: "user",
          data: { node: node_payload(LENS_NODE_TOKEN, LENS_DOC_TOKEN, "景别与机位") },
        },
        [FALLBACK_INPUT_TOKEN]: {
          ok: true,
          identity: "user",
          data: node_payload(FALLBACK_INPUT_TOKEN, FALLBACK_OBJ_TOKEN, "回退解析标题"),
        },
        [NO_HEADING_NODE_TOKEN]: {
          ok: true,
          identity: "user",
          data: {
            node: node_payload(NO_HEADING_NODE_TOKEN, NO_HEADING_DOC_TOKEN, "节点回退标题"),
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return map_path;
}

function document_payload(
  document_id: string,
  revision_id: number,
  content: string,
  tips = "",
): Record<string, unknown> {
  return {
    ok: true,
    identity: "user",
    data: {
      document: { document_id, revision_id, content, reference_map: {}, tips },
    },
  };
}

function node_payload(
  node_token: string,
  obj_token: string,
  title: string,
): Record<string, unknown> {
  return { node_token, obj_token, obj_type: "docx", node_type: "origin", title };
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

function expect_fetch_ok(
  result: FetchKnowledgeADocResult,
): Exclude<FetchKnowledgeADocResult, { ok: false }> {
  if ("ok" in result) {
    throw new Error(`期望读取成功，实际失败：${JSON.stringify(result)}`);
  }
  return result;
}

describe("fetch_knowledge_a_doc", () => {
  test("fetch parses document id revision and content", async () => {
    const result = expect_fetch_ok(
      await fetch_knowledge_a_doc({ doc: RECORDED_DOC_TOKEN, env }),
    );

    expect(result.doc_token).toBe(RECORDED_DOC_TOKEN);
    expect(result.revision_id).toBe(13);
    expect(result.title).toBe("示例文档标题");
    expect(result.content).toContain("这是合成的占位正文段落");
    expect(result.tips).toBe("");
    expect(result.warnings).toEqual([]);

    // 命令形态逐字固定：只发一次 docs +fetch，markdown 模式不传 --detail、不传 --scope。
    expect(read_calls().map((call) => call.args)).toEqual([
      [
        "docs",
        "+fetch",
        "--doc",
        RECORDED_DOC_TOKEN,
        "--doc-format",
        "markdown",
        "--revision-id",
        "-1",
        "--format",
        "json",
      ],
    ]);
  });

  test("fetch resolves wiki url to obj token", async () => {
    const result = expect_fetch_ok(await fetch_knowledge_a_doc({ doc: WIKI_URL, env }));

    expect(result.doc_token).toBe(LENS_DOC_TOKEN);
    expect(result.revision_id).toBe(7);
    expect(result.title).toBe("景别与机位");
    expect(result.warnings).toEqual([]);

    const calls = read_calls().map((call) => call.args);
    expect(calls.map((args) => [args[0], args[1]])).toEqual([
      ["wiki", "+node-get"],
      ["docs", "+fetch"],
    ]);
    expect(calls[0]).toEqual([
      "wiki",
      "+node-get",
      "--node-token",
      LENS_NODE_TOKEN,
      "--space-id",
      SPACE_A,
      "--as",
      "user",
    ]);
    expect(flag_value(calls[1], "--doc")).toBe(LENS_DOC_TOKEN);
  });

  test("fetch falls back to node resolution for unknown token", async () => {
    const result = expect_fetch_ok(
      await fetch_knowledge_a_doc({ doc: FALLBACK_INPUT_TOKEN, env }),
    );

    expect(result.doc_token).toBe(FALLBACK_OBJ_TOKEN);
    expect(result.title).toBe("回退解析标题");

    const calls = read_calls().map((call) => call.args);
    expect(calls.map((args) => [args[0], args[1]])).toEqual([
      ["docs", "+fetch"],
      ["wiki", "+node-get"],
      ["docs", "+fetch"],
    ]);
    expect(flag_value(calls[0], "--doc")).toBe(FALLBACK_INPUT_TOKEN);
    expect(flag_value(calls[1], "--node-token")).toBe(FALLBACK_INPUT_TOKEN);
    expect(flag_value(calls[2], "--doc")).toBe(FALLBACK_OBJ_TOKEN);
  });

  test("fetch returns DOC_FETCH_FAILED with original input", async () => {
    env.FAKE_SCENARIO = "docs-unreachable";
    const original_input = `https://feishu.cn/wiki/${NO_HEADING_NODE_TOKEN}`;

    const result = await fetch_knowledge_a_doc({ doc: original_input, env });

    if (!("ok" in result)) {
      throw new Error("期望读取失败");
    }
    expect(result.error.code).toBe("DOC_FETCH_FAILED");
    // details.doc 是输入原文（URL），不是解析出的 node/doc token。
    expect(result.error.details?.doc).toBe(original_input);
    expect(read_calls().map((call) => [call.args[0], call.args[1]])).toEqual([
      ["wiki", "+node-get"],
      ["docs", "+fetch"],
    ]);
  });

  test("fetch keeps tips for safe replay", async () => {
    const result = expect_fetch_ok(
      await fetch_knowledge_a_doc({ doc: TIPS_DOC_TOKEN, env }),
    );

    expect(result.tips).toBe(TIPS_TEXT);
    expect(result.doc_token).toBe(TIPS_DOC_TOKEN);
    expect(result.revision_id).toBe(21);
  });

  test("fetch resolves bare wiki token to obj token", async () => {
    const result = expect_fetch_ok(
      await fetch_knowledge_a_doc({ doc: LENS_NODE_TOKEN, env }),
    );

    expect(result.doc_token).toBe(LENS_DOC_TOKEN);
    const calls = read_calls().map((call) => call.args);
    expect(calls.map((args) => [args[0], args[1]])).toEqual([
      ["wiki", "+node-get"],
      ["docs", "+fetch"],
    ]);
    expect(flag_value(calls[0], "--node-token")).toBe(LENS_NODE_TOKEN);
    expect(flag_value(calls[1], "--doc")).toBe(LENS_DOC_TOKEN);
  });

  test("fetch returns DOC_FETCH_FAILED when node resolution fails", async () => {
    const original_input = "https://feishu.cn/wiki/wikcnNOTRECORDED";

    const result = await fetch_knowledge_a_doc({ doc: original_input, env });

    if (!("ok" in result)) {
      throw new Error("期望读取失败");
    }
    expect(result.error.code).toBe("DOC_FETCH_FAILED");
    expect(result.error.details?.doc).toBe(original_input);
    // 节点解析失败后不再拿原始 URL 当文档 token 重试。
    expect(read_calls().map((call) => [call.args[0], call.args[1]])).toEqual([
      ["wiki", "+node-get"],
    ]);
  });

  test("fetch falls back to node title when content has no heading", async () => {
    const result = expect_fetch_ok(
      await fetch_knowledge_a_doc({
        doc: `https://feishu.cn/wiki/${NO_HEADING_NODE_TOKEN}`,
        env,
      }),
    );

    expect(result.doc_token).toBe(NO_HEADING_DOC_TOKEN);
    expect(result.title).toBe("节点回退标题");
    expect(result.warnings.map((warning) => warning.code)).toEqual(["DOC_TITLE_FROM_NODE"]);
    expect(result.warnings[0].message).toContain("节点回退标题");
  });

  test("fetch reads docx url directly and warns when no title source exists", async () => {
    const result = expect_fetch_ok(
      await fetch_knowledge_a_doc({
        doc: `https://feishu.cn/docx/${NO_HEADING_DOC_TOKEN}`,
        env,
      }),
    );

    expect(result.title).toBe("");
    expect(result.warnings.map((warning) => warning.code)).toEqual(["DOC_TITLE_MISSING"]);
    const calls = read_calls().map((call) => call.args);
    expect(calls.map((args) => [args[0], args[1]])).toEqual([["docs", "+fetch"]]);
    expect(flag_value(calls[0], "--doc")).toBe(NO_HEADING_DOC_TOKEN);
  });
});
