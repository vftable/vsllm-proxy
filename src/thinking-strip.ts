// =============================================================================
// Strip `thinking` blocks from outgoing request messages
// =============================================================================
//
// A `thinking` block (interleaved-thinking) carries a `signature` that is
// cryptographically bound to the account that produced it. When a request is
// proxied to a different upstream account — common in this proxy's multi-key
// failover model — Anthropic rejects the replayed signature with HTTP 400:
//   `messages.N.content.M: Invalid signature in thinking block`
//
// The robust fix is to drop `thinking` blocks from `messages[].content` before
// the request is forwarded. The model loses the prior reasoning context but the
// conversation remains valid; a fresh thinking block is produced on the next
// turn if thinking is enabled. `text`, `tool_use`, `tool_result`, and `image`
// blocks are preserved.

export function stripThinkingBlocks(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const messages = requestBody["messages"];
  if (!Array.isArray(messages)) return { ...requestBody };

  let changed = false;
  const newMessages = messages.map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    const msg = m as Record<string, unknown>;
    const content = msg["content"];
    if (!Array.isArray(content)) return msg;

    const filtered = content.filter((block) => {
      if (
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as Record<string, unknown>)["type"] === "thinking"
      ) {
        return false; // drop
      }
      return true;
    });

    if (filtered.length === content.length) return msg;
    changed = true;
    return { ...msg, content: filtered };
  });

  if (!changed) return { ...requestBody };
  return { ...requestBody, messages: newMessages };
}
