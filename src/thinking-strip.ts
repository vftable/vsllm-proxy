// =============================================================================
// Normalize `thinking` blocks in outgoing request messages
// =============================================================================
//
// A `thinking` block (interleaved-thinking) carries a `signature` that is
// cryptographically bound to the account that produced it. When a request is
// proxied to a different upstream account — common in this proxy's multi-key
// failover model — Anthropic rejects the replayed signature with HTTP 400:
//   `messages.N.content.M: Invalid signature in thinking block`
//
// Two ways to keep the conversation valid across accounts:
//
//   - "strip" (stripThinkingBlocks): drop the `thinking`/`redacted_thinking`
//     blocks entirely. The model loses the prior reasoning context but the
//     conversation stays valid; a fresh thinking block is produced next turn if
//     thinking is enabled.
//
//   - "text" (thinkingBlocksToText): rewrite each `thinking` block to a
//     signature-free `{type:"text", text}` block, preserving the reasoning
//     prose. This is schema-valid because the two block types validate
//     differently: a `text` block has NO `signature` field (nothing to reject
//     across accounts), and converting away every `thinking` block means the
//     "`thinking`/`redacted_thinking` blocks in the latest assistant message
//     cannot be modified" rule has no block left to fire on.
//
// In both modes `text`, `tool_use`, `tool_result`, and `image` blocks are
// preserved unchanged, and `redacted_thinking` blocks are dropped (their
// content is encrypted — there is no readable prose to carry over).

export function stripThinkingBlocks(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return mapThinkingBlocks(requestBody, () => undefined);
}

/**
 * Rewrite `thinking` blocks to signature-free `text` blocks, preserving the
 * reasoning prose so the model keeps its prior context across an account
 * switch. A `thinking` field that is empty or whitespace-only — the default
 * when the producing model used `display:"omitted"` (Opus 4.8/4.7, Sonnet 5,
 * Fable 5) — has no prose to carry, and `{type:"text", text:""}` is rejected
 * by the API (text must be non-empty), so such a block is dropped instead.
 * `redacted_thinking` blocks are always dropped (encrypted, no readable text).
 */
export function thinkingBlocksToText(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return mapThinkingBlocks(requestBody, (block) => {
    const raw = block["thinking"];
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() === "") return undefined; // empty → drop, not an empty text block
    return { type: "text", text };
  });
}

/**
 * Walk `messages[].content`, replacing each `thinking` block with the result of
 * `transform` (return `undefined` to drop it) and always dropping
 * `redacted_thinking` blocks. All other blocks pass through untouched. Returns
 * a shallow copy; only messages whose content actually changed are rebuilt.
 */
function mapThinkingBlocks(
  requestBody: Readonly<Record<string, unknown>>,
  transform: (block: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  const messages = requestBody["messages"];
  if (!Array.isArray(messages)) return { ...requestBody };

  let changed = false;
  const newMessages = messages.map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    const msg = m as Record<string, unknown>;
    const content = msg["content"];
    if (!Array.isArray(content)) return msg;

    let blockChanged = false;
    const newContent: unknown[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const b = block as Record<string, unknown>;
        const type = b["type"];
        if (type === "thinking") {
          const replacement = transform(b);
          if (replacement !== undefined) newContent.push(replacement);
          blockChanged = true;
          continue;
        }
        if (type === "redacted_thinking") {
          blockChanged = true; // encrypted; nothing to preserve
          continue;
        }
      }
      newContent.push(block);
    }

    if (!blockChanged) return msg;
    changed = true;
    return { ...msg, content: newContent };
  });

  if (!changed) return { ...requestBody };
  return { ...requestBody, messages: newMessages };
}
