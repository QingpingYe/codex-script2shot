import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

describe("plugin manifest", () => {
  test("plugin manifest declares identity, mcp server and skills path", () => {
    const plugin = readJson("plugin.json");
    expect(plugin.name).toBe("script2shot");
    expect(plugin.version).toBe("0.3.0");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(typeof plugin.description).toBe("string");
    expect((plugin.description as string).trim().length).toBeGreaterThan(0);
    expect(plugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");

    const extensions = plugin.extensions as Record<string, Record<string, unknown>> | undefined;
    expect(extensions?.["com.openai"]?.onboardingSkill).toBe("./skills/setup/SKILL.md");

    const mcp = readJson("mcp.json");
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const server = servers?.script2shot;
    expect(server).toBeDefined();
    expect(server?.type).toBe("stdio");
    expect(server?.command).toBe("./scripts/launch_script2shot_mcp");

    const skillsDir = path.join(repoRoot, "skills");
    expect(existsSync(skillsDir) && statSync(skillsDir).isDirectory()).toBe(true);
  });

  test("launcher scripts exist and start server/dist/server.mjs", () => {
    const launchers = ["scripts/launch_script2shot_mcp.cmd", "scripts/launch_script2shot_mcp"];
    for (const launcher of launchers) {
      const absolutePath = path.join(repoRoot, launcher);
      expect(existsSync(absolutePath), `${launcher} should exist`).toBe(true);
      const contents = readFileSync(absolutePath, "utf8").replaceAll("\\", "/");
      expect(contents, `${launcher} should start server/dist/server.mjs`).toContain(
        "server/dist/server.mjs",
      );
      expect(contents, `${launcher} should reuse the private runtime`).toContain(
        ".codex-script2shot",
      );
      expect(contents, `${launcher} should respect SCRIPT2SHOT_HOME`).toContain(
        "SCRIPT2SHOT_HOME",
      );
    }
  });

  test("plugin declares onboarding skill that exists", () => {
    const plugin = readJson("plugin.json");
    const extensions = plugin.extensions as Record<string, Record<string, unknown>> | undefined;
    expect(extensions?.["com.openai"]?.onboardingSkill).toBe("./skills/setup/SKILL.md");

    const skillFile = path.join(repoRoot, "skills", "setup", "SKILL.md");
    expect(existsSync(skillFile), "skills/setup/SKILL.md should exist").toBe(true);

    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(skillFile, "utf8"));
    expect(frontmatter, "setup SKILL.md should start with YAML frontmatter").not.toBeNull();
    const name = /^name:\s*(.+?)\s*$/m.exec(frontmatter?.[1] ?? "");
    expect(name?.[1], "setup SKILL.md frontmatter name should be setup").toBe("setup");
  });
});

/**
 * Claude Code 侧清单（设计：docs/superpowers/specs/2026-10-30-claude-code-dual-harness-design.md）。
 * 三个文件与 Codex 侧并存，宿主各读各自的一份。
 */
describe("claude code manifest", () => {
  test("claude plugin manifest is valid and versioned in step with the codex manifest", () => {
    const claude = readJson(".claude-plugin/plugin.json");
    const codex = readJson("plugin.json");

    expect(claude.name).toBe("script2shot");
    expect(claude.version).toBe(codex.version);
    expect(claude.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof claude.description).toBe("string");
    expect((claude.description as string).trim().length).toBeGreaterThan(0);
  });

  test("claude marketplace points at the repo root and reuses the same version", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const claude = readJson(".claude-plugin/plugin.json");

    expect(typeof marketplace.name).toBe("string");
    const owner = marketplace.owner as Record<string, unknown> | undefined;
    expect(owner?.name).toBeTruthy();

    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("script2shot");
    expect(plugins[0].source).toBe("./");
    expect(plugins[0].version).toBe(claude.version);
  });

  test("claude mcp config launches the repo launcher through CLAUDE_PLUGIN_ROOT", () => {
    const mcp = readJson(".mcp.json");
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const server = servers?.core;
    expect(server).toBeDefined();
    expect(server?.command).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/launch_script2shot_mcp");
    expect(server?.type, "stdio 条目可不写 type").toBeUndefined();
    expect(server?.cwd, "MCP 条目不使用未文档化的 cwd 字段").toBeUndefined();
  });

  test("all plugin versions stay in sync across manifests and packages", () => {
    const canonical = readJson("plugin.json").version as string;
    const files: Array<[string, (value: Record<string, unknown>) => unknown]> = [
      [".claude-plugin/plugin.json", (value) => value.version],
      ["server/package.json", (value) => value.version],
      ["server/package-lock.json", (value) => (value as Record<string, unknown>).version],
    ];
    for (const [file, pick] of files) {
      expect(pick(readJson(file)), `${file} 的版本应与 plugin.json 一致`).toBe(canonical);
    }

    const marketplace = readJson(".claude-plugin/marketplace.json");
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    expect(plugins[0].version, "marketplace 条目版本应与 plugin.json 一致").toBe(canonical);

    const serverSource = readFileSync(path.join(repoRoot, "server", "src", "index.ts"), "utf8");
    expect(serverSource, "MCP Server 汇报的版本应与 plugin.json 一致").toContain(
      `version: "${canonical}"`,
    );
  });

  test("server dist is committed for marketplace distribution", () => {
    const dist = path.join(repoRoot, "server", "dist", "server.mjs");
    expect(existsSync(dist), "server/dist/server.mjs 必须随分发提交").toBe(true);
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain("!server/dist/server.mjs");
    const gitattributes = readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
    expect(gitattributes).toContain("server/dist/server.mjs text eol=lf");
  });

  test("launchers and bootstrap wrappers document the no-node fallback", () => {
    const wrappers = [
      "scripts/launch_script2shot_mcp",
      "scripts/launch_script2shot_mcp.cmd",
      "scripts/setup_bootstrap",
      "scripts/setup_bootstrap.cmd",
    ];
    for (const wrapper of wrappers) {
      const contents = readFileSync(path.join(repoRoot, wrapper), "utf8");
      expect(contents, `${wrapper} 应报中性的 Node 缺失信息`).toContain("未找到可用的 Node 运行时");
      expect(contents, `${wrapper} 不应再依赖 Codex 专属提示`).not.toContain("请更新 Codex");
    }
    for (const helper of ["scripts/ensure_node.ps1", "scripts/ensure_node.sh"]) {
      expect(existsSync(path.join(repoRoot, helper)), `${helper} should exist`).toBe(true);
    }

    // Windows PowerShell 5.1 无 BOM 时按 ANSI 解析含中文的脚本会报语法错误，
    // ensure_node.ps1 必须携带 UTF-8 BOM（2026-10-30 实测）。
    const ps1 = readFileSync(path.join(repoRoot, "scripts", "ensure_node.ps1"));
    expect(
      ps1[0] === 0xef && ps1[1] === 0xbb && ps1[2] === 0xbf,
      "ensure_node.ps1 必须带 UTF-8 BOM",
    ).toBe(true);
  });
});
