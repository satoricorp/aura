import { describe, expect, test } from "bun:test";
import { SessionCapture } from "../src/core/proxy/capture";

describe("SessionCapture", () => {
  test("captures streaming text, tool calls, token usage, and files", () => {
    const capture = new SessionCapture(
      "req_test",
      {
        max_tokens: 1000,
        messages: [{ role: "user", content: "fix parser" }],
        model: "claude-test",
      },
      "/tmp/session.jsonl",
    );

    const events = [
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 0, delta: { text: "Done" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", name: "Edit", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { partial_json: '{"file_path":"src/utils/parser.ts"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ];

    const raw = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    capture.observeSseChunk(Buffer.from(raw));

    expect(capture.toSummary()).toEqual(
      expect.objectContaining({
        finalAssistantText: "Done",
        inputTokens: 12,
        outputTokens: 7,
        originalTask: "fix parser",
        toolCalls: [
          {
            input: { file_path: "src/utils/parser.ts" },
            summary: "Edit src/utils/parser.ts",
            tool_name: "Edit",
          },
        ],
      }),
    );
    expect(capture.toSummary().filesTouched).toEqual([
      {
        action: "modified",
        note: "Edit referenced this path",
        path: "src/utils/parser.ts",
      },
    ]);
  });

  test("captures CRLF-delimited streaming events", () => {
    const capture = new SessionCapture(
      "req_test",
      {
        messages: [{ role: "user", content: "fix parser" }],
      },
      "/tmp/session.jsonl",
    );

    const raw = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_delta", index: 0, delta: { text: "Done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("");

    const events = capture.observeSseChunk(Buffer.from(raw));

    expect(events).toHaveLength(4);
    expect(capture.toSummary().finalAssistantText).toBe("Done");
  });

  test("captures non-streaming responses", () => {
    const capture = new SessionCapture(
      "req_test",
      {
        messages: [{ role: "user", content: [{ type: "text", text: "read only" }] }],
      },
      "/tmp/session.jsonl",
    );

    capture.observeNonStreamingResponse(
      Buffer.from(
        JSON.stringify({
          content: [{ type: "text", text: "No changes made" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      ),
    );

    expect(capture.toSummary()).toEqual(
      expect.objectContaining({
        finalAssistantText: "No changes made",
        filesTouched: [],
        inputTokens: 3,
        originalTask: "read only",
        outputTokens: 4,
      }),
    );
  });

  test("includes tool calls already present in request history", () => {
    const capture = new SessionCapture(
      "req_test",
      {
        messages: [
          { role: "user", content: "create a readme" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Write",
                input: { file_path: "README.md", content: "# Project" },
              },
            ],
          },
        ],
      },
      "/tmp/session.jsonl",
    );

    expect(capture.toSummary().toolCalls).toEqual([
      {
        input: { file_path: "README.md", content: "# Project" },
        summary: "Write README.md",
        tool_name: "Write",
      },
    ]);
    expect(capture.toSummary().filesTouched).toEqual([
      {
        action: "created",
        note: "Write referenced this path",
        path: "README.md",
      },
    ]);
  });
});
