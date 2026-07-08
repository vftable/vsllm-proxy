import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import {
  applyAnthropicBilling,
  buildBillingBlock,
  buildFinalBody,
  buildSystemArray,
  CC_ENTRYPOINT,
  CC_VERSION,
  CCH_PLACEHOLDER,
  CLAUDE_CODE_IDENTITY_TEXT,
  computeCchForBody,
  computeVersionSuffix,
  extractFirstUserText,
  isBillingText,
  normalizeSystemBlocks,
  serializeBody,
  stripExistingFingerprint,
  withBetaQuery,
} from "../src/billing.js";
import { CC_TOOL_NAMES } from "../src/tool-normalization.js";

const ENV_KEYS = [
  "PROXY_CC_VERSION",
  "PROXY_CCH_VALUE",
  "PROXY_CC_SCRUB_MESSAGES",
  "PROXY_CC_NORMALIZE_TOOLS",
  "PROXY_CC_DECOY_TOOLS",
] as const;

const snapshot: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  // Decoys default OFF in production now; tests exercise the full pipeline.
  process.env["PROXY_CC_DECOY_TOOLS"] = "true";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k]!;
  }
});

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("CC_VERSION is the current Claude Code release (2.1.196)", () => {
  assert.equal(CC_VERSION, "2.1.196");
  assert.equal(CC_ENTRYPOINT, "cli");
});

