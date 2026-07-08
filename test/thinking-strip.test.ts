import test from "node:test";
import assert from "node:assert";
import {
  stripThinkingBlocks,
  thinkingBlocksToText,
} from "../src/thinking-strip.js";

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

test("stripThinkingBlocks also drops redacted_thinking blocks", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "encrypted-blob" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = stripThinkingBlocks(body);
  const content = (
    out.messages as Array<{ content: Array<{ type: string }> }>
  )[0]!.content;
  assert.equal(content.length, 1);
  assert.equal(content[0]!.type, "text");
});

// ---------------------------------------------------------------------------
// thinkingBlocksToText — convert thinking → signature-free text
// ---------------------------------------------------------------------------

test("thinkingBlocksToText rewrites a thinking block to a signature-free text block", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "step-by-step reasoning",
            signature: "sig",
          },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const content = (
    out.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0]!.content;
  assert.equal(content.length, 2);
  // The former thinking block is now a plain text block carrying the prose,
  // with NO signature field (the whole point — nothing to reject cross-account).
  assert.deepEqual(content[0], {
    type: "text",
    text: "step-by-step reasoning",
  });
  assert.ok(
    !("signature" in content[0]!),
    "converted block must have no signature",
  );
  assert.deepEqual(content[1], { type: "text", text: "answer" });
});

test("thinkingBlocksToText drops empty / whitespace-only thinking (would be an invalid empty text block)", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig" }, // display:"omitted" default
          { type: "thinking", thinking: "   \n", signature: "sig2" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const content = (
    out.messages as Array<{ content: Array<{ type: string }> }>
  )[0]!.content;
  assert.equal(content.length, 1, "both empty thinking blocks dropped");
  assert.equal(content[0]!.type, "text");
});

test("thinkingBlocksToText drops redacted_thinking (encrypted, no readable prose)", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "blob" },
          { type: "thinking", thinking: "visible reasoning", signature: "s" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const content = (
    out.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0]!.content;
  assert.equal(content.length, 1);
  assert.deepEqual(content[0], { type: "text", text: "visible reasoning" });
});

test("thinkingBlocksToText preserves tool_use / tool_result / image untouched", () => {
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
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const a = (out.messages as Array<{ content: Array<{ type: string }> }>)[0]!
    .content;
  assert.deepEqual(a[0], { type: "text", text: "r" });
  assert.equal(a[1]!.type, "tool_use");
  const u = (out.messages as Array<{ content: Array<{ type: string }> }>)[1]!
    .content;
  assert.equal(u[0]!.type, "tool_result");
});

test("thinkingBlocksToText does not mutate the input body", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "r", signature: "s" }],
      },
    ],
  };
  const snap = JSON.parse(JSON.stringify(body));
  thinkingBlocksToText(body);
  assert.deepEqual(body, snap);
});

test("thinkingBlocksToText tolerates non-array content and missing messages", () => {
  assert.deepEqual(thinkingBlocksToText({}), {});
  const keep = { messages: [{ role: "user", content: "plain string" }] };
  assert.deepEqual(thinkingBlocksToText(keep), keep);
});
