import test from "node:test";
import assert from "node:assert";
import {
  computeBillingHeader,
  extractFirstUserMessageText,
  injectBillingHeader,
  isBillingText,
  CC_VERSION,
} from "../src/billing.js";

// ---------------------------------------------------------------------------
// Test vectors from the spec
//   Message "hey":
//     SHA-256("hey") = "fa690b82..."  -> cch = "fa690"
//     sampled (all out of bounds)     = "000"
//     SHA-256("59cf53e54c78"+"000"+"2.1.37")[:3] = "0d9"
//     => cc_version = "2.1.37.0d9"
//   Message "":
//     SHA-256("") = "e3b0c442..."     -> cch = "e3b0c"
// ---------------------------------------------------------------------------

test("computeBillingHeader matches spec test vector for 'hey'", () => {
  const h = computeBillingHeader("hey");
  assert.ok(h.startsWith("x-anthropic-billing-header: "), `got: ${h}`);
  assert.ok(h.includes("cc_version=2.1.37.0d9;"), `cc_version mismatch: ${h}`);
  assert.ok(h.includes("cc_entrypoint=cli;"), `got: ${h}`);
  assert.ok(h.includes("cch=fa690;"), `cch mismatch: ${h}`);
  assert.ok(h.endsWith(";"));
});

test("computeBillingHeader matches spec test vector for empty message", () => {
  const h = computeBillingHeader("");
  assert.ok(h.includes("cch=e3b0c;"), `cch mismatch: ${h}`);
  // Empty message: sampled = "000" -> same version hash as "hey"
  assert.ok(h.includes("cc_version=2.1.37.0d9;"), `got: ${h}`);
});

test("computeBillingHeader produces the expected overall shape", () => {
  const h = computeBillingHeader("some longer message text here");
  assert.match(
    h,
    /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
  );
});

test("computeBillingHeader changes when the message changes", () => {
  const a = computeBillingHeader("hello");
  const b = computeBillingHeader("world");
  assert.notEqual(a, b, "different messages must produce different headers");
  // cch must differ
  assert.notEqual(
    a.match(/cch=([0-9a-f]{5})/)?.[1],
    b.match(/cch=([0-9a-f]{5})/)?.[1],
  );
});

test("computeBillingHeader supports custom entrypoint", () => {
  const h = computeBillingHeader("hey", "sdk");
  assert.ok(h.includes("cc_entrypoint=sdk;"), `got: ${h}`);
});

test("computeBillingHeader samples characters at indices 4, 7, 20", () => {
  // Message long enough that all indices are in bounds.
  // "0123456789abcdefghijklmnop" (length 27)
  //   index 4 = '4', index 7 = '7', index 20 = 'k'
  const msg = "0123456789abcdefghijklmnop";
  const h = computeBillingHeader(msg);
  // We can't easily verify the hash by hand, but we can verify it's stable
  // and different from the all-padded version.
  const padded = computeBillingHeader("hey"); // sampled "000"
  assert.notEqual(
    h.match(/cc_version=2\.1\.37\.([0-9a-f]{3})/)?.[1],
    padded.match(/cc_version=2\.1\.37\.([0-9a-f]{3})/)?.[1],
    "version hash should differ when sampled chars are in bounds",
  );
});

test("CC_VERSION is exported", () => {
  assert.equal(CC_VERSION, "2.1.37");
});

test("isBillingText recognises billing header lines", () => {
  assert.ok(
    isBillingText(
      "x-anthropic-billing-header: cc_version=2.1.37.0d9; cc_entrypoint=cli; cch=fa690;",
    ),
  );
  assert.ok(isBillingText("  x-anthropic-billing-header: whatever"));
  assert.ok(!isBillingText("You are Claude Code."));
  assert.ok(!isBillingText(undefined));
});

// ---------------------------------------------------------------------------
// extractFirstUserMessageText
// ---------------------------------------------------------------------------

