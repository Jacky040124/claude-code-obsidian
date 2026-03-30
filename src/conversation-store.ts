import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";

// --- Data Models ---

export interface StoredMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	toolBlocks?: ToolBlockData[];
	thinkingContent?: string;
	attachments?: AttachmentData[];
}

export interface ToolBlockData {
	toolId: string;
	toolName: string;
	input: string;
	isComplete: boolean;
}

export interface AttachmentData {
	name: string;
	type: string; // MIME type
	size: number;
	path?: string; // vault-relative path for files
}

export interface Conversation {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: StoredMessage[];
	sessionId?: string; // Claude CLI session ID for resumption
}

export type ConversationSummary = Omit<Conversation, "messages"> & {
	messageCount: number;
	lastMessagePreview: string;
};

// --- Store ---

export class ConversationStore {
	private app: App;
	private conversationsDir: string;
	private cache: Map<string, Conversation> = new Map();
	private loaded = false;

	constructor(app: App) {
		this.app = app;
		const basePath = (
			app.vault.adapter as { getBasePath?: () => string }
		).getBasePath?.();
		if (!basePath) throw new Error("Cannot determine vault base path");
		this.conversationsDir = path.join(
			basePath,
			".obsidian",
			"plugins",
			"obsidian-claude-code",
			"conversations"
		);
	}

	async initialize(): Promise<void> {
		if (this.loaded) return;
		await this.ensureDir();
		await this.loadAll();
		this.loaded = true;
	}

	// --- CRUD ---

	async create(firstMessage?: string): Promise<Conversation> {
		const id = this.generateId();
		const now = Date.now();
		const title = firstMessage
			? this.generateTitle(firstMessage)
			: "New conversation";
		const conversation: Conversation = {
			id,
			title,
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
		this.cache.set(id, conversation);
		await this.save(conversation);
		return conversation;
	}

	get(id: string): Conversation | undefined {
		return this.cache.get(id);
	}

	listAll(): ConversationSummary[] {
		const conversations = Array.from(this.cache.values());
		conversations.sort((a, b) => b.updatedAt - a.updatedAt);
		return conversations.map((c) => this.toSummary(c));
	}

	search(query: string): ConversationSummary[] {
		const lower = query.toLowerCase();
		return this.listAll().filter(
			(c) =>
				c.title.toLowerCase().includes(lower) ||
				c.lastMessagePreview.toLowerCase().includes(lower)
		);
	}

	async rename(id: string, newTitle: string): Promise<void> {
		const conv = this.cache.get(id);
		if (!conv) return;
		conv.title = newTitle;
		conv.updatedAt = Date.now();
		await this.save(conv);
	}

	async delete(id: string): Promise<void> {
		this.cache.delete(id);
		const filePath = this.filePath(id);
		try {
			await fs.promises.unlink(filePath);
		} catch {
			// File may not exist
		}
	}

	// --- Message Operations ---

	async addMessage(
		conversationId: string,
		message: StoredMessage
	): Promise<void> {
		const conv = this.cache.get(conversationId);
		if (!conv) return;
		conv.messages.push(message);
		conv.updatedAt = Date.now();
		// Auto-title from first user message if still default
		if (
			conv.title === "New conversation" &&
			message.role === "user" &&
			conv.messages.filter((m) => m.role === "user").length === 1
		) {
			conv.title = this.generateTitle(message.content);
		}
		await this.save(conv);
	}

	async updateSessionId(
		conversationId: string,
		sessionId: string
	): Promise<void> {
		const conv = this.cache.get(conversationId);
		if (!conv) return;
		conv.sessionId = sessionId;
		await this.save(conv);
	}

	async truncateAfter(
		conversationId: string,
		messageIndex: number
	): Promise<void> {
		const conv = this.cache.get(conversationId);
		if (!conv) return;
		conv.messages = conv.messages.slice(0, messageIndex);
		conv.updatedAt = Date.now();
		await this.save(conv);
	}

	async removeLastAssistantMessage(
		conversationId: string
	): Promise<StoredMessage | undefined> {
		const conv = this.cache.get(conversationId);
		if (!conv || conv.messages.length === 0) return undefined;
		const lastIdx = conv.messages.length - 1;
		if (conv.messages[lastIdx].role !== "assistant") return undefined;
		const removed = conv.messages.pop()!;
		conv.updatedAt = Date.now();
		await this.save(conv);
		return removed;
	}

	// --- Persistence ---

	private async ensureDir(): Promise<void> {
		await fs.promises.mkdir(this.conversationsDir, { recursive: true });
	}

	private async loadAll(): Promise<void> {
		let files: string[];
		try {
			files = await fs.promises.readdir(this.conversationsDir);
		} catch {
			return; // Directory doesn't exist yet
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = await fs.promises.readFile(
					path.join(this.conversationsDir, file),
					"utf-8"
				);
				const conv: Conversation = JSON.parse(raw);
				this.cache.set(conv.id, conv);
			} catch {
				console.warn(
					`[claude-code] Failed to load conversation: ${file}`
				);
			}
		}
	}

	private async save(conversation: Conversation): Promise<void> {
		await this.ensureDir();
		const filePath = this.filePath(conversation.id);
		await fs.promises.writeFile(
			filePath,
			JSON.stringify(conversation, null, 2),
			"utf-8"
		);
	}

	private filePath(id: string): string {
		return path.join(this.conversationsDir, `${id}.json`);
	}

	// --- Helpers ---

	private generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}

	private generateTitle(firstMessage: string): string {
		// Strip file context lines like [Currently viewing: ...]
		const cleaned = firstMessage
			.replace(/^\[.*?\]\n?/gm, "")
			.trim();
		if (!cleaned) return "New conversation";
		// Take first ~50 chars, break at word boundary
		if (cleaned.length <= 50) return cleaned;
		const truncated = cleaned.slice(0, 50);
		const lastSpace = truncated.lastIndexOf(" ");
		return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "...";
	}

	private toSummary(conv: Conversation): ConversationSummary {
		const lastMsg = conv.messages[conv.messages.length - 1];
		let preview = "";
		if (lastMsg) {
			preview =
				lastMsg.content.length > 80
					? lastMsg.content.slice(0, 80) + "..."
					: lastMsg.content;
		}
		return {
			id: conv.id,
			title: conv.title,
			createdAt: conv.createdAt,
			updatedAt: conv.updatedAt,
			sessionId: conv.sessionId,
			messageCount: conv.messages.length,
			lastMessagePreview: preview,
		};
	}
}
