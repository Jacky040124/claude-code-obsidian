import { MarkdownView, Notice, Plugin } from "obsidian";
import { ActiveFileContext, ClaudeCodeService, InternalEvent } from "./src/claude-service";
import { ChatView, VIEW_TYPE_CLAUDE_CHAT } from "./src/chat-view";
import { FileSyncService } from "./src/file-sync";
import { ObsidianMcpServer } from "./src/mcp-server";
import {
  ClaudeCodeSettings,
  ClaudeCodeSettingTab,
  DEFAULT_SETTINGS,
} from "./src/settings";
import { discoverSkills } from "./src/slash-commands";

export default class ClaudeCodePlugin extends Plugin {
  settings: ClaudeCodeSettings = DEFAULT_SETTINGS;
  private claudeService: ClaudeCodeService | null = null;
  private fileSyncService: FileSyncService | null = null;
  private mcpServer: ObsidianMcpServer | null = null;
  private currentSessionId: string | undefined;
  private activeFileContext: ActiveFileContext | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Start MCP server — gives Claude CLI access to vault editing tools
    this.mcpServer = new ObsidianMcpServer(this.app);
    let mcpPort: number | undefined;
    try {
      mcpPort = await this.mcpServer.start();
      console.log(`[claude-code] MCP server started on port ${mcpPort}`);
    } catch (err) {
      console.error("[claude-code] Failed to start MCP server:", err);
      new Notice("Claude Code: MCP server failed to start");
    }

    // Initialize services
    this.claudeService = new ClaudeCodeService({
      claudeBinaryPath: this.settings.claudeBinaryPath,
      model: this.settings.model,
      allowedTools: this.settings.allowedTools,
      maxTurnMs: this.settings.maxResponseTimeout * 1000,
      mcpPort,
    });
    this.fileSyncService = new FileSyncService(this.app);

    // Register the chat view
    this.registerView(VIEW_TYPE_CLAUDE_CHAT, (leaf) => {
      const view = new ChatView(leaf);
      view.setSendHandler((msg) => this.handleUserMessage(msg));
      view.setModel(this.settings.model);
      view.setSlashCommands(discoverSkills());
      view.setModelChangeHandler((model) => this.handleModelChange(model));
      if (this.activeFileContext) {
        view.setActiveFileContext({
          file: this.activeFileContext.filePath,
          content: undefined,
          selection: this.activeFileContext.selection,
        });
      }
      return view;
    });

    // Ribbon icon — opens chat sidebar
    this.addRibbonIcon("message-square", "Open Claude Code Chat", () => {
      this.activateChatView();
    });

    // Commands
    this.addCommand({
      id: "open-chat",
      name: "Open Claude Code Chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "new-session",
      name: "New Chat Session",
      callback: () => {
        this.currentSessionId = undefined;
        const view = this.getChatView();
        if (view) view.clearMessages();
        new Notice("Started new Claude Code session");
      },
    });

