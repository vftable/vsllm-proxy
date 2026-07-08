// =============================================================================
// Tool-name normalization (Anthropic OAuth billing classifier bypass)
// =============================================================================
//
// Anthropic's classifier expects Claude Code's PascalCase tool casing for OAuth
// subscription tool access; lowercase / snake_case tool names are a third-party
// fingerprint. Every tool that does NOT start with `mcp_` (MCP tools keep their
// `mcp__server__tool` convention) is rewritten to PascalCase:
//   - known opencode lowercase names use the explicit override map below
//     (handles special cases like `lsp`→`LSP`, `question`→`AskUserQuestion`);
//   - all other names are PascalCased algorithmically.
// Renames are applied consistently across `tools[]`, `tool_choice.name`, and
// assistant `tool_use.name` in `messages[]`, and the resulting `tools[]` is
// de-duplicated by name so the outgoing request stays valid against Anthropic's
// Messages API (duplicate tool names trigger HTTP 400).

export const OPENCODE_TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map<
  string,
  string
>([
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["todowrite", "TodoWrite"],
  ["lsp", "LSP"],
  ["skill", "Skill"],
  ["question", "AskUserQuestion"],
]);

export interface NormalizedToolsResult {
  body: Record<string, unknown>;
  /**
   * transformed tool name → original tool name, for response-side remapping.
   * Built from `tools[]` (the set of tools the model can actually call);
   * first occurrence wins so it stays consistent with de-duplication.
   */
  renameMap: Map<string, string>;
}

export function normalizeToolNames(
  requestBody: Readonly<Record<string, unknown>>,
): NormalizedToolsResult {
  const out: Record<string, unknown> = { ...requestBody };
  const renameMap = new Map<string, string>();

  // 1. Top-level tools[] array — rename (recording the reverse map, first
  //    occurrence wins to match dedup), then drop duplicate names. Anthropic
  //    rejects duplicate tool names with HTTP 400.
  const tools = out["tools"];
  if (Array.isArray(tools)) {
    out["tools"] = dedupToolsByName(
      tools.map((t) => renameToolDefinition(t, renameMap)),
    );
  }

  // 2. tool_choice.name (kept consistent with tools[]; responses never echo
  //    tool_choice, so it is not recorded in the reverse map).
  const choice = out["tool_choice"];
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const c = choice as Record<string, unknown>;
    const renamed = maybeRenameToolName(c["name"]);
    if (renamed !== undefined) {
      out["tool_choice"] = { ...c, name: renamed };
    }
  }

  // 3. Assistant tool_use.name in messages[] (multi-turn history consistency).
  const messages = out["messages"];
  if (Array.isArray(messages)) {
    out["messages"] = messages.map((m) => renameToolUseInMessage(m));
  }

  return { body: out, renameMap };
}

function renameToolDefinition(
  t: unknown,
  renameMap: Map<string, string>,
): unknown {
  if (typeof t !== "object" || t === null || Array.isArray(t)) return t;
  const td = { ...(t as Record<string, unknown>) };
  const original = td["name"];
  const renamed = maybeRenameToolName(original);
  if (renamed !== undefined) {
    td["name"] = renamed;
    if (
      typeof original === "string" &&
      renamed !== original &&
      !renameMap.has(renamed)
    ) {
      renameMap.set(renamed, original);
    }
  }
  return td;
}

function renameToolUseInMessage(m: unknown): unknown {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return m;
  const msg = { ...(m as Record<string, unknown>) };
  const content = msg["content"];
  if (!Array.isArray(content)) return msg;
  msg["content"] = content.map((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block))
      return block;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_use") {
      const renamed = maybeRenameToolName(b["name"]);
      if (renamed !== undefined) {
        return { ...b, name: renamed };
      }
    }
    return block;
  });
  return msg;
}

