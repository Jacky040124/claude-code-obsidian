import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// Mock child_process and fs before importing the service
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { ClaudeCodeService, type InternalEvent } from "../src/claude-service";

const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

const mockSpawn = vi.mocked(spawn);

// Helper: create a fake ChildProcess
function createMockProcess(): ChildProcess & {
  _stdout: EventEmitter;
  _stderr: EventEmitter;
  _emit: (event: string, ...args: any[]) => void;
} {
  const proc = new EventEmitter() as any;
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  proc.stdout = proc._stdout;
  proc.stderr = proc._stderr;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
    return true;
  });
  proc.pid = 12345;
  proc._emit = proc.emit.bind(proc);
  return proc;
}

// Helper: send a raw CLI JSON event line through stdout
function sendRawEvent(proc: ReturnType<typeof createMockProcess>, event: object) {
  proc._stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
}

// Helper: close the process
function closeProcess(proc: ReturnType<typeof createMockProcess>, code = 0) {
  proc._emit("close", code, null);
}

// --- Real CLI event factories ---

function makeSystemInit(sessionId = "sess-123") {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: ["Read", "Edit"],
    model: "claude-sonnet-4-6",
  };
}

function makeTextBlockStart(index = 0) {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text" } },
  };
}

function makeTextDelta(text: string, index = 0) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

function makeBlockStop(index = 0) {
  return {
    type: "stream_event",
    event: { type: "content_block_stop", index },
  };
}

function makeResult(sessionId = "sess-123", success = true) {
  return {
    type: "result",
    subtype: success ? "success" : "error",
    ...(success ? { result: "Done" } : { error: "Something failed" }),
    session_id: sessionId,
    cost_usd: 0.01,
    duration_ms: 1000,
    num_turns: 1,
  };
}