test("CLAUDE_CODE_IDENTITY_TEXT is the exact required string", () => {
  assert.equal(
    CLAUDE_CODE_IDENTITY_TEXT,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
});

// ---------------------------------------------------------------------------
// computeVersionSuffix
// ---------------------------------------------------------------------------

test("computeVersionSuffix pads missing indices with '0'", () => {
  // "hey" (length 3): indices 4/7/20 all out of bounds → "000".
  const expected = sha256(`59cf53e54c78000${CC_VERSION}`).slice(0, 3);
  assert.equal(computeVersionSuffix("hey", CC_VERSION), expected);
  assert.equal(computeVersionSuffix("", CC_VERSION), expected);
});

test("computeVersionSuffix samples chars at indices 4, 7, 20 (plain indexing)", () => {
  // "hello world": index4='o', index7='o', index20 out-of-bounds='0' → "oo0".
  const expected = sha256(`59cf53e54c78oo0${CC_VERSION}`).slice(0, 3);
  assert.equal(computeVersionSuffix("hello world", CC_VERSION), expected);
});

test("computeVersionSuffix differs once sampled chars are in bounds", () => {
  const short = computeVersionSuffix("hi", CC_VERSION); // "000"
  const long = computeVersionSuffix(
    "0123456789abcdefghijklmnop", // index4='4', index7='7', index20='k'
    CC_VERSION,
  );
  assert.notEqual(short, long);
});

// ---------------------------------------------------------------------------
// extractFirstUserText
// ---------------------------------------------------------------------------

test("extractFirstUserText returns string content of the first user message", () => {
  assert.equal(
    extractFirstUserText({
      messages: [{ role: "user", content: "hey" }],
    }),
    "hey",
  );
});

test("extractFirstUserText returns the FIRST text block only (not concatenated)", () => {
  assert.equal(
    extractFirstUserText({
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
    "hello ",
  );
});

test("extractFirstUserText accepts input_text blocks (OpenAI-style)", () => {
  assert.equal(
    extractFirstUserText({
      messages: [
        {
          role: "user",
          content: [{ type: "input_text", text: "openai block" }],
        },
      ],
    }),
    "openai block",
  );
});

test("extractFirstUserText finds the first user message, skipping assistants", () => {
  assert.equal(
    extractFirstUserText({
      messages: [
        { role: "assistant", content: "x" },
        { role: "user", content: "found me" },
        { role: "user", content: "not me" },
      ],
    }),
    "found me",
  );
});

test("extractFirstUserText returns empty when there is no user text", () => {
  assert.equal(
    extractFirstUserText({ messages: [{ role: "assistant", content: "x" }] }),
    "",
  );
  assert.equal(extractFirstUserText({}), "");
  assert.equal(extractFirstUserText({ messages: [] }), "");
});

// ---------------------------------------------------------------------------
// system[] construction
// ---------------------------------------------------------------------------

test("isBillingText recognises billing header lines", () => {
  assert.ok(
    isBillingText(
      "x-anthropic-billing-header: cc_version=2.1.196.0d9; cc_entrypoint=cli; cch=fa690;",
    ),
  );
  assert.ok(isBillingText("  x-anthropic-billing-header: whatever"));
  assert.ok(!isBillingText("You are Claude Code."));
  assert.ok(!isBillingText(undefined));
});

test("normalizeSystemBlocks converts string and array forms", () => {
  assert.deepEqual(normalizeSystemBlocks("hello"), [
    { type: "text", text: "hello" },
  ]);
  assert.deepEqual(
    normalizeSystemBlocks([
      "str",
      { type: "text", text: "obj", cache_control: { type: "ephemeral" } },
    ]),
    [
      { type: "text", text: "str" },
      { type: "text", text: "obj", cache_control: { type: "ephemeral" } },
    ],
  );
  assert.deepEqual(normalizeSystemBlocks(undefined), []);
});

test("stripExistingFingerprint drops identity and billing blocks", () => {
  const blocks = normalizeSystemBlocks([
    { type: "text", text: "x-anthropic-billing-header: old" },
    { type: "text", text: CLAUDE_CODE_IDENTITY_TEXT },
    { type: "text", text: "keep me" },
  ]);
  const cleaned = stripExistingFingerprint(blocks);
  assert.deepEqual(
    cleaned.map((b) => b.text),
    ["keep me"],
  );
});

test("buildSystemArray orders [billing, identity, ...cleaned] and dedups identity", () => {
  const billing = buildBillingBlock(
    "cc_version=x; cc_entrypoint=cli; cch=00000;",
  );
  const sys = buildSystemArray(
    [
      { type: "text", text: CLAUDE_CODE_IDENTITY_TEXT },
      { type: "text", text: "Original", cache_control: { type: "ephemeral" } },
    ],
    billing,
  );
  assert.equal(sys.length, 3);
  assert.equal(sys[0], billing);
  assert.deepEqual(sys[1], { type: "text", text: CLAUDE_CODE_IDENTITY_TEXT });
  assert.deepEqual(sys[2], {
    type: "text",
    text: "Original",
    cache_control: { type: "ephemeral" },
  });
});

// ---------------------------------------------------------------------------
// buildFinalBody — deterministic key order
// ---------------------------------------------------------------------------

test("buildFinalBody emits keys in Claude Code's order", () => {
  // Feed keys in scrambled order; output must be canonical.
  const original: Record<string, unknown> = {
    stream: true,
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    thinking: { type: "enabled", budget_tokens: 1024 },
  };
  const out = buildFinalBody(original, []);
  assert.deepEqual(Object.keys(out), [
    "system",
    "messages",
    "model",
    "max_tokens",
    "stream",
    "thinking",
  ]);
});

test("buildFinalBody drops unknown keys", () => {
  const out = buildFinalBody(
    { model: "x", bogus: true, _callType: "messages" },
    [],
  );
  assert.deepEqual(Object.keys(out), ["system", "model"]);
});

// ---------------------------------------------------------------------------
// withBetaQuery
// ---------------------------------------------------------------------------

test("withBetaQuery appends ?beta=true with the right separator", () => {
  assert.equal(
    withBetaQuery("https://api.anthropic.com/v1/messages"),
    "https://api.anthropic.com/v1/messages?beta=true",
  );
  assert.equal(
    withBetaQuery("https://api.anthropic.com/v1/messages?beta=true"),
    "https://api.anthropic.com/v1/messages?beta=true",
  );
  assert.equal(
    withBetaQuery("https://api.anthropic.com/v1/messages?stream=true"),
    "https://api.anthropic.com/v1/messages?stream=true&beta=true",
  );
});

test("withBetaQuery works on a bare path", () => {
  assert.equal(withBetaQuery("/v1/messages"), "/v1/messages?beta=true");
});

test("withBetaQuery leaves non-/v1/messages URLs untouched", () => {
  assert.equal(
    withBetaQuery("https://api.anthropic.com/v1/models"),
    "https://api.anthropic.com/v1/models",
  );
});

// ---------------------------------------------------------------------------
// computeCchForBody
// ---------------------------------------------------------------------------

test("computeCchForBody returns a 5-char hex token", () => {
  const body = serializeBody({
    system: [{ type: "text", text: "x" }],
    messages: [{ role: "user", content: "hi" }],
  });
  const cch = computeCchForBody(body, CC_VERSION);
  assert.match(cch, /^[0-9a-f]{5}$/);
});

test("computeCchForBody is deterministic", () => {
  const body = serializeBody({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(
    computeCchForBody(body, CC_VERSION),
    computeCchForBody(body, CC_VERSION),
  );
});

test("computeCchForBody masks to the lower 20 bits", () => {
  const cch = computeCchForBody(
    serializeBody({ messages: [{ role: "user", content: "prompt" }] }),
    CC_VERSION,
  );
  const parsed = parseInt(cch, 16);
  assert.ok(
    parsed >= 0 && parsed <= 0xfffff,
    `cch out of 20-bit range: ${cch}`,
  );
});

// ---------------------------------------------------------------------------
// applyAnthropicBilling — the orchestrator
// ---------------------------------------------------------------------------

const HEADER_RE =
  /^cc_version=2\.1\.196\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/;

test("applyAnthropicBilling returns a well-formed header value", () => {
  const { header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "Hello world from a test prompt" }],
  });
  assert.match(header, HEADER_RE);
  assert.ok(!/cch=00000;/.test(header), "cch must not be the placeholder");
});

test("applyAnthropicBilling rebuilds system[] as [billing, identity, ...]", () => {
  const { body, header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "Hello" }],
  });
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.ok(Array.isArray(sys));
  assert.equal(sys[0].text, `x-anthropic-billing-header: ${header}`);
  assert.deepEqual(sys[1], { type: "text", text: CLAUDE_CODE_IDENTITY_TEXT });
});

