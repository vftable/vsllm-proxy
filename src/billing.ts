import { createHash } from "node:crypto";

const BILLING_PREFIX = "x-anthropic-billing-header:";

// Claude Code client version this proxy presents as upstream. Keep in sync
// with the version embedded in the configured user-agent.
export const CC_VERSION = "2.1.37";

// Salt extracted from Claude Code's source — used in the version integrity
// hash. Do not change unless the upstream algorithm changes.
const BILLING_SALT = "59cf53e54c78";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isBillingText(text: unknown): boolean {
  return (
    typeof text === "string" && text.trimStart().startsWith(BILLING_PREFIX)
  );
}

// ---------------------------------------------------------------------------
// computeBillingHeader(messageText, entrypoint?)
//
// Computes the full billing header text for a given user message:
//
//   "x-anthropic-billing-header: cc_version=2.1.37.0d9; cc_entrypoint=cli; cch=fa690;"
//
// Algorithm (per Claude Code spec):
//   cch           = SHA-256(messageText)[:5]
//   sampled       = messageText[4] + messageText[7] + messageText[20]
//                   (padding with "0" when the index is out of bounds)
//   versionHash   = SHA-256(BILLING_SALT + sampled + CC_VERSION)[:3]
//   cc_version    = CC_VERSION + "." + versionHash
//
// The value is per-request: both cch and the version suffix depend on the
// message text.
// ---------------------------------------------------------------------------
export function computeBillingHeader(
  messageText: string,
  entrypoint = "cli",
): string {
  const indices = [4, 7, 20];
  // Use Array.from so indexing is by Unicode codepoint, matching the Python
  // reference implementation.
  const chars = Array.from(messageText);
  let sampled = "";
  for (const i of indices) {
    sampled += i < chars.length ? chars[i] : "0";
  }
  const versionHash = sha256Hex(`${BILLING_SALT}${sampled}${CC_VERSION}`).slice(
    0,
    3,
  );
  const cch = sha256Hex(messageText).slice(0, 5);
  return (
    `${BILLING_PREFIX} cc_version=${CC_VERSION}.${versionHash}; ` +
    `cc_entrypoint=${entrypoint}; cch=${cch};`
  );
}

// Extract the text content of the first user message from an Anthropic-style
// request body. Handles both string content and arrays of content blocks
// (concatenating all text blocks). Returns "" when no user message or text.
export function extractFirstUserMessageText(
  body: Record<string, unknown>,
): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    if ((msg as { role?: string }).role !== "user") continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      let text = "";
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          text += (block as { text: string }).text;
        }
      }
      return text;
    }
    return "";
  }
  return "";
}

// Ensures the first text block of `system` carries the billing header.
//
// - When `system` is missing it is created as a single-element array.
// - When `system` is a plain string it is converted to a two-element array
//   with the billing block prepended.
// - When `system` is already an array, an existing billing block (if present)
//   is replaced in place; otherwise the billing block is prepended.
//
// The billing block never carries cache_control.
//
// Mutates `body` in place. Returns true when a modification was made.
export function injectBillingHeader(
  body: Record<string, unknown>,
  fullBillingText: string,
): boolean {
  if (!body || typeof body !== "object") return false;
  const block = { type: "text", text: fullBillingText };
  const system = body.system;

  if (system === undefined || system === null) {
    body.system = [block];
    return true;
  }

  if (typeof system === "string") {
    body.system = [block, { type: "text", text: system }];
    return true;
  }

  if (Array.isArray(system)) {
    const idx = system.findIndex(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "text" &&
        isBillingText((b as { text?: unknown }).text),
    );
    if (idx >= 0) {
      // Replace text in place and strip cache_control — the billing block
      // must never carry it, even if the original did.
      const existing = system[idx] as Record<string, unknown>;
      existing.text = fullBillingText;
      delete existing.cache_control;
    } else {
      system.unshift(block);
    }
    return true;
  }

  return false;
}
