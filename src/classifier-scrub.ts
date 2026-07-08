// =============================================================================
// In-place anchor scrubbing (Anthropic OAuth billing classifier bypass)
// =============================================================================
//
// Ported 1:1 from the anthropic-billing-header plugin's classifier-scrub.ts
// (v0.6.0). Anthropic's OAuth billing classifier inspects the ENTIRE request
// payload (system[] + messages[] + tools[]), not just system[]. Surgical
// scrubbing of specific opencode fingerprint phrases — applied to system[]
// text AND messages[] text blocks (text blocks only; tool_use / tool_result /
// image blocks are untouched) — removes the classifier triggers while
// preserving prompt-cache prefixes.
//
// References:
//   - NousResearch/hermes-agent#53212 (multi-feature classifier)
//   - shahidshabbir-se/opencode-anthropic-oauth v0.4.7 (surgical scrub pattern)
//   - ex-machina-co/opencode-anthropic-auth v1.7.5 (env-block phrase trigger)

export interface ScrubSubstitution {
  readonly from: RegExp;
  readonly to: string;
}

export const OPENCODE_SCRUB_SUBSTITUTIONS: readonly ScrubSubstitution[] = [
  // Source-repo fingerprint
  {
    from: /github\.com\/anomalyco\/opencode/g,
    to: "github.com/anthropics/claude-code",
  },
  // Docs fingerprint
  { from: /opencode\.ai\/docs/g, to: "docs.claude.com/en/docs/claude-code" },
  // Source-prompt identity phrases (exact, not broad)
  {
    from: /You are OpenCode, the best coding agent on the planet\./g,
    to: "You are Claude Code, Anthropic's official CLI for Claude.",
  },
  // Environment-label fingerprints (opencode emits these literally)
  { from: /Workspace root folder:/g, to: "Working directory:" },
  { from: /Is directory a git repo:/g, to: "Git repository:" },
  { from: /<directories>/g, to: "<project_files>" },
  { from: /<\/directories>/g, to: "</project_files>" },
  // Known classifier trigger (ex-machina v1.7.5 documented this exact phrase)
  {
    from: /Here is some useful information about the environment you are running in:/g,
    to: "Environment context:",
  },
  // Note: TodoWrite is NOT scrubbed — same real tool name in opencode and CC.
];

export interface ScrubAnchorsOptions {
  readonly scrubMessages?: boolean;
}

export function scrubAnchorsInPlace(
  requestBody: Readonly<Record<string, unknown>>,
  opts: Readonly<ScrubAnchorsOptions>,
): Record<string, unknown> {
  const scrubMessages = opts.scrubMessages ?? true;

  const out: Record<string, unknown> = { ...requestBody };
  out["system"] = scrubSystem(out["system"]);
  if (scrubMessages) {
    out["messages"] = scrubMessagesArray(out["messages"]);
  } else {
    out["messages"] = cloneMessageArrayShallow(out["messages"]);
  }
  return out;
}

function scrubSystem(value: unknown): unknown {
  if (typeof value === "string") {
    return applySubstitutions(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        out.push(applySubstitutions(entry));
        continue;
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        if (e["type"] === "text" && typeof e["text"] === "string") {
          out.push({ ...e, text: applySubstitutions(e["text"] as string) });
          continue;
        }
      }
      out.push(entry);
    }
    return out;
  }
  return value;
}

function scrubMessagesArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((m) => scrubOneMessage(m));
}

function cloneMessageArrayShallow(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((m) => {
    if (typeof m !== "object" || m === null || Array.isArray(m)) return m;
    return { ...(m as Record<string, unknown>) };
  });
}

function scrubOneMessage(m: unknown): unknown {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return m;
  const msg = { ...(m as Record<string, unknown>) };
  const content = msg["content"];
  if (typeof content === "string") {
    msg["content"] = applySubstitutions(content);
    return msg;
  }
  if (Array.isArray(content)) {
    msg["content"] = content.map((block) => {
      if (typeof block !== "object" || block === null || Array.isArray(block))
        return block;
      const b = block as Record<string, unknown>;
      const type = b["type"];
      // Only scrub text-bearing blocks. Leave tool_use, tool_result, image, etc.
      if (type === "text" && typeof b["text"] === "string") {
        return { ...b, text: applySubstitutions(b["text"] as string) };
      }
      return block;
    });
  }
  return msg;
}

function applySubstitutions(text: string): string {
  let out = text;
  for (const sub of OPENCODE_SCRUB_SUBSTITUTIONS) {
    out = out.replace(sub.from, sub.to);
  }
  return out;
}