test("applyAnthropicBilling preserves original system blocks after identity", () => {
  const { body } = applyAnthropicBilling({
    system: "Original system prompt",
    messages: [{ role: "user", content: "Hello" }],
  });
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 3);
  assert.ok(sys[0].text.startsWith("x-anthropic-billing-header:"));
  assert.equal(sys[1].text, CLAUDE_CODE_IDENTITY_TEXT);
  assert.equal(sys[2].text, "Original system prompt");
});

test("applyAnthropicBilling preserves cache_control on non-identity original blocks", () => {
  const { body } = applyAnthropicBilling({
    system: [
      {
        type: "text",
        text: "Tool instructions",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "Hello" }],
  });
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.equal(sys.length, 3);
  assert.deepEqual(sys[2], {
    type: "text",
    text: "Tool instructions",
    cache_control: { type: "ephemeral" },
  });
});

test("applyAnthropicBilling does not duplicate an existing identity block", () => {
  const { body } = applyAnthropicBilling({
    system: [{ type: "text", text: CLAUDE_CODE_IDENTITY_TEXT }],
    messages: [{ role: "user", content: "Hello" }],
  });
  const sys = body.system as Array<{ type: string; text: string }>;
  const identityCount = sys.filter(
    (s) => s.text === CLAUDE_CODE_IDENTITY_TEXT,
  ).length;
  assert.equal(identityCount, 1);
});

test("applyAnthropicBilling is idempotent on a second pass", () => {
  const first = applyAnthropicBilling({
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello" }],
  });
  const second = applyAnthropicBilling(first.body);
  assert.equal(first.header, second.header);
});

test("applyAnthropicBilling derives the reference version suffix for a known message", () => {
  const expected = sha256(`59cf53e54c78oo0${CC_VERSION}`).slice(0, 3);
  const { header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "hello world" }],
  });
  assert.ok(header.includes(`.${expected};`), `header: ${header}`);
});

test("applyAnthropicBilling cch is invariant to model/max_tokens (preimage transform)", () => {
  const a = applyAnthropicBilling({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello world" }],
  }).header;
  const b = applyAnthropicBilling({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: "Hello world" }],
  }).header;
  const aCch = a.match(/cch=([0-9a-f]{5})/)![1];
  const bCch = b.match(/cch=([0-9a-f]{5})/)![1];
  assert.equal(aCch, bCch, "cch must match when only model/max_tokens differ");
});

