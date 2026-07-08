// =============================================================================
// Anthropic OAuth subscription billing transform (plugin v0.6.0 port)
// =============================================================================
//
// This module replaces the original SHA-256-based billing stub with a faithful
// port of the anthropic-billing-header plugin (v0.6.0). It mutates the
// outgoing /v1/messages body so an OAuth-subscription request (Claude Pro /
// Max) counts against the subscription pool instead of the third-party
// "extra usage" pool.
//
// Anthropic has four independent detection vectors that all must pass:
//
//   1. `x-anthropic-billing-header` HTTP header — a recent `cc_version` AND a
//      freshly-computed `cch` body attestation. Stale version or a static
//      placeholder cch routes to extra usage.
//   2. `system[0]` content for OAuth accounts — the first block of `system[]`
//      must be EXACTLY the Claude Code identity string.
//   3. `?beta=true` query string on /v1/messages.
//   4. A whole-payload content classifier — handled by the in-place anchor
//      scrub (src/classifier-scrub.ts) and tool-name normalization
//      (src/tool-normalization.ts).
//
// `cch` derivation (per-request body attestation, current Claude Code
// protocol):
//   1. Build the full body with `cch=00000` placeholder, `system[0]` = billing
//      block, `system[1]` = identity block, keys in Claude Code's order.
//   2. Apply the v2.1.172+ preimage transform: blank `model` value, strip
//      `max_tokens` field.
//   3. cch = xxHash64(preimage_bytes, seed) & 0xFFFFF → 5-char zero-padded hex.
//   4. Replace the placeholder with the computed value.
//
// The xxHash64 seed is baked into Claude Code's compiled binary. The current
// verified seed (0x4D659218E32A3268) is used by v2.1.138+ (including v2.1.196).
//
// Source of truth (read-only):
//   Downloads/.../anthropic-billing-header/{plugin,body,cch,constants}.ts
// Reference:
//   https://github.com/BYK/loreai/blob/main/packages/gateway/src/cch.ts
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_signing.go

import { createHash } from "node:crypto";
import { MASK_20, xxHash64 } from "./xxhash64.js";
import { scrubAnchorsInPlace } from "./classifier-scrub.js";
import {
  ensureCcDecoyTools,
  normalizeToolNames,
} from "./tool-normalization.js";
import { stripThinkingBlocks } from "./thinking-strip.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Salt for the 3-char hex cc_version suffix (extracted from Claude Code). */
export const BILLING_SALT = "59cf53e54c78";

/**
 * Latest published Claude Code version as of 2026-06-29. This is the single
 * source of truth — config.ts reads it to build the matching `user-agent`.
 * Bump when Anthropic ships a new release; otherwise requests route to
 * "extra usage".
 */
export const CC_VERSION = "2.1.196";

/**
 * Anthropic requires the first content block of any OAuth-authenticated
 * Messages request's `system[]` to be exactly this string (effective March 16,
 * 2026; Sonnet/Opus only — Haiku exempt).
 */
export const CLAUDE_CODE_IDENTITY_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** cc_entrypoint value emitted by Claude Code for interactive CLI use. */
export const CC_ENTRYPOINT = "cli";

/** Static fallback when the body attestation cannot run. */
export const CCH_PLACEHOLDER = "00000";

/** Mask the xxHash64 result to its lower 20 bits (= 5 hex chars). */
export const CCH_MASK = MASK_20;

const BILLING_PREFIX = "x-anthropic-billing-header:";

interface SeedPair {
  readonly seedHigh: number;
  readonly seedLow: number;
}

/** Legacy seed used by Claude Code 2.1.37 (kept for completeness). */
const SEED_2_1_37: SeedPair = { seedHigh: 0x6e52736a, seedLow: 0xc806831e };
/** Verified current seed (v2.1.138+ through v2.1.196 as of 2026-06-29). */
const SEED_CURRENT: SeedPair = { seedHigh: 0x4d659218, seedLow: 0xe32a3268 };

/**
 * Map a Claude Code version to its xxHash64 seed. Only the legacy 2.1.37 used
 * a different seed; every version since 2.1.138 shares SEED_CURRENT. Unknown /
 * future versions fall back to the current seed so the header stays well-formed
 * even before the registry is updated.
 */
