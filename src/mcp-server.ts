import * as http from "http";
import * as crypto from "crypto";
import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";

// ---------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------
// MCP tool schema types
// ---------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------
// SSE session — tracks one connected client
// ---------------------------------------------------------------

class SseSession {
  readonly id: string;
  private res: http.ServerResponse;

  constructor(res: http.ServerResponse) {
    this.id = crypto.randomUUID();
    this.res = res;
  }

  /** Send an SSE event to the connected client. */
  send(event: string, data: string): void {
    this.res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  /** Close the SSE stream. */
  close(): void {
    this.res.end();
  }
}

// ---------------------------------------------------------------
// MCP tool result helpers
// ---------------------------------------------------------------

function mcpText(text: string) {
  return { content: [{ type: "text", text }] };
}

function mcpError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------
// Main MCP server class
// ---------------------------------------------------------------

export class ObsidianMcpServer {
  private app: App;
  private httpServer: http.Server | null = null;
  private sessions: Map<string, SseSession> = new Map();
  private tools: McpTool[];
  private port = 0;

  constructor(app: App) {
    this.app = app;
    this.tools = this.defineTools();
  }

  /**
   * Start the HTTP server. Port 0 = OS picks a free port.
   * Returns the actual port.
   */
  async start(): Promise<number> {
    this.httpServer = http.createServer(this.handleRequest.bind(this));

    return new Promise((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr !== "string") {
          this.port = addr.port;
        }
        console.log(`[mcp-server] Listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return this.port;
  }

  // ---------------------------------------------------------------
  // HTTP routing
  // ---------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      this.handleSse(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      this.handlePost(req, res, sessionId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  // ---------------------------------------------------------------
  // GET /sse — open SSE stream, send endpoint event
  // ---------------------------------------------------------------

  private handleSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const session = new SseSession(res);
    this.sessions.set(session.id, session);

    // Tell the client where to POST messages
    session.send("endpoint", `/messages?sessionId=${session.id}`);

    res.on("close", () => {
      this.sessions.delete(session.id);
    });
  }

  // ---------------------------------------------------------------
  // POST /messages — receive JSON-RPC, respond via SSE
  // ---------------------------------------------------------------

  private handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string | null
  ): void {
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Unknown session");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      // Accept the POST immediately (MCP SSE convention)
      res.writeHead(202);
      res.end("Accepted");

      // Process the JSON-RPC message and send result via SSE
      this.processJsonRpc(body, session).catch((err) => {
        console.error("[mcp-server] Error processing JSON-RPC:", err);
      });
    });
  }

  // ---------------------------------------------------------------
  // JSON-RPC dispatch
  // ---------------------------------------------------------------

  private async processJsonRpc(body: string, session: SseSession): Promise<void> {
    let rpcReq: JsonRpcRequest;
    try {
      rpcReq = JSON.parse(body);
    } catch {
      const errResp: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" },
      };
      session.send("message", JSON.stringify(errResp));
      return;
    }

    let result: unknown;
    let error: { code: number; message: string } | undefined;

    try {
      switch (rpcReq.method) {
        case "initialize":
          result = this.handleInitialize(rpcReq.params);
          break;
        case "notifications/initialized":
          // Client ack — no response needed
          return;
        case "tools/list":
          result = { tools: this.tools };
          break;
        case "tools/call":
          result = await this.handleToolCall(rpcReq.params);
          break;
        case "ping":
          result = {};
          break;
        default:
          error = { code: -32601, message: `Method not found: ${rpcReq.method}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error = { code: -32603, message: msg };
    }

    const resp: JsonRpcResponse = { jsonrpc: "2.0", id: rpcReq.id };
    if (error) {
      resp.error = error;
    } else {
      resp.result = result;
    }

    session.send("message", JSON.stringify(resp));
  }

  // ---------------------------------------------------------------
  // MCP protocol handlers
  // ---------------------------------------------------------------

  private handleInitialize(_params?: Record<string, unknown>) {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "obsidian", version: "0.1.0" },
    };
  }

