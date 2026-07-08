import type { PrefillBody } from "./types.js";

// Models that require the prefill auto-fix (a trailing assistant turn must be
// followed by a synthetic user "continue" turn). Only `claude-` models ever
// match — non-Claude models (gpt-*, gemini-*, ollama, ...) are never touched.
//
//   - claude-{sonnet,opus,haiku}-4-<N>   where N is 6-9 or two+ digits (4.6+)
//   - claude-{sonnet,opus,haiku}-<N>     where N is 5-9 or two+ digits (5+)
//   - claude-fable / claude-mythos       (any version)
const NO_PREFILL_RE =
  /claude-(?:sonnet|opus|haiku)-4-([6-9]|\d{2,})(?:-|$)|claude-(?:sonnet|opus|haiku)-([5-9]|\d{2,})(?:-|$)|claude-(?:fable|mythos)/i;

export function modelNeedsFix(model: unknown): boolean {
  return typeof model === "string" && NO_PREFILL_RE.test(model);
}

export function extractToolUseIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is { type: string; id: string } =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "tool_use",
    )
    .map((b) => b.id)
    .filter((id): id is string => id != null);
}

export function buildUserMessage(content: unknown): {
  role: string;
  content:
    string | Array<{ type: string; tool_use_id: string; content: string }>;
} {
  const toolIds = extractToolUseIds(content);
  if (toolIds.length) {
    return {
      role: "user",
      content: toolIds.map((tid) => ({
        type: "tool_result",
        tool_use_id: tid,
        content: "continue",
      })),
    };
  }
  return { role: "user", content: "continue" };
}

export function applyPrefillFix(
  body: PrefillBody | null | undefined,
  callType: string = "",
): boolean {
  if (!body || typeof body !== "object") return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object" || last.role !== "assistant")
    return false;
  if (!modelNeedsFix(body.model)) return false;

  const toolIds = extractToolUseIds(last.content);
  const userMsg = buildUserMessage(last.content);
  body.messages = [...messages, userMsg];

  const traceId = body.metadata?.trace_id || body.litellm_trace_id || "";
  const toolIdsStr = toolIds.length ? toolIds.join(",") : "none";

  console.log(
    `[AppendContinueCallback] model=${body.model} call_type=${callType} ` +
      `action=appended count=${messages.length}->${messages.length + 1} ` +
      `tool_ids=${toolIdsStr} trace_id=${traceId}`,
  );

  return true;
}

export const NO_PREFILL_RE_EXPORT = NO_PREFILL_RE;
