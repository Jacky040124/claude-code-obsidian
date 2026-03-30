// ============================================================
// Raw CLI types — match actual `claude -p --output-format stream-json --verbose` output
// ============================================================

export interface RawSystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: string[];
  model: string;
}

// --- Stream event inner types ---

export interface ContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text" }
    | { type: "tool_use"; id: string; name: string; input: string };
}

export interface ContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string };
}

export interface ContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface MessageStart {
  type: "message_start";
  message?: Record<string, unknown>;
}

export interface MessageDelta {
  type: "message_delta";
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export interface MessageStop {
  type: "message_stop";
}

export type StreamInnerEvent =
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageStart
  | MessageDelta
  | MessageStop;

export interface RawStreamEvent {
  type: "stream_event";
  event: StreamInnerEvent;
}

export interface RawAssistantMessage {
  type: "assistant";
  message: {
    role: string;
    content: unknown[];
    model: string;
    stop_reason: string;
  };
}

export interface RawResultEvent {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  error?: string;
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  num_turns: number;
}

export type RawCliEvent =
  | RawSystemInitEvent
  | RawStreamEvent
  | RawAssistantMessage
  | RawResultEvent;

// ============================================================
// Internal UI events — clean discriminated union for consumers
// ============================================================

export type InternalEvent =
  | { kind: "init"; sessionId: string; model: string; tools: string[] }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; thinking: string }
  | { kind: "tool_start"; toolId: string; toolName: string }
  | { kind: "tool_input_delta"; toolId: string; partialJson: string }
  | { kind: "tool_end"; toolId: string }
  | { kind: "assistant_message"; content: unknown[] }
  | {
      kind: "result";
      success: boolean;
      text?: string;
      error?: string;
      sessionId: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { kind: "error"; message: string };

// ============================================================
// StreamTranslator — stateful mapper from RawCliEvent → InternalEvent[]
// ============================================================

interface BlockInfo {
  type: "text" | "tool_use" | "thinking";
  toolId?: string;
  toolName?: string;
}

export class StreamTranslator {
  private blocks: Map<number, BlockInfo> = new Map();

  translate(raw: RawCliEvent): InternalEvent[] {
    switch (raw.type) {
      case "system":
        return this.handleSystemInit(raw);
      case "stream_event":
        return this.handleStreamEvent(raw);
      case "assistant":
        return this.handleAssistantMessage(raw);
      case "result":
        return this.handleResult(raw);
      default:
        return [];
    }
  }

  private handleSystemInit(event: RawSystemInitEvent): InternalEvent[] {
    return [
      {
        kind: "init",
        sessionId: event.session_id,
        model: event.model,
        tools: event.tools,
      },
    ];
  }

  private handleStreamEvent(event: RawStreamEvent): InternalEvent[] {
    const inner = event.event;
    switch (inner.type) {
      case "content_block_start":
        return this.handleContentBlockStart(inner);
      case "content_block_delta":
        return this.handleContentBlockDelta(inner);
      case "content_block_stop":
        return this.handleContentBlockStop(inner);
      default:
        // message_start, message_delta, message_stop — no UI events needed
        return [];
    }
  }

  private handleContentBlockStart(event: ContentBlockStart): InternalEvent[] {
    const block = event.content_block;
    if (block.type === "tool_use") {
      this.blocks.set(event.index, {
        type: "tool_use",
        toolId: block.id,
        toolName: block.name,
      });
      return [
        { kind: "tool_start", toolId: block.id, toolName: block.name },
      ];
    }
    // text or thinking blocks — type is determined on first delta
    this.blocks.set(event.index, { type: "text" });
    return [];
  }

  private handleContentBlockDelta(event: ContentBlockDelta): InternalEvent[] {
    const delta = event.delta;
    const block = this.blocks.get(event.index);

    if (delta.type === "text_delta") {
      return [{ kind: "text_delta", text: delta.text }];
    }

    if (delta.type === "thinking_delta") {
      // Update block type so we know it's a thinking block
      if (block) block.type = "thinking";
      return [{ kind: "thinking_delta", thinking: delta.thinking }];
    }

    if (delta.type === "input_json_delta") {
      const toolId = block?.toolId;
      if (toolId) {
        return [
          { kind: "tool_input_delta", toolId, partialJson: delta.partial_json },
        ];
      }
    }

    return [];
  }

  private handleContentBlockStop(event: ContentBlockStop): InternalEvent[] {
    const block = this.blocks.get(event.index);
    this.blocks.delete(event.index);

    if (block?.type === "tool_use" && block.toolId) {
      return [{ kind: "tool_end", toolId: block.toolId }];
    }
    return [];
  }

  private handleAssistantMessage(event: RawAssistantMessage): InternalEvent[] {
    return [{ kind: "assistant_message", content: event.message.content }];
  }

  private handleResult(event: RawResultEvent): InternalEvent[] {
    return [
      {
        kind: "result",
        success: event.subtype === "success",
        text: event.result,
        error: event.error,
        sessionId: event.session_id,
        costUsd: event.cost_usd,
        durationMs: event.duration_ms,
        numTurns: event.num_turns,
      },
    ];
  }
}
