import test from "node:test";
import assert from "node:assert";
import { stripThinkingBlocks } from "../src/thinking-strip.js";

test("stripThinkingBlocks drops thinking blocks from message content", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = stripThinkingBlocks(body);
  const content = (out.messages[0] as { content: Array<{ type: string }> })
    .content;
  assert.equal(content.length, 1);
  assert.equal(content[0]!.type, "text");
});

test("stripThinkingBlocks preserves tool_use / tool_result / image blocks", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r", signature: "s" },
          { type: "tool_use", id: "tu1", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "ok" },
          { type: "image", source: { type: "base64" } },
        ],
      },
    ],
  };
  const out = stripThinkingBlocks(body);
  const a = (out.messages[0] as { content: Array<{ type: string }> }).content;
  assert.equal(a.length, 1);
  assert.equal(a[0]!.type, "tool_use");
  const u = (out.messages[1] as { content: Array<{ type: string }> }).content;
  assert.equal(u.length, 2);
});

test("stripThinkingBlocks leaves messages with no thinking blocks untouched", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "hey" },
    ],
  };
  const out = stripThinkingBlocks(body);
  // Structurally identical (a shallow clone is acceptable).
  assert.deepEqual(out.messages, body.messages);
});

test("stripThinkingBlocks tolerates non-array content and missing messages", () => {
  assert.deepEqual(stripThinkingBlocks({}), {});
  assert.deepEqual(stripThinkingBlocks({ messages: [] }), { messages: [] });
  assert.deepEqual(stripThinkingBlocks({ messages: "bad" }), {
    messages: "bad",
  });
  const keep = { messages: [{ role: "user", content: "plain string" }] };
  assert.deepEqual(stripThinkingBlocks(keep), keep);
});

test("stripThinkingBlocks does not mutate the input body", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r", signature: "s" },
          { type: "text", text: "a" },
        ],
      },
    ],
  };
  const snap = JSON.parse(JSON.stringify(body));
  stripThinkingBlocks(body);
  assert.deepEqual(body, snap);
});
