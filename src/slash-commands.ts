import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SlashCommand {
  name: string;
  description: string;
  isLocal: true;
}

/**
 * Parse simple YAML frontmatter (between --- markers) from a string.
 * Returns a record of key-value pairs. No YAML library needed.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return result;

  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) {
      // Strip surrounding quotes if present
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

/**
 * Discover skills from ~/.claude/skills/ directories.
 * Each skill directory should contain a SKILL.md with YAML frontmatter
 * defining `name` and `description`.
 */
export function discoverSkills(): SlashCommand[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  const commands: SlashCommand[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    // ~/.claude/skills/ doesn't exist or isn't readable
    return commands;
  }

  for (const entry of entries) {
    try {
      const entryPath = join(skillsDir, entry);
      const stat = statSync(entryPath); // follows symlinks by default
      if (!stat.isDirectory()) continue;

      const skillMdPath = join(entryPath, "SKILL.md");
      const content = readFileSync(skillMdPath, "utf-8");
      const frontmatter = parseFrontmatter(content);

      const name = frontmatter.name || entry;
      const description = frontmatter.description || "";

      commands.push({ name, description, isLocal: true });
    } catch {
      // Skip entries with missing SKILL.md, permission errors, etc.
      continue;
    }
  }

  return commands;
}
