import type { PrefillBody } from "./types.js";
import { isModelPost45, POST_45_RE_EXPORT } from "./model-version.js";

// The prefill auto-fix (a trailing assistant turn must be followed by a
// synthetic user "continue" turn) applies to every Claude model newer than 4.5.
// The version gate lives in ./model-version.js (shared with the Claude Code
// identity injection); `modelNeedsFix` is the prefill-facing alias.
export function modelNeedsFix(model: unknown): boolean {
  return isModelPost45(model);
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

export const NO_PREFILL_RE_EXPORT = POST_45_RE_EXPORT;
