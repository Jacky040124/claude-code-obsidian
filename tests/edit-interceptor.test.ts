import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  Notice: class {
    constructor(_msg: string) {}
  },
  TFile: class {
    path = "";
  },
  Vault: class {},
}));

import { TFile } from "obsidian";
import {
  parseEditBlocks,
  hasIncompleteEditBlock,
  applyEdit,
  type EditBlock,
} from "../src/edit-interceptor";

// --- parseEditBlocks ---

describe("parseEditBlocks", () => {
  it("parses a single edit block", () => {
    const text = `Some text before
<<<OBSIDIAN_EDIT>>>
file_path: notes/test.md
action: edit
old_string: hello
new_string: world
<<<END_EDIT>>>
Some text after`;

    const { blocks, cleanText } = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      filePath: "notes/test.md",
      action: "edit",
      oldString: "hello",
      newString: "world",
    });
    expect(cleanText).toBe("Some text before\n\nSome text after");
  });

  it("parses a create block", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
file_path: new-file.md
action: create
new_string: # New File
<<<END_EDIT>>>`;

    const { blocks } = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      filePath: "new-file.md",
      action: "create",
      oldString: undefined,
      newString: "# New File",
    });
  });

  it("parses a write block", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
file_path: notes/overwrite.md
action: write
new_string: completely new content
<<<END_EDIT>>>`;

    const { blocks } = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].action).toBe("write");
    expect(blocks[0].newString).toBe("completely new content");
  });

  it("parses multiple edit blocks", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
file_path: a.md
action: edit
old_string: foo
new_string: bar
<<<END_EDIT>>>
Middle text
<<<OBSIDIAN_EDIT>>>
file_path: b.md
action: create
new_string: new content
<<<END_EDIT>>>`;

    const { blocks, cleanText } = parseEditBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].filePath).toBe("a.md");
    expect(blocks[1].filePath).toBe("b.md");
    expect(cleanText).toContain("Middle text");
    expect(cleanText).not.toContain("OBSIDIAN_EDIT");
  });

  it("returns empty blocks for text without edit markers", () => {
    const { blocks, cleanText } = parseEditBlocks("just normal text");
    expect(blocks).toHaveLength(0);
    expect(cleanText).toBe("just normal text");
  });

  it("does not parse incomplete blocks (no end marker)", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
file_path: test.md
action: edit
old_string: hello`;

    const { blocks, cleanText } = parseEditBlocks(text);
    expect(blocks).toHaveLength(0);
    expect(cleanText).toBe(text);
  });

  it("handles multi-line old_string and new_string", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
file_path: test.md
action: edit
old_string: line 1
line 2
line 3
new_string: replaced 1
replaced 2
<<<END_EDIT>>>`;

    const { blocks } = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oldString).toBe("line 1\nline 2\nline 3");
    expect(blocks[0].newString).toBe("replaced 1\nreplaced 2");
  });

  it("rejects edit block without old_string", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
file_path: test.md
action: edit
new_string: something
<<<END_EDIT>>>`;

    const { blocks } = parseEditBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it("rejects block without file_path", () => {
    const text = `<<<OBSIDIAN_EDIT>>>
action: create
new_string: content
<<<END_EDIT>>>`;

    const { blocks } = parseEditBlocks(text);
    expect(blocks).toHaveLength(0);
  });
});

// --- hasIncompleteEditBlock ---

