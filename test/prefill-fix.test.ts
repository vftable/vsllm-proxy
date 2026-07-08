import test from "node:test";
import assert from "node:assert";
import {
  modelNeedsFix,
  buildUserMessage,
  extractToolUseIds,
  applyPrefillFix,
} from "../src/prefill-fix.js";

test("modelNeedsFix matches Claude 4.6+ ids", () => {
  assert.ok(modelNeedsFix("claude-sonnet-4-6"));
  assert.ok(modelNeedsFix("claude-opus-4-7"));
  assert.ok(modelNeedsFix("claude-haiku-4-6-20250101"));
  assert.ok(modelNeedsFix("CLAUDE-SONNET-4-8"));
  assert.ok(modelNeedsFix("claude-sonnet-5-20260101"));
  assert.ok(modelNeedsFix("claude-mythos"));
});

test("modelNeedsFix does not match older Claude models", () => {
  assert.ok(!modelNeedsFix("claude-sonnet-4-5"));
  assert.ok(!modelNeedsFix("claude-3-5-sonnet-20240620"));
  assert.ok(!modelNeedsFix("claude-sonnet-4-5-20250929"));
  assert.ok(!modelNeedsFix("gpt-4o"));
});

test("modelNeedsFix matches two-digit minor versions (4-10, 4-55)", () => {
  assert.ok(modelNeedsFix("claude-sonnet-4-10"));
  assert.ok(modelNeedsFix("claude-sonnet-4-55"));
  assert.ok(modelNeedsFix("claude-opus-4-50"));
  assert.ok(modelNeedsFix("claude-sonnet-4-55-20260101"));
});

test("modelNeedsFix matches claude-fable and claude-mythos", () => {
  assert.ok(modelNeedsFix("claude-fable"));
  assert.ok(modelNeedsFix("claude-fable-5-20260101"));
  assert.ok(modelNeedsFix("claude-mythos"));
});

test("buildUserMessage returns a plain continue when no tool_use", () => {
  assert.deepEqual(buildUserMessage("text"), {
    role: "user",
    content: "continue",
  });
  assert.deepEqual(buildUserMessage([{ type: "text", text: "hi" }]), {
    role: "user",
    content: "continue",
  });
});

test("buildUserMessage returns tool_result blocks when tool_use present", () => {
  const msg = buildUserMessage([
    { type: "text", text: "calling tool" },
    { type: "tool_use", id: "toolu_1" },
    { type: "tool_use", id: "toolu_2" },
  ]);
  assert.deepEqual(msg, {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "continue" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "continue" },
    ],
  });
});

test("extractToolUseIds handles non-array content", () => {
  assert.deepEqual(extractToolUseIds("text"), []);
  assert.deepEqual(extractToolUseIds(null), []);
});

test("applyPrefillFix appends user message for trailing assistant turn", () => {
  const body: any = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
  const changed = applyPrefillFix(body);
  assert.equal(changed, true);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[2], { role: "user", content: "continue" });
});

test("applyPrefillFix is a no-op when last message is user", () => {
  const body: any = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(applyPrefillFix(body), false);
  assert.equal(body.messages.length, 1);
});

test("applyPrefillFix is a no-op for non-Claude-4.6+ models", () => {
  const body: any = {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
  assert.equal(applyPrefillFix(body), false);
  assert.equal(body.messages.length, 2);
});

test("applyPrefillFix appends tool_result blocks for trailing tool_use", () => {
  const body: any = {
    model: "claude-opus-4-7",
    messages: [
      { role: "user", content: "use the tool" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "toolu_abc" },
        ],
      },
    ],
  };
  assert.equal(applyPrefillFix(body), true);
  assert.deepEqual(body.messages[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_abc", content: "continue" },
    ],
  });
});

test("applyPrefillFix no-op when messages missing", () => {
  assert.equal(applyPrefillFix({ model: "claude-sonnet-4-6" }), false);
  assert.equal(applyPrefillFix({}), false);
  assert.equal(applyPrefillFix(null), false);
});