test("applyAnthropicBilling cch changes when the first user text changes", () => {
  const a = applyAnthropicBilling({
    messages: [{ role: "user", content: "Hello world from a test prompt" }],
  }).header;
  const b = applyAnthropicBilling({
    messages: [{ role: "user", content: "A completely different prompt" }],
  }).header;
  assert.notEqual(
    a.match(/cch=([0-9a-f]{5})/)![1],
    b.match(/cch=([0-9a-f]{5})/)![1],
  );
});

test("applyAnthropicBilling honors PROXY_CCH_VALUE override", () => {
  process.env["PROXY_CCH_VALUE"] = "fa690";
  const { header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(header, /; cch=fa690;$/);
});

test("applyAnthropicBilling strips cch= prefix from PROXY_CCH_VALUE", () => {
  process.env["PROXY_CCH_VALUE"] = "cch=abc12";
  const { header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(header, /; cch=abc12;$/);
});

test("applyAnthropicBilling ignores an invalid PROXY_CCH_VALUE", () => {
  process.env["PROXY_CCH_VALUE"] = "nothex";
  const { header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(header, /; cch=[0-9a-f]{5};$/);
  assert.ok(!/; cch=nothex;$/.test(header));
});

test("applyAnthropicBilling honors PROXY_CC_VERSION override", () => {
  process.env["PROXY_CC_VERSION"] = "2.1.999";
  const { header } = applyAnthropicBilling({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(
    header,
    /^cc_version=2\.1\.999\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
  );
});

test("applyAnthropicBilling scrubs opencode fingerprints from system[]", () => {
  const { body } = applyAnthropicBilling({
    system:
      "You are OpenCode, the best coding agent on the planet. " +
      "Workspace root folder: /foo. Is directory a git repo: yes. " +
      "See https://github.com/anomalyco/opencode",
    messages: [{ role: "user", content: "Hello" }],
  });
  const sys = body.system as Array<{ type: string; text: string }>;
  const allText = sys.map((s) => s.text).join("\n");
  assert.ok(!allText.includes("anomalyco"));
  assert.ok(!allText.includes("OpenCode"));
  assert.ok(!allText.includes("Workspace root folder:"));
  assert.ok(allText.includes("Working directory:"));
  assert.ok(allText.includes("Git repository:"));
});

test("applyAnthropicBilling scrubs fingerprints from messages[] too", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [
      {
        role: "user",
        content:
          "Previous: Workspace root folder: /home. See https://github.com/anomalyco/opencode.",
      },
    ],
  });
  const allText = JSON.stringify(body.messages);
  assert.ok(!allText.includes("anomalyco"));
  assert.ok(!allText.includes("Workspace root folder:"));
  assert.ok(allText.includes("Working directory:"));
  assert.ok(allText.includes("github.com/anthropics/claude-code"));
});

test("applyAnthropicBilling renames native tool names to PascalCase", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      { name: "read", description: "Read", input_schema: { type: "object" } },
      { name: "bash", description: "Run", input_schema: { type: "object" } },
    ],
    tool_choice: { type: "tool", name: "read" },
  });
  const tools = body.tools as Array<{ name: string }>;
  assert.equal(tools[0].name, "Read");
  assert.equal(tools[1].name, "Bash");
  const choice = body.tool_choice as { name: string };
  assert.equal(choice.name, "Read");
});

test("PROXY_CC_NORMALIZE_TOOLS=false leaves tool names untouched", () => {
  process.env["PROXY_CC_NORMALIZE_TOOLS"] = "false";
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ name: "read", description: "" }],
  });
  const tools = body.tools as Array<{ name: string }>;
  assert.equal(tools[0].name, "read");
});

// ---------------------------------------------------------------------------
// Tool-name PascalCasing (every non-mcp_ tool) + schema safety
// ---------------------------------------------------------------------------

test("applyAnthropicBilling PascalCases arbitrary non-mcp_ tool names", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        name: "get_user_profile",
        description: "d",
        input_schema: { type: "object" },
      },
      {
        name: "search-index",
        description: "d",
        input_schema: { type: "object" },
      },
      {
        name: "camelCaseThing",
        description: "d",
        input_schema: { type: "object" },
      },
    ],
  });
  const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("GetUserProfile"), `got: ${names.join(",")}`);
  assert.ok(names.includes("SearchIndex"));
  assert.ok(names.includes("CamelCaseThing"));
});

