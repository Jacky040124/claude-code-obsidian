import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs before importing the store
vi.mock("fs", () => ({
	promises: {
		mkdir: vi.fn().mockResolvedValue(undefined),
		readdir: vi.fn().mockResolvedValue([]),
		readFile: vi.fn().mockResolvedValue("{}"),
		writeFile: vi.fn().mockResolvedValue(undefined),
		unlink: vi.fn().mockResolvedValue(undefined),
	},
}));

import * as fs from "fs";
import {
	ConversationStore,
	type Conversation,
	type StoredMessage,
	type ConversationSummary,
} from "../src/conversation-store";

const mockFs = vi.mocked(fs.promises);

// Helper: create a minimal mock Obsidian App
function createMockApp(basePath = "/vault") {
	return {
		vault: {
			adapter: {
				getBasePath: () => basePath,
			},
		},
	} as any;
}

// Helper: create a StoredMessage
function makeMessage(
	role: "user" | "assistant",
	content: string,
	extra?: Partial<StoredMessage>
): StoredMessage {
	return {
		role,
		content,
		timestamp: Date.now(),
		...extra,
	};
}

// Helper: create an initialized store with mocked loadAll returning empty dir
async function createStore(basePath = "/vault"): Promise<ConversationStore> {
	const store = new ConversationStore(createMockApp(basePath));
	await store.initialize();
	return store;
}

