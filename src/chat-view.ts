import {
	App,
	ItemView,
	MarkdownRenderer,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { SlashCommand } from "./slash-commands";

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
	// Check for MCP vault tools first
	const mcpInfo = parseMcpToolName(toolName);
	if (mcpInfo.isVaultOp) {
		const filePath = json.file_path ?? json.path ?? "";
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
			return `Reading ${json.file_path ?? json.path ?? "file"}`;
		case "Bash":
			return `Running: ${json.command ?? "command"}`;
		case "Grep":
			return `Searching: ${json.pattern ?? "pattern"}`;
		case "Edit":
			return `Editing ${json.file_path ?? json.path ?? "file"}`;
		case "Write":
			return `Writing ${json.file_path ?? json.path ?? "file"}`;
		case "Glob":
			return `Globbing ${json.pattern ?? "pattern"}`;
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
	private onSendMessage: ((message: string) => void) | null = null;

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
		return "Claude Code";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("claude-chat-container");

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

		// Input box — contains textarea + toolbar
		const inputBox = inputArea.createDiv({ cls: "claude-input-box" });

		this.inputEl = inputBox.createEl("textarea", {
			cls: "claude-chat-input",
			attr: { placeholder: "Reply to Claude...", rows: "1" },
		});

		// Toolbar inside the input box
		const toolbar = inputBox.createDiv({ cls: "claude-input-toolbar" });

		// Left: file indicator
		const toolbarLeft = toolbar.createDiv({ cls: "claude-input-toolbar-left" });
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
		setIcon(this.sendBtnEl, "send");

		// Event listeners
		this.inputEl.addEventListener("keydown", this.handleInputKeydown.bind(this));
		this.inputEl.addEventListener("input", this.handleInputChange.bind(this));
		this.sendBtnEl.addEventListener("click", () => this.sendMessage());
	}

	async onClose(): Promise<void> {
		this.cancelPendingRafs();
		this.closeModelDropdown();
		this.messages = [];
	}

	// =============================================================
	// Public API — send handler & user messages
	// =============================================================

	setSendHandler(handler: (message: string) => void): void {
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
		this.sendBtnEl.disabled = streaming;
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
			this.fileIndicatorEl.style.display = "";
		} else {
			this.fileIndicatorEl.textContent = "";
			this.fileIndicatorEl.style.display = "none";
		}
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
		setIcon(iconEl, mcpInfo.isVaultOp ? "vault" : mcpInfo.isMcp ? "plug" : "wrench");

		headerEl.createSpan({ text: mcpInfo.displayName, cls: "claude-tool-name" });

		const summaryEl = headerEl.createSpan({
			cls: "claude-tool-args-summary",
			text: "",
		});

		const statusEl = headerEl.createSpan({ cls: "claude-tool-status" });
		const spinnerEl = statusEl.createSpan({ cls: "claude-tool-icon running" });
		setIcon(spinnerEl, "loader");

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
		setIcon(doneIcon, "check-circle");

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
		setIcon(iconEl, "alert-circle");
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
		MarkdownRenderer.render(
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
		MarkdownRenderer.render(
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
	// User messages
	// =============================================================

	private renderUserMessage(msg: ChatMessage): void {
		const wrapper = this.messageListEl.createDiv({
			cls: "claude-msg claude-msg-user",
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
		if (!text || this.isStreaming) return;

		// Add to history
		this.commandHistory.push(text);
		this.historyIndex = -1;

		// Add user message
		this.addMessage({ role: "user", content: text, timestamp: Date.now() });

		// Clear input and reset height
		this.inputEl.value = "";
		this.inputEl.style.height = "auto";
		this.hideAutocomplete();

		// Notify handler
		if (this.onSendMessage) {
			this.onSendMessage(text);
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
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";

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
			setIcon(iconEl, "file-text");
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
			setIcon(iconEl, "terminal");
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
