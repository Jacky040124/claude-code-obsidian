import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InternalEvent } from "../src/event-translator";

// We need to mock obsidian before importing FileSyncService
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

import { FileSyncService } from "../src/file-sync";

function createMockApp(vaultBasePath = "/Users/test/vault") {
  return {
    vault: {
      adapter: {
        getBasePath: () => vaultBasePath,
        read: vi.fn().mockResolvedValue("file content"),
      },
      getAbstractFileByPath: vi.fn(),
      modify: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
      getMarkdownFiles: vi.fn().mockReturnValue([]),
    },
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      trigger: vi.fn(),
    },
  } as any;
}

// Helper: simulate a full tool lifecycle (start → input deltas → end)
function simulateToolUse(
  service: FileSyncService,
  toolId: string,
  toolName: string,
  input: Record<string, unknown>
) {
  service.handleEvent({ kind: "tool_start", toolId, toolName });
  service.handleEvent({
    kind: "tool_input_delta",
    toolId,
    partialJson: JSON.stringify(input),
  });
  service.handleEvent({ kind: "tool_end", toolId });
}

describe("FileSyncService", () => {
  let service: FileSyncService;
  let mockApp: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp = createMockApp();
    service = new FileSyncService(mockApp);
  });

  // --- Change detection ---

  describe("change detection", () => {
    it("tracks Edit tool_use events via tool lifecycle", () => {
      // Should not throw
      simulateToolUse(service, "t1", "Edit", {
        file_path: "/Users/test/vault/notes/test.md",
      });
    });

    it("tracks Write tool_use events via tool lifecycle", () => {
      simulateToolUse(service, "t2", "Write", {
        file_path: "/Users/test/vault/notes/new.md",
      });
    });

    it("ignores non-file-modifying tools (Read, Grep, etc.)", async () => {
      simulateToolUse(service, "t3", "Read", {
        file_path: "/Users/test/vault/notes/test.md",
      });

      // Give async a chance to run
      await new Promise((r) => setTimeout(r, 20));
      expect(mockApp.vault.adapter.read).not.toHaveBeenCalled();
    });

    it("ignores tool_use without file_path", async () => {
      simulateToolUse(service, "t4", "Edit", {
        old_string: "foo",
        new_string: "bar",
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(mockApp.vault.adapter.read).not.toHaveBeenCalled();
    });

    it("ignores events of other kinds (init, text_delta, result)", () => {
      const events: InternalEvent[] = [
        { kind: "init", sessionId: "s", model: "m", tools: [] },
        { kind: "text_delta", text: "hello" },
        {
          kind: "result",
          success: true,
          sessionId: "s",
          costUsd: 0,
          durationMs: 0,
          numTurns: 1,
        },
      ];

      for (const e of events) {
        service.handleEvent(e);
      }
      // No errors and no vault operations
      expect(mockApp.vault.adapter.read).not.toHaveBeenCalled();
    });
  });

  // --- Refresh on tool_end ---

  describe("refresh on tool_end", () => {
    it("refreshes vault when Edit tool completes", async () => {
      const mockFile = { path: "notes/test.md" };
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      simulateToolUse(service, "t1", "Edit", {
        file_path: "/Users/test/vault/notes/test.md",
      });

      await vi.waitFor(() => {
        expect(mockApp.vault.adapter.read).toHaveBeenCalledWith("notes/test.md");
      });
    });

    it("handles incremental input_json_delta accumulation", async () => {
      const mockFile = { path: "notes/test.md" };
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      service.handleEvent({ kind: "tool_start", toolId: "t1", toolName: "Edit" });
      // Send JSON in chunks
      service.handleEvent({ kind: "tool_input_delta", toolId: "t1", partialJson: '{"file_' });
      service.handleEvent({ kind: "tool_input_delta", toolId: "t1", partialJson: 'path": "/Users/test/vault/' });
      service.handleEvent({ kind: "tool_input_delta", toolId: "t1", partialJson: 'notes/test.md"}' });
      service.handleEvent({ kind: "tool_end", toolId: "t1" });

      await vi.waitFor(() => {
        expect(mockApp.vault.adapter.read).toHaveBeenCalledWith("notes/test.md");
      });
    });

    it("creates new file if not found in vault", async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

      simulateToolUse(service, "t1", "Write", {
        file_path: "/Users/test/vault/new-file.md",
      });

      await vi.waitFor(() => {
        expect(mockApp.vault.create).toHaveBeenCalledWith(
          "new-file.md",
          "file content"
        );
      });
    });

    it("ignores files outside vault root", async () => {
      simulateToolUse(service, "t1", "Edit", {
        file_path: "/some/other/path/file.ts",
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(mockApp.vault.adapter.read).not.toHaveBeenCalled();
    });

    it("handles malformed accumulated JSON gracefully", async () => {
      service.handleEvent({ kind: "tool_start", toolId: "t1", toolName: "Edit" });
      service.handleEvent({ kind: "tool_input_delta", toolId: "t1", partialJson: "{invalid" });
      // Should not throw
      service.handleEvent({ kind: "tool_end", toolId: "t1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(mockApp.vault.adapter.read).not.toHaveBeenCalled();
    });
  });

  // --- Path conversion ---

  describe("vault path conversion", () => {
    it("converts absolute path to vault-relative", async () => {
      const mockFile = { path: "notes/test.md" };
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      simulateToolUse(service, "t1", "Edit", {
        file_path: "/Users/test/vault/notes/test.md",
      });

      await vi.waitFor(() => {
        expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalledWith(
          "notes/test.md"
        );
      });
    });
  });

  // --- forceVaultRefresh ---

  describe("forceVaultRefresh", () => {
    it("reads all markdown files", async () => {
      const files = [{ path: "a.md" }, { path: "b.md" }];
      mockApp.vault.getMarkdownFiles.mockReturnValue(files);

      await service.forceVaultRefresh();

      expect(mockApp.vault.adapter.read).toHaveBeenCalledTimes(2);
      expect(mockApp.vault.adapter.read).toHaveBeenCalledWith("a.md");
      expect(mockApp.vault.adapter.read).toHaveBeenCalledWith("b.md");
    });

    it("handles missing files gracefully", async () => {
      const files = [{ path: "deleted.md" }];
      mockApp.vault.getMarkdownFiles.mockReturnValue(files);
      mockApp.vault.adapter.read.mockRejectedValueOnce(new Error("not found"));

      // Should not throw
      await service.forceVaultRefresh();
    });
  });
});