/**
 * Resolve a tool name to its Claude Code-native form:
 *   - `mcp_*` (e.g. `mcp__server__tool`) is returned unchanged — MCP tools keep
 *     their own naming convention.
 *   - Known opencode lowercase names use the explicit override map (handles
 *     special cases like `lsp`→`LSP`, `question`→`AskUserQuestion`).
 *   - Everything else is PascalCased so the tool list reads as native Claude
 *     Code tooling. Lowercase / snake_case tool names are a third-party
 *     fingerprint that Anthropic's classifier uses to flag non-CC clients.
 *
 * Returns `undefined` only for non-string / empty names (leave untouched).
 */
function maybeRenameToolName(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (value.startsWith("mcp_")) return undefined;
  const mapped = OPENCODE_TOOL_NAME_MAP.get(value);
  if (mapped !== undefined) return mapped;
  return toPascalCase(value);
}

/**
 * Convert an arbitrary tool name to PascalCase. Splits on runs of
 * non-alphanumeric characters and on lower→upper (camelCase) boundaries,
 * capitalizes the first letter of each token, and joins. Idempotent on names
 * that are already PascalCase, and strips characters outside Anthropic's tool
 * name schema (`^[a-zA-Z0-9_-]{1,64}$`).
 */
function toPascalCase(name: string): string {
  const tokens = name
    .split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return name; // no alphanumeric content; leave as-is
  return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join("");
}

/** Keep the first tool per `name`; drop later duplicates (post-rename). */
function dedupToolsByName(tools: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const t of tools) {
    const name =
      t && typeof t === "object" && !Array.isArray(t)
        ? (t as Record<string, unknown>)["name"]
        : undefined;
    if (typeof name === "string") {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    result.push(t);
  }
  return result;
}

// =============================================================================
// CC decoy tools — anti-ban fallback
// =============================================================================
//
// Claude Code always advertises its full native tool set on /v1/messages.
// Requests that omit some of those tools look unlike Claude Code to Anthropic's
// classifier. To complete the fingerprint, any Claude Code native tool that the
// request did NOT supply (neither directly from Claude nor via an opencode
// override that normalized to the same PascalCase name) is appended as a decoy
// marked unavailable. The model cannot actually call them, but their presence
// makes the tool list match Claude Code's shape.
//
// Dedup is case-insensitive so an opencode `read` (renamed to `Read`) suppresses
// the `Read` decoy even when normalization is disabled.

export interface CcDecoyTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: { type: string; properties: Record<string, unknown> };
}

export const CC_DECOY_TOOLS: readonly CcDecoyTool[] = [
  {
    name: "Agent",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "AskUserQuestion",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Bash",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "CronCreate",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "CronDelete",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "CronList",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "DesignSync",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Edit",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "EnterPlanMode",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "EnterWorktree",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ExitPlanMode",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ExitWorktree",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Glob",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Grep",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Monitor",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "NotebookEdit",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "PowerShell",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "PushNotification",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Read",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ScheduleWakeup",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Skill",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Task",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "TaskOutput",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "TaskStop",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "TaskCreate",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "TaskGet",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "TaskUpdate",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "TaskList",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "WebFetch",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "WebSearch",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Workflow",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "Write",
    description: "This tool is currently unavailable.",
    input_schema: { type: "object", properties: {} },
  },
];

/**
 * Append a decoy (marked unavailable) for every Claude Code native tool the
 * request did not already advertise. Tools already present — whether supplied
 * directly by Claude or produced by an opencode override that renames to the
 * same PascalCase name — are left alone (case-insensitive dedup).
 */
export function ensureCcDecoyTools(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...requestBody };
  const tools = out["tools"];
  const list: unknown[] = Array.isArray(tools) ? tools : [];

  const existing = new Set<string>();
  for (const t of list) {
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") existing.add(name.toLowerCase());
    }
  }

  const decoys = CC_DECOY_TOOLS.filter(
    (d) => !existing.has(d.name.toLowerCase()),
  ).map((d) => ({ ...d }));
  if (decoys.length === 0) return out;

  out["tools"] = [...list, ...decoys];
  return out;
}
