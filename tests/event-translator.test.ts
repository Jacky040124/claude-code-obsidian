import { describe, it, expect, beforeEach } from "vitest";
import {
  StreamTranslator,
  type RawCliEvent,
  type RawSystemInitEvent,
  type RawStreamEvent,
  type RawAssistantMessage,
  type RawResultEvent,
  type InternalEvent,
} from "../src/event-translator";

describe("StreamTranslator", () => {
  let translator: StreamTranslator;

  beforeEach(() => {
    translator = new StreamTranslator();
  });

  // --- System init ---

  describe("system init", () => {
    it("translates system init to internal init event", () => {
      const raw: RawSystemInitEvent = {
        type: "system",
        subtype: "init",
        session_id: "sess-abc-123",
        tools: ["Read", "Edit", "Write"],
        model: "claude-sonnet-4-6",
      };

      const events = translator.translate(raw);
      expect(events).toEqual([
        {
          kind: "init",
          sessionId: "sess-abc-123",
          model: "claude-sonnet-4-6",
          tools: ["Read", "Edit", "Write"],
        },
      ]);
    });

    it("handles empty tools array", () => {
      const raw: RawSystemInitEvent = {
        type: "system",
        subtype: "init",
        session_id: "s",
        tools: [],
        model: "m",
      };

      const events = translator.translate(raw);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "init", tools: [] });
    });
  });

  // --- Text delta lifecycle ---

  describe("text delta translation", () => {
    it("translates content_block_start text → content_block_delta text_delta → content_block_stop", () => {
      // content_block_start for text — no output expected
      const start: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      };
      expect(translator.translate(start)).toEqual([]);

      // text_delta — should emit text_delta
      const delta: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      };
      const deltaEvents = translator.translate(delta);
      expect(deltaEvents).toEqual([{ kind: "text_delta", text: "Hello" }]);

      // Another text delta
      const delta2: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      };
      expect(translator.translate(delta2)).toEqual([{ kind: "text_delta", text: " world" }]);

      // content_block_stop for text — no tool_end expected
      const stop: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      };
      expect(translator.translate(stop)).toEqual([]);
    });
  });

  // --- Tool use lifecycle ---

  describe("tool use lifecycle", () => {
    it("translates tool_use start → input_json_delta → stop", () => {
      // content_block_start with tool_use
      const start: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_123", name: "Read", input: "" },
        },
      };
      const startEvents = translator.translate(start);
      expect(startEvents).toEqual([
        { kind: "tool_start", toolId: "tool_123", toolName: "Read" },
      ]);

      // input_json_delta
      const delta1: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_' },
        },
      };
      expect(translator.translate(delta1)).toEqual([
        { kind: "tool_input_delta", toolId: "tool_123", partialJson: '{"file_' },
      ]);

      const delta2: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'path": "/tmp/test.ts"}' },
        },
      };
      expect(translator.translate(delta2)).toEqual([
        { kind: "tool_input_delta", toolId: "tool_123", partialJson: 'path": "/tmp/test.ts"}' },
      ]);

      // content_block_stop — should emit tool_end
      const stop: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      };
      expect(translator.translate(stop)).toEqual([
        { kind: "tool_end", toolId: "tool_123" },
      ]);
    });
  });

  // --- Thinking delta ---

  describe("thinking delta translation", () => {
    it("translates thinking_delta events", () => {
      // Start a text block (thinking starts as text type)
      translator.translate({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      });

      // First thinking delta upgrades block type
      const delta: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me think about this..." },
        },
      };
      const events = translator.translate(delta);
      expect(events).toEqual([
        { kind: "thinking_delta", thinking: "Let me think about this..." },
      ]);

      // Subsequent thinking deltas
      const delta2: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: " Step 1: analyze." },
        },
      };
      expect(translator.translate(delta2)).toEqual([
        { kind: "thinking_delta", thinking: " Step 1: analyze." },
      ]);

      // Stop — thinking blocks are not tool_use, so no tool_end
      const stop: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      };
      expect(translator.translate(stop)).toEqual([]);
    });
  });

  // --- Result events ---

  describe("result event translation", () => {
    it("translates success result", () => {
      const raw: RawResultEvent = {
        type: "result",
        subtype: "success",
        result: "Done!",
        session_id: "sess-xyz",
        cost_usd: 0.0123,
        duration_ms: 5000,
        num_turns: 3,
      };

      const events = translator.translate(raw);
      expect(events).toEqual([
        {
          kind: "result",
          success: true,
          text: "Done!",
          error: undefined,
          sessionId: "sess-xyz",
          costUsd: 0.0123,
          durationMs: 5000,
          numTurns: 3,
        },
      ]);
    });

    it("translates error result", () => {
      const raw: RawResultEvent = {
        type: "result",
        subtype: "error",
        error: "Rate limit exceeded",
        session_id: "sess-err",
        cost_usd: 0.001,
        duration_ms: 200,
        num_turns: 0,
      };

      const events = translator.translate(raw);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "result",
        success: false,
        error: "Rate limit exceeded",
      });
    });
  });

  // --- Assistant message ---

  describe("assistant message translation", () => {
    it("translates assistant message with content array", () => {
      const raw: RawAssistantMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Hello!" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
          ],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
        },
      };

      const events = translator.translate(raw);
      expect(events).toEqual([
        {
          kind: "assistant_message",
          content: raw.message.content,
        },
      ]);
    });

    it("handles empty content array", () => {
      const raw: RawAssistantMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: "end_turn",
        },
      };

      const events = translator.translate(raw);
      expect(events).toEqual([{ kind: "assistant_message", content: [] }]);
    });
  });

  // --- Interleaved text and tool blocks ---

  describe("interleaved blocks", () => {
    it("handles text block then tool block at different indices", () => {
      const allEvents: InternalEvent[] = [];

      // Block 0: text
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
        })
      );
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll read the file." } },
        })
      );
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        })
      );

      // Block 1: tool_use
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "Read", input: "" },
          },
        })
      );
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/x"}' },
          },
        })
      );
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
        })
      );

      expect(allEvents).toEqual([
        // Block 0: text start produces nothing, delta produces text_delta, stop produces nothing
        { kind: "text_delta", text: "I'll read the file." },
        // Block 1: tool start, input delta, tool end
        { kind: "tool_start", toolId: "tu_1", toolName: "Read" },
        { kind: "tool_input_delta", toolId: "tu_1", partialJson: '{"file_path":"/tmp/x"}' },
        { kind: "tool_end", toolId: "tu_1" },
      ]);
    });

    it("handles multiple tool blocks in sequence", () => {
      const allEvents: InternalEvent[] = [];

      // Tool block at index 0
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "t_a", name: "Glob", input: "" },
          },
        })
      );
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        })
      );

      // Tool block at index 1
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "t_b", name: "Edit", input: "" },
          },
        })
      );
      allEvents.push(
        ...translator.translate({
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
        })
      );

      expect(allEvents).toEqual([
        { kind: "tool_start", toolId: "t_a", toolName: "Glob" },
        { kind: "tool_end", toolId: "t_a" },
        { kind: "tool_start", toolId: "t_b", toolName: "Edit" },
        { kind: "tool_end", toolId: "t_b" },
      ]);
    });
  });

  // --- Message-level events (should be silent) ---

  describe("message-level events", () => {
    it("message_start produces no internal events", () => {
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_123" } },
      };
      expect(translator.translate(raw)).toEqual([]);
    });

    it("message_delta produces no internal events", () => {
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
      };
      expect(translator.translate(raw)).toEqual([]);
    });

    it("message_stop produces no internal events", () => {
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: { type: "message_stop" },
      };
      expect(translator.translate(raw)).toEqual([]);
    });
  });

  // --- Unknown/malformed event handling ---

  describe("unknown event handling", () => {
    it("returns empty array for unknown top-level type", () => {
      const raw = { type: "some_future_event", data: 42 } as unknown as RawCliEvent;
      expect(translator.translate(raw)).toEqual([]);
    });

    it("returns empty array for unknown stream inner event type", () => {
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: { type: "ping" } as any,
      };
      expect(translator.translate(raw)).toEqual([]);
    });

    it("handles content_block_delta for unknown index gracefully", () => {
      // Delta without prior start — block map has no entry
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 99,
          delta: { type: "text_delta", text: "orphan" },
        },
      };
      // Should still produce text_delta (text_delta doesn't need block info)
      const events = translator.translate(raw);
      expect(events).toEqual([{ kind: "text_delta", text: "orphan" }]);
    });

    it("handles content_block_stop for unknown index gracefully", () => {
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_stop", index: 99 },
      };
      // No block tracked, so no tool_end emitted
      expect(translator.translate(raw)).toEqual([]);
    });

    it("handles input_json_delta with no tracked block", () => {
      const raw: RawStreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 50,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
      };
      // No toolId in block map → empty
      expect(translator.translate(raw)).toEqual([]);
    });
  });

  // --- State tracking ---

  describe("block index state tracking", () => {
    it("tracks separate indices independently", () => {
      // Start block 0 as text, block 1 as tool
      translator.translate({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      });
      translator.translate({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t1", name: "Bash", input: "" },
        },
      });

      // Delta on text block
      const textResult = translator.translate({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running..." } },
      });
      expect(textResult).toEqual([{ kind: "text_delta", text: "Running..." }]);

      // Delta on tool block
      const toolResult = translator.translate({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
        },
      });
      expect(toolResult).toEqual([
        { kind: "tool_input_delta", toolId: "t1", partialJson: '{"cmd":"ls"}' },
      ]);

      // Stop tool block
      const stopTool = translator.translate({
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
      });
      expect(stopTool).toEqual([{ kind: "tool_end", toolId: "t1" }]);

      // Stop text block
      const stopText = translator.translate({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      });
      expect(stopText).toEqual([]);
    });

    it("cleans up block info after stop", () => {
      // Start and stop a tool block
      translator.translate({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "Read", input: "" },
        },
      });
      translator.translate({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      });

      // Reuse index 0 with a new block — should not carry over old state
      translator.translate({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      });
      const delta = translator.translate({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "new text" } },
      });
      expect(delta).toEqual([{ kind: "text_delta", text: "new text" }]);

      // Stop should not emit tool_end since this is a text block now
      const stop = translator.translate({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      });
      expect(stop).toEqual([]);
    });
  });

  // --- Full stream simulation ---

  describe("full stream simulation", () => {
    it("processes a realistic sequence of CLI events", () => {
      const rawEvents: RawCliEvent[] = [
        // 1. System init
        { type: "system", subtype: "init", session_id: "sess-1", tools: ["Read", "Edit"], model: "claude-sonnet-4-6" },
        // 2. Message start
        { type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } },
        // 3. Text block
        { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll read " } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file." } } },
        { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
        // 4. Tool use block
        { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_read", name: "Read", input: "" } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":' } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"/tmp/test.ts"}' } } },
        { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
        // 5. Message stop
        { type: "stream_event", event: { type: "message_stop" } },
        // 6. Assistant message
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll read the file." }], model: "claude-sonnet-4-6", stop_reason: "end_turn" } },
        // 7. Result
        { type: "result", subtype: "success", result: "Done", session_id: "sess-1", cost_usd: 0.005, duration_ms: 2000, num_turns: 1 },
      ];

      const allInternal: InternalEvent[] = [];
      for (const raw of rawEvents) {
        allInternal.push(...translator.translate(raw));
      }

      expect(allInternal).toEqual([
        { kind: "init", sessionId: "sess-1", model: "claude-sonnet-4-6", tools: ["Read", "Edit"] },
        { kind: "text_delta", text: "I'll read " },
        { kind: "text_delta", text: "the file." },
        { kind: "tool_start", toolId: "tu_read", toolName: "Read" },
        { kind: "tool_input_delta", toolId: "tu_read", partialJson: '{"file_path":' },
        { kind: "tool_input_delta", toolId: "tu_read", partialJson: '"/tmp/test.ts"}' },
        { kind: "tool_end", toolId: "tu_read" },
        { kind: "assistant_message", content: [{ type: "text", text: "I'll read the file." }] },
        {
          kind: "result",
          success: true,
          text: "Done",
          error: undefined,
          sessionId: "sess-1",
          costUsd: 0.005,
          durationMs: 2000,
          numTurns: 1,
        },
      ]);
    });
  });
});