describe("ConversationStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFs.readdir.mockResolvedValue([]);
	});

	// --- Construction ---

	describe("constructor", () => {
		it("should throw if vault base path is unavailable", () => {
			const badApp = { vault: { adapter: {} } } as any;
			expect(() => new ConversationStore(badApp)).toThrow(
				"Cannot determine vault base path"
			);
		});

		it("should construct with a valid app", () => {
			const store = new ConversationStore(createMockApp());
			expect(store).toBeDefined();
		});
	});

	// --- Initialization ---

	describe("initialize", () => {
		it("should create the conversations directory", async () => {
			await createStore();
			expect(mockFs.mkdir).toHaveBeenCalledWith(
				expect.stringContaining("conversations"),
				{ recursive: true }
			);
		});

		it("should load existing conversation files", async () => {
			const conv: Conversation = {
				id: "abc123",
				title: "Test conv",
				createdAt: 1000,
				updatedAt: 2000,
				messages: [],
			};
			mockFs.readdir.mockResolvedValue(["abc123.json"] as any);
			mockFs.readFile.mockResolvedValue(JSON.stringify(conv));

			const store = await createStore();
			expect(store.get("abc123")).toEqual(conv);
		});

		it("should skip non-json files during load", async () => {
			mockFs.readdir.mockResolvedValue(["readme.txt", "abc.json"] as any);
			const conv: Conversation = {
				id: "abc",
				title: "Hi",
				createdAt: 1,
				updatedAt: 1,
				messages: [],
			};
			mockFs.readFile.mockResolvedValue(JSON.stringify(conv));

			const store = await createStore();
			// readFile called once (only for .json)
			expect(mockFs.readFile).toHaveBeenCalledTimes(1);
		});

		it("should warn and continue if a conversation file is corrupt", async () => {
			const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
			mockFs.readdir.mockResolvedValue(["bad.json"] as any);
			mockFs.readFile.mockResolvedValue("NOT VALID JSON!!!");

			const store = await createStore();
			expect(store.listAll()).toHaveLength(0);
			expect(spy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to load conversation")
			);
			spy.mockRestore();
		});

		it("should only load once even if called multiple times", async () => {
			const store = new ConversationStore(createMockApp());
			await store.initialize();
			await store.initialize();
			// readdir called once (second initialize is a no-op)
			expect(mockFs.readdir).toHaveBeenCalledTimes(1);
		});

		it("should handle missing directory gracefully", async () => {
			mockFs.readdir.mockRejectedValue(new Error("ENOENT"));
			const store = await createStore();
			expect(store.listAll()).toHaveLength(0);
		});
	});

	// --- CRUD: create ---

	describe("create", () => {
		it("should create a conversation with default title", async () => {
			const store = await createStore();
			const conv = await store.create();

			expect(conv.id).toBeTruthy();
			expect(conv.title).toBe("New conversation");
			expect(conv.messages).toEqual([]);
			expect(conv.createdAt).toBeGreaterThan(0);
			expect(conv.updatedAt).toBe(conv.createdAt);
		});

		it("should auto-title from first message", async () => {
			const store = await createStore();
			const conv = await store.create("Help me write a function");

			expect(conv.title).toBe("Help me write a function");
		});

		it("should truncate long titles at word boundary", async () => {
			const store = await createStore();
			const longMsg =
				"This is a very long message that exceeds fifty characters and should be truncated properly";
			const conv = await store.create(longMsg);

			expect(conv.title.length).toBeLessThanOrEqual(53); // 50 + "..."
			expect(conv.title).toMatch(/\.\.\.$/);
		});

		it("should persist the conversation to disk", async () => {
			const store = await createStore();
			await store.create("Hello");

			expect(mockFs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining(".json"),
				expect.any(String),
				"utf-8"
			);
		});

		it("should make the conversation retrievable via get()", async () => {
			const store = await createStore();
			const conv = await store.create();

			expect(store.get(conv.id)).toEqual(conv);
		});

		it("should generate unique IDs for each conversation", async () => {
			const store = await createStore();
			const c1 = await store.create();
			const c2 = await store.create();

			expect(c1.id).not.toBe(c2.id);
		});
	});

	// --- CRUD: get ---

	describe("get", () => {
		it("should return undefined for nonexistent ID", async () => {
			const store = await createStore();
			expect(store.get("nonexistent")).toBeUndefined();
		});

		it("should return the conversation by ID", async () => {
			const store = await createStore();
			const conv = await store.create("test");
			expect(store.get(conv.id)).toBe(conv);
		});
	});

	// --- CRUD: listAll ---

	describe("listAll", () => {
		it("should return empty array when store is empty", async () => {
			const store = await createStore();
			expect(store.listAll()).toEqual([]);
		});

		it("should return summaries sorted by updatedAt descending", async () => {
			const store = await createStore();
			const c1 = await store.create("First");
			// Ensure different updatedAt by adding a message to c1
			await store.addMessage(c1.id, makeMessage("user", "update"));

			const c2 = await store.create("Second");

			const list = store.listAll();
			// c2 was created after c1's addMessage, or c1 was updated after c2
			// Both are recent; the most recently updated should be first
			expect(list.length).toBe(2);
			expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[1].updatedAt);
		});

		it("should return ConversationSummary with messageCount and preview", async () => {
			const store = await createStore();
			const conv = await store.create("Test");
			await store.addMessage(
				conv.id,
				makeMessage("user", "Hello world")
			);

			const list = store.listAll();
			const summary = list.find((s) => s.id === conv.id)!;

			expect(summary.messageCount).toBe(1);
			expect(summary.lastMessagePreview).toBe("Hello world");
			// Summaries should not contain messages array
			expect((summary as any).messages).toBeUndefined();
		});

		it("should truncate long preview text to ~80 chars", async () => {
			const store = await createStore();
			const conv = await store.create();
			const longContent = "x".repeat(120);
			await store.addMessage(
				conv.id,
				makeMessage("user", longContent)
			);

			const list = store.listAll();
			const summary = list.find((s) => s.id === conv.id)!;

			expect(summary.lastMessagePreview.length).toBeLessThanOrEqual(83); // 80 + "..."
			expect(summary.lastMessagePreview).toMatch(/\.\.\.$/);
		});

		it("should return empty preview when conversation has no messages", async () => {
			const store = await createStore();
			await store.create();

			const list = store.listAll();
			expect(list[0].lastMessagePreview).toBe("");
		});
	});

	// --- CRUD: search ---

	describe("search", () => {
		it("should find conversations by title (case-insensitive)", async () => {
			const store = await createStore();
			await store.create("TypeScript refactor");
			await store.create("Python migration");

			const results = store.search("typescript");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("TypeScript refactor");
		});

		it("should find conversations by message preview", async () => {
			const store = await createStore();
			const conv = await store.create("Chat 1");
			await store.addMessage(
				conv.id,
				makeMessage("assistant", "Here is some unique search term xyz")
			);

			const results = store.search("unique search term");
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe(conv.id);
		});

		it("should return empty array when nothing matches", async () => {
			const store = await createStore();
			await store.create("Hello world");

			expect(store.search("zzz-no-match")).toEqual([]);
		});

		it("should return results sorted by updatedAt descending", async () => {
			const store = await createStore();
			await store.create("Bug fix alpha");
			await store.create("Bug fix beta");

			const results = store.search("Bug fix");
			expect(results).toHaveLength(2);
			expect(results[0].updatedAt).toBeGreaterThanOrEqual(
				results[1].updatedAt
			);
		});
	});

	// --- CRUD: rename ---

	describe("rename", () => {
		it("should update the conversation title", async () => {
			const store = await createStore();
			const conv = await store.create("Old title");
			await store.rename(conv.id, "New title");

			expect(store.get(conv.id)!.title).toBe("New title");
		});

		it("should update the updatedAt timestamp", async () => {
			const store = await createStore();
			const conv = await store.create("Title");
			const oldUpdated = conv.updatedAt;

			// Small delay to ensure timestamp differs
			await new Promise((r) => setTimeout(r, 5));
			await store.rename(conv.id, "Renamed");

			expect(store.get(conv.id)!.updatedAt).toBeGreaterThanOrEqual(
				oldUpdated
			);
		});

		it("should persist the rename to disk", async () => {
			const store = await createStore();
			const conv = await store.create("Title");
			mockFs.writeFile.mockClear();

			await store.rename(conv.id, "Renamed");

			expect(mockFs.writeFile).toHaveBeenCalled();
			const written = JSON.parse(
				mockFs.writeFile.mock.calls[0][1] as string
			);
			expect(written.title).toBe("Renamed");
		});

		it("should silently ignore rename of nonexistent conversation", async () => {
			const store = await createStore();
			mockFs.writeFile.mockClear();
			await store.rename("nonexistent", "title");
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});
	});

	// --- CRUD: delete ---

	describe("delete", () => {
		it("should remove the conversation from cache", async () => {
			const store = await createStore();
			const conv = await store.create("To delete");
			await store.delete(conv.id);

			expect(store.get(conv.id)).toBeUndefined();
			expect(store.listAll()).toHaveLength(0);
		});

		it("should delete the file from disk", async () => {
			const store = await createStore();
			const conv = await store.create("To delete");
			await store.delete(conv.id);

			expect(mockFs.unlink).toHaveBeenCalledWith(
				expect.stringContaining(conv.id + ".json")
			);
		});

		it("should not throw if the file does not exist on disk", async () => {
			const store = await createStore();
			const conv = await store.create("Test");
			mockFs.unlink.mockRejectedValue(new Error("ENOENT"));

			await expect(store.delete(conv.id)).resolves.not.toThrow();
		});
	});

	// --- Message Operations ---

	describe("addMessage", () => {
		it("should append a message to the conversation", async () => {
			const store = await createStore();
			const conv = await store.create();
			const msg = makeMessage("user", "Hello");

			await store.addMessage(conv.id, msg);

			expect(store.get(conv.id)!.messages).toHaveLength(1);
			expect(store.get(conv.id)!.messages[0].content).toBe("Hello");
		});

		it("should update updatedAt on the conversation", async () => {
			const store = await createStore();
			const conv = await store.create();
			const originalUpdatedAt = conv.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			await store.addMessage(conv.id, makeMessage("user", "Hi"));

			expect(store.get(conv.id)!.updatedAt).toBeGreaterThanOrEqual(
				originalUpdatedAt
			);
		});

		it("should auto-title from first user message when title is default", async () => {
			const store = await createStore();
			const conv = await store.create(); // default title "New conversation"

			await store.addMessage(
				conv.id,
				makeMessage("user", "Explain closures in JS")
			);

			expect(store.get(conv.id)!.title).toBe("Explain closures in JS");
		});

		it("should not auto-title if conversation already has a custom title", async () => {
			const store = await createStore();
			const conv = await store.create("My custom title");

			await store.addMessage(
				conv.id,
				makeMessage("user", "Something else")
			);

			expect(store.get(conv.id)!.title).toBe("My custom title");
		});

		it("should not auto-title from assistant messages", async () => {
			const store = await createStore();
			const conv = await store.create();

			await store.addMessage(
				conv.id,
				makeMessage("assistant", "I can help with that")
			);

			expect(store.get(conv.id)!.title).toBe("New conversation");
		});

		it("should not auto-title on second user message", async () => {
			const store = await createStore();
			const conv = await store.create();

			await store.addMessage(
				conv.id,
				makeMessage("user", "First message")
			);
			await store.addMessage(
				conv.id,
				makeMessage("user", "Second message")
			);

			expect(store.get(conv.id)!.title).toBe("First message");
		});

		it("should strip file context prefixes from auto-title", async () => {
			const store = await createStore();
			const conv = await store.create();

			await store.addMessage(
				conv.id,
				makeMessage(
					"user",
					"[Currently viewing: main.ts]\nExplain this code"
				)
			);

			expect(store.get(conv.id)!.title).toBe("Explain this code");
		});

		it("should silently ignore addMessage for nonexistent conversation", async () => {
			const store = await createStore();
			mockFs.writeFile.mockClear();
			await store.addMessage("nonexistent", makeMessage("user", "Hi"));
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});

		it("should preserve toolBlocks, thinkingContent, and attachments", async () => {
			const store = await createStore();
			const conv = await store.create();
			const msg = makeMessage("assistant", "Done", {
				toolBlocks: [
					{
						toolId: "t1",
						toolName: "Read",
						input: '{"path":"a.ts"}',
						isComplete: true,
					},
				],
				thinkingContent: "Let me think...",
				attachments: [
					{ name: "file.ts", type: "text/typescript", size: 1024 },
				],
			});

			await store.addMessage(conv.id, msg);
			const stored = store.get(conv.id)!.messages[0];

			expect(stored.toolBlocks).toHaveLength(1);
			expect(stored.thinkingContent).toBe("Let me think...");
			expect(stored.attachments).toHaveLength(1);
		});
	});

	describe("updateSessionId", () => {
		it("should set the sessionId on the conversation", async () => {
			const store = await createStore();
			const conv = await store.create();

			await store.updateSessionId(conv.id, "sess-abc");

			expect(store.get(conv.id)!.sessionId).toBe("sess-abc");
		});

		it("should persist the change", async () => {
			const store = await createStore();
			const conv = await store.create();
			mockFs.writeFile.mockClear();

			await store.updateSessionId(conv.id, "sess-xyz");

			expect(mockFs.writeFile).toHaveBeenCalled();
			const written = JSON.parse(
				mockFs.writeFile.mock.calls[0][1] as string
			);
			expect(written.sessionId).toBe("sess-xyz");
		});

		it("should silently ignore nonexistent conversation", async () => {
			const store = await createStore();
			mockFs.writeFile.mockClear();
			await store.updateSessionId("nonexistent", "sess-1");
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe("truncateAfter", () => {
		it("should remove messages after the given index", async () => {
			const store = await createStore();
			const conv = await store.create();
			await store.addMessage(conv.id, makeMessage("user", "msg 0"));
			await store.addMessage(conv.id, makeMessage("assistant", "msg 1"));
			await store.addMessage(conv.id, makeMessage("user", "msg 2"));

			await store.truncateAfter(conv.id, 1);

			const messages = store.get(conv.id)!.messages;
			expect(messages).toHaveLength(1);
			expect(messages[0].content).toBe("msg 0");
		});

		it("should handle truncating to 0 (remove all messages)", async () => {
			const store = await createStore();
			const conv = await store.create();
			await store.addMessage(conv.id, makeMessage("user", "msg"));

			await store.truncateAfter(conv.id, 0);

			expect(store.get(conv.id)!.messages).toHaveLength(0);
		});

		it("should update updatedAt", async () => {
			const store = await createStore();
			const conv = await store.create();
			await store.addMessage(conv.id, makeMessage("user", "msg"));
			const before = store.get(conv.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			await store.truncateAfter(conv.id, 0);

			expect(store.get(conv.id)!.updatedAt).toBeGreaterThanOrEqual(
				before
			);
		});

		it("should silently ignore nonexistent conversation", async () => {
			const store = await createStore();
			mockFs.writeFile.mockClear();
			await store.truncateAfter("nonexistent", 0);
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe("removeLastAssistantMessage", () => {
		it("should remove and return the last message if it is from assistant", async () => {
			const store = await createStore();
			const conv = await store.create();
			await store.addMessage(conv.id, makeMessage("user", "Hi"));
			await store.addMessage(
				conv.id,
				makeMessage("assistant", "Hello!")
			);

			const removed = await store.removeLastAssistantMessage(conv.id);

			expect(removed).toBeDefined();
			expect(removed!.content).toBe("Hello!");
			expect(store.get(conv.id)!.messages).toHaveLength(1);
		});

		it("should return undefined if last message is from user", async () => {
			const store = await createStore();
			const conv = await store.create();
			await store.addMessage(conv.id, makeMessage("user", "Hi"));

			const removed = await store.removeLastAssistantMessage(conv.id);

			expect(removed).toBeUndefined();
			expect(store.get(conv.id)!.messages).toHaveLength(1);
		});

		it("should return undefined if conversation has no messages", async () => {
			const store = await createStore();
			const conv = await store.create();

			const removed = await store.removeLastAssistantMessage(conv.id);

			expect(removed).toBeUndefined();
		});

		it("should return undefined for nonexistent conversation", async () => {
			const store = await createStore();
			const removed =
				await store.removeLastAssistantMessage("nonexistent");
			expect(removed).toBeUndefined();
		});

		it("should update updatedAt after removal", async () => {
			const store = await createStore();
			const conv = await store.create();
			await store.addMessage(conv.id, makeMessage("user", "Hi"));
			await store.addMessage(
				conv.id,
				makeMessage("assistant", "Hello!")
			);
			const before = store.get(conv.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			await store.removeLastAssistantMessage(conv.id);

			expect(store.get(conv.id)!.updatedAt).toBeGreaterThanOrEqual(
				before
			);
		});
	});

	// --- Title Generation ---

	describe("title generation", () => {
		it("should return 'New conversation' for empty/whitespace-only messages", async () => {
			const store = await createStore();
			const conv = await store.create("   ");
			expect(conv.title).toBe("New conversation");
		});

		it("should return 'New conversation' if message is only file context", async () => {
			const store = await createStore();
			const conv = await store.create("[Currently viewing: file.ts]");
			expect(conv.title).toBe("New conversation");
		});

		it("should keep short titles as-is", async () => {
			const store = await createStore();
			const conv = await store.create("Fix the bug");
			expect(conv.title).toBe("Fix the bug");
		});

		it("should strip multiple file context lines", async () => {
			const store = await createStore();
			const conv = await store.create(
				"[Currently viewing: main.ts]\n[Selection: lines 1-10]\nRefactor this"
			);
			expect(conv.title).toBe("Refactor this");
		});
	});
});
