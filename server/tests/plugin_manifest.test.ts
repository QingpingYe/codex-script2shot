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
    expect(plugin.version).toBe("0.1.1");
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
