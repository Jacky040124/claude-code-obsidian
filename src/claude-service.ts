import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { RawCliEvent, InternalEvent, StreamTranslator } from "./event-translator";

// Re-export for consumers
export type { InternalEvent } from "./event-translator";

export interface ActiveFileContext {
  filePath: string;
  absolutePath: string;
  selection?: string;
  cursorLine?: number;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  viewType: string;
}

// --- Service options ---

export interface ClaudeServiceOptions {
  claudeBinaryPath?: string; // defaults to "claude"
  model?: string; // "sonnet", "opus", "haiku" — defaults to "sonnet"
  allowedTools?: string[];
  maxTurnMs?: number; // timeout per request
  mcpPort?: number; // MCP server port — enables MCP tools when set
}

const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
];

// GUI Electron apps don't inherit shell PATH.
// Prepend common bin dirs so we can find the claude binary.
function getEnhancedPath(): string {
  const home = homedir();
  const extraDirs = [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const existing = process.env.PATH ?? "";
  return [...extraDirs, existing].join(":");
}

// --- Main service class ---

// MCP tool names as they appear in Claude CLI stream output
const MCP_TOOLS = [
  "mcp__obsidian__obsidian_read_active",
  "mcp__obsidian__obsidian_edit",
  "mcp__obsidian__obsidian_write",
  "mcp__obsidian__obsidian_create",
  "mcp__obsidian__obsidian_search",
];

export class ClaudeCodeService extends EventEmitter {
  private process: ChildProcess | null = null;
  private binaryPath: string;
  private model: string;
  private allowedTools: string[];
  private maxTurnMs: number;
  private enhancedPath: string;
  private mcpPort: number | undefined;
  private mcpConfigPath: string | null = null;

  constructor(opts?: ClaudeServiceOptions) {
    super();
    this.binaryPath = opts?.claudeBinaryPath ?? "claude";
    this.model = opts?.model ?? "sonnet";
    this.allowedTools = opts?.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.maxTurnMs = opts?.maxTurnMs ?? 300_000; // 5 min default
    this.enhancedPath = getEnhancedPath();
    this.mcpPort = opts?.mcpPort;

    if (this.mcpPort) {
      this.writeMcpConfig(this.mcpPort);
    }
  }

  /**
   * Send a prompt and stream back events.
   */
  async *sendMessage(
    prompt: string,
    options: { sessionId?: string; workingDir: string; systemPrompt?: string }
  ): AsyncGenerator<InternalEvent> {
    const args = this.buildArgs(prompt, options.sessionId, options.systemPrompt);
    yield* this.spawnAndStream(args, options.workingDir);
  }

  /**
   * Start a new session. Returns session_id from the init event.
   */
  async startSession(workingDir: string): Promise<string> {
    const args = this.buildArgs("hello", undefined);
    for await (const event of this.spawnAndStream(args, workingDir)) {
      if (event.kind === "init") {
        this.cancelRequest();
        return event.sessionId;
      }
    }
    throw new Error("Failed to start session: no init event received");
  }

  /**
   * Resume an existing session with a new prompt.
   */
  async *resumeSession(
    sessionId: string,
    prompt: string,
    workingDir: string,
    systemPrompt?: string
  ): AsyncGenerator<InternalEvent> {
    const args = this.buildArgs(prompt, sessionId, systemPrompt);
    yield* this.spawnAndStream(args, workingDir);
  }

  /**
   * Kill the running subprocess.
   */
  cancelRequest(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Force kill after 3s if still alive
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 3000);
    }
    this.process = null;
  }

  /**
   * Check if claude binary is available.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.binaryPath, ["--version"], {
        stdio: "pipe",
        timeout: 5000,
        env: { ...process.env, PATH: this.enhancedPath },
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }

  /**
   * One-shot prompt: spawns an independent process (won't conflict with active chat),
   * collects the full text response, and returns it.
   */
  async sendOneShot(prompt: string, workingDir: string): Promise<string> {
    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--model", this.model,
    ];

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(this.binaryPath, args, {
        cwd: workingDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: this.enhancedPath },
      });

      let buffer = "";
      let result = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            // Collect assistant text deltas
            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta"
            ) {
              result += event.delta.text;
            }
            // Also handle the assistant message result format
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") result += block.text;
              }
            }
            // Handle result event that contains the final text
            if (event.type === "result" && event.result) {
              // If we haven't collected text via deltas, use the result
              if (!result) result = event.result;
            }
          } catch {
            // skip malformed lines
          }
        }
      });

      proc.on("error", (err) => reject(err));

      proc.on("close", (code) => {
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim());
            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta"
            ) {
              result += event.delta.text;
            }
          } catch {
            // ignore
          }
        }

        if (code !== 0 && !result) {
          reject(new Error(`Claude CLI exited with code ${code}`));
        } else {
          resolve(result.trim());
        }
      });

      // Timeout after maxTurnMs
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
          reject(new Error("Quick action timed out"));
        }
      }, this.maxTurnMs);
    });
  }

  // --- Private helpers ---

  /**
   * Write a temp MCP config JSON that Claude CLI will use to connect to our server.
   */
  private writeMcpConfig(port: number): void {
    const config = {
      mcpServers: {
        obsidian: {
          type: "sse",
          url: `http://127.0.0.1:${port}/sse`,
        },
      },
    };
    this.mcpConfigPath = join(tmpdir(), `obsidian-mcp-${process.pid}.json`);
    writeFileSync(this.mcpConfigPath, JSON.stringify(config, null, 2));
  }

  /**
   * Clean up the temp config file.
   */
  cleanupMcpConfig(): void {
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath);
      } catch {
        // ignore
      }
      this.mcpConfigPath = null;
    }
  }

  private buildArgs(prompt: string, sessionId?: string, systemPrompt?: string): string[] {
    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--model", this.model,
    ];

    // Allow read-only CLI tools + MCP tools
    const allAllowed = this.mcpConfigPath
      ? [...this.allowedTools, ...MCP_TOOLS]
      : this.allowedTools;

    for (const tool of allAllowed) {
      args.push("--allowedTools", tool);
    }

    // Block native edit tools — edits go through MCP
    args.push("--disallowedTools", "Edit", "Write", "NotebookEdit");

    // Point CLI at our local MCP server
    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }

    return args;
  }

  private async *spawnAndStream(
    args: string[],
    workingDir: string
  ): AsyncGenerator<InternalEvent> {
    const translator = new StreamTranslator();

    // Spawn claude CLI
    const proc = spawn(this.binaryPath, args, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: this.enhancedPath },
    });

    this.process = proc;

    // Set up timeout
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (this.maxTurnMs > 0) {
      timeoutId = setTimeout(() => {
        this.cancelRequest();
        this.emit("error", new Error("Request timed out"));
      }, this.maxTurnMs);
    }

    // Buffer for incomplete lines
    let buffer = "";

    // Create an async iterator from stdout
    const events: InternalEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const raw = JSON.parse(trimmed) as RawCliEvent;
          const translated = translator.translate(raw);
          for (const evt of translated) {
            events.push(evt);
          }
          if (resolve) {
            resolve();
            resolve = null;
          }
        } catch {
          // Malformed JSON line — skip gracefully
          // Malformed JSON line — silently skip
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) {
        console.error("[claude-service] stderr:", msg);
      }
    });

    proc.on("error", (err: Error) => {
      if (err.message.includes("ENOENT")) {
        error = new Error(
          `Claude CLI not found at "${this.binaryPath}". Install it with: npm install -g @anthropic-ai/claude-code`
        );
      } else {
        error = err;
      }
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    proc.on("close", () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const raw = JSON.parse(buffer.trim()) as RawCliEvent;
          const translated = translator.translate(raw);
          for (const evt of translated) {
            events.push(evt);
          }
        } catch {
          // ignore
        }
      }
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Yield events as they arrive
    try {
      while (true) {
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }

        if (done) {
          // Yield any remaining events
          while (events.length > 0) {
            yield events.shift()!;
          }
          break;
        }

        // Wait for next event or completion
        await new Promise<void>((r) => {
          resolve = r;
        });
      }

      if (error) {
        throw error;
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.process = null;
    }
  }
}
