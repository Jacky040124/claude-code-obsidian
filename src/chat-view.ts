import {
	ItemView,
	MarkdownRenderer,
	Menu,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { SlashCommand } from "./slash-commands";
import { ConversationSummary } from "./conversation-store";
import { renderIcon } from "./icons";

export interface FileContext {
	file?: string;
	content?: string;
	selection?: string;
}

export const VIEW_TYPE_CLAUDE_CHAT = "claude-code-chat-view";

const MODELS = [
	{ id: "haiku", label: "Haiku", desc: "Fast & lightweight" },
	{ id: "sonnet", label: "Sonnet", desc: "Balanced & capable" },
	{ id: "opus", label: "Opus", desc: "Maximum reasoning" },
] as const;

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface FileAttachment {
	name: string;
	type: string; // MIME type
	size: number;
	data: ArrayBuffer;
	previewUrl?: string; // Object URL for image previews
}

// --- MCP tool name helpers ---

interface McpToolInfo {
	isMcp: boolean;
	isVaultOp: boolean;
	displayName: string;
	action: string; // verb for summary, e.g. "Editing", "Writing"
}

const VAULT_TOOL_MAP: Record<string, { displayName: string; action: string }> = {
	obsidian_edit: { displayName: "Vault Edit", action: "Editing" },
	obsidian_write: { displayName: "Vault Write", action: "Writing" },
	obsidian_create: { displayName: "Vault Create", action: "Creating" },
	obsidian_read_active: { displayName: "Vault Read", action: "Reading active file" },
	obsidian_search: { displayName: "Vault Search", action: "Searching vault" },
};

function parseMcpToolName(rawName: string): McpToolInfo {
	// MCP tool names look like "mcp__obsidian__obsidian_edit"
	const mcpMatch = rawName.match(/^mcp__([^_]+(?:__[^_]+)?)__(.+)$/);
	if (!mcpMatch) {
		return { isMcp: false, isVaultOp: false, displayName: rawName, action: rawName };
	}

	const toolSuffix = mcpMatch[2]; // e.g. "obsidian_edit"
	const vaultInfo = VAULT_TOOL_MAP[toolSuffix];
	if (vaultInfo) {
		return { isMcp: true, isVaultOp: true, displayName: vaultInfo.displayName, action: vaultInfo.action };
	}

	// Generic MCP tool — show the suffix in a readable form
	const readable = toolSuffix.replace(/_/g, " ");
	return { isMcp: true, isVaultOp: false, displayName: readable, action: readable };
}

// --- Tool arg summary helpers ---

function summarizeToolArgs(toolName: string, json: Record<string, unknown>): string {
	const str = (val: unknown, fallback: string): string =>
		typeof val === "string" ? val : fallback;

	// Check for MCP vault tools first
	const mcpInfo = parseMcpToolName(toolName);
	if (mcpInfo.isVaultOp) {
		const filePath = str(json.file_path ?? json.path, "");
		if (mcpInfo.action === "Reading active file") {
			return "Reading active file";
		}
		return filePath ? `${mcpInfo.action} ${filePath}` : mcpInfo.action;
	}
	if (mcpInfo.isMcp) {
		// Generic MCP tool — show action + first string arg if available
		const firstArg = Object.values(json).find((v) => typeof v === "string");
		return firstArg ? `${mcpInfo.action}: ${firstArg}` : mcpInfo.action;
	}

	switch (toolName) {
		case "Read":
			return `Reading ${str(json.file_path ?? json.path, "file")}`;
		case "Bash":
			return `Running: ${str(json.command, "command")}`;
		case "Grep":
			return `Searching: ${str(json.pattern, "pattern")}`;
		case "Edit":
			return `Editing ${str(json.file_path ?? json.path, "file")}`;
		case "Write":
			return `Writing ${str(json.file_path ?? json.path, "file")}`;
		case "Glob":
			return `Globbing ${str(json.pattern, "pattern")}`;
		default:
			return toolName;
	}
}

// --- Tool block state ---

interface ToolBlockState {
	containerEl: HTMLElement;
	headerEl: HTMLElement;
	summaryEl: HTMLElement;
	statusEl: HTMLElement;
	bodyEl: HTMLElement;
	preEl: HTMLElement;
	toolName: string;
	accumulatedJson: string;
	finalized: boolean;
}

export class ChatView extends ItemView {
	private messageListEl: HTMLElement;
	private inputEl: HTMLTextAreaElement;
	private sendBtnEl: HTMLButtonElement;
	private messages: ChatMessage[] = [];
	private commandHistory: string[] = [];
	private historyIndex = -1;
	private isStreaming = false;
	private autocompleteEl: HTMLElement;
	private autocompleteFiles: TFile[] = [];
	private autocompleteIndex = 0;
	private onSendMessage: ((message: string, attachments?: FileAttachment[]) => void) | null = null;

	// --- Model selector state ---
	private currentModel = "sonnet";
	private modelSelectorEl: HTMLElement | null = null;
	private modelDropdownEl: HTMLElement | null = null;
	private modelDropdownIndex = -1;
	private onModelChange: ((model: string) => void) | null = null;
	private closeDropdownHandler: ((e: MouseEvent) => void) | null = null;
	private closeDropdownKeyHandler: ((e: KeyboardEvent) => void) | null = null;

	// --- Slash command autocomplete state ---
	private slashAutocompleteEl: HTMLElement | null = null;
	private slashCommands: SlashCommand[] = [];
	private filteredSlashCommands: SlashCommand[] = [];
	private slashAutocompleteIndex = 0;
	private activeFileContext: FileContext = {};
	private fileIndicatorEl: HTMLElement | null = null;

	// --- Conversation list state ---
	private conversationListEl: HTMLElement | null = null;
	private conversationSearchEl: HTMLInputElement | null = null;
	private conversationItemsEl: HTMLElement | null = null;
	private conversationPanelOpen = false;
	private activeConversationId: string | null = null;
	private onNewChat: (() => void) | null = null;
	private onSwitchConversation: ((id: string) => void) | null = null;
	private onDeleteConversation: ((id: string) => void) | null = null;
	private onRenameConversation: ((id: string, title: string) => void) | null = null;
	private conversations: ConversationSummary[] = [];

	// --- File upload state ---
	private pendingAttachments: FileAttachment[] = [];
	private attachmentPreviewEl: HTMLElement | null = null;
	private dropOverlayEl: HTMLElement | null = null;

	// --- Message operation state ---
	private onStopGeneration: (() => void) | null = null;
	private onEditAndResend: ((messageIndex: number, newContent: string) => void) | null = null;
	private onRegenerateResponse: (() => void) | null = null;
	private stopBtnEl: HTMLButtonElement | null = null;

	// --- Assistant turn state ---
	private currentTurnEl: HTMLElement | null = null;
	private currentTurnContentEl: HTMLElement | null = null;
	private currentTextEl: HTMLElement | null = null;
	private currentThinkingEl: HTMLElement | null = null;
	private currentThinkingContentEl: HTMLElement | null = null;
	private toolBlocks: Map<string, ToolBlockState> = new Map();

	// --- rAF batching state ---
	private textBuffer = "";
	private textDirty = false;
	private textRafId: number | null = null;
	private thinkingBuffer = "";
	private thinkingDirty = false;
	private thinkingRafId: number | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CLAUDE_CHAT;
	}

	getDisplayText(): string {
		return "Claude code";
	}

	getIcon(): string {
		return "message-square";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("claude-chat-container");

		// Header bar
		const headerEl = contentEl.createDiv({ cls: "claude-chat-header" });

		const historyBtn = headerEl.createEl("button", {
			cls: "claude-header-btn",
			attr: { "aria-label": "Conversation history" },
		});
		renderIcon(historyBtn, "list");
		historyBtn.addEventListener("click", () => this.toggleConversationPanel());

		headerEl.createSpan({ text: "Claude Code", cls: "claude-header-title" });

		const newChatBtn = headerEl.createEl("button", {
			cls: "claude-header-btn",
			attr: { "aria-label": "New chat" },
		});
		renderIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => {
			if (this.onNewChat) this.onNewChat();
		});

		// Conversation list panel (hidden by default)
		this.conversationListEl = contentEl.createDiv({
			cls: "claude-conversation-panel hidden",
		});

		this.conversationSearchEl = this.conversationListEl.createEl("input", {
			cls: "claude-conversation-search",
			attr: { placeholder: "Search conversations...", type: "text" },
		});
		this.conversationSearchEl.addEventListener("input", () => {
			this.renderConversationList();
		});

		this.conversationItemsEl = this.conversationListEl.createDiv({
			cls: "claude-conversation-items",
		});

		// Message list
		this.messageListEl = contentEl.createDiv({ cls: "claude-chat-messages" });

		// Streaming indicator (hidden by default)
		const streamingEl = contentEl.createDiv({
			cls: "claude-chat-streaming hidden",
		});
		streamingEl.createSpan({ cls: "claude-streaming-dot" });
		streamingEl.createSpan({ text: "Claude is thinking...", cls: "claude-streaming-label" });

		// Input area
		const inputArea = contentEl.createDiv({ cls: "claude-chat-input-area" });

		// @file autocomplete dropdown
		this.autocompleteEl = inputArea.createDiv({
			cls: "claude-autocomplete hidden",
		});

		// Slash command autocomplete dropdown
		this.slashAutocompleteEl = inputArea.createDiv({
			cls: "claude-slash-autocomplete hidden",
		});

		// Drag & drop overlay
		this.dropOverlayEl = inputArea.createDiv({
			cls: "claude-drop-overlay hidden",
		});
		this.dropOverlayEl.createSpan({ text: "Drop files here" });

		// Input box — contains textarea + toolbar
		const inputBox = inputArea.createDiv({ cls: "claude-input-box" });

		// Attachment preview area (above textarea, hidden when empty)
		this.attachmentPreviewEl = inputBox.createDiv({
			cls: "claude-attachment-preview hidden",
		});

		this.inputEl = inputBox.createEl("textarea", {
			cls: "claude-chat-input",
			attr: { placeholder: "Type a message...", rows: "1" },
		});

		// Toolbar inside the input box
		const toolbar = inputBox.createDiv({ cls: "claude-input-toolbar" });

		// Left: attach button + file indicator
		const toolbarLeft = toolbar.createDiv({ cls: "claude-input-toolbar-left" });

		const attachBtn = toolbarLeft.createEl("button", {
			cls: "claude-attach-btn",
			attr: { "aria-label": "Attach file" },
		});
		renderIcon(attachBtn, "paperclip");
		attachBtn.addEventListener("click", () => this.openFilePicker());

		this.fileIndicatorEl = toolbarLeft.createSpan({ cls: "claude-file-indicator" });
		this.updateFileIndicator();

		// Right: model selector + send button
		const toolbarRight = toolbar.createDiv({ cls: "claude-input-toolbar-right" });

		this.modelSelectorEl = toolbarRight.createSpan({
			cls: "claude-model-selector",
		});
		this.updateSelectorLabel();
		this.modelSelectorEl.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleModelDropdown();
		});

		// Dropdown panel (hidden by default, positioned from toolbar)
		this.modelDropdownEl = toolbarRight.createDiv({
			cls: "claude-model-dropdown",
		});
		this.buildDropdownOptions();

		this.sendBtnEl = toolbarRight.createEl("button", {
			cls: "claude-chat-send-btn",
		});
		renderIcon(this.sendBtnEl, "send");

		this.stopBtnEl = toolbarRight.createEl("button", {
			cls: "claude-chat-stop-btn hidden",
		});
		renderIcon(this.stopBtnEl, "square");
		this.stopBtnEl.addEventListener("click", () => {
			if (this.onStopGeneration) this.onStopGeneration();
		});

		// Event listeners
		this.inputEl.addEventListener("keydown", this.handleInputKeydown.bind(this));
		this.inputEl.addEventListener("input", this.handleInputChange.bind(this));
		this.sendBtnEl.addEventListener("click", () => this.sendMessage());

		// Paste handler for images
		this.inputEl.addEventListener("paste", (e) => this.handlePaste(e));

		// Drag & drop handlers on input area
		inputArea.addEventListener("dragenter", (e) => {
			e.preventDefault();
			this.dropOverlayEl?.removeClass("hidden");
		});
		inputArea.addEventListener("dragover", (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		});
		inputArea.addEventListener("dragleave", (e) => {
			const rect = inputArea.getBoundingClientRect();
			if (
				e.clientX <= rect.left ||
				e.clientX >= rect.right ||
				e.clientY <= rect.top ||
				e.clientY >= rect.bottom
			) {
				this.dropOverlayEl?.addClass("hidden");
			}
		});
		inputArea.addEventListener("drop", (e) => {
			e.preventDefault();
			this.dropOverlayEl?.addClass("hidden");
			if (e.dataTransfer?.files) {
				this.handleFileList(e.dataTransfer.files);
			}
		});
	}

	onClose(): void {
		this.cancelPendingRafs();
		this.closeModelDropdown();
		this.clearAttachments();
		this.messages = [];
	}

	// =============================================================
	// Public API — send handler & user messages
	// =============================================================

	setSendHandler(handler: (message: string, attachments?: FileAttachment[]) => void): void {
		this.onSendMessage = handler;
	}

	addMessage(msg: ChatMessage): void {
		this.messages.push(msg);
		this.renderUserMessage(msg);
		this.scrollToBottom();
	}

	setStreaming(streaming: boolean): void {
		this.isStreaming = streaming;
		const el = this.contentEl.querySelector(".claude-chat-streaming");
		if (el) {
			el.toggleClass("hidden", !streaming);
		}
		this.sendBtnEl.toggleClass("hidden", streaming);
		this.stopBtnEl?.toggleClass("hidden", !streaming);
	}

	clearMessages(): void {
		this.messages = [];
		this.messageListEl.empty();
		this.resetTurnState();
	}

	// =============================================================
	// Public API — model & slash commands
	// =============================================================

	setModel(model: string): void {
		this.currentModel = model;
		this.updateSelectorLabel();
		this.buildDropdownOptions();
	}

	setSlashCommands(commands: SlashCommand[]): void {
		this.slashCommands = commands;
	}

	setModelChangeHandler(handler: (model: string) => void): void {
		this.onModelChange = handler;
	}

	setActiveFileContext(context: FileContext): void {
		this.activeFileContext = context;
		this.updateFileIndicator();
	}

	private updateFileIndicator(): void {
		if (!this.fileIndicatorEl) return;
		const file = this.activeFileContext?.file;
		if (file) {
			// Show just the filename, not the full path
			const name = file.split("/").pop() ?? file;
			this.fileIndicatorEl.textContent = `📎 ${name}`;
			this.fileIndicatorEl.title = file;
			this.fileIndicatorEl.removeClass("hidden");
		} else {
			this.fileIndicatorEl.textContent = "";
			this.fileIndicatorEl.addClass("hidden");
		}
	}

	// =============================================================
	// Public API — conversation management
	// =============================================================

	setNewChatHandler(handler: () => void): void {
		this.onNewChat = handler;
	}

	setSwitchConversationHandler(handler: (id: string) => void): void {
		this.onSwitchConversation = handler;
	}

	setDeleteConversationHandler(handler: (id: string) => void): void {
		this.onDeleteConversation = handler;
	}

	setRenameConversationHandler(handler: (id: string, title: string) => void): void {
		this.onRenameConversation = handler;
	}

	setConversations(conversations: ConversationSummary[]): void {
		this.conversations = conversations;
		this.renderConversationList();
	}

	setActiveConversationId(id: string | null): void {
		this.activeConversationId = id;
		this.renderConversationList();
	}

	// =============================================================
	// Public API — message operations
	// =============================================================

	setStopHandler(handler: () => void): void {
		this.onStopGeneration = handler;
	}

	setEditAndResendHandler(handler: (messageIndex: number, newContent: string) => void): void {
		this.onEditAndResend = handler;
	}

	setRegenerateHandler(handler: () => void): void {
		this.onRegenerateResponse = handler;
	}

	// =============================================================
	// Public API — block-based assistant turn
	// =============================================================

	startAssistantTurn(): void {
		this.resetTurnState();
		this.currentTurnEl = this.messageListEl.createDiv({
			cls: "claude-msg claude-msg-assistant",
		});
		this.currentTurnContentEl = this.currentTurnEl.createDiv({ cls: "claude-turn-content" });
	}

	appendTextDelta(text: string): void {
		if (!this.currentTurnEl) return;
		this.ensureTextBlock();
		this.textBuffer += text;
		this.scheduleTextRender();
	}

	/**
	 * Replace the entire text buffer (used when edit blocks are stripped
	 * from the stream so the display stays clean).
	 */
	setAccumulatedText(text: string): void {
		if (!this.currentTurnEl) return;
		this.ensureTextBlock();
		this.textBuffer = text;
		this.scheduleTextRender();
	}

	appendThinking(text: string): void {
		if (!this.currentTurnEl) return;
		this.ensureThinkingBlock();
		this.thinkingBuffer += text;
		this.scheduleThinkingRender();
	}

	addToolBlock(toolId: string, toolName: string): void {
		if (!this.currentTurnEl) return;
		const parent = this.currentTurnContentEl ?? this.currentTurnEl;

		// Close current text block so next text goes into a new one after the tool
		this.flushTextRender();
		this.currentTextEl = null;

		const mcpInfo = parseMcpToolName(toolName);
		const blockCls = mcpInfo.isVaultOp
			? "claude-tool-block claude-tool-vault"
			: "claude-tool-block";
		const containerEl = parent.createDiv({ cls: blockCls });

		// Header
		const headerEl = containerEl.createDiv({ cls: "claude-tool-header" });

		const iconEl = headerEl.createSpan({ cls: "claude-tool-icon" });
		renderIcon(iconEl, mcpInfo.isVaultOp ? "box" : mcpInfo.isMcp ? "plug" : "wrench");

		headerEl.createSpan({ text: mcpInfo.displayName, cls: "claude-tool-name" });

		const summaryEl = headerEl.createSpan({
			cls: "claude-tool-args-summary",
			text: "",
		});

		const statusEl = headerEl.createSpan({ cls: "claude-tool-status" });
		const spinnerEl = statusEl.createSpan({ cls: "claude-tool-icon running" });
		renderIcon(spinnerEl, "loader");

		// Body (collapsed by default)
		const bodyEl = containerEl.createDiv({ cls: "claude-tool-body" });
		const preEl = bodyEl.createEl("pre");

		// Click to toggle
		headerEl.addEventListener("click", () => {
			containerEl.toggleClass("expanded", !containerEl.hasClass("expanded"));
		});

		this.toolBlocks.set(toolId, {
			containerEl,
			headerEl,
			summaryEl,
			statusEl,
			bodyEl,
			preEl,
			toolName,
			accumulatedJson: "",
			finalized: false,
		});
	}

	appendToolInput(toolId: string, partialJson: string): void {
		const block = this.toolBlocks.get(toolId);
		if (!block) return;

		block.accumulatedJson += partialJson;
		block.preEl.setText(block.accumulatedJson);

		// Try to parse and show summary
		try {
			const parsed = JSON.parse(block.accumulatedJson);
			block.summaryEl.setText(summarizeToolArgs(block.toolName, parsed));
		} catch {
			// Still accumulating — partial JSON, that's fine
		}
	}

	finalizeToolBlock(toolId: string): void {
		const block = this.toolBlocks.get(toolId);
		if (!block) return;

		block.finalized = true;
		block.statusEl.empty();
		const doneIcon = block.statusEl.createSpan({ cls: "claude-tool-icon done" });
		renderIcon(doneIcon, "circle-check");

		// Final parse attempt for summary
		try {
			const parsed = JSON.parse(block.accumulatedJson);
			block.summaryEl.setText(summarizeToolArgs(block.toolName, parsed));
		} catch {
			// Keep whatever summary we have
		}
	}

	showResultInfo(costUsd?: number, durationMs?: number, numTurns?: number): void {
		if (!this.currentTurnEl) return;
		const parent = this.currentTurnContentEl ?? this.currentTurnEl;

		const infoEl = parent.createDiv({ cls: "claude-result-info" });

		if (costUsd != null) {
			const cost = costUsd < 0.01
				? `$${costUsd.toFixed(4)}`
				: `$${costUsd.toFixed(2)}`;
			infoEl.createSpan({ text: `${cost}` });
		}
		if (durationMs != null) {
			const secs = (durationMs / 1000).toFixed(1);
			infoEl.createSpan({ text: `${secs}s` });
		}
		if (numTurns != null) {
			infoEl.createSpan({ text: `${numTurns} turn${numTurns !== 1 ? "s" : ""}` });
		}
	}

	showError(message: string): void {
		if (!this.currentTurnEl) return;
		const parent = this.currentTurnContentEl ?? this.currentTurnEl;

		const errorEl = parent.createDiv({ cls: "claude-msg-error" });
		const iconEl = errorEl.createSpan({ cls: "claude-error-icon" });
		renderIcon(iconEl, "circle-alert");
		errorEl.createSpan({ text: message });
	}

	finishAssistantTurn(): void {
		// Final flush of any pending renders
		this.flushTextRender();
		this.flushThinkingRender();
		this.cancelPendingRafs();

		// Remove thinking block if empty, otherwise collapse it
		if (this.currentThinkingEl) {
			this.currentThinkingEl.removeClass("active");
			if (!this.thinkingBuffer.trim()) {
				this.currentThinkingEl.remove();
			}
		}

		// Add assistant message actions (copy + regenerate)
		if (this.currentTurnEl) {
			const actionsEl = this.currentTurnEl.createDiv({
				cls: "claude-msg-actions claude-msg-actions-assistant",
			});

			const copyBtn = actionsEl.createEl("button", {
				cls: "claude-msg-action-btn",
				attr: { "aria-label": "Copy response" },
			});
			renderIcon(copyBtn, "copy");
			const responseText = this.textBuffer;
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.copyToClipboard(responseText, copyBtn);
			});

			const regenBtn = actionsEl.createEl("button", {
				cls: "claude-msg-action-btn",
				attr: { "aria-label": "Regenerate response" },
			});
			renderIcon(regenBtn, "refresh-cw");
			regenBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.onRegenerateResponse) this.onRegenerateResponse();
			});

			// Add copy buttons to code blocks
			this.addCodeBlockCopyButtons(this.currentTurnEl);
		}

		this.scrollToBottom();
	}

	// =============================================================
	// rAF batching internals
	// =============================================================

	private ensureTextBlock(): void {
		if (this.currentTextEl) return;
		const parent = this.currentTurnContentEl ?? this.currentTurnEl;
		if (!parent) return;
		this.currentTextEl = parent.createDiv({ cls: "claude-turn-text claude-serif" });
		this.textBuffer = "";
	}

	private ensureThinkingBlock(): void {
		if (this.currentThinkingEl) return;
		const parent = this.currentTurnContentEl ?? this.currentTurnEl;
		if (!parent) return;

		this.currentThinkingEl = parent.createDiv({
			cls: "claude-turn-thinking active",
		});

		const labelEl = this.currentThinkingEl.createDiv({ cls: "claude-thinking-label" });
		labelEl.setText("Thinking...");

		// Click label to toggle content
		labelEl.addEventListener("click", () => {
			if (this.currentThinkingEl) {
				this.currentThinkingEl.toggleClass(
					"expanded",
					!this.currentThinkingEl.hasClass("expanded")
				);
			}
		});

		this.currentThinkingContentEl = this.currentThinkingEl.createDiv({
			cls: "claude-thinking-content",
		});
		this.thinkingBuffer = "";
	}

	private scheduleTextRender(): void {
		this.textDirty = true;
		if (this.textRafId !== null) return;
		this.textRafId = requestAnimationFrame(() => {
			this.textRafId = null;
			if (this.textDirty) {
				this.flushTextRender();
			}
		});
	}

	private scheduleThinkingRender(): void {
		this.thinkingDirty = true;
		if (this.thinkingRafId !== null) return;
		this.thinkingRafId = requestAnimationFrame(() => {
			this.thinkingRafId = null;
			if (this.thinkingDirty) {
				this.flushThinkingRender();
			}
		});
	}

	private flushTextRender(): void {
		if (!this.textDirty || !this.currentTextEl) return;
		this.textDirty = false;
		this.currentTextEl.empty();
		void MarkdownRenderer.render(
			this.app,
			this.textBuffer,
			this.currentTextEl,
			"",
			this
		);
		this.scrollToBottom();
	}

	private flushThinkingRender(): void {
		if (!this.thinkingDirty || !this.currentThinkingContentEl) return;
		this.thinkingDirty = false;
		this.currentThinkingContentEl.empty();
		void MarkdownRenderer.render(
			this.app,
			this.thinkingBuffer,
			this.currentThinkingContentEl,
			"",
			this
		);
		this.scrollToBottom();
	}

	private cancelPendingRafs(): void {
		if (this.textRafId !== null) {
			cancelAnimationFrame(this.textRafId);
			this.textRafId = null;
		}
		if (this.thinkingRafId !== null) {
			cancelAnimationFrame(this.thinkingRafId);
			this.thinkingRafId = null;
		}
	}

	private resetTurnState(): void {
		this.cancelPendingRafs();
		this.currentTurnEl = null;
		this.currentTurnContentEl = null;
		this.currentTextEl = null;
		this.currentThinkingEl = null;
		this.currentThinkingContentEl = null;
		this.toolBlocks.clear();
		this.textBuffer = "";
		this.textDirty = false;
		this.thinkingBuffer = "";
		this.thinkingDirty = false;
	}

	// =============================================================
	// Conversation panel
	// =============================================================

	private toggleConversationPanel(): void {
		this.conversationPanelOpen = !this.conversationPanelOpen;
		if (this.conversationListEl) {
			this.conversationListEl.toggleClass("hidden", !this.conversationPanelOpen);
		}
		if (this.conversationPanelOpen) {
			this.renderConversationList();
			this.conversationSearchEl?.focus();
		}
	}

	private renderConversationList(): void {
		if (!this.conversationItemsEl) return;
		this.conversationItemsEl.empty();

		const query = this.conversationSearchEl?.value.toLowerCase() ?? "";
		const filtered = query
			? this.conversations.filter(
					(c) =>
						c.title.toLowerCase().includes(query) ||
						c.lastMessagePreview.toLowerCase().includes(query)
				)
			: this.conversations;

		if (filtered.length === 0) {
			const emptyEl = this.conversationItemsEl.createDiv({
				cls: "claude-conversation-empty",
			});
			emptyEl.setText(
				query ? "No matching conversations" : "No conversations yet"
			);
			return;
		}

		for (const conv of filtered) {
			const isActive = conv.id === this.activeConversationId;
			const itemEl = this.conversationItemsEl.createDiv({
				cls: `claude-conversation-item${isActive ? " active" : ""}`,
			});

			const titleEl = itemEl.createSpan({
				cls: "claude-conversation-title",
				text: conv.title,
			});

			itemEl.createSpan({
				cls: "claude-conversation-time",
				text: this.relativeTime(conv.updatedAt),
			});

			// Click to switch
			itemEl.addEventListener("click", () => {
				if (this.onSwitchConversation) {
					this.onSwitchConversation(conv.id);
				}
				this.conversationPanelOpen = false;
				this.conversationListEl?.addClass("hidden");
			});

			// Right-click context menu
			itemEl.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.showConversationContextMenu(e, conv);
			});

			// Double-click to rename
			titleEl.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				this.startInlineRename(titleEl, conv);
			});
		}
	}

	private showConversationContextMenu(
		e: MouseEvent,
		conv: ConversationSummary
	): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Rename")
				.setIcon("pencil")
				.onClick(() => {
					const titleEl = this.conversationItemsEl?.querySelector(
						`.claude-conversation-item.active .claude-conversation-title`
					) as HTMLElement | null;
					if (titleEl) this.startInlineRename(titleEl, conv);
				})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Delete")
				.setIcon("trash")
				.onClick(() => {
					if (this.onDeleteConversation) {
						this.onDeleteConversation(conv.id);
					}
				})
		);
		menu.showAtMouseEvent(e);
	}

	private startInlineRename(
		titleEl: HTMLElement,
		conv: ConversationSummary
	): void {
		const input = document.createElement("input");
		input.type = "text";
		input.value = conv.title;
		input.className = "claude-conversation-rename-input";

		const commit = () => {
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== conv.title && this.onRenameConversation) {
				this.onRenameConversation(conv.id, newTitle);
			}
			// Re-render will replace the input
			this.renderConversationList();
		};

		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				input.blur();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				this.renderConversationList();
			}
		});

		titleEl.replaceWith(input);
		input.focus();
		input.select();
	}

	private relativeTime(timestamp: number): string {
		const diff = Date.now() - timestamp;
		const minutes = Math.floor(diff / 60000);
		if (minutes < 1) return "now";
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}d`;
		return new Date(timestamp).toLocaleDateString();
	}

	// =============================================================
	// Message operation helpers
	// =============================================================

	private copyToClipboard(text: string, btnEl: HTMLElement): void {
		void navigator.clipboard.writeText(text).then(() => {
			btnEl.empty();
			renderIcon(btnEl, "check");
			btnEl.addClass("copied");
			setTimeout(() => {
				btnEl.empty();
				renderIcon(btnEl, "copy");
				btnEl.removeClass("copied");
			}, 1500);
		});
	}

	private startEditMessage(
		wrapperEl: HTMLElement,
		msg: ChatMessage,
		msgIndex: number
	): void {
		const bubble = wrapperEl.querySelector(".claude-msg-bubble") as HTMLElement;
		if (!bubble) return;

		bubble.empty();
		const textarea = bubble.createEl("textarea", {
			cls: "claude-edit-textarea",
			attr: { rows: "3" },
		});
		textarea.value = msg.content;

		const btnRow = bubble.createDiv({ cls: "claude-edit-actions" });

		const cancelBtn = btnRow.createEl("button", {
			cls: "claude-edit-btn claude-edit-cancel",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => {
			bubble.empty();
			const contentEl = bubble.createDiv({ cls: "claude-msg-content" });
			contentEl.setText(msg.content);
		});

		const saveBtn = btnRow.createEl("button", {
			cls: "claude-edit-btn claude-edit-save",
			text: "Save & send",
		});
		saveBtn.addEventListener("click", () => {
			const newContent = textarea.value.trim();
			if (newContent && this.onEditAndResend) {
				this.onEditAndResend(msgIndex, newContent);
			}
		});

		textarea.focus();
	}

	private addCodeBlockCopyButtons(container: HTMLElement): void {
		const codeBlocks = container.querySelectorAll("pre > code");
		codeBlocks.forEach((codeEl) => {
			const preEl = codeEl.parentElement;
			if (!preEl) return;

			// Make pre relative for positioning
			preEl.addClass("claude-code-block-wrapper");

			const header = preEl.createDiv({ cls: "claude-code-block-header" });

			// Extract language from class (e.g., "language-typescript")
			const langClass = Array.from(codeEl.classList).find((c) =>
				c.startsWith("language-")
			);
			if (langClass) {
				header.createSpan({
					cls: "claude-code-lang",
					text: langClass.replace("language-", ""),
				});
			}

			const copyBtn = header.createEl("button", {
				cls: "claude-code-copy-btn",
				attr: { "aria-label": "Copy code" },
			});
			renderIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.copyToClipboard(codeEl.textContent ?? "", copyBtn);
			});

			// Insert header before code content
			preEl.insertBefore(header, preEl.firstChild);
		});
	}

	// =============================================================
	// File upload helpers
	// =============================================================

	private static readonly SUPPORTED_TYPES = new Set([
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
		"text/plain",
		"text/markdown",
		"text/csv",
		"application/json",
	]);

	private static readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

	private openFilePicker(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept =
			"image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json";
		input.addEventListener("change", () => {
			if (input.files) this.handleFileList(input.files);
		});
		input.click();
	}

	private handlePaste(e: ClipboardEvent): void {
		const items = e.clipboardData?.items;
		if (!items) return;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === "file") {
				e.preventDefault();
				const file = item.getAsFile();
				if (file) void this.addAttachmentFromFile(file);
			}
		}
	}

	private handleFileList(files: FileList): void {
		for (let i = 0; i < files.length; i++) {
			void this.addAttachmentFromFile(files[i]);
		}
	}

	private async addAttachmentFromFile(file: File): Promise<void> {
		if (!ChatView.SUPPORTED_TYPES.has(file.type) && !this.isTextFile(file.name)) {
			// Unsupported type — skip silently
			return;
		}

		if (file.size > ChatView.MAX_FILE_SIZE) {
			// Show brief warning in input area
			const warn = this.contentEl.createDiv({ cls: "claude-upload-warn" });
			warn.setText(`${file.name} exceeds 10MB limit`);
			setTimeout(() => warn.remove(), 3000);
			return;
		}

		const data = await file.arrayBuffer();
		const attachment: FileAttachment = {
			name: file.name,
			type: file.type,
			size: file.size,
			data,
		};

		if (file.type.startsWith("image/")) {
			attachment.previewUrl = URL.createObjectURL(file);
		}

		this.pendingAttachments.push(attachment);
		this.renderAttachmentPreviews();
	}

	private isTextFile(name: string): boolean {
		return /\.(txt|md|csv|json|log|xml|yaml|yml|toml)$/i.test(name);
	}

	private renderAttachmentPreviews(): void {
		if (!this.attachmentPreviewEl) return;
		this.attachmentPreviewEl.empty();

		if (this.pendingAttachments.length === 0) {
			this.attachmentPreviewEl.addClass("hidden");
			return;
		}

		this.attachmentPreviewEl.removeClass("hidden");

		this.pendingAttachments.forEach((att, idx) => {
			const item = this.attachmentPreviewEl!.createDiv({
				cls: "claude-attachment-item",
			});

			if (att.previewUrl) {
				item.createEl("img", {
					cls: "claude-attachment-thumb",
					attr: { src: att.previewUrl, alt: att.name },
				});
			} else {
				const iconEl = item.createSpan({ cls: "claude-attachment-icon" });
				renderIcon(iconEl, this.getFileIcon(att.type));
			}

			const info = item.createDiv({ cls: "claude-attachment-info" });
			info.createSpan({ cls: "claude-attachment-name", text: att.name });
			info.createSpan({
				cls: "claude-attachment-size",
				text: this.formatFileSize(att.size),
			});

			const removeBtn = item.createEl("button", {
				cls: "claude-attachment-remove",
				attr: { "aria-label": "Remove" },
			});
			renderIcon(removeBtn, "x");
			removeBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.removeAttachment(idx);
			});
		});
	}

	private removeAttachment(index: number): void {
		const att = this.pendingAttachments[index];
		if (att?.previewUrl) {
			URL.revokeObjectURL(att.previewUrl);
		}
		this.pendingAttachments.splice(index, 1);
		this.renderAttachmentPreviews();
	}

	private clearAttachments(): void {
		for (const att of this.pendingAttachments) {
			if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
		}
		this.pendingAttachments = [];
		this.renderAttachmentPreviews();
	}

	private getFileIcon(mimeType: string): string {
		if (mimeType === "application/pdf") return "file-text";
		if (mimeType.startsWith("image/")) return "image";
		return "file";
	}

	private formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}

	// =============================================================
	// User messages
	// =============================================================

	private renderUserMessage(msg: ChatMessage): void {
		const msgIndex = this.messages.indexOf(msg);
		const wrapper = this.messageListEl.createDiv({
			cls: "claude-msg claude-msg-user",
		});

		// Hover actions
		const actionsEl = wrapper.createDiv({ cls: "claude-msg-actions" });

		const copyBtn = actionsEl.createEl("button", {
			cls: "claude-msg-action-btn",
			attr: { "aria-label": "Copy message" },
		});
		renderIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.copyToClipboard(msg.content, copyBtn);
		});

		const editBtn = actionsEl.createEl("button", {
			cls: "claude-msg-action-btn",
			attr: { "aria-label": "Edit message" },
		});
		renderIcon(editBtn, "pencil");
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.startEditMessage(wrapper, msg, msgIndex);
		});

		const bubble = wrapper.createDiv({ cls: "claude-msg-bubble" });
		const contentEl = bubble.createDiv({ cls: "claude-msg-content" });
		contentEl.setText(msg.content);
	}

	private scrollToBottom(): void {
		this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
	}

	private sendMessage(): void {
		const text = this.inputEl.value.trim();
		if (!text && this.pendingAttachments.length === 0) return;
		if (this.isStreaming) return;

		// Add to history
		if (text) {
			this.commandHistory.push(text);
			this.historyIndex = -1;
		}

		// Add user message
		this.addMessage({ role: "user", content: text || "(attached files)", timestamp: Date.now() });

		// Grab attachments before clearing
		const attachments = this.pendingAttachments.length > 0
			? [...this.pendingAttachments]
			: undefined;

		// Clear input, attachments, and reset height
		this.inputEl.value = "";
		this.inputEl.setCssProps({ "--input-height": "auto" });
		this.clearAttachments();
		this.hideAutocomplete();

		// Notify handler
		if (this.onSendMessage) {
			this.onSendMessage(text, attachments);
		}
	}

	// =============================================================
	// Model dropdown
	// =============================================================

	private updateSelectorLabel(): void {
		if (!this.modelSelectorEl) return;
		const model = MODELS.find((m) => m.id === this.currentModel);
		this.modelSelectorEl.setText(`${model?.label ?? this.currentModel} ▾`);
	}

	private buildDropdownOptions(): void {
		if (!this.modelDropdownEl) return;
		this.modelDropdownEl.empty();

		MODELS.forEach((model, i) => {
			const isActive = model.id === this.currentModel;
			const option = this.modelDropdownEl!.createDiv({
				cls: `claude-model-option${isActive ? " active" : ""}`,
			});
			option.dataset.index = String(i);

			const nameRow = option.createDiv({ cls: "claude-model-option-row" });
			nameRow.createSpan({ text: model.label, cls: "claude-model-name" });
			if (isActive) {
				nameRow.createSpan({ text: " ✓", cls: "claude-model-check" });
			}
			option.createDiv({ text: model.desc, cls: "claude-model-desc" });

			option.addEventListener("click", (e) => {
				e.stopPropagation();
				this.selectModel(model.id);
			});
		});
	}

	private toggleModelDropdown(): void {
		if (this.isStreaming) return;
		if (!this.modelDropdownEl) return;

		const isOpen = this.modelDropdownEl.hasClass("open");
		if (isOpen) {
			this.closeModelDropdown();
		} else {
			this.openModelDropdown();
		}
	}

	private openModelDropdown(): void {
		if (!this.modelDropdownEl) return;
		this.modelDropdownIndex = MODELS.findIndex((m) => m.id === this.currentModel);
		this.modelDropdownEl.addClass("open");
		this.updateDropdownFocus();

		// Close on outside click
		this.closeDropdownHandler = (e: MouseEvent) => {
			if (
				this.modelDropdownEl &&
				!this.modelDropdownEl.contains(e.target as Node) &&
				this.modelSelectorEl &&
				!this.modelSelectorEl.contains(e.target as Node)
			) {
				this.closeModelDropdown();
			}
		};
		document.addEventListener("click", this.closeDropdownHandler, true);

		// Keyboard nav
		this.closeDropdownKeyHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeModelDropdown();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.moveDropdownFocus(-1);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				this.moveDropdownFocus(1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (this.modelDropdownIndex >= 0 && this.modelDropdownIndex < MODELS.length) {
					this.selectModel(MODELS[this.modelDropdownIndex].id);
				}
			}
		};
		document.addEventListener("keydown", this.closeDropdownKeyHandler, true);
	}

	private closeModelDropdown(): void {
		if (this.modelDropdownEl) {
			this.modelDropdownEl.removeClass("open");
		}
		if (this.closeDropdownHandler) {
			document.removeEventListener("click", this.closeDropdownHandler, true);
			this.closeDropdownHandler = null;
		}
		if (this.closeDropdownKeyHandler) {
			document.removeEventListener("keydown", this.closeDropdownKeyHandler, true);
			this.closeDropdownKeyHandler = null;
		}
	}

	private moveDropdownFocus(direction: number): void {
		this.modelDropdownIndex =
			(this.modelDropdownIndex + direction + MODELS.length) % MODELS.length;
		this.updateDropdownFocus();
	}

	private updateDropdownFocus(): void {
		if (!this.modelDropdownEl) return;
		const options = this.modelDropdownEl.querySelectorAll(".claude-model-option");
		options.forEach((el, i) => {
			if (i === this.modelDropdownIndex) {
				el.addClass("focused");
			} else {
				el.removeClass("focused");
			}
		});
	}

	private selectModel(modelId: string): void {
		this.setModel(modelId);
		this.closeModelDropdown();
		if (this.onModelChange) {
			this.onModelChange(modelId);
		}
	}

	// =============================================================
	// Input handling — keyboard, autocomplete, history
	// =============================================================

	private handleInputKeydown(e: KeyboardEvent): void {
		const slashOpen = this.slashAutocompleteEl && !this.slashAutocompleteEl.hasClass("hidden");
		const fileOpen = !this.autocompleteEl.hasClass("hidden");

		// Enter to send, Shift+Enter for newline
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (slashOpen) {
				this.selectSlashAutocompleteItem();
			} else if (fileOpen) {
				this.selectAutocompleteItem();
			} else {
				this.sendMessage();
			}
			return;
		}

		// Arrow keys for autocomplete or command history
		if (e.key === "ArrowUp") {
			if (slashOpen) {
				e.preventDefault();
				this.moveSlashAutocomplete(-1);
			} else if (fileOpen) {
				e.preventDefault();
				this.moveAutocomplete(-1);
			} else if (this.inputEl.value === "" && this.commandHistory.length > 0) {
				e.preventDefault();
				this.navigateHistory(-1);
			}
		}
		if (e.key === "ArrowDown") {
			if (slashOpen) {
				e.preventDefault();
				this.moveSlashAutocomplete(1);
			} else if (fileOpen) {
				e.preventDefault();
				this.moveAutocomplete(1);
			} else if (this.historyIndex >= 0) {
				e.preventDefault();
				this.navigateHistory(1);
			}
		}

		// Escape to close autocomplete
		if (e.key === "Escape") {
			if (slashOpen) {
				this.hideSlashAutocomplete();
			} else {
				this.hideAutocomplete();
			}
		}
	}

	private handleInputChange(): void {
		// Auto-resize textarea
		this.inputEl.setCssProps({ "--input-height": "auto" });
		this.inputEl.setCssProps({ "--input-height": Math.min(this.inputEl.scrollHeight, 150) + "px" });

		const value = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart;
		const textBefore = value.substring(0, cursorPos);

		// Check for /slash command trigger (must be at start of input)
		const slashMatch = value.match(/^\/(\S*)$/);
		if (slashMatch && this.slashCommands.length > 0) {
			this.showSlashAutocomplete(slashMatch[1]);
			this.hideAutocomplete();
			return;
		} else {
			this.hideSlashAutocomplete();
		}

		// Check for @file autocomplete trigger
		const atMatch = textBefore.match(/@([^\s]*)$/);
		if (atMatch) {
			this.showAutocomplete(atMatch[1]);
		} else {
			this.hideAutocomplete();
		}
	}

	private showAutocomplete(query: string): void {
		const files = this.app.vault.getMarkdownFiles();
		const lowerQuery = query.toLowerCase();

		this.autocompleteFiles = files
			.filter((f) => f.path.toLowerCase().includes(lowerQuery))
			.slice(0, 8);

		if (this.autocompleteFiles.length === 0) {
			this.hideAutocomplete();
			return;
		}

		this.autocompleteEl.empty();
		this.autocompleteIndex = 0;

		this.autocompleteFiles.forEach((file, i) => {
			const item = this.autocompleteEl.createDiv({
				cls: `claude-autocomplete-item ${i === 0 ? "active" : ""}`,
			});
			const iconEl = item.createSpan({ cls: "claude-autocomplete-icon" });
			renderIcon(iconEl, "file-text");
			item.createSpan({ text: file.path, cls: "claude-autocomplete-path" });
			item.addEventListener("click", () => {
				this.autocompleteIndex = i;
				this.selectAutocompleteItem();
			});
		});

		this.autocompleteEl.removeClass("hidden");
	}

	private hideAutocomplete(): void {
		this.autocompleteEl.addClass("hidden");
		this.autocompleteFiles = [];
	}

	private moveAutocomplete(direction: number): void {
		const items = this.autocompleteEl.querySelectorAll(
			".claude-autocomplete-item"
		);
		if (items.length === 0) return;

		items[this.autocompleteIndex].removeClass("active");
		this.autocompleteIndex =
			(this.autocompleteIndex + direction + items.length) % items.length;
		items[this.autocompleteIndex].addClass("active");
		(items[this.autocompleteIndex] as HTMLElement).scrollIntoView({
			block: "nearest",
		});
	}

	private selectAutocompleteItem(): void {
		const file = this.autocompleteFiles[this.autocompleteIndex];
		if (!file) return;

		const cursorPos = this.inputEl.selectionStart;
		const textBefore = this.inputEl.value.substring(0, cursorPos);
		const textAfter = this.inputEl.value.substring(cursorPos);
		const atIndex = textBefore.lastIndexOf("@");

		this.inputEl.value =
			textBefore.substring(0, atIndex) + `@${file.path} ` + textAfter;
		this.inputEl.selectionStart = this.inputEl.selectionEnd =
			atIndex + file.path.length + 2;
		this.hideAutocomplete();
		this.inputEl.focus();
	}

	private navigateHistory(direction: number): void {
		if (direction < 0) {
			if (this.historyIndex < 0) {
				this.historyIndex = this.commandHistory.length - 1;
			} else if (this.historyIndex > 0) {
				this.historyIndex--;
			}
		} else {
			if (this.historyIndex >= this.commandHistory.length - 1) {
				this.historyIndex = -1;
				this.inputEl.value = "";
				return;
			}
			this.historyIndex++;
		}
		this.inputEl.value = this.commandHistory[this.historyIndex];
	}

	// =============================================================
	// Slash command autocomplete
	// =============================================================

	private showSlashAutocomplete(query: string): void {
		if (!this.slashAutocompleteEl) return;
		const lowerQuery = query.toLowerCase();

		this.filteredSlashCommands = this.slashCommands
			.filter((cmd) => cmd.name.toLowerCase().includes(lowerQuery))
			.slice(0, 8);

		if (this.filteredSlashCommands.length === 0) {
			this.hideSlashAutocomplete();
			return;
		}

		this.slashAutocompleteEl.empty();
		this.slashAutocompleteIndex = 0;

		this.filteredSlashCommands.forEach((cmd, i) => {
			const item = this.slashAutocompleteEl!.createDiv({
				cls: `claude-autocomplete-item ${i === 0 ? "active" : ""}`,
			});
			const iconEl = item.createSpan({ cls: "claude-autocomplete-icon" });
			renderIcon(iconEl, "terminal");
			item.createSpan({ text: `/${cmd.name}`, cls: "claude-slash-name" });
			item.createSpan({ text: ` — ${cmd.description}`, cls: "claude-slash-desc" });
			item.addEventListener("click", () => {
				this.slashAutocompleteIndex = i;
				this.selectSlashAutocompleteItem();
			});
		});

		this.slashAutocompleteEl.removeClass("hidden");
	}

	private hideSlashAutocomplete(): void {
		if (this.slashAutocompleteEl) {
			this.slashAutocompleteEl.addClass("hidden");
		}
		this.filteredSlashCommands = [];
	}

	private moveSlashAutocomplete(direction: number): void {
		if (!this.slashAutocompleteEl) return;
		const items = this.slashAutocompleteEl.querySelectorAll(
			".claude-autocomplete-item"
		);
		if (items.length === 0) return;

		items[this.slashAutocompleteIndex].removeClass("active");
		this.slashAutocompleteIndex =
			(this.slashAutocompleteIndex + direction + items.length) % items.length;
		items[this.slashAutocompleteIndex].addClass("active");
		(items[this.slashAutocompleteIndex] as HTMLElement).scrollIntoView({
			block: "nearest",
		});
	}

	private selectSlashAutocompleteItem(): void {
		const cmd = this.filteredSlashCommands[this.slashAutocompleteIndex];
		if (!cmd) return;

		this.hideSlashAutocomplete();

		// Set /skillname prefix — user can add arguments, CLI handles execution
		this.inputEl.value = `/${cmd.name} `;
		this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
		this.inputEl.focus();
	}
}