describe("ClaudeCodeService", () => {
  let service: ClaudeCodeService;
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as any);
    service = new ClaudeCodeService();
  });

  afterEach(() => {
    service.cancelRequest();
  });

  // --- Constructor & defaults ---

  describe("constructor", () => {
    it("uses default binary path 'claude'", () => {
      const svc = new ClaudeCodeService();
      const gen = svc.sendMessage("test", { workingDir: "/tmp" });
      gen.next(); // start the generator
      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.any(Object)
      );
    });

    it("accepts custom binary path", () => {
      const svc = new ClaudeCodeService({ claudeBinaryPath: "/usr/local/bin/claude" });
      const gen = svc.sendMessage("test", { workingDir: "/tmp" });
      gen.next();
      expect(mockSpawn).toHaveBeenCalledWith(
        "/usr/local/bin/claude",
        expect.any(Array),
        expect.any(Object)
      );
    });
  });

  // --- Streaming with real CLI event format ---

  describe("streaming with real CLI event format", () => {
    it("translates system init into internal init event", async () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      const p = gen.next();
      sendRawEvent(mockProc, makeSystemInit("sess-abc"));
      const result = await p;

      expect(result.value).toEqual({
        kind: "init",
        sessionId: "sess-abc",
        model: "claude-sonnet-4-6",
        tools: ["Read", "Edit"],
      });

      closeProcess(mockProc);
      for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}
    });

    it("translates a full text stream into text_delta events", async () => {
      const events: InternalEvent[] = [];
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });

      const collectPromise = (async () => {
        for await (const e of { [Symbol.asyncIterator]: () => gen }) {
          events.push(e);
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      sendRawEvent(mockProc, makeSystemInit());
      sendRawEvent(mockProc, makeTextBlockStart(0));
      sendRawEvent(mockProc, makeTextDelta("Hello!"));
      sendRawEvent(mockProc, makeBlockStop(0));
      sendRawEvent(mockProc, makeResult());
      closeProcess(mockProc);

      await collectPromise;

      expect(events).toHaveLength(3); // init, text_delta, result
      expect(events[0]).toMatchObject({ kind: "init" });
      expect(events[1]).toEqual({ kind: "text_delta", text: "Hello!" });
      expect(events[2]).toMatchObject({ kind: "result", success: true });
    });

    it("handles chunked data (split across buffers)", async () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      const event = makeSystemInit();
      const json = JSON.stringify(event);
      const mid = Math.floor(json.length / 2);

      const collectPromise = (async () => {
        const results: InternalEvent[] = [];
        for await (const e of { [Symbol.asyncIterator]: () => gen }) {
          results.push(e);
        }
        return results;
      })();

      await new Promise((r) => setTimeout(r, 10));
      mockProc._stdout.emit("data", Buffer.from(json.substring(0, mid)));
      mockProc._stdout.emit("data", Buffer.from(json.substring(mid) + "\n"));
      closeProcess(mockProc);

      const events = await collectPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "init", sessionId: "sess-123" });
    });

    it("skips malformed JSON lines gracefully", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });

      const collectPromise = (async () => {
        const results: InternalEvent[] = [];
        for await (const e of { [Symbol.asyncIterator]: () => gen }) {
          results.push(e);
        }
        return results;
      })();

      await new Promise((r) => setTimeout(r, 10));
      mockProc._stdout.emit("data", Buffer.from("not valid json\n"));
      sendRawEvent(mockProc, makeSystemInit());
      closeProcess(mockProc);

      const events = await collectPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "init" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("malformed"),
        expect.any(String)
      );
      warnSpy.mockRestore();
    });

    it("handles empty lines between events", async () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });

      const collectPromise = (async () => {
        const results: InternalEvent[] = [];
        for await (const e of { [Symbol.asyncIterator]: () => gen }) {
          results.push(e);
        }
        return results;
      })();

      await new Promise((r) => setTimeout(r, 10));
      const event = makeSystemInit();
      mockProc._stdout.emit("data", Buffer.from("\n\n" + JSON.stringify(event) + "\n\n"));
      closeProcess(mockProc);

      const events = await collectPromise;
      expect(events).toHaveLength(1);
    });

    it("parses remaining buffer on process close", async () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });

      const collectPromise = (async () => {
        const results: InternalEvent[] = [];
        for await (const e of { [Symbol.asyncIterator]: () => gen }) {
          results.push(e);
        }
        return results;
      })();

      await new Promise((r) => setTimeout(r, 10));
      // Send event WITHOUT trailing newline
      const event = makeSystemInit();
      mockProc._stdout.emit("data", Buffer.from(JSON.stringify(event)));
      closeProcess(mockProc);

      const events = await collectPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "init" });
    });
  });

  // --- Session management with real init/result events ---

  describe("session management", () => {
    it("startSession returns session_id from init event", async () => {
      const promise = service.startSession("/tmp");
      sendRawEvent(mockProc, makeSystemInit("sess-abc"));
      closeProcess(mockProc);

      const sessionId = await promise;
      expect(sessionId).toBe("sess-abc");
    });

    it("startSession cancels after getting init", async () => {
      const promise = service.startSession("/tmp");
      sendRawEvent(mockProc, makeSystemInit("sess-abc"));
      closeProcess(mockProc);

      await promise;
      expect(mockProc.kill).toHaveBeenCalled();
    });

    it("startSession throws if no init event", async () => {
      const promise = service.startSession("/tmp");
      closeProcess(mockProc);

      await expect(promise).rejects.toThrow("Failed to start session");
    });

    it("resumeSession passes --resume flag", async () => {
      const gen = service.resumeSession("sess-123", "continue", "/tmp");
      gen.next(); // trigger spawn

      const callArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(callArgs).toContain("--resume");
      expect(callArgs).toContain("sess-123");

      closeProcess(mockProc);
      for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}
    });

    it("sendMessage without sessionId does not include --resume", async () => {
      const gen = service.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const callArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(callArgs).not.toContain("--resume");

      closeProcess(mockProc);
      for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}
    });

    it("sendMessage with sessionId includes --resume", async () => {
      const gen = service.sendMessage("test", {
        workingDir: "/tmp",
        sessionId: "sess-456",
      });
      gen.next();

      const callArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(callArgs).toContain("--resume");
      expect(callArgs).toContain("sess-456");

      closeProcess(mockProc);
      for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("throws on ENOENT (binary not found)", async () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      const iterPromise = gen.next();

      const err = new Error("spawn claude ENOENT");
      (err as any).code = "ENOENT";
      mockProc._emit("error", err);

      await expect(async () => {
        await iterPromise;
        for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}
      }).rejects.toThrow("Claude CLI not found");
    });

    it("throws on generic spawn error", async () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      const iterPromise = gen.next();

      mockProc._emit("error", new Error("something went wrong"));

      await expect(async () => {
        await iterPromise;
        for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}
      }).rejects.toThrow("something went wrong");
    });

    it("logs stderr output", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      gen.next();

      mockProc._stderr.emit("data", Buffer.from("warning: something\n"));
      closeProcess(mockProc);

      for await (const _ of { [Symbol.asyncIterator]: () => gen }) {}

      expect(warnSpy).toHaveBeenCalledWith(
        "[claude-service] stderr:",
        expect.stringContaining("warning: something")
      );
      warnSpy.mockRestore();
    });
  });

  // --- Process cleanup ---

  describe("process cleanup", () => {
    it("cancelRequest kills the process with SIGTERM", () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      gen.next();

      service.cancelRequest();
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("cancelRequest is safe to call when no process", () => {
      expect(() => service.cancelRequest()).not.toThrow();
    });

    it("cancelRequest is idempotent", () => {
      const gen = service.sendMessage("hello", { workingDir: "/tmp" });
      gen.next();

      service.cancelRequest();
      service.cancelRequest();
      expect(mockProc.kill).toHaveBeenCalledTimes(1);
    });
  });

  // --- CLI args ---

  describe("buildArgs", () => {
    it("includes --output-format stream-json", () => {
      const gen = service.sendMessage("hello world", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
    });

    it("includes -p flag with prompt", () => {
      const gen = service.sendMessage("test prompt", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      const pIdx = args.indexOf("-p");
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(args[pIdx + 1]).toBe("test prompt");
    });

    it("includes --allowedTools with default tools", () => {
      const gen = service.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--allowedTools");
    });

    it("uses custom allowed tools", () => {
      const svc = new ClaudeCodeService({ allowedTools: ["Read"] });
      const gen = svc.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      const idx = args.indexOf("--allowedTools");
      expect(args[idx + 1]).toBe("Read");
    });

    it("passes workingDir as cwd", () => {
      const gen = service.sendMessage("test", { workingDir: "/my/vault" });
      gen.next();

      const spawnOpts = mockSpawn.mock.calls[0][2] as any;
      expect(spawnOpts.cwd).toBe("/my/vault");
    });
  });

  // --- isAvailable ---

  describe("isAvailable", () => {
    it("returns true when claude --version exits 0", async () => {
      const versionProc = createMockProcess();
      mockSpawn.mockReturnValueOnce(versionProc as any);

      const promise = service.isAvailable();
      versionProc._emit("close", 0, null);

      expect(await promise).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        ["--version"],
        expect.objectContaining({ stdio: "pipe" })
      );
    });

    it("returns false when claude --version exits non-zero", async () => {
      const versionProc = createMockProcess();
      mockSpawn.mockReturnValueOnce(versionProc as any);

      const promise = service.isAvailable();
      versionProc._emit("close", 1, null);

      expect(await promise).toBe(false);
    });

    it("returns false on spawn error", async () => {
      const versionProc = createMockProcess();
      mockSpawn.mockReturnValueOnce(versionProc as any);

      const promise = service.isAvailable();
      versionProc._emit("error", new Error("ENOENT"));

      expect(await promise).toBe(false);
    });
  });

  // --- MCP config ---

  describe("MCP server integration", () => {
    it("writes MCP config file when mcpPort is provided", () => {
      const svc = new ClaudeCodeService({ mcpPort: 27182 });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("obsidian-mcp-"),
        expect.stringContaining('"url": "http://127.0.0.1:27182/sse"')
      );
      svc.cleanupMcpConfig();
    });

    it("does not write MCP config when mcpPort is not provided", () => {
      mockWriteFileSync.mockClear();
      new ClaudeCodeService();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("includes --mcp-config in args when mcpPort is set", () => {
      const svc = new ClaudeCodeService({ mcpPort: 27182 });
      const gen = svc.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--mcp-config");
      const idx = args.indexOf("--mcp-config");
      expect(args[idx + 1]).toMatch(/obsidian-mcp-.*\.json$/);

      closeProcess(mockProc);
      svc.cleanupMcpConfig();
    });

    it("does not include --mcp-config when mcpPort is not set", () => {
      const gen = service.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--mcp-config");

      closeProcess(mockProc);
    });

    it("includes MCP tools in --allowedTools when mcpPort is set", () => {
      const svc = new ClaudeCodeService({ mcpPort: 27182 });
      const gen = svc.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("mcp__obsidian__obsidian_edit");
      expect(args).toContain("mcp__obsidian__obsidian_write");
      expect(args).toContain("mcp__obsidian__obsidian_create");
      expect(args).toContain("mcp__obsidian__obsidian_read_active");

      closeProcess(mockProc);
      svc.cleanupMcpConfig();
    });

    it("does not include MCP tools when mcpPort is not set", () => {
      const gen = service.sendMessage("test", { workingDir: "/tmp" });
      gen.next();

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("mcp__obsidian__obsidian_edit");

      closeProcess(mockProc);
    });

    it("cleanupMcpConfig removes the temp file", () => {
      const svc = new ClaudeCodeService({ mcpPort: 27182 });
      svc.cleanupMcpConfig();
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("obsidian-mcp-")
      );
    });

    it("cleanupMcpConfig is safe to call when no config exists", () => {
      expect(() => service.cleanupMcpConfig()).not.toThrow();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });
  });
});