test("applyAnthropicBilling maps ohmypi tool names to CC-native names", () => {
  // ohmypi's snake_case/lowercase builtins map to their closest Claude Code
  // native tool via OHMYPI_TOOL_NAME_MAP (semantic aliases the algorithmic
  // PascalCaser can't infer).
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      { name: "ask", description: "d", input_schema: { type: "object" } },
      { name: "task", description: "d", input_schema: { type: "object" } },
      { name: "todo", description: "d", input_schema: { type: "object" } },
      {
        name: "manage_skill",
        description: "d",
        input_schema: { type: "object" },
      },
      {
        name: "web_search",
        description: "d",
        input_schema: { type: "object" },
      },
    ],
  });
  const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("AskUserQuestion"), `got: ${names.join(",")}`);
  assert.ok(names.includes("Agent"), `got: ${names.join(",")}`);
  assert.ok(names.includes("TaskCreate"), `got: ${names.join(",")}`);
  assert.ok(names.includes("Skill"), `got: ${names.join(",")}`);
  assert.ok(names.includes("WebSearch"), `got: ${names.join(",")}`);
  // No leaked non-CC PascalCase spellings.
  for (const leaked of ["Ask", "Task", "Todo", "ManageSkill"]) {
    assert.ok(!names.includes(leaked), `must not leak ${leaked}`);
  }
});

test("applyAnthropicBilling cases ohmypi acronym-only extras (SSH/IRC/…)", () => {
  // Outliers with no CC counterpart stay as extras but keep proper acronym
  // casing the algorithmic pass would otherwise mangle (Ssh/Irc/Github/Lsp).
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      { name: "ssh", description: "d", input_schema: { type: "object" } },
      { name: "irc", description: "d", input_schema: { type: "object" } },
      { name: "github", description: "d", input_schema: { type: "object" } },
      { name: "lsp", description: "d", input_schema: { type: "object" } },
    ],
  });
  const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("SSH"), `got: ${names.join(",")}`);
  assert.ok(names.includes("IRC"));
  assert.ok(names.includes("GitHub"));
  assert.ok(names.includes("LSP"));
});

test("applyAnthropicBilling passes Claude Code native tool names through as-is", () => {
  // A genuine Claude Code client already sends PascalCase native names. They
  // must survive normalization byte-for-byte (the override maps are keyed by
  // the lowercase client spelling, so a CC name misses them and lands on the
  // idempotent PascalCaser).
  const ccTools = ["Read", "Bash", "Edit", "TaskCreate", "WebSearch"];
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: ccTools.map((name) => ({
      name,
      description: "d",
      input_schema: { type: "object" },
    })),
    tool_choice: { type: "tool", name: "TaskCreate" },
  });
  const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
  for (const name of ccTools) {
    assert.ok(names.includes(name), `CC native ${name} must pass through`);
  }
  const choice = body.tool_choice as { name: string };
  assert.equal(choice.name, "TaskCreate", "CC tool_choice must be untouched");
});

test("applyAnthropicBilling leaves mcp_ tool names untouched", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        name: "mcp__github__create_issue",
        description: "d",
        input_schema: { type: "object" },
      },
    ],
  });
  const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("mcp__github__create_issue"));
});

test("applyAnthropicBilling leaves server/built-in tools verbatim (fixed name)", () => {
  // Anthropic mandates name='web_search' for a type='web_search_*' tool.
  // Renaming it triggers `tools.N.<type>.name: Input should be 'web_search'`.
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Record<string, unknown>,
      {
        type: "computer_20250124",
        name: "computer",
        display_width_px: 1024,
        display_height_px: 768,
      } as unknown as Record<string, unknown>,
    ],
  });
  const tools = body.tools as Array<{ name: string; type?: string }>;
  const ws = tools.find((t) => t.type === "web_search_20250305")!;
  assert.equal(ws.name, "web_search");
  const comp = tools.find((t) => t.type === "computer_20250124")!;
  assert.equal(comp.name, "computer");
});

test("applyAnthropicBilling still renames a type:custom tool like a normal one", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        type: "custom",
        name: "get_user",
        input_schema: { type: "object" },
      } as unknown as Record<string, unknown>,
    ],
  });
  const tools = body.tools as Array<{ name: string }>;
  assert.ok(tools.some((t) => t.name === "GetUser"));
});