  private async handleToolCall(params?: Record<string, unknown>) {
    const name = params?.name as string | undefined;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;

    if (!name) {
      return mcpError("Missing tool name");
    }

    try {
      switch (name) {
        case "obsidian_read_active":
          return await this.toolReadActive();
        case "obsidian_edit":
          return await this.toolEdit(
            args as { file_path: string; old_string: string; new_string: string }
          );
        case "obsidian_write":
          return await this.toolWrite(args as { file_path: string; content: string });
        case "obsidian_create":
          return await this.toolCreate(args as { file_path: string; content: string });
        default:
          return mcpError(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return mcpError(`Error: ${msg}`);
    }
  }

  // ---------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------

  private defineTools(): McpTool[] {
    return [
      {
        name: "obsidian_read_active",
        description:
          "Read the currently active file in Obsidian, including content, selection, cursor position, frontmatter, and tags.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "obsidian_edit",
        description:
          "Edit a file by finding and replacing an exact string. Uses the editor API for open files to avoid conflicts.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Vault-relative path" },
            old_string: { type: "string", description: "Exact text to find" },
            new_string: { type: "string", description: "Replacement text" },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
      {
        name: "obsidian_write",
        description:
          "Write (overwrite) an entire file. Creates it if it doesn't exist. Uses the editor API for open files.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Vault-relative path" },
            content: { type: "string", description: "Full file content" },
          },
          required: ["file_path", "content"],
        },
      },
      {
        name: "obsidian_create",
        description: "Create a new file. Fails if it already exists.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Vault-relative path" },
            content: { type: "string", description: "File content" },
          },
          required: ["file_path", "content"],
        },
      },
    ];
  }

  // ---------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------

  private async toolReadActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return mcpError("No active file open in Obsidian.");
    }

    const editorInfo = this.findEditorForFile(file.path);
    const content = editorInfo
      ? editorInfo.editor.getValue()
      : await this.app.vault.read(file);

    const result: Record<string, unknown> = { file_path: file.path, content };

    if (editorInfo) {
      const sel = editorInfo.editor.getSelection();
      if (sel) result.selection = sel;
      result.cursor_line = editorInfo.editor.getCursor().line + 1;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter) result.frontmatter = { ...cache.frontmatter };
    if (cache?.tags) result.tags = cache.tags.map((t) => t.tag);

    return mcpText(JSON.stringify(result, null, 2));
  }

  private async toolEdit(args: {
    file_path: string;
    old_string: string;
    new_string: string;
  }) {
    const { file_path, old_string, new_string } = args;
    const file = this.app.vault.getAbstractFileByPath(file_path);
    if (!(file instanceof TFile)) {
      return mcpError(`File not found: ${file_path}`);
    }

    // Editor-first strategy
    const editorInfo = this.findEditorForFile(file_path);
    if (editorInfo) {
      const { editor } = editorInfo;
      const content = editor.getValue();
      const idx = content.indexOf(old_string);
      if (idx === -1) {
        return mcpError(`old_string not found in ${file_path}`);
      }
      const from = editor.offsetToPos(idx);
      const to = editor.offsetToPos(idx + old_string.length);
      editor.replaceRange(new_string, from, to);
      new Notice(`Edited: ${file_path}`);
      return mcpText(`Edited ${file_path} (via editor)`);
    }

    // Fallback: vault.process for closed files
    let found = false;
    await this.app.vault.process(file, (data) => {
      if (data.includes(old_string)) {
        found = true;
        return data.replace(old_string, new_string);
      }
      return data;
    });

    if (!found) {
      return mcpError(`old_string not found in ${file_path}`);
    }

    new Notice(`Edited: ${file_path}`);
    return mcpText(`Edited ${file_path} (via vault)`);
  }

  private async toolWrite(args: { file_path: string; content: string }) {
    const { file_path, content } = args;
    const file = this.app.vault.getAbstractFileByPath(file_path);

    if (file instanceof TFile) {
      const editorInfo = this.findEditorForFile(file_path);
      if (editorInfo) {
        editorInfo.editor.setValue(content);
        new Notice(`Written: ${file_path}`);
        return mcpText(`Written ${file_path} (via editor)`);
      }

      await this.app.vault.modify(file, content);
      new Notice(`Written: ${file_path}`);
      return mcpText(`Written ${file_path} (via vault)`);
    }

    // File doesn't exist — create it
    await this.ensureFolder(file_path);
    await this.app.vault.create(file_path, content);
    new Notice(`Created: ${file_path}`);
    return mcpText(`Created ${file_path}`);
  }

  private async toolCreate(args: { file_path: string; content: string }) {
    const { file_path, content } = args;
    const existing = this.app.vault.getAbstractFileByPath(file_path);
    if (existing) {
      return mcpError(`File already exists: ${file_path}. Use obsidian_write to overwrite.`);
    }

    await this.ensureFolder(file_path);
    await this.app.vault.create(file_path, content);
    new Notice(`Created: ${file_path}`);
    return mcpText(`Created ${file_path}`);
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  private findEditorForFile(
    filePath: string
  ): { editor: Editor; view: MarkdownView } | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === filePath) {
        return { editor: view.editor, view };
      }
    }
    return null;
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) {
      try {
        await this.app.vault.createFolder(dir);
      } catch {
        // Folder already exists
      }
    }
  }
}
