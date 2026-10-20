import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const skillsRoot = path.join(repoRoot, "skills");

function listSkillFiles(): { skillDir: string; skillFile: string }[] {
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot)
    .filter((entry) => statSync(path.join(skillsRoot, entry)).isDirectory())
    .map((entry) => ({ skillDir: entry, skillFile: path.join(skillsRoot, entry, "SKILL.md") }))
    .filter((entry) => existsSync(entry.skillFile));
}

function parseFrontmatter(markdown: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) {
      fields[field[1]] = field[2].trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1");
    }
  }
  return fields;
}

describe("skills contract", () => {
  const skillFiles = listSkillFiles();

  test.skipIf(skillFiles.length === 0)(
    "every skill has matching name and non-empty description",
    () => {
      for (const { skillDir, skillFile } of skillFiles) {
        const fields = parseFrontmatter(readFileSync(skillFile, "utf8"));
        expect(fields, `${skillDir}/SKILL.md should start with YAML frontmatter`).toBeDefined();
        expect(fields?.name, `${skillDir}/SKILL.md name should match its directory`).toBe(skillDir);
        expect((fields?.description ?? "").trim().length, `${skillDir}/SKILL.md description should be non-empty`).toBeGreaterThan(0);
      }
    },
  );
});
