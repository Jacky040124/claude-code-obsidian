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
        case "obsidian_search":
          return await this.toolSearch(
            args as {
              query?: string;
              tags?: string[];
              property?: { key: string; value: string };
              linked_to?: string;
              linked_from?: string;
              days_recent?: number;
              limit?: number;
            }
          );
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
      {
        name: "obsidian_search",
        description:
          "Search the Obsidian vault by content, tags, frontmatter properties, links, or recency. All parameters are optional - combine them to narrow results.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text to search for in file content (case-insensitive)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags, e.g. ['#project', '#todo']",
            },
            property: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
              },
              description: "Filter by frontmatter property key-value pair",
            },
            linked_to: {
              type: "string",
              description: "Find files that link TO this file path",
            },
            linked_from: {
              type: "string",
              description: "Find files linked FROM this file path",
            },
            days_recent: {
              type: "number",
              description: "Only include files modified within this many days",
            },
            limit: {
              type: "number",
              description: "Max results to return (default 20)",
            },
          },
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

  private async toolSearch(args: {
    query?: string;
    tags?: string[];
    property?: { key: string; value: string };
    linked_to?: string;
    linked_from?: string;
    days_recent?: number;
    limit?: number;
  }) {
    let candidates = this.app.vault.getMarkdownFiles();

    // Filter by recency (cheapest)
    if (args.days_recent != null) {
      const cutoff = Date.now() - args.days_recent * 86400000;
      candidates = candidates.filter((f) => f.stat.mtime > cutoff);
    }

    // Filter by tags
    if (args.tags && args.tags.length > 0) {
      candidates = candidates.filter((f) => {
        const fileTags = this.app.metadataCache.getFileCache(f)?.tags;
        if (!fileTags) return false;
        return args.tags!.some((requested) =>
          fileTags.some((ft) => ft.tag === requested)
        );
      });
    }

    // Filter by frontmatter property
    if (args.property) {
      const { key, value } = args.property;
      candidates = candidates.filter((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        if (!fm || !(key in fm)) return false;
        const fmVal = fm[key];
        if (Array.isArray(fmVal)) return fmVal.map(String).includes(value);
        return String(fmVal) === value;
      });
    }

    // Filter by linked_to (backlinks — files that link TO the given path)
    if (args.linked_to) {
      const candidatePaths = new Set(candidates.map((f) => f.path));
      const sourcePaths = new Set<string>();
      for (const [source, targets] of Object.entries(
        this.app.metadataCache.resolvedLinks
      )) {
        if ((targets as Record<string, number>)[args.linked_to] != null) {
          sourcePaths.add(source);
        }
      }
      candidates = candidates.filter(
        (f) => candidatePaths.has(f.path) && sourcePaths.has(f.path)
      );
    }

    // Filter by linked_from (outgoing links FROM the given path)
    if (args.linked_from) {
      const targets = this.app.metadataCache.resolvedLinks[args.linked_from];
      if (!targets) {
        candidates = [];
      } else {
        const targetPaths = new Set(Object.keys(targets as Record<string, number>));
        candidates = candidates.filter((f) => targetPaths.has(f.path));
      }
    }

    // Content search (most expensive — do last, cap at 100 reads)
    interface SearchResult {
      path: string;
      snippet?: string;
      tags?: string[];
      mtime: string;
    }

    let results: SearchResult[];

    if (args.query) {
      const queryLower = args.query.toLowerCase();
      const toSearch = candidates.slice(0, 100);
      results = [];
      for (const file of toSearch) {
        const content = await this.app.vault.read(file);
        const idxMatch = content.toLowerCase().indexOf(queryLower);
        if (idxMatch === -1) continue;

        const snippetStart = Math.max(0, idxMatch - 80);
        const snippetEnd = Math.min(content.length, idxMatch + args.query.length + 120);
        const snippet = content.substring(snippetStart, snippetEnd);

        const fileTags = this.app.metadataCache.getFileCache(file)?.tags?.map((t) => t.tag);
        results.push({
          path: file.path,
          snippet,
          tags: fileTags,
          mtime: new Date(file.stat.mtime).toISOString(),
        });
      }
    } else {
      results = candidates.map((file) => {
        const fileTags = this.app.metadataCache.getFileCache(file)?.tags?.map((t) => t.tag);
        return {
          path: file.path,
          tags: fileTags,
          mtime: new Date(file.stat.mtime).toISOString(),
        };
      });
    }

    // Sort by mtime descending
    results.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());

    // Apply limit
    results = results.slice(0, args.limit ?? 20);

    if (results.length === 0) {
      return mcpText(
        JSON.stringify({ results: [], message: "No files matched the search criteria" })
      );
    }

    return mcpText(JSON.stringify(results, null, 2));
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
