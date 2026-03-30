import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs, path, and os before importing
vi.mock("fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { readdirSync, readFileSync, statSync } from "fs";
import { discoverSkills } from "../src/slash-commands";

const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

function mockDirectory() {
  return { isDirectory: () => true } as ReturnType<typeof statSync>;
}

function mockFile() {
  return { isDirectory: () => false } as ReturnType<typeof statSync>;
}

describe("discoverSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when ~/.claude/skills/ does not exist", () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(discoverSkills()).toEqual([]);
  });

  it("discovers a skill with name and description from SKILL.md frontmatter", () => {
    mockReaddirSync.mockReturnValue(["my-skill"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync.mockReturnValue(
      `---\nname: test-skill\ndescription: A test skill\n---\n\nBody content here.`
    );

    const skills = discoverSkills();
    expect(skills).toEqual([
      { name: "test-skill", description: "A test skill", isLocal: true },
    ]);
  });

  it("uses directory name as fallback when frontmatter has no name", () => {
    mockReaddirSync.mockReturnValue(["fallback-dir"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync.mockReturnValue(
      `---\ndescription: Some description\n---\n\nContent.`
    );

    const skills = discoverSkills();
    expect(skills).toEqual([
      { name: "fallback-dir", description: "Some description", isLocal: true },
    ]);
  });

  it("uses empty description when frontmatter has no description", () => {
    mockReaddirSync.mockReturnValue(["skill-dir"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync.mockReturnValue(
      `---\nname: named-skill\n---\n\nContent.`
    );

    const skills = discoverSkills();
    expect(skills).toEqual([
      { name: "named-skill", description: "", isLocal: true },
    ]);
  });

  it("skips non-directory entries", () => {
    mockReaddirSync.mockReturnValue(["a-file.md", "a-dir"] as any);
    mockStatSync
      .mockReturnValueOnce(mockFile())
      .mockReturnValueOnce(mockDirectory());
    mockReadFileSync.mockReturnValue(
      `---\nname: real-skill\ndescription: desc\n---\n`
    );

    const skills = discoverSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("real-skill");
  });

  it("skips directories without SKILL.md", () => {
    mockReaddirSync.mockReturnValue(["no-skill-md"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const skills = discoverSkills();
    expect(skills).toEqual([]);
  });

  it("discovers multiple skills", () => {
    mockReaddirSync.mockReturnValue(["skill-a", "skill-b"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync
      .mockReturnValueOnce(`---\nname: alpha\ndescription: First\n---\n`)
      .mockReturnValueOnce(`---\nname: beta\ndescription: Second\n---\n`);

    const skills = discoverSkills();
    expect(skills).toHaveLength(2);
    expect(skills[0]).toEqual({ name: "alpha", description: "First", isLocal: true });
    expect(skills[1]).toEqual({ name: "beta", description: "Second", isLocal: true });
  });

  it("strips quotes from frontmatter values", () => {
    mockReaddirSync.mockReturnValue(["quoted"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync.mockReturnValue(
      `---\nname: "quoted-name"\ndescription: 'quoted desc'\n---\n`
    );

    const skills = discoverSkills();
    expect(skills[0].name).toBe("quoted-name");
    expect(skills[0].description).toBe("quoted desc");
  });

  it("handles SKILL.md with no frontmatter — falls back to dir name", () => {
    mockReaddirSync.mockReturnValue(["bare-dir"] as any);
    mockStatSync.mockReturnValue(mockDirectory());
    mockReadFileSync.mockReturnValue("Just plain content, no frontmatter.");

    const skills = discoverSkills();
    expect(skills).toEqual([
      { name: "bare-dir", description: "", isLocal: true },
    ]);
  });

  it("continues past one bad entry and still discovers others", () => {
    mockReaddirSync.mockReturnValue(["bad", "good"] as any);
    mockStatSync
      .mockImplementationOnce(() => { throw new Error("permission denied"); })
      .mockReturnValueOnce(mockDirectory());
    mockReadFileSync.mockReturnValue(
      `---\nname: good-skill\ndescription: works\n---\n`
    );

    const skills = discoverSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("good-skill");
  });
});
