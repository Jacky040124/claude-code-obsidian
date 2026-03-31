import { App, Notice, TFile, Vault } from "obsidian";
import { InternalEvent } from "./event-translator";

/**
 * Tracks files modified by Claude Code CLI and syncs changes back to Obsidian vault.
 */
export class FileSyncService {
  private app: App;
  private vault: Vault;
  private pendingEdits: Set<string> = new Set();
  // Track active tools: toolId -> { toolName, accumulatedJson }
  private activeTools: Map<string, { toolName: string; accumulatedJson: string }> = new Map();

  constructor(app: App) {
    this.app = app;
    this.vault = app.vault;
  }

  /**
   * Process an internal event and detect file modifications.
   */
  handleEvent(event: InternalEvent): void {
    switch (event.kind) {
      case "tool_start":
        this.activeTools.set(event.toolId, {
          toolName: event.toolName,
          accumulatedJson: "",
        });
        break;

      case "tool_input_delta": {
        const tool = this.activeTools.get(event.toolId);
        if (tool) {
          tool.accumulatedJson += event.partialJson;
        }
        break;
      }

      case "tool_end": {
        const tool = this.activeTools.get(event.toolId);
        this.activeTools.delete(event.toolId);
        if (tool && (tool.toolName === "Edit" || tool.toolName === "Write")) {
          try {
            const parsed = JSON.parse(tool.accumulatedJson);
            const filePath = parsed.file_path as string | undefined;
            if (filePath) {
              this.pendingEdits.add(filePath);
              void this.refreshPendingEdits();
            }
          } catch {
            // Incomplete or malformed JSON — skip
          }
        }
        break;
      }
    }
  }

  /**
   * Refresh all files that were recently edited by Claude.
   */
  private async refreshPendingEdits(): Promise<void> {
    const edits = Array.from(this.pendingEdits);
    this.pendingEdits.clear();

    const modified: string[] = [];

    for (const absPath of edits) {
      const vaultPath = this.toVaultRelativePath(absPath);
      if (!vaultPath) continue;

      try {
        await this.refreshFile(vaultPath);
        modified.push(vaultPath);
      } catch (err) {
        console.error(`[file-sync] Failed to refresh ${vaultPath}:`, err);
      }
    }

    if (modified.length > 0) {
      this.showEditNotification(modified);
    }
  }

  /**
   * Re-read a file from disk and update Obsidian's cache.
   */
  private async refreshFile(vaultPath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(vaultPath);

    if (file instanceof TFile) {
      // Read updated content from disk
      const content = await this.vault.adapter.read(vaultPath);

      // Update the cached content in Obsidian
      await this.vault.modify(file, content);

      // If the file is currently open in an editor, force refresh
      this.refreshActiveEditor(file);
    } else {
      // New file created by Claude — trigger vault scan
      const content = await this.vault.adapter.read(vaultPath);
      await this.vault.create(vaultPath, content);
    }
  }

  /**
   * If the modified file is open in an active editor, refresh the view.
   */
  private refreshActiveEditor(file: TFile): void {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && "file" in view && (view as { file: TFile }).file?.path === file.path) {
        this.app.workspace.trigger("file-open", file);
      }
    }
  }

  /**
   * Convert absolute file path to vault-relative path.
   */
  private toVaultRelativePath(absPath: string): string | null {
    const vaultRoot = (this.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
    if (!vaultRoot) return null;

    if (absPath.startsWith(vaultRoot)) {
      return absPath.slice(vaultRoot.length).replace(/^\//, "");
    }

    return null;
  }

  /**
   * Show a notification summarizing edits.
   */
  private showEditNotification(modified: string[]): void {
    if (modified.length === 1) {
      new Notice(`✓ Modified: ${modified[0]}`);
    } else {
      new Notice(`✓ Modified ${modified.length} files`);
    }
  }

  /**
   * Force a full vault refresh (e.g., after a batch operation).
   */
  async forceVaultRefresh(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    for (const file of files) {
      try {
        await this.vault.adapter.read(file.path);
      } catch {
        // File may have been deleted
      }
    }
  }
}