function resolveSeed(version: string): SeedPair {
  if (version === "2.1.37") return SEED_2_1_37;
  return SEED_CURRENT;
}

export function isBillingText(text: unknown): boolean {
  return (
    typeof text === "string" && text.trimStart().startsWith(BILLING_PREFIX)
  );
}

// -----------------------------------------------------------------------------
// Version suffix + first-user-text extraction
// -----------------------------------------------------------------------------

/** Compute the 3-char SHA-256 suffix for the cc_version component. */
export function computeVersionSuffix(
  firstUserText: string,
  version: string,
): string {
  // Plain [] indexing (UTF-16 code units) with '0' padding for out-of-bounds,
  // matching Claude Code's implementation exactly.
  const sampled =
    (firstUserText[4] || "0") +
    (firstUserText[7] || "0") +
    (firstUserText[20] || "0");
  return createHash("sha256")
    .update(`${BILLING_SALT}${sampled}${version}`)
    .digest("hex")
    .slice(0, 3);
}

/**
 * Pull the first user-message text from the outgoing request body. Supports
 * string-form content and array-form content with a `{ type: "text", text }`
 * (Anthropic) or `{ type: "input_text", text }` (OpenAI-style) block. Returns
 * the FIRST text block only (not concatenated); '' when no user text is found.
 */
export function extractFirstUserText(
  requestBody: Readonly<Record<string, unknown>>,
): string {
  const messages = requestBody["messages"];
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m["role"] !== "user") continue;
    const content = m["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (
          typeof p["text"] === "string" &&
          (p["type"] === "text" || p["type"] === "input_text")
        ) {
          return p["text"] as string;
        }
      }
    }
  }
  return "";
}

// -----------------------------------------------------------------------------
// system[] array construction
// -----------------------------------------------------------------------------

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: string };
}

function isBillingHeaderBlock(block: SystemBlock): boolean {
  return (
    typeof block.text === "string" && block.text.startsWith(BILLING_PREFIX)
  );
}

function isIdentityBlock(block: SystemBlock): boolean {
  return block.text === CLAUDE_CODE_IDENTITY_TEXT;
}

/** Convert whatever form of `system` upstream provided into a SystemBlock[]. */
export function normalizeSystemBlocks(rawSystem: unknown): SystemBlock[] {
  if (typeof rawSystem === "string") {
    return [{ type: "text", text: rawSystem }];
  }
  if (Array.isArray(rawSystem)) {
    const blocks: SystemBlock[] = [];
    for (const entry of rawSystem) {
      if (typeof entry === "string") {
        blocks.push({ type: "text", text: entry });
        continue;
      }
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e["text"] === "string") {
          const block: SystemBlock = {
            type: "text",
            text: e["text"] as string,
          };
          if (e["cache_control"] && typeof e["cache_control"] === "object") {
            block.cache_control = e["cache_control"] as {
              type: "ephemeral";
              ttl?: string;
            };
          }
          blocks.push(block);
        }
      }
    }
    return blocks;
  }
  return [];
}

/** Drop any existing identity or billing-header block (idempotent). */
export function stripExistingFingerprint(blocks: SystemBlock[]): SystemBlock[] {
  return blocks.filter((b) => !isIdentityBlock(b) && !isBillingHeaderBlock(b));
}

/**
 * Build the final `system[]` array in the order real Claude Code emits:
 *   system[0] = billing header block (NO cache_control — rotates per request)
 *   system[1] = identity block (NO cache_control — matches plugin wire format)
 *   system[2..] = original blocks (cache_control preserved if present)
 */
export function buildSystemArray(
  rawSystem: unknown,
  billingBlock: SystemBlock,
): SystemBlock[] {
  // The identity block is emitted WITHOUT cache_control to match Claude Code's
  // wire format byte-for-byte (verified by the plugin's plugin.spec.ts). Any
  // extra field here would alter the cch preimage and diverge from upstream.
  const identity: SystemBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY_TEXT,
  };
  const cleaned = stripExistingFingerprint(normalizeSystemBlocks(rawSystem));
  return [billingBlock, identity, ...cleaned];
}

/** Build the `x-anthropic-billing-header:` text block. */
export function buildBillingBlock(billingHeaderText: string): SystemBlock {
  return {
    type: "text",
    text: `${BILLING_PREFIX} ${billingHeaderText}`,
  };
}

