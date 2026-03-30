import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { JSDOM } from "jsdom";

// Set up global DOM APIs before anything else
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
	url: "http://localhost",
});

// Assign writable globals
const domGlobals: Record<string, any> = {
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
	HTMLDivElement: dom.window.HTMLDivElement,
	HTMLButtonElement: dom.window.HTMLButtonElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLSpanElement: dom.window.HTMLSpanElement,
	HTMLPreElement: dom.window.HTMLPreElement,
	Element: dom.window.Element,
	Node: dom.window.Node,
	Event: dom.window.Event,
	MouseEvent: dom.window.MouseEvent,
	KeyboardEvent: dom.window.KeyboardEvent,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
};

for (const [key, value] of Object.entries(domGlobals)) {
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

// navigator is read-only in Node — override with defineProperty
Object.defineProperty(globalThis, "navigator", {
	value: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
	writable: true,
	configurable: true,
});

// URL helpers for image previews
globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-url");
globalThis.URL.revokeObjectURL = vi.fn();

// Obsidian extends HTMLElement with convenience methods. Patch them onto the prototype.
const proto = dom.window.HTMLElement.prototype as any;

proto.empty = function () {
	while (this.firstChild) this.removeChild(this.firstChild);
};

proto.addClass = function (...classes: string[]) {
	this.classList.add(...classes);
};

proto.removeClass = function (...classes: string[]) {
	this.classList.remove(...classes);
};

proto.toggleClass = function (cls: string, force?: boolean) {
	this.classList.toggle(cls, force);
};

proto.hasClass = function (cls: string) {
	return this.classList.contains(cls);
};

proto.createDiv = function (options?: any) {
	const el = document.createElement("div");
	applyCreateOptions(el, options);
	this.appendChild(el);
	return el;
};

proto.createSpan = function (options?: any) {
	const el = document.createElement("span");
	applyCreateOptions(el, options);
	this.appendChild(el);
	return el;
};

proto.createEl = function (tag: string, options?: any) {
	const el = document.createElement(tag);
	applyCreateOptions(el, options);
	this.appendChild(el);
	return el;
};

proto.setText = function (text: string) {
	this.textContent = text;
};

proto.getText = function () {
	return this.textContent ?? "";
};

function applyCreateOptions(el: any, options?: any) {
	if (!options) return;
	if (options.cls) {
		const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(" ");
		el.classList.add(...classes);
	}
	if (options.text) {
		el.textContent = options.text;
	}
	if (options.attr) {
		for (const [k, v] of Object.entries(options.attr)) {
			el.setAttribute(k, v as string);
		}
	}
	if (options.type) {
		el.type = options.type;
	}
	if (options.placeholder) {
		el.placeholder = options.placeholder;
	}
	if (options.value) {
		el.value = options.value;
	}
}

import { ChatView, type FileAttachment } from "../src/chat-view";

// Helper: create a mock WorkspaceLeaf
function createMockLeaf() {
	return {
		app: {
			vault: {
				adapter: { getBasePath: () => "/vault" },
				getAbstractFileByPath: () => null,
			},
			workspace: {
				getActiveFile: () => null,
			},
			metadataCache: {
				getFileCache: () => null,
			},
		},
		view: null,
	} as any;
}

// Helper: create an initialized ChatView
async function createChatView(): Promise<ChatView> {
	const leaf = createMockLeaf();
	const view = new ChatView(leaf);
	await view.onOpen();
	return view;
}

// Helper: create a File with specific size
function createMockFile(name: string, type: string, size: number): File {
	// Create real file then override size
	const file = new File(["x"], name, { type });
	Object.defineProperty(file, "size", { value: size, writable: false });
	return file;
}

describe("ChatView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset clipboard mock
		(globalThis.navigator as any).clipboard = {
			writeText: vi.fn().mockResolvedValue(undefined),
		};
	});

	// =================================================================
	// Streaming / Stop generation
	// =================================================================

	describe("setStreaming", () => {
		it("should show stop button and hide send button while streaming", async () => {
			const view = await createChatView();
			const sendBtn = view.contentEl.querySelector(".claude-chat-send-btn") as HTMLElement;
			const stopBtn = view.contentEl.querySelector(".claude-chat-stop-btn") as HTMLElement;

			view.setStreaming(true);
			expect(sendBtn?.classList.contains("hidden")).toBe(true);
			expect(stopBtn?.classList.contains("hidden")).toBe(false);
		});

		it("should show send button and hide stop button when not streaming", async () => {
			const view = await createChatView();
			const sendBtn = view.contentEl.querySelector(".claude-chat-send-btn") as HTMLElement;
			const stopBtn = view.contentEl.querySelector(".claude-chat-stop-btn") as HTMLElement;

			view.setStreaming(true);
			view.setStreaming(false);

			expect(sendBtn?.classList.contains("hidden")).toBe(false);
			expect(stopBtn?.classList.contains("hidden")).toBe(true);
		});
	});

	describe("stop generation handler", () => {
		it("should invoke the callback when stop button is clicked", async () => {
			const view = await createChatView();
			const stopHandler = vi.fn();
			view.setStopHandler(stopHandler);

			view.setStreaming(true);
			const stopBtn = view.contentEl.querySelector(".claude-chat-stop-btn") as HTMLElement;
			stopBtn?.click();

			expect(stopHandler).toHaveBeenCalledTimes(1);
		});
	});

	// =================================================================
	// Message display
	// =================================================================

	describe("addMessage", () => {
		it("should add a user message to the DOM", async () => {
			const view = await createChatView();
			view.addMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			const msgs = view.contentEl.querySelectorAll(".claude-msg-user");
			expect(msgs.length).toBe(1);
		});

		it("should render the message content text", async () => {
			const view = await createChatView();
			view.addMessage({ role: "user", content: "Test content", timestamp: Date.now() });

			const contentEl = view.contentEl.querySelector(".claude-msg-content");
			expect(contentEl?.textContent).toBe("Test content");
		});
	});

	describe("clearMessages", () => {
		it("should remove all messages from the display", async () => {
			const view = await createChatView();
			view.addMessage({ role: "user", content: "msg1", timestamp: Date.now() });
			view.addMessage({ role: "user", content: "msg2", timestamp: Date.now() });

			view.clearMessages();

			const msgs = view.contentEl.querySelectorAll(".claude-msg");
			expect(msgs.length).toBe(0);
		});
	});

	// =================================================================
	// Edit & Resend
	// =================================================================

	describe("edit and resend", () => {
		it("should invoke handler with message index and new content", async () => {
			const view = await createChatView();
			const editHandler = vi.fn();
			view.setEditAndResendHandler(editHandler);

			view.addMessage({ role: "user", content: "Original", timestamp: Date.now() });

			const editBtn = view.contentEl.querySelector('[aria-label="Edit message"]') as HTMLElement;
			expect(editBtn).toBeTruthy();
			editBtn.click();

			const textarea = view.contentEl.querySelector(".claude-edit-textarea") as HTMLTextAreaElement;
			expect(textarea).toBeTruthy();
			expect(textarea.value).toBe("Original");

			textarea.value = "Edited";
			const saveBtn = view.contentEl.querySelector(".claude-edit-save") as HTMLElement;
			saveBtn.click();

			expect(editHandler).toHaveBeenCalledWith(0, "Edited");
		});

		it("should restore original content on cancel", async () => {
			const view = await createChatView();
			view.addMessage({ role: "user", content: "Original", timestamp: Date.now() });

			const editBtn = view.contentEl.querySelector('[aria-label="Edit message"]') as HTMLElement;
			editBtn.click();

			const cancelBtn = view.contentEl.querySelector(".claude-edit-cancel") as HTMLElement;
			cancelBtn.click();

			const contentEl = view.contentEl.querySelector(".claude-msg-content");
			expect(contentEl?.textContent).toBe("Original");
		});

		it("should not call handler if edited content is whitespace-only", async () => {
			const view = await createChatView();
			const editHandler = vi.fn();
			view.setEditAndResendHandler(editHandler);

			view.addMessage({ role: "user", content: "Original", timestamp: Date.now() });

			const editBtn = view.contentEl.querySelector('[aria-label="Edit message"]') as HTMLElement;
			editBtn.click();

			const textarea = view.contentEl.querySelector(".claude-edit-textarea") as HTMLTextAreaElement;
			textarea.value = "   ";

			const saveBtn = view.contentEl.querySelector(".claude-edit-save") as HTMLElement;
			saveBtn.click();

			expect(editHandler).not.toHaveBeenCalled();
		});
	});

	// =================================================================
	// Regenerate
	// =================================================================

	describe("regenerate response", () => {
		it("should invoke handler when regenerate button is clicked", async () => {
			const view = await createChatView();
			const regenHandler = vi.fn();
			view.setRegenerateHandler(regenHandler);

			view.startAssistantTurn();
			view.appendTextDelta("Response");
			view.finishAssistantTurn();

			const regenBtn = view.contentEl.querySelector('[aria-label="Regenerate response"]') as HTMLElement;
			expect(regenBtn).toBeTruthy();
			regenBtn.click();

			expect(regenHandler).toHaveBeenCalledTimes(1);
		});
	});

	// =================================================================
	// Copy buttons
	// =================================================================

	describe("copy message", () => {
		it("should render a copy button on user messages", async () => {
			const view = await createChatView();
			view.addMessage({ role: "user", content: "Copy me", timestamp: Date.now() });

			const copyBtn = view.contentEl.querySelector('[aria-label="Copy message"]');
			expect(copyBtn).toBeTruthy();
		});

		it("should render a copy button on finished assistant turns", async () => {
			const view = await createChatView();
			view.startAssistantTurn();
			view.appendTextDelta("Response");
			view.finishAssistantTurn();

			const copyBtn = view.contentEl.querySelector('[aria-label="Copy response"]');
			expect(copyBtn).toBeTruthy();
		});
	});

	// =================================================================
	// File upload validation
	// =================================================================

	describe("file upload", () => {
		describe("file type validation", () => {
			const SUPPORTED_MIME_TYPES = [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
				"text/plain",
				"text/markdown",
				"text/csv",
				"application/json",
			];

			for (const type of SUPPORTED_MIME_TYPES) {
				it(`should accept ${type} files`, async () => {
					const view = await createChatView();
					await (view as any).addAttachmentFromFile(createMockFile("test", type, 100));
					expect((view as any).pendingAttachments.length).toBe(1);
				});
			}

			it("should accept text files by extension fallback (.txt .md .csv .json .log .xml .yaml .yml .toml)", async () => {
				const textFiles = [
					"test.txt", "readme.md", "data.csv", "config.json",
					"app.log", "config.xml", "docker.yaml", "compose.yml", "cargo.toml",
				];

				for (const name of textFiles) {
					const view = await createChatView();
					await (view as any).addAttachmentFromFile(createMockFile(name, "", 100));
					expect((view as any).pendingAttachments.length, `Expected ${name} to be accepted`).toBe(1);
				}
			});

			it("should reject unsupported file types", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("malware.exe", "application/x-msdownload", 100));
				expect((view as any).pendingAttachments.length).toBe(0);
			});

			it("should reject a .zip file", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("archive.zip", "application/zip", 100));
				expect((view as any).pendingAttachments.length).toBe(0);
			});
		});

		describe("file size validation", () => {
			it("should accept files under 10MB", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("small.png", "image/png", 5 * 1024 * 1024));
				expect((view as any).pendingAttachments.length).toBe(1);
			});

			it("should accept files exactly at 10MB", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("exact.png", "image/png", 10 * 1024 * 1024));
				expect((view as any).pendingAttachments.length).toBe(1);
			});

			it("should reject files over 10MB", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("huge.png", "image/png", 10 * 1024 * 1024 + 1));
				expect((view as any).pendingAttachments.length).toBe(0);
			});
		});

		describe("attachment management", () => {
			it("should accumulate multiple attachments", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("a.png", "image/png", 100));
				await (view as any).addAttachmentFromFile(createMockFile("b.json", "application/json", 200));
				expect((view as any).pendingAttachments.length).toBe(2);
			});

			it("should remove an attachment by index", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("a.png", "image/png", 100));
				await (view as any).addAttachmentFromFile(createMockFile("b.png", "image/png", 200));

				(view as any).removeAttachment(0);

				expect((view as any).pendingAttachments.length).toBe(1);
				expect((view as any).pendingAttachments[0].name).toBe("b.png");
			});

			it("should clear all attachments", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("a.png", "image/png", 100));
				await (view as any).addAttachmentFromFile(createMockFile("b.png", "image/png", 100));

				(view as any).clearAttachments();

				expect((view as any).pendingAttachments.length).toBe(0);
			});

			it("should set previewUrl for image attachments", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("photo.png", "image/png", 100));
				expect((view as any).pendingAttachments[0].previewUrl).toBeDefined();
			});

			it("should not set previewUrl for non-image attachments", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("doc.pdf", "application/pdf", 100));
				expect((view as any).pendingAttachments[0].previewUrl).toBeUndefined();
			});

			it("should populate all attachment fields from the File", async () => {
				const view = await createChatView();
				await (view as any).addAttachmentFromFile(createMockFile("report.pdf", "application/pdf", 4096));

				const att: FileAttachment = (view as any).pendingAttachments[0];
				expect(att.name).toBe("report.pdf");
				expect(att.type).toBe("application/pdf");
				expect(att.size).toBe(4096);
				expect(att.data).toBeInstanceOf(ArrayBuffer);
			});
		});

		describe("send with attachments", () => {
			it("should pass attachments to the send handler", async () => {
				const view = await createChatView();
				const sendHandler = vi.fn();
				view.setSendHandler(sendHandler);

				await (view as any).addAttachmentFromFile(createMockFile("img.png", "image/png", 100));

				const inputEl = view.contentEl.querySelector(".claude-chat-input") as HTMLTextAreaElement;
				if (inputEl) inputEl.value = "Check this file";
				(view as any).sendMessage();

				expect(sendHandler).toHaveBeenCalledWith(
					"Check this file",
					expect.arrayContaining([expect.objectContaining({ name: "img.png" })])
				);
			});

			it("should clear attachments after sending", async () => {
				const view = await createChatView();
				view.setSendHandler(vi.fn());

				await (view as any).addAttachmentFromFile(createMockFile("img.png", "image/png", 100));

				const inputEl = view.contentEl.querySelector(".claude-chat-input") as HTMLTextAreaElement;
				if (inputEl) inputEl.value = "msg";
				(view as any).sendMessage();

				expect((view as any).pendingAttachments.length).toBe(0);
			});
		});
	});

	// =================================================================
	// FileAttachment interface shape
	// =================================================================

	describe("FileAttachment interface", () => {
		it("should have required fields", () => {
			const att: FileAttachment = {
				name: "test.png", type: "image/png", size: 1024, data: new ArrayBuffer(1024),
			};
			expect(att.name).toBe("test.png");
			expect(att.type).toBe("image/png");
			expect(att.size).toBe(1024);
			expect(att.data).toBeInstanceOf(ArrayBuffer);
			expect(att.previewUrl).toBeUndefined();
		});

		it("should accept optional previewUrl", () => {
			const att: FileAttachment = {
				name: "photo.jpg", type: "image/jpeg", size: 2048,
				data: new ArrayBuffer(2048), previewUrl: "blob:http://localhost/abc",
			};
			expect(att.previewUrl).toBe("blob:http://localhost/abc");
		});
	});

	// =================================================================
	// Format helpers
	// =================================================================

	describe("formatFileSize", () => {
		it("should format bytes", async () => {
			const view = await createChatView();
			const fmt = (view as any).formatFileSize.bind(view);
			expect(fmt(500)).toBe("500B");
		});

		it("should format kilobytes", async () => {
			const view = await createChatView();
			const fmt = (view as any).formatFileSize.bind(view);
			expect(fmt(1024)).toBe("1KB");
			expect(fmt(2560)).toBe("3KB");
		});

		it("should format megabytes", async () => {
			const view = await createChatView();
			const fmt = (view as any).formatFileSize.bind(view);
			expect(fmt(1024 * 1024)).toBe("1.0MB");
			expect(fmt(5.5 * 1024 * 1024)).toBe("5.5MB");
		});
	});

	describe("relativeTime", () => {
		it("should return 'now' for very recent timestamps", async () => {
			const view = await createChatView();
			const rt = (view as any).relativeTime.bind(view);
			expect(rt(Date.now())).toBe("now");
		});

		it("should return minutes for recent timestamps", async () => {
			const view = await createChatView();
			const rt = (view as any).relativeTime.bind(view);
			expect(rt(Date.now() - 5 * 60000)).toBe("5m");
		});

		it("should return hours for timestamps within a day", async () => {
			const view = await createChatView();
			const rt = (view as any).relativeTime.bind(view);
			expect(rt(Date.now() - 3 * 3600000)).toBe("3h");
		});

		it("should return days for timestamps within a week", async () => {
			const view = await createChatView();
			const rt = (view as any).relativeTime.bind(view);
			expect(rt(Date.now() - 2 * 86400000)).toBe("2d");
		});

		it("should return a date string for timestamps older than a week", async () => {
			const view = await createChatView();
			const rt = (view as any).relativeTime.bind(view);
			const result = rt(Date.now() - 14 * 86400000);
			expect(result).not.toMatch(/^\d+[mhd]$/);
			expect(result).not.toBe("now");
		});
	});
});