test("applyAnthropicBilling strips thinking blocks before sending", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r", signature: "sig" },
          { type: "text", text: "ok" },
        ],
      },
      { role: "user", content: "more" },
    ],
  });
  const allBlocks = JSON.stringify(body.messages);
  assert.ok(
    !allBlocks.includes('"thinking"'),
    "thinking blocks must be stripped",
  );
  assert.ok(allBlocks.includes('"text"'), "text blocks must be preserved");
});

test("applyAnthropicBilling dedups tools that collide after renaming", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      { name: "read", description: "first", input_schema: { type: "object" } },
      { name: "Read", description: "second", input_schema: { type: "object" } },
    ],
  });
  const tools = body.tools as Array<{ name: string; description: string }>;
  const reads = tools.filter((t) => t.name === "Read");
  assert.equal(reads.length, 1, "colliding tool names must be deduped");
  assert.equal(reads[0]!.description, "first");
});

test("applyAnthropicBilling renames tool_use and tool_choice consistently", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "get_user", input: {} },
        ],
      },
    ],
    tools: [
      { name: "get_user", description: "d", input_schema: { type: "object" } },
    ],
    tool_choice: { type: "tool", name: "get_user" },
  });
  const tools = body.tools as Array<{ name: string }>;
  assert.ok(tools.some((t) => t.name === "GetUser"));
  assert.equal((body.tool_choice as { name: string }).name, "GetUser");
  const msg = (
    body.messages as Array<{ content: Array<{ name?: string }> }>
  )[0]!;
  assert.equal(msg.content[0]!.name, "GetUser");
});

test("applyAnthropicBilling emits only schema-valid tool names", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        name: "weird.name+v2",
        description: "d",
        input_schema: { type: "object" },
      },
    ],
  });
  const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
  // Stripped to alphanumeric PascalCase; no dots/plus → Anthropic tool-name valid.
  assert.ok(names.includes("WeirdNameV2"), `got: ${names.join(",")}`);
  for (const n of names) assert.match(n, /^[A-Za-z0-9]{1,64}$/);
});

test("applyAnthropicBilling returns a reverse tool-rename map for responses", () => {
  const { toolRenameMap } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      { name: "get_user", description: "d", input_schema: { type: "object" } },
      { name: "bash", description: "d", input_schema: { type: "object" } },
      {
        name: "mcp__svc__thing",
        description: "d",
        input_schema: { type: "object" },
      },
    ],
  });
  assert.equal(toolRenameMap.get("GetUser"), "get_user");
  assert.equal(toolRenameMap.get("Bash"), "bash");
  // mcp_ tools are not renamed → not in the map.
  assert.equal(toolRenameMap.get("mcp__svc__thing"), undefined);
  // Decoy-only names (no client original) are not in the map.
  assert.equal(toolRenameMap.get("Read"), undefined);
});

// ---------------------------------------------------------------------------
// CC decoy tools fallback
// ---------------------------------------------------------------------------

test("applyAnthropicBilling injects decoys for every missing CC native tool", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ name: "read", description: "real" }],
  });
  const tools = body.tools as Array<{ name: string; description: string }>;
  const names = new Set(tools.map((t) => t.name));
  // The supplied `read` (PascalCased to `Read`) OVERRIDES the CC `Read` slot —
  // the client's real definition wins, the stub is NOT injected.
  assert.equal([...names].filter((n) => n === "Read").length, 1);
  assert.equal(tools.find((t) => t.name === "Read")!.description, "real");
  // A representative sample of the other CC names is present, as stubs.
  for (const decoy of [
    "Agent",
    "Bash",
    "Grep",
    "TaskCreate",
    "Write",
    "Workflow",
  ]) {
    assert.ok(names.has(decoy), `missing decoy ${decoy}`);
  }
  assert.equal(
    tools.find((t) => t.name === "Bash")!.description,
    "This tool is currently unavailable.",
  );
});

test("applyAnthropicBilling injects the full CC name set as unavailable stubs when no tools are supplied", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
  });
  const tools = body.tools as Array<{ name: string; description: string }>;
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Every Claude Code native tool NAME must exist (as a generic stub). We do
  // NOT pin the total — a client may always supply more tools (see next test).
  for (const name of CC_TOOL_NAMES) {
    assert.ok(byName.has(name), `missing CC tool name ${name}`);
    assert.equal(
      byName.get(name)!.description,
      "This tool is currently unavailable.",
    );
  }
  // No standalone "Task" tool in the CC set (only Task*/TaskCreate/etc.).
  assert.ok(!byName.has("Task"));
});