describe("hasIncompleteEditBlock", () => {
  it("returns false for text without any edit markers", () => {
    expect(hasIncompleteEditBlock("normal text")).toBe(false);
  });

  it("returns false for text with completed edit block", () => {
    const text = "before <<<OBSIDIAN_EDIT>>> content <<<END_EDIT>>> after";
    expect(hasIncompleteEditBlock(text)).toBe(false);
  });

  it("returns true for text with started but not ended block", () => {
    const text = "text <<<OBSIDIAN_EDIT>>> partial content";
    expect(hasIncompleteEditBlock(text)).toBe(true);
  });

  it("returns true when last start is after last end", () => {
    const text = "<<<OBSIDIAN_EDIT>>> x <<<END_EDIT>>> <<<OBSIDIAN_EDIT>>> partial";
    expect(hasIncompleteEditBlock(text)).toBe(true);
  });

  it("returns false when all blocks are complete", () => {
    const text = "<<<OBSIDIAN_EDIT>>> a <<<END_EDIT>>> <<<OBSIDIAN_EDIT>>> b <<<END_EDIT>>>";
    expect(hasIncompleteEditBlock(text)).toBe(false);
  });
});

// --- applyEdit ---

describe("applyEdit", () => {
  function createMockApp() {
    return {
      vault: {
        getAbstractFileByPath: vi.fn(),
        create: vi.fn().mockResolvedValue(undefined),
        modify: vi.fn().mockResolvedValue(undefined),
        process: vi.fn(),
        createFolder: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  it("creates a new file", async () => {
    const app = createMockApp();
    app.vault.getAbstractFileByPath.mockReturnValue(null);

    const result = await applyEdit(app, {
      filePath: "new.md",
      action: "create",
      newString: "# Hello",
    });

    expect(result).toContain("Created");
    expect(app.vault.create).toHaveBeenCalledWith("new.md", "# Hello");
  });

  it("returns message if file already exists on create", async () => {
    const app = createMockApp();
    app.vault.getAbstractFileByPath.mockReturnValue({ path: "existing.md" });

    const result = await applyEdit(app, {
      filePath: "existing.md",
      action: "create",
      newString: "content",
    });

    expect(result).toContain("already exists");
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("creates parent folders for nested paths", async () => {
    const app = createMockApp();
    app.vault.getAbstractFileByPath.mockReturnValue(null);

    await applyEdit(app, {
      filePath: "deep/nested/file.md",
      action: "create",
      newString: "content",
    });

    expect(app.vault.createFolder).toHaveBeenCalledWith("deep/nested");
  });

  it("overwrites file on write action", async () => {
    const app = createMockApp();
    const mockFile = Object.create(TFile.prototype);
    mockFile.path = "test.md";
    app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

    const result = await applyEdit(app, {
      filePath: "test.md",
      action: "write",
      newString: "new content",
    });

    expect(result).toContain("Written");
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "new content");
  });

  it("edits file using vault.process on edit action", async () => {
    const app = createMockApp();
    const mockFile = Object.create(TFile.prototype);
    mockFile.path = "test.md";
    app.vault.getAbstractFileByPath.mockReturnValue(mockFile);
    app.vault.process.mockImplementation(async (_file: any, fn: (data: string) => string) => {
      fn("hello world");
    });

    const result = await applyEdit(app, {
      filePath: "test.md",
      action: "edit",
      oldString: "hello",
      newString: "goodbye",
    });

    expect(result).toContain("Edited");
    expect(app.vault.process).toHaveBeenCalled();
  });

  it("returns error if file not found for edit", async () => {
    const app = createMockApp();
    app.vault.getAbstractFileByPath.mockReturnValue(null);

    const result = await applyEdit(app, {
      filePath: "missing.md",
      action: "edit",
      oldString: "x",
      newString: "y",
    });

    expect(result).toContain("not found");
  });

  it("returns error if old_string not found in file", async () => {
    const app = createMockApp();
    const mockFile = Object.create(TFile.prototype);
    mockFile.path = "test.md";
    app.vault.getAbstractFileByPath.mockReturnValue(mockFile);
    app.vault.process.mockImplementation(async (_file: any, fn: (data: string) => string) => {
      fn("different content");
    });

    const result = await applyEdit(app, {
      filePath: "test.md",
      action: "edit",
      oldString: "not here",
      newString: "y",
    });

    expect(result).toContain("not found");
  });
});
