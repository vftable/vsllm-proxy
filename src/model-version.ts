// =============================================================================
// Claude model version gate (shared)
// =============================================================================
//
// Matches Claude models strictly NEWER than 4.5 — i.e. "over 4.5":
//   - claude-{sonnet,opus,haiku}-4-<N>   where N is 6-9 or two+ digits (4.6+)
//   - claude-{sonnet,opus,haiku}-<N>     where N is 5-9 or two+ digits (5+)
//   - claude-fable / claude-mythos       (any version)
// and nothing else — older Claude (4.5, 3.x, ...) and non-Claude models
// (gpt-*, gemini-*, ollama, ...) never match.
//
// Two upstream behaviors are gated on this exact set, both effective for the
// post-4.5 generation:
//   - the prefill auto-fix (a trailing assistant turn needs a synthetic user
//     "continue" turn) — see src/prefill-fix.ts;
//   - the Claude Code `system[]` identity block injection — see src/billing.ts.

const POST_45_RE =
  /claude-(?:sonnet|opus|haiku)-4-([6-9]|\d{2,})(?:-|$)|claude-(?:sonnet|opus|haiku)-([5-9]|\d{2,})(?:-|$)|claude-(?:fable|mythos)/i;

/** True when `model` is a Claude model newer than 4.5 (see module header). */
export function isModelPost45(model: unknown): boolean {
  return typeof model === "string" && POST_45_RE.test(model);
}

export const POST_45_RE_EXPORT = POST_45_RE;