// -----------------------------------------------------------------------------
// Body serialization (deterministic key order)
// -----------------------------------------------------------------------------

/**
 * Top-level keys preserved and serialized in Claude Code's order: `system`,
 * `messages`, `model`, `max_tokens`, ... Unknown keys are dropped so they
 * cannot contaminate the cch preimage.
 */
const ORDERED_KEYS = [
  "system",
  "messages",
  "model",
  "max_tokens",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "stream",
  "metadata",
  "thinking",
] as const;

export function buildFinalBody(
  original: Readonly<Record<string, unknown>>,
  systemArray: SystemBlock[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out["system"] = systemArray;
  for (const key of ORDERED_KEYS) {
    if (key === "system") continue; // already set above
    if (key in original) out[key] = original[key];
  }
  return out;
}

/** Stringify a request body without inserting whitespace — wire-faithful. */
export function serializeBody(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

// -----------------------------------------------------------------------------
// cch preimage transform (v2.1.172+) + xxHash64 attestation
// -----------------------------------------------------------------------------

// Anthropic's classifier hashes a TRANSFORMED version of the body, not the wire
// body, when computing cch:
//   1. the `model` VALUE is blanked: `"model":"sonnet-4"` → `"model":""`
//   2. the `max_tokens` field is removed (with the adjacent comma stripped)
// Both edits are no-ops when the field is absent, so they are safe to apply
// unconditionally.
const MODEL_VALUE_RE = /("model":")[^"]*(")/;
const MAX_TOKENS_FIELD_RE = /"max_tokens":\d+,|,"max_tokens":\d+/;

/**
 * Compute the 5-char lowercase hex `cch` token for a serialized request body.
 * Applies the v2.1.172+ preimage transform, then hashes with the
 * version-resolved seed. Returns `CCH_PLACEHOLDER` (`00000`) if anything throws.
 */
export function computeCchForBody(
  serializedBody: string,
  version: string,
): string {
  try {
    const { seedHigh, seedLow } = resolveSeed(version);
    const preimage = serializedBody
      .replace(MODEL_VALUE_RE, "$1$2")
      .replace(MAX_TOKENS_FIELD_RE, "");
    const bytes = Buffer.from(preimage, "utf8");
    const full = xxHash64(bytes, seedHigh, seedLow);
    return (full & MASK_20).toString(16).padStart(5, "0");
  } catch {
    return CCH_PLACEHOLDER;
  }
}

// -----------------------------------------------------------------------------
// ?beta=true query string
// -----------------------------------------------------------------------------

/**
 * Augment an outgoing Messages URL with `?beta=true`. Idempotent. Preserves
 * any existing query params (appends with `&`). No-op when the path is not
 * `/v1/messages` or `beta=true` is already present.
 */
export function withBetaQuery(url: string): string {
  const messagesIdx = url.indexOf("/v1/messages");
  if (messagesIdx === -1) return url;
  const endpoint = messagesIdx + "/v1/messages".length;
  const head = url.slice(0, endpoint);
  const tail = url.slice(endpoint);
  if (/[?&]beta=true(?:&|$)/.test(tail)) return url;
  const separator = tail.length === 0 ? "?" : "&";
  return `${head}${tail}${separator}beta=true`;
}

// -----------------------------------------------------------------------------
// Orchestrator — mirrors the plugin's transformRequest
// -----------------------------------------------------------------------------

function readEnvFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}

/**
 * Apply a body transform, returning the input unchanged if it throws. Each
 * pipeline stage (scrub → normalize → decoy) degrades gracefully to its
 * predecessor so a single failing stage never breaks the whole request.
 */
function applyTransform(
  value: Readonly<Record<string, unknown>>,
  fn: (v: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  try {
    return fn(value);
  } catch {
    return value;
  }
}

export interface ApplyAnthropicBillingOptions {
  scrubMessages?: boolean;
  normalizeTools?: boolean;
  decoyTools?: boolean;
}

export interface AnthropicBillingResult {
  /** The transformed request body (system[] rebuilt, keys ordered). */
  body: Record<string, unknown>;
  /** The `cc_version=…; cc_entrypoint=cli; cch=…;` HTTP-header VALUE. */
  header: string;
  /**
   * transformed tool name → original tool name. Used to remap `tool_use` names
   * in the upstream response back to the names the client actually registered,
   * so the client receives the same tool-call names it sent. Empty when no
   * tools were renamed.
   */
  toolRenameMap: Map<string, string>;
}

/**
 * Apply the full v0.6.0 billing transform to a /v1/messages request body and
 * return both the rewritten body and the `x-anthropic-billing-header` value.
 *
 * Env knobs:
 *   PROXY_CC_VERSION        — override the stamped cc_version (default 2.1.196)
 *   PROXY_CCH_VALUE         — pin `cch` to a 5-hex value (bypass attestation)
 *   PROXY_CC_SCRUB_MESSAGES — scrub opencode fingerprints in system[]+messages[]
 *                             (default true)
 *   PROXY_CC_NORMALIZE_TOOLS — rename native tool names to PascalCase
 *                              (default true)
 *   PROXY_CC_DECOY_TOOLS    — append unavailable decoys for any Claude Code
 *                             native tool the request did not supply (anti-ban;
 *                             default true)
 */
export function applyAnthropicBilling(
  requestBody: Readonly<Record<string, unknown>>,
  opts: ApplyAnthropicBillingOptions = {},
): AnthropicBillingResult {
  const scrubMessages =
    opts.scrubMessages ?? readEnvFlag("PROXY_CC_SCRUB_MESSAGES", true);
  const normalizeTools =
    opts.normalizeTools ?? readEnvFlag("PROXY_CC_NORMALIZE_TOOLS", true);
  const decoyTools =
    opts.decoyTools ?? readEnvFlag("PROXY_CC_DECOY_TOOLS", true);

  // 1. Strip thinking → scrub → normalize → decoy. Each stage degrades to its
  //    predecessor on failure. Thinking blocks are dropped first because their
  //    signature is account-bound and rejected when replayed across keys; decoys
  //    run last (before the cch build so the attested body matches the sent body).
  let bodyForSigning: Readonly<Record<string, unknown>> = applyTransform(
    requestBody,
    stripThinkingBlocks,
  );
  bodyForSigning = applyTransform(bodyForSigning, (b) =>
    scrubAnchorsInPlace(b, { scrubMessages }),
  );
  let toolRenameMap = new Map<string, string>();
  if (normalizeTools) {
    try {
      const normalized = normalizeToolNames(bodyForSigning);
      bodyForSigning = normalized.body;
      toolRenameMap = normalized.renameMap;
    } catch {
      // Normalization failed — fall back to the scrubbed body, no rename map.
    }
  }
  if (decoyTools) {
    bodyForSigning = applyTransform(bodyForSigning, ensureCcDecoyTools);
  }

  // 2. Version suffix from the first user message text.
  const systemSource: unknown = bodyForSigning["system"];
  const firstUserText = extractFirstUserText(bodyForSigning);
  const version = process.env["PROXY_CC_VERSION"] || CC_VERSION;
  const suffix = computeVersionSuffix(firstUserText, version);

  // 3. Placeholder cch=00000 to compute the body bytes the real cch hashes.
  const placeholderHeaderValue = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${CCH_PLACEHOLDER};`;
  const placeholderBillingBlock = buildBillingBlock(placeholderHeaderValue);
  const placeholderSystemArray = buildSystemArray(
    systemSource,
    placeholderBillingBlock,
  );
  const placeholderBody = buildFinalBody(
    bodyForSigning,
    placeholderSystemArray,
  );
  const serializedBody = serializeBody(placeholderBody);

  // 4. Compute the real cch (or honor an explicit override).
  const envCch = process.env["PROXY_CCH_VALUE"];
  const cchOverride = envCch?.trim().replace(/^cch=/, "");
  const cch =
    cchOverride && /^[0-9a-f]{5}$/.test(cchOverride)
      ? cchOverride
      : computeCchForBody(serializedBody, version);

  // 5. Rebuild with the real cch, preserving the scrubbed original system
  //    entries verbatim (only system[0] is replaced: placeholder → final).
  const finalHeaderValue = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
  const finalBillingBlock = buildBillingBlock(finalHeaderValue);
  const finalSystemArray = placeholderSystemArray.map((block, idx) =>
    idx === 0 ? finalBillingBlock : block,
  );
  const finalBody = buildFinalBody(bodyForSigning, finalSystemArray);

  return { body: finalBody, header: finalHeaderValue, toolRenameMap };
}