test("applyAnthropicBilling keeps extra client tools on top of the CC names", () => {
  // A client may supply MORE tools than the CC set — they are all kept; the CC
  // names just have to also exist.
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      { name: "frob", description: "custom", input_schema: { type: "object" } },
      {
        name: "widgetizer",
        description: "custom",
        input_schema: { type: "object" },
      },
    ],
  });
  const tools = body.tools as Array<{ name: string; description: string }>;
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Client's extra tools (PascalCased) are kept verbatim.
  assert.equal(byName.get("Frob")!.description, "custom");
  assert.equal(byName.get("Widgetizer")!.description, "custom");
  // The CC names still all exist as stubs.
  for (const name of CC_TOOL_NAMES) {
    assert.ok(byName.has(name), `missing CC tool name ${name}`);
  }
  // Total = client tools + all CC names (client tools don't collide with CC).
  assert.ok(tools.length > CC_TOOL_NAMES.length);
});

test("applyAnthropicBilling does not duplicate an already-supplied tool", () => {
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ name: "Read", description: "real" }],
  });
  const tools = body.tools as Array<{ name: string }>;
  assert.equal(tools.filter((t) => t.name === "Read").length, 1);
});

test("PROXY_CC_DECOY_TOOLS=false disables decoy injection", () => {
  process.env["PROXY_CC_DECOY_TOOLS"] = "false";
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(body.tools, undefined, "no decoys should be injected");
});

test("a web_search server tool does NOT suppress the WebSearch decoy", () => {
  // Claude Code calls its tools by PascalCase names: it sends
  // `tool_choice:{type:"tool",name:"WebSearch"}` and its history carries
  // `WebSearch` tool_use blocks, even when the server `web_search` tool is also
  // declared. Anthropic rejects any tool_use / tool_choice name not present in
  // `tools[]` ("Tool 'WebSearch' not found in provided tools"), so the decoy
  // must stay to keep that reference valid. Decoys are only suppressed on an
  // exact (case-insensitive) name match, never a fuzzy one.
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
      } as unknown as Record<string, unknown>,
    ],
    tool_choice: { type: "tool", name: "WebSearch" },
  });
  const tools = body.tools as Array<{ name: string; type?: string }>;
  const names = tools.map((t) => t.name);
  // Both the real server tool AND the WebSearch decoy are present.
  assert.ok(names.includes("web_search"), "server web_search must be present");
  assert.ok(names.includes("WebSearch"), "WebSearch decoy must be retained");
  // tool_choice is left as the client sent it (still resolves, via the decoy).
  assert.deepEqual(body.tool_choice, { type: "tool", name: "WebSearch" });
});

test("a client-supplied PascalCase tool overrides its CC stub (client definition wins)", () => {
  // The CC names just need to EXIST; a tool the client actually supplies (and
  // that PascalCases to a CC name) must keep the client's real definition, not
  // be replaced by the unavailable stub.
  const { body } = applyAnthropicBilling({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        name: "web_search",
        description: "client-side web search",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
  });
  const tools = body.tools as Array<{
    name: string;
    description: string;
    input_schema: { properties: Record<string, unknown> };
  }>;
  // `web_search` → PascalCase `WebSearch` → overrides the CC `WebSearch` slot.
  const ws = tools.filter((t) => t.name === "WebSearch");
  assert.equal(ws.length, 1, "WebSearch must appear exactly once");
  assert.equal(ws[0]!.description, "client-side web search");
  assert.ok("q" in ws[0]!.input_schema.properties);
  // All other CC names are still filled with the unavailable stub.
  assert.equal(
    tools.find((t) => t.name === "Bash")!.description,
    "This tool is currently unavailable.",
  );
});

test("applyAnthropicBilling preserves system[] order [billing, identity, scrubbed...]", () => {
  const { body } = applyAnthropicBilling({
    system: "Workspace root folder: /foo",
    messages: [{ role: "user", content: "Hi" }],
  });
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.ok(sys[0].text.startsWith("x-anthropic-billing-header:"));
  assert.equal(sys[1].text, CLAUDE_CODE_IDENTITY_TEXT);
  assert.ok(sys[2].text.includes("Working directory:"));
});
