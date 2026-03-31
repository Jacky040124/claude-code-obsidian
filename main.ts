import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { ActiveFileContext, ClaudeCodeService } from "./src/claude-service";
import { ChatView, VIEW_TYPE_CLAUDE_CHAT } from "./src/chat-view";
import { FileSyncService } from "./src/file-sync";
import { ObsidianMcpServer } from "./src/mcp-server";
import {
  ClaudeCodeSettings,
  ClaudeCodeSettingTab,
  DEFAULT_SETTINGS,
} from "./src/settings";
import { discoverSkills } from "./src/slash-commands";
import { ConversationStore } from "./src/conversation-store";
import { QuickAction } from "./src/quick-actions";

export default class ClaudeCodePlugin extends Plugin {
  settings: ClaudeCodeSettings = DEFAULT_SETTINGS;
  private claudeService: ClaudeCodeService | null = null;
  private fileSyncService: FileSyncService | null = null;
  private mcpServer: ObsidianMcpServer | null = null;
  private conversationStore: ConversationStore | null = null;
  private activeConversationId: string | null = null;
  private currentSessionId: string | undefined;
  private activeFileContext: ActiveFileContext | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Start MCP server — gives Claude CLI access to vault editing tools
    this.mcpServer = new ObsidianMcpServer(this.app);
    let mcpPort: number | undefined;
    try {
      mcpPort = await this.mcpServer.start();
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

    // Initialize conversation store
    try {
      this.conversationStore = new ConversationStore(this.app);
      await this.conversationStore.initialize();
    } catch (err) {
      console.error("[claude-code] Failed to initialize conversation store:", err);
    }

    // Register the chat view
    this.registerView(VIEW_TYPE_CLAUDE_CHAT, (leaf) => {
      const view = new ChatView(leaf);
      view.setSendHandler((msg) => this.handleUserMessage(msg));
      view.setModel(this.settings.model);
      view.setSlashCommands(discoverSkills());
      view.setModelChangeHandler((model) => this.handleModelChange(model));

      // Conversation management handlers
      view.setNewChatHandler(() => this.handleNewChat());
      view.setSwitchConversationHandler((id) => this.handleSwitchConversation(id));
      view.setDeleteConversationHandler((id) => this.handleDeleteConversation(id));
      view.setRenameConversationHandler((id, title) => this.handleRenameConversation(id, title));

      // Message operation handlers
      view.setStopHandler(() => this.claudeService?.cancelRequest());
      view.setEditAndResendHandler((idx, content) => this.handleEditAndResend(idx, content));
      view.setRegenerateHandler(() => this.handleRegenerateResponse());

      if (this.activeFileContext) {
        view.setActiveFileContext({
          file: this.activeFileContext.filePath,
          content: undefined,
          selection: this.activeFileContext.selection,
        });
      }

      // Load conversation list and restore last active
      this.refreshConversationList(view);
      if (this.activeConversationId) {
        this.loadConversationIntoView(this.activeConversationId, view);
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
      callback: () => this.handleNewChat(),
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

    // Right-click quick actions
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (!selection) return;

        const actions = this.settings.quickActions.filter((a) => a.enabled);
        if (actions.length === 0) return;

        menu.addSeparator();
        for (const action of actions) {
          menu.addItem((item) => {
            item
              .setTitle(`Claude: ${action.label}`)
              .setIcon("bot")
              .onClick(() => this.runQuickAction(action, editor, selection));
          });
        }
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

  private async resolveAtReferences(message: string): Promise<string> {
    const pattern = /@([\w/.\-\u4e00-\u9fff ]+\.(?:md|canvas))/g;
    const matches = [...message.matchAll(pattern)];
    if (matches.length === 0) return message;

    const contextBlocks: string[] = [];
    for (const match of matches) {
      const path = match[1];
      const abstractFile = this.app.vault.getAbstractFileByPath(path);
      if (!(abstractFile instanceof TFile)) continue;

      let content = await this.app.vault.read(abstractFile);
      if (content.length > this.settings.maxAtReferenceChars) {
        content = content.slice(0, this.settings.maxAtReferenceChars) + "\n...truncated";
      }
      contextBlocks.push(`[Referenced note: ${path}]\n${content}\n`);
    }

    if (contextBlocks.length === 0) return message;
    return contextBlocks.join("\n") + "\n" + message;
  }

  private async buildGraphContext(filePath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return "";

    const cache = this.app.metadataCache.getFileCache(file);
    const maxNotes = this.settings.maxGraphNotes;

    // Outgoing links
    const outgoing: TFile[] = [];
    if (cache?.links) {
      for (const link of cache.links) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, filePath);
        if (dest instanceof TFile && outgoing.length < maxNotes) {
          outgoing.push(dest);
        }
      }
    }

    // Backlinks
    const backlinks: TFile[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
      if (targets[filePath] && targets[filePath] > 0 && sourcePath !== filePath) {
        const src = this.app.vault.getAbstractFileByPath(sourcePath);
        if (src instanceof TFile) {
          backlinks.push(src);
          if (backlinks.length >= maxNotes) break;
        }
      }
    }

    if (outgoing.length === 0 && backlinks.length === 0) return "";

    const getSummary = async (f: TFile): Promise<string> => {
      const fc = this.app.metadataCache.getFileCache(f);
      if (fc?.frontmatter?.description) return String(fc.frontmatter.description);

      const content = await this.app.vault.read(f);
      const lines = content.split("\n");
      let i = 0;
      // Skip frontmatter
      if (lines[0]?.trim() === "---") {
        i = 1;
        while (i < lines.length && lines[i].trim() !== "---") i++;
        i++; // skip closing ---
      }
      const summaryLines: string[] = [];
      while (i < lines.length && summaryLines.length < this.settings.graphSummaryLines) {
        const line = lines[i].trim();
        if (line) summaryLines.push(line);
        i++;
      }
      return summaryLines.join(" ");
    };

    const parts: string[] = [`[Graph context for ${file.basename}]`];

    if (outgoing.length > 0) {
      parts.push("Outgoing links:");
      for (const f of outgoing) {
        const summary = await getSummary(f);
        parts.push(`- ${f.path}: ${summary}`);
      }
    }

    if (backlinks.length > 0) {
      parts.push("Backlinks:");
      for (const f of backlinks) {
        const summary = await getSummary(f);
        parts.push(`- ${f.path}: ${summary}`);
      }
    }

    return parts.join("\n");
  }

  private async enrichWithFileContext(message: string): Promise<string> {
    if (!this.activeFileContext) return message;
    const ctx = this.activeFileContext;
    const parts = [`[Currently viewing: ${ctx.filePath}]`];
    if (ctx.selection) parts.push(`[Selected text: ${ctx.selection}]`);
    if (ctx.cursorLine != null) parts.push(`[Cursor at line ${ctx.cursorLine}]`);
    if (ctx.tags?.length) parts.push(`[Tags: ${ctx.tags.join(", ")}]`);

    if (this.settings.enableGraphContext) {
      const graphCtx = await this.buildGraphContext(ctx.filePath);
      if (graphCtx) parts.push(graphCtx);
    }

    return parts.join("\n") + "\n\n" + message;
  }

  private async runQuickAction(action: QuickAction, editor: Editor, selection: string): Promise<void> {
    if (!this.claudeService) {
      new Notice("Claude Code service not available");
      return;
    }

    const vaultPath = (
      this.app.vault.adapter as { getBasePath?: () => string }
    ).getBasePath?.();
    if (!vaultPath) {
      new Notice("Could not determine vault path");
      return;
    }

    const notice = new Notice(`Claude: ${action.label}...`, 0);

    try {
      const prompt = action.prompt.replace("{{selection}}", selection);
      const result = await this.claudeService.sendOneShot(prompt, vaultPath);

      if (!result) {
        notice.hide();
        new Notice("Claude returned an empty response");
        return;
      }

      if (action.mode === "replace") {
        editor.replaceSelection(result);
      } else {
        // insert_after
        editor.replaceSelection(selection + "\n\n" + result);
      }

      notice.hide();
      new Notice(`Claude: ${action.label} done`);
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Claude error: ${msg}`);
    }
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

    // Ensure we have an active conversation
    await this.ensureActiveConversation(message);

    // Save user message to store
    if (this.conversationStore && this.activeConversationId) {
      await this.conversationStore.addMessage(this.activeConversationId, {
        role: "user",
        content: message,
        timestamp: Date.now(),
      });
    }

    view.setStreaming(true);
    view.startAssistantTurn();

    let assistantText = "";
    let thinkingText = "";
    const toolBlockMap = new Map<string, { toolId: string; toolName: string; input: string; isComplete: boolean }>();

    try {
      const withRefs = await this.resolveAtReferences(message);
      const enrichedMessage = await this.enrichWithFileContext(withRefs);

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
            assistantText += event.text;
            view.appendTextDelta(event.text);
            break;
          case "thinking_delta":
            thinkingText += event.thinking;
            view.appendThinking(event.thinking);
            break;
          case "tool_start":
            toolBlockMap.set(event.toolId, { toolId: event.toolId, toolName: event.toolName, input: "", isComplete: false });
            view.addToolBlock(event.toolId, event.toolName);
            break;
          case "tool_input_delta": {
            const tb = toolBlockMap.get(event.toolId);
            if (tb) tb.input += event.partialJson;
            view.appendToolInput(event.toolId, event.partialJson);
            break;
          }
          case "tool_end": {
            const tb = toolBlockMap.get(event.toolId);
            if (tb) tb.isComplete = true;
            view.finalizeToolBlock(event.toolId);
            break;
          }
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
      await this.saveAssistantMessage(assistantText, thinkingText, toolBlockMap);
      this.refreshConversationList();
    }
  }

  // --- Conversation management ---

  private async saveAssistantMessage(
    text: string,
    thinking: string,
    toolBlockMap: Map<string, { toolId: string; toolName: string; input: string; isComplete: boolean }>
  ): Promise<void> {
    if (!this.conversationStore || !this.activeConversationId || !text) return;

    await this.conversationStore.addMessage(this.activeConversationId, {
      role: "assistant",
      content: text,
      timestamp: Date.now(),
      thinkingContent: thinking || undefined,
      toolBlocks: toolBlockMap.size > 0 ? Array.from(toolBlockMap.values()) : undefined,
    });

    if (this.currentSessionId) {
      await this.conversationStore.updateSessionId(
        this.activeConversationId,
        this.currentSessionId
      );
    }
  }

  private async ensureActiveConversation(firstMessage?: string): Promise<void> {
    if (this.activeConversationId && this.conversationStore?.get(this.activeConversationId)) {
      return;
    }
    if (!this.conversationStore) return;

    const conv = await this.conversationStore.create(firstMessage);
    this.activeConversationId = conv.id;
    this.currentSessionId = undefined;

    const view = this.getChatView();
    if (view) view.setActiveConversationId(conv.id);
  }

  private async handleNewChat(): Promise<void> {
    this.currentSessionId = undefined;
    this.activeConversationId = null;

    const view = this.getChatView();
    if (view) {
      view.clearMessages();
      view.setActiveConversationId(null);
    }

    this.refreshConversationList();
    new Notice("Started new chat");
  }

  private async handleSwitchConversation(id: string): Promise<void> {
    if (id === this.activeConversationId) return;
    const view = this.getChatView();
    if (!view) return;

    this.loadConversationIntoView(id, view);
  }

  private loadConversationIntoView(id: string, view: ChatView): void {
    const conv = this.conversationStore?.get(id);
    if (!conv) return;

    this.activeConversationId = id;
    this.currentSessionId = conv.sessionId;

    view.clearMessages();
    view.setActiveConversationId(id);

    // Replay messages into the view
    for (const msg of conv.messages) {
      if (msg.role === "user") {
        view.addMessage({
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        });
      } else {
        // Render assistant message as a completed turn
        view.startAssistantTurn();
        if (msg.thinkingContent) {
          view.appendThinking(msg.thinkingContent);
        }
        if (msg.toolBlocks) {
          for (const tb of msg.toolBlocks) {
            view.addToolBlock(tb.toolId, tb.toolName);
            if (tb.input) view.appendToolInput(tb.toolId, tb.input);
            if (tb.isComplete) view.finalizeToolBlock(tb.toolId);
          }
        }
        if (msg.content) {
          view.appendTextDelta(msg.content);
        }
        view.finishAssistantTurn();
      }
    }
  }

  private async handleDeleteConversation(id: string): Promise<void> {
    if (!this.conversationStore) return;
    await this.conversationStore.delete(id);

    if (id === this.activeConversationId) {
      // Switch to the most recent conversation or start fresh
      const list = this.conversationStore.listAll();
      if (list.length > 0) {
        this.handleSwitchConversation(list[0].id);
      } else {
        this.handleNewChat();
      }
    }

    this.refreshConversationList();
  }

  private async handleRenameConversation(id: string, title: string): Promise<void> {
    if (!this.conversationStore) return;
    await this.conversationStore.rename(id, title);
    this.refreshConversationList();
  }

  private async handleEditAndResend(messageIndex: number, newContent: string): Promise<void> {
    if (!this.conversationStore || !this.activeConversationId) return;

    // Truncate conversation after this message
    await this.conversationStore.truncateAfter(this.activeConversationId, messageIndex);

    // Reset session — edited message changes context
    this.currentSessionId = undefined;

    // Reload the truncated conversation and resend
    const view = this.getChatView();
    if (view) {
      this.loadConversationIntoView(this.activeConversationId, view);
      this.handleUserMessage(newContent);
    }
  }

  private async handleRegenerateResponse(): Promise<void> {
    if (!this.conversationStore || !this.activeConversationId) return;

    const conv = this.conversationStore.get(this.activeConversationId);
    if (!conv || conv.messages.length === 0) return;

    // Remove last assistant message
    await this.conversationStore.removeLastAssistantMessage(this.activeConversationId);

    // Find last user message (conv is modified in-place by removeLastAssistantMessage)
    const lastUserMsg = [...conv.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    // Reset session and resend
    this.currentSessionId = undefined;
    const view = this.getChatView();
    if (view) {
      this.loadConversationIntoView(this.activeConversationId, view);
      this.handleUserMessage(lastUserMsg.content);
    }
  }

  private refreshConversationList(view?: ChatView): void {
    const v = view ?? this.getChatView();
    if (!v || !this.conversationStore) return;
    v.setConversations(this.conversationStore.listAll());
    v.setActiveConversationId(this.activeConversationId);
  }
}
