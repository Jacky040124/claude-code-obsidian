import { App, Notice, TFile } from "obsidian";

export interface EditBlock {
  filePath: string;
  action: "edit" | "write" | "create";
  oldString?: string;
  newString: string;
}

const EDIT_START = "<<<OBSIDIAN_EDIT>>>";
const EDIT_END = "<<<END_EDIT>>>";

/**
 * System prompt instructing Claude to output edits in our structured format
 * instead of using the Edit/Write tools (which we remove from allowedTools).
 */
export const EDIT_INTERCEPTION_SYSTEM_PROMPT = `When you need to edit, write, or create a file, do NOT use the Edit or Write tools. Instead, output the change in this exact format:

${EDIT_START}
file_path: path/to/file
action: edit
old_string: text to find
new_string: replacement text
${EDIT_END}

For creating a new file:
${EDIT_START}
file_path: path/to/file
action: create
new_string: full file content here
${EDIT_END}

For overwriting a file completely:
${EDIT_START}
file_path: path/to/file
action: write
new_string: full new content here
${EDIT_END}

You may output multiple edit blocks in a single response. Always use this format for any file modifications.`;

/**
 * Parse edit blocks from accumulated assistant text.
 * Returns parsed blocks and the text with edit blocks removed for display.
 */
export function parseEditBlocks(text: string): { blocks: EditBlock[]; cleanText: string } {
  const blocks: EditBlock[] = [];
  let cleanText = text;

  // Find all complete edit blocks
  let startIdx = cleanText.indexOf(EDIT_START);
  while (startIdx !== -1) {
    const endIdx = cleanText.indexOf(EDIT_END, startIdx);
    if (endIdx === -1) break; // Incomplete block, wait for more text

    const blockContent = cleanText.substring(
      startIdx + EDIT_START.length,
      endIdx
    ).trim();

    const block = parseBlockContent(blockContent);
    if (block) {
      blocks.push(block);
    }

    // Remove the block from display text
    cleanText = cleanText.substring(0, startIdx) + cleanText.substring(endIdx + EDIT_END.length);

    startIdx = cleanText.indexOf(EDIT_START);
  }

  return { blocks, cleanText };
}

/**
 * Check if text contains an incomplete (started but not ended) edit block.
 */
export function hasIncompleteEditBlock(text: string): boolean {
  const lastStart = text.lastIndexOf(EDIT_START);
  if (lastStart === -1) return false;
  const lastEnd = text.lastIndexOf(EDIT_END);
  return lastEnd < lastStart;
}

function parseBlockContent(content: string): EditBlock | null {
  const lines = content.split("\n");
  let filePath = "";
  let action: "edit" | "write" | "create" = "edit";
  let oldString: string | undefined;
  let newString = "";
  let currentField: "none" | "old_string" | "new_string" = "none";
  const fieldLines: string[] = [];

  function flushField() {
    const value = fieldLines.join("\n");
    if (currentField === "old_string") {
      oldString = value;
    } else if (currentField === "new_string") {
      newString = value;
    }
    fieldLines.length = 0;
  }

  for (const line of lines) {
    // Check for field headers (only at the start of a line)
    if (line.startsWith("file_path:") && currentField === "none") {
      filePath = line.substring("file_path:".length).trim();
      continue;
    }
    if (line.startsWith("action:") && currentField === "none") {
      const a = line.substring("action:".length).trim();
      if (a === "edit" || a === "write" || a === "create") {
        action = a;
      }
      continue;
    }
    if (line.startsWith("old_string:")) {
      flushField();
      currentField = "old_string";
      const rest = line.substring("old_string:".length);
      if (rest.trimStart()) fieldLines.push(rest.trimStart());
      continue;
    }
    if (line.startsWith("new_string:")) {
      flushField();
      currentField = "new_string";
      const rest = line.substring("new_string:".length);
      if (rest.trimStart()) fieldLines.push(rest.trimStart());
      continue;
    }

    // Accumulate multi-line field content
    if (currentField !== "none") {
      fieldLines.push(line);
    }
  }
  flushField();

  if (!filePath || !newString) return null;
  if (action === "edit" && !oldString) return null;

  return { filePath, action, oldString, newString };
}

/**
 * Apply an edit block using Obsidian's vault API.
 */
export async function applyEdit(app: App, block: EditBlock): Promise<string> {
  const { filePath, action, oldString, newString } = block;

  if (action === "create") {
    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing) {
      return `File already exists: ${filePath}`;
    }
    // Ensure parent folders exist
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) {
      try {
        await app.vault.createFolder(dir);
      } catch {
        // Folder may already exist
      }
    }
    await app.vault.create(filePath, newString);
    new Notice(`Created: ${filePath}`);
    return `Created: ${filePath}`;
  }

  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) {
    return `File not found: ${filePath}`;
  }

  if (action === "write") {
    await app.vault.modify(file, newString);
    new Notice(`Written: ${filePath}`);
    return `Written: ${filePath}`;
  }

  // action === "edit"
  if (!oldString) {
    return `Edit failed: no old_string provided for ${filePath}`;
  }

  let found = false;
  await app.vault.process(file, (data) => {
    if (data.includes(oldString)) {
      found = true;
      return data.replace(oldString, newString);
    }
    return data;
  });

  if (!found) {
    return `Edit failed: old_string not found in ${filePath}`;
  }

  new Notice(`Edited: ${filePath}`);
  return `Edited: ${filePath}`;
}