    this.addCommand({
      id: "edit-current-note",
      name: "Edit Current Note with AI",
      editorCallback: async (editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active note to edit");
          return;
        }
        await this.activateChatView();
        const content = editor.getValue();
        const prompt = `Please review and suggest improvements for the note "${file.basename}":\n\n${content}`;
        this.handleUserMessage(prompt);
      },
    });

    // Track active file context
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view?.getViewType() === VIEW_TYPE_CLAUDE_CHAT) return;
        this.updateActiveContext();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf?.view?.getViewType() === VIEW_TYPE_CLAUDE_CHAT) return;
        this.updateActiveContext();
      })
    );

    // Settings tab
    this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));

    // Populate initial context from whatever file is already open
    this.updateActiveContext();
  }

  async onunload(): Promise<void> {
    this.claudeService?.cancelRequest();
    this.claudeService?.cleanupMcpConfig();
    this.claudeService = null;
    this.fileSyncService = null;
    await this.mcpServer?.stop();
    this.mcpServer = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Recreate service with updated settings
    if (this.claudeService) {
      this.claudeService.cancelRequest();
      this.claudeService.cleanupMcpConfig();
      this.claudeService = new ClaudeCodeService({
        claudeBinaryPath: this.settings.claudeBinaryPath,
        model: this.settings.model,
        allowedTools: this.settings.allowedTools,
        maxTurnMs: this.settings.maxResponseTimeout * 1000,
        mcpPort: this.mcpServer?.getPort(),
      });
    }
  }

  private async handleModelChange(model: string): Promise<void> {
    this.settings.model = model;
    await this.saveSettings();
    new Notice(`Switched to ${model}`);
  }

  // --- Private methods ---

  private async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_CLAUDE_CHAT,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private getChatView(): ChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
    if (leaves.length > 0) {
      return leaves[0].view as ChatView;
    }
    return null;
  }

  private updateActiveContext(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.activeFileContext = null;
      return;
    }

    const vaultPath = (
      this.app.vault.adapter as { getBasePath?: () => string }
    ).getBasePath?.();

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let selection: string | undefined;
    let cursorLine: number | undefined;
    let viewType = "unknown";

    if (mdView) {
      viewType = "markdown";
      const editor = mdView.editor;
      const sel = editor.getSelection();
      if (sel) selection = sel;
      cursorLine = editor.getCursor().line + 1; // 1-based
    } else {
      // Detect view type from the active leaf
      const leaf = this.app.workspace.activeLeaf;
      if (leaf) {
        viewType = leaf.view.getViewType();
      }
    }

    let frontmatter: Record<string, unknown> | undefined;
    let tags: string[] | undefined;
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache) {
      if (cache.frontmatter) {
        frontmatter = { ...cache.frontmatter };
      }
      if (cache.tags) {
        tags = cache.tags.map((t) => t.tag);
      }
    }

    this.activeFileContext = {
      filePath: file.path,
      absolutePath: vaultPath ? `${vaultPath}/${file.path}` : file.path,
      selection,
      cursorLine,
      frontmatter,
      tags,
      viewType,
    };

    // Push context to chat view for template expansion
    const chatView = this.getChatView();
    if (chatView) {
      chatView.setActiveFileContext({
        file: file.path,
        content: undefined, // loaded on demand by slash command expansion
        selection,
      });
    }
  }

  private enrichWithFileContext(message: string): string {
    if (!this.activeFileContext) return message;
    const ctx = this.activeFileContext;
    const parts = [`[Currently viewing: ${ctx.filePath}]`];
    if (ctx.selection) parts.push(`[Selected text: ${ctx.selection}]`);
    if (ctx.cursorLine != null) parts.push(`[Cursor at line ${ctx.cursorLine}]`);
    if (ctx.tags?.length) parts.push(`[Tags: ${ctx.tags.join(", ")}]`);
    return parts.join("\n") + "\n\n" + message;
  }

  private async handleUserMessage(message: string): Promise<void> {
    const view = this.getChatView();
    if (!view || !this.claudeService) return;

    const vaultPath = (
      this.app.vault.adapter as { getBasePath?: () => string }
    ).getBasePath?.();
    if (!vaultPath) {
      new Notice("Could not determine vault path");
      return;
    }

    // Check if CLI is available
    const available = await this.claudeService.isAvailable();
    if (!available) {
      new Notice(
        "Claude Code CLI not found. Install it or check the binary path in settings."
      );
      return;
    }

    view.setStreaming(true);
    view.startAssistantTurn();

    try {
      const enrichedMessage = this.enrichWithFileContext(message);

      const systemPrompt = this.settings.defaultSystemPrompt || undefined;

      const stream = this.currentSessionId
        ? this.claudeService.resumeSession(
            this.currentSessionId,
            enrichedMessage,
            vaultPath,
            systemPrompt
          )
        : this.claudeService.sendMessage(enrichedMessage, {
            workingDir: vaultPath,
            systemPrompt,
          });

      for await (const event of stream) {
        switch (event.kind) {
          case "text_delta":
            view.appendTextDelta(event.text);
            break;
          case "thinking_delta":
            view.appendThinking(event.thinking);
            break;
          case "tool_start":
            view.addToolBlock(event.toolId, event.toolName);
            break;
          case "tool_input_delta":
            view.appendToolInput(event.toolId, event.partialJson);
            break;
          case "tool_end":
            view.finalizeToolBlock(event.toolId);
            break;
          case "result":
            this.currentSessionId = event.sessionId;
            view.showResultInfo(event.costUsd, event.durationMs, event.numTurns);
            break;
          case "init":
            this.currentSessionId = event.sessionId;
            break;
          case "error":
            view.showError(event.message);
            break;
        }

        // Pass to file sync (handles non-MCP file changes like Bash-created files)
        this.fileSyncService?.handleEvent(event);
      }
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : "Unknown error occurred";
      view.showError(errMsg);
      new Notice(`Claude Code error: ${errMsg}`);
    } finally {
      view.finishAssistantTurn();
      view.setStreaming(false);
    }
  }
}