test("extractFirstUserMessageText returns string content", () => {
  assert.equal(
    extractFirstUserMessageText({
      messages: [{ role: "user", content: "hey" }],
    }),
    "hey",
  );
});

test("extractFirstUserMessageText concatenates text blocks", () => {
  assert.equal(
    extractFirstUserMessageText({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image", source: {} },
            { type: "text", text: "world" },
          ],
        },
      ],
    }),
    "hello world",
  );
});

test("extractFirstUserMessageText finds the first user message", () => {
  assert.equal(
    extractFirstUserMessageText({
      messages: [
        { role: "assistant", content: "hi" },
        { role: "user", content: "found me" },
        { role: "user", content: "not me" },
      ],
    }),
    "found me",
  );
});

test("extractFirstUserMessageText returns empty when no user message", () => {
  assert.equal(
    extractFirstUserMessageText({ messages: [{ role: "assistant", content: "x" }] }),
    "",
  );
  assert.equal(extractFirstUserMessageText({}), "");
  assert.equal(extractFirstUserMessageText({ messages: [] }), "");
});

// ---------------------------------------------------------------------------
// injectBillingHeader
// ---------------------------------------------------------------------------

test("injectBillingHeader creates system when missing", () => {
  const body: Record<string, unknown> = { model: "claude-sonnet-4-6" };
  const text = computeBillingHeader("hey");
  const changed = injectBillingHeader(body, text);
  assert.equal(changed, true);
  assert.ok(Array.isArray(body.system));
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 1);
  assert.equal(sys[0].type, "text");
  assert.ok(sys[0].text.startsWith("x-anthropic-billing-header:"));
  assert.equal(sys[0].text, text);
});

test("injectBillingHeader converts a string system to an array", () => {
  const body: Record<string, unknown> = { system: "You are Claude Code." };
  const text = computeBillingHeader("hey");
  injectBillingHeader(body, text);
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 2);
  assert.equal(sys[0].text, text);
  assert.equal(sys[1].text, "You are Claude Code.");
});

test("injectBillingHeader prepends when no billing block exists", () => {
  const body: Record<string, unknown> = {
    system: [
      {
        type: "text",
        text: "You are Claude Code.",
        cache_control: { type: "ephemeral" },
      },
    ],
  };
  const text = computeBillingHeader("hey");
  injectBillingHeader(body, text);
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 2);
  assert.equal(sys[0].text, text);
  assert.equal(sys[1].text, "You are Claude Code.");
  // Existing block's cache_control is untouched.
  assert.deepEqual((sys[1] as { cache_control?: unknown }).cache_control, {
    type: "ephemeral",
  });
});

test("injectBillingHeader replaces an existing billing block in place", () => {
  const body: Record<string, unknown> = {
    system: [
      { type: "text", text: "x-anthropic-billing-header: OLD VALUE" },
      {
        type: "text",
        text: "You are Claude Code.",
        cache_control: { type: "ephemeral" },
      },
    ],
  };
  const text = computeBillingHeader("hey");
  injectBillingHeader(body, text);
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 2);
  assert.equal(sys[0].text, text);
  assert.ok(!sys[0].text.includes("OLD VALUE"));
  assert.equal(sys[1].text, "You are Claude Code.");
});

test("injectBillingHeader strips cache_control from replaced billing block", () => {
  const body: Record<string, unknown> = {
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: OLD",
        cache_control: { type: "ephemeral" },
      },
    ],
  };
  const text = computeBillingHeader("hey");
  injectBillingHeader(body, text);
  const sys = body.system as Array<Record<string, unknown>>;
  assert.equal(sys[0].text, text);
  assert.equal(sys[0].cache_control, undefined, "cache_control must be stripped");
});

test("injectBillingHeader does not duplicate the billing block on repeat calls", () => {
  const body: Record<string, unknown> = { model: "claude-sonnet-4-6" };
  injectBillingHeader(body, computeBillingHeader("a"));
  injectBillingHeader(body, computeBillingHeader("b"));
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 1);
  assert.ok(sys[0].text.includes("cch="));
});
