#!/usr/bin/env node
// 假 lark-cli：Task 4 起的封闭测试替身，只实现只读命令（--help / --version / auth status）。
// Task 5 追加 wiki +node-list 与 base +table-list 的只读应答。
// 行为开关：
//   FAKE_SCENARIO        ok | no-auth | old-version | missing-capability | bad-json |
//                        space-unreachable | base-unreachable | table-missing（默认 ok）
//   FAKE_AUTH_EXIT_CODE  覆盖 auth status 的退出码，用于覆盖 ok:false 且退出码为 0 的分支
//   FAKE_LOG_FILE        把每次调用的 argv 以 JSON Lines 追加记录
import { appendFileSync } from "node:fs";

const scenario = process.env.FAKE_SCENARIO ?? "ok";
const args = process.argv.slice(2);
const log_file = process.env.FAKE_LOG_FILE;
if (log_file) {
  appendFileSync(log_file, `${JSON.stringify({ scenario, args })}\n`, "utf8");
}

const HELP_COMMANDS = {
  wiki: ["+node-list", "+node-get", "+space-list"],
  docs: ["+fetch", "+create", "+update"],
  base: ["+table-create", "+table-list", "+record-batch-create", "+record-list", "+record-delete"],
  auth: ["status", "login", "logout", "list"],
};

function help_text(group) {
  let commands = HELP_COMMANDS[group];
  if (!commands) {
    return undefined;
  }
  if (scenario === "missing-capability" && group === "base") {
    commands = commands.filter((name) => name !== "+record-batch-create" && name !== "+record-delete");
  }
  return [
    `fake ${group} commands`,
    "",
    "Usage:",
    `  lark-cli ${group} [flags]`,
    `  lark-cli ${group} [command]`,
    "",
    "Available Commands:",
    ...commands.map((name) => `  ${name.padEnd(24)} fake help entry`),
    "",
  ].join("\n");
}

function exit_with(code) {
  process.exit(code);
}

if (args.length === 1 && args[0] === "--version") {
  const version = scenario === "old-version" ? "0.9.0" : "1.0.98";
  process.stdout.write(`lark-cli version ${version}\n`);
  exit_with(0);
}

const [group, sub] = args;
if (sub === "--help" && help_text(group) !== undefined) {
  process.stdout.write(help_text(group));
  exit_with(0);
}

if (group === "auth" && sub === "status") {
  if (scenario === "no-auth") {
    const override = process.env.FAKE_AUTH_EXIT_CODE;
    const exit_code = override === undefined ? 1 : Number.parseInt(override, 10);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "NOT_LOGGED_IN", message: "not logged in" } })}\n`,
    );
    process.stderr.write("fake-lark-cli: not logged in, run `lark-cli auth login`\n");
    exit_with(Number.isNaN(exit_code) ? 1 : exit_code);
  }
  if (scenario === "bad-json") {
    process.stdout.write("not-json{\n");
    process.stderr.write(`fake-lark-cli: invalid json payload ${"x".repeat(600)}\n`);
    exit_with(0);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      data: {
        identity: "fake-identity-1",
        user: { name: "测试用户", open_id: "ou_fake_1" },
        verified: args.includes("--verify"),
      },
    })}\n`,
  );
  exit_with(0);
}

if (group === "wiki" && sub === "+node-list") {
  if (scenario === "space-unreachable") {
    process.stderr.write("fake-lark-cli: wiki space unreachable\n");
    exit_with(1);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, data: { nodes: [], has_more: false, page_token: "" } })}\n`,
  );
  exit_with(0);
}

if (group === "base" && sub === "+table-list") {
  if (scenario === "base-unreachable") {
    process.stderr.write("fake-lark-cli: base unreachable\n");
    exit_with(1);
  }
  const tables = [
    { table_id: "tbl_cards", name: "KnowledgeCards" },
    { table_id: "tbl_state", name: "SyncState" },
  ];
  const response =
    scenario === "table-missing"
      ? tables.filter((table) => table.table_id !== "tbl_state")
      : tables;
  process.stdout.write(`${JSON.stringify({ ok: true, data: { tables: response } })}\n`);
  exit_with(0);
}

process.stderr.write(`fake-lark-cli: unsupported command: ${args.join(" ")}\n`);
exit_with(1);
