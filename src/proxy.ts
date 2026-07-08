import * as http from "node:http";
import * as https from "node:https";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ProxyConfig,
  ProxyServer,
  RouteResult,
  AttemptResult,
  KeyState,
  CreateProxyOpts,
} from "./types.js";
import { resolveConfig, resolvePort } from "./config.js";
import { applyPrefillFix, modelNeedsFix } from "./prefill-fix.js";
import { extractThinkingProps, formatThinkingLog } from "./thinking-restore.js";
import { applyAnthropicBilling, withBetaQuery } from "./billing.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 504]);

// Config headers that always override whatever the caller sent. These identify
// the proxy as a specific Claude Code client upstream, so the caller's value
// (which may come from a different client) must never leak through.
const ALWAYS_OVERRIDE_HEADERS = new Set(["user-agent"]);

// Statuses that indicate the API key itself is rejected (expired, revoked,
// unauthorized). When multiple keys are configured and at least one other key
// is still usable, these trigger an immediate failover to the next key and the
// offending key is disabled for the lifetime of the process.
const AUTH_FAIL_STATUS = new Set([401, 403]);

function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 12) return `${key.slice(0, 3)}...${key.slice(-4)}`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function extractModel(body: Buffer | null): string | null {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      model?: unknown;
    };
    const model = parsed.model;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    return null;
  }
}

// Split a comma-separated flag header (e.g. anthropic-beta) into a de-duplicated
// array. Flags from `primary` are always kept; flags from `secondary` are
// dropped when they appear in `blacklist`. Returns the joined string or
// undefined when nothing remains.
function mergeFlagHeader(
  primary: string | undefined,
  secondary: string | undefined,
  blacklist: Set<string>,
): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, filter: boolean): void => {
    if (!raw) return;
    for (const flag of raw.split(",")) {
      const f = flag.trim();
      if (!f || seen.has(f)) continue;
      if (filter && blacklist.has(f)) continue;
      seen.add(f);
      parts.push(f);
    }
  };
  add(primary, false);
  add(secondary, true);
  return parts.length > 0 ? parts.join(",") : undefined;
}

function prettyBody(body: Buffer | string | null): string {
  if (!body) return "(empty)";
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (!raw.length) return "(empty)";

  const str = raw.toString("utf8");
  const trimmed = str.trim();
  if (!trimmed) return "(empty)";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, 8192);
    } catch {}
  }

  if (trimmed.includes("data: ")) {
    return trimmed
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data: ")) return line;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") return `data: ${data}`;
        try {
          return `data: ${JSON.stringify(JSON.parse(data), null, 2)}`;
        } catch {
          return line;
        }
      })
      .join("\n")
      .slice(0, 8192);
  }

  let nonPrintable = 0;
  for (let i = 0; i < trimmed.length && i < 512; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
  }
  if (nonPrintable > 4) {
    return `(binary/compressed data, ${raw.length} bytes)`;
  }

  return str.slice(0, 4096);
}

function parseRateLimit(
  status: number,
  resHeaders: Record<string, string>,
): number {
  if (status !== 429) return 0;

  const rams = resHeaders["retry-after-ms"];
  if (rams) {
    const ms = parseInt(rams, 10);
    if (!isNaN(ms) && ms > 0) return ms;
  }

  const ra = resHeaders["retry-after"];
  if (ra) {
    const secs = parseFloat(ra);
    if (!isNaN(secs)) return Math.max(1000, secs * 1000);
    const date = new Date(ra);
    if (!isNaN(date.getTime())) {
      return Math.max(1000, date.getTime() - Date.now());
    }
  }

  return 60_000;
}

function logFailure(
  tag: string,
  method: string | undefined,
  path: string,
  keyId: string,
  clientHeaders: Record<string, string>,
  upstreamHeaders: Record<string, string>,
  reqBody: Buffer | null,
  resHeaders: Record<string, string> | null,
  resBody: Buffer | null,
  resStatus: number | null,
  reason: string,
): void {
  console.error(
    `[vsllm-proxy] ${tag} FAILURE ${method ?? "?"} ${path} key=${keyId}\n` +
      `  reason: ${reason}\n` +
      `  status: ${resStatus ?? "N/A"}\n` +
      `  client request headers:\n  ${JSON.stringify(clientHeaders, null, 2)}\n` +
      `  upstream request headers:\n  ${JSON.stringify(upstreamHeaders, null, 2)}\n` +
      `  request body:\n  ${prettyBody(reqBody)}\n` +
      `  response headers:\n  ${resHeaders ? JSON.stringify(resHeaders, null, 2) : "(no response)"}\n` +
      `  response body:\n  ${prettyBody(resBody)}`,
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readStreamBody(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Buffers the upstream response body and logs a failure with the request and
// response details. Resolves with the captured body, or null if the body could
// not be read (the failure is still logged in that case).
function captureAndLogFailure(
  tag: string,
  method: string | undefined,
  path: string,
  keyId: string,
  clientHeaders: Record<string, string>,
  upstreamHeaders: Record<string, string>,
  reqBody: Buffer | null,
  resHeaders: Record<string, string>,
  stream: IncomingMessage,
  resStatus: number | null,
  reason: string,
): Promise<Buffer | null> {
  return readStreamBody(stream)
    .then((resBody) => {
      logFailure(
        tag,
        method,
        path,
        keyId,
        clientHeaders,
        upstreamHeaders,
        reqBody,
        resHeaders,
        resBody,
        resStatus,
        reason,
      );
      return resBody;
    })
    .catch(() => {
      logFailure(
        tag,
        method,
        path,
        keyId,
        clientHeaders,
        upstreamHeaders,
        reqBody,
        resHeaders,
        null,
        resStatus,
        reason,
      );
      return null;
    });
}

function respond(
  res: ServerResponse,
  status: number,
  obj: Record<string, unknown>,
): void {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isStreamError(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.error) {
        const err = parsed.error;
        if (typeof err === "string") return err;
        if (typeof err === "object" && err !== null) {
          return (
            ((err as Record<string, unknown>).message as string) ||
            ((err as Record<string, unknown>).type as string) ||
            "upstream error"
          );
        }
        return "upstream error";
      }
      if (
        parsed.type &&
        typeof parsed.type === "string" &&
        parsed.type.startsWith("error")
      ) {
        return (parsed.message as string) || parsed.type;
      }
    } catch {
      return null;
    }
    return null;
  }

  const lines = trimmed.split("\n");
  for (const line of lines) {
    const dataPrefix = "data: ";
    if (!line.startsWith(dataPrefix)) continue;
    const data = line.slice(dataPrefix.length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.error) {
        const err = parsed.error;
        if (typeof err === "string") return err;
        if (typeof err === "object" && err !== null) {
          return (
            ((err as Record<string, unknown>).message as string) ||
            ((err as Record<string, unknown>).type as string) ||
            "upstream error"
          );
        }
        return "upstream error";
      }
      if (
        parsed.type &&
        typeof parsed.type === "string" &&
        parsed.type.startsWith("error")
      ) {
        return (parsed.message as string) || parsed.type;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Remap tool_use names in a buffered JSON response body (non-SSE) back to the
// client's original tool names. Returns the buffer unchanged when the body is
// not JSON, has no tool_use blocks, or no names need remapping.
function remapJsonResponseToolNames(
  buf: Buffer,
  map: Map<string, string>,
): Buffer {
  if (map.size === 0 || buf.length === 0) return buf;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(buf.toString("utf8"));
  } catch {
    return buf;
  }
  if (!obj || typeof obj !== "object") return buf;
  const content = obj["content"];
  if (!Array.isArray(content)) return buf;
  let changed = false;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "tool_use"
    ) {
      const b = block as Record<string, unknown>;
      const name = b["name"];
      if (typeof name === "string") {
        const orig = map.get(name);
        if (orig !== undefined && orig !== name) {
          b["name"] = orig;
          changed = true;
        }
      }
    }
  }
  return changed ? Buffer.from(JSON.stringify(obj)) : buf;
}

/**
 * Streaming SSE rewriter that maps `content_block_start` tool_use names back to
 * the client's originals. SSE chunks do not align with event boundaries, so it
 * buffers partial lines and only emits complete (possibly rewritten) lines;
 * the final partial line is flushed on stream end. Non-`data:` lines, data
 * lines that are not tool-use content_block_start events, and `[DONE]` markers
 * pass through untouched.
 */
class SseToolNameRewriter {
  private pending = "";
  constructor(private readonly map: Map<string, string>) {}

  push(chunk: Buffer): Buffer {
    this.pending += chunk.toString("utf8");
    let out = "";
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, nl + 1);
      this.pending = this.pending.slice(nl + 1);
      out += this.rewriteLine(line);
    }
    return Buffer.from(out, "utf8");
  }

  flush(): Buffer {
    if (this.pending.length === 0) return Buffer.alloc(0);
    const out = this.rewriteLine(this.pending);
    this.pending = "";
    return Buffer.from(out, "utf8");
  }

  private rewriteLine(lineWithNl: string): string {
    const nlMatch = lineWithNl.match(/(\r?\n)$/);
    const nl = nlMatch ? nlMatch[1] : "";
    const line = nl
      ? lineWithNl.slice(0, lineWithNl.length - nl.length)
      : lineWithNl;
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) return lineWithNl;
    const raw = m[1];
    if (!raw || raw === "[DONE]" || raw.charCodeAt(0) !== 123 /* '{' */)
      return lineWithNl;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw);
    } catch {
      return lineWithNl;
    }
    const cb = obj["content_block"] as Record<string, unknown> | undefined;
    if (
      obj["type"] === "content_block_start" &&
      cb &&
      cb["type"] === "tool_use" &&
      typeof cb["name"] === "string"
    ) {
      const orig = this.map.get(cb["name"]);
      if (orig !== undefined && orig !== cb["name"]) {
        cb["name"] = orig;
        return `data: ${JSON.stringify(obj)}${nl}`;
      }
    }
    return lineWithNl;
  }
}

/**
 * Compact one-line description of a request's `tools[]` for logging: each tool
 * is rendered as `name` plus a qualifier — `:type` for server/built-in tools
 * (e.g. `web_search:web_search_20250305`), `:no-schema` when it is missing the
 * required `input_schema`, or bare for a well-formed user-defined tool.
 */
function describeTools(body: Record<string, unknown> | null): string {
  if (!body) return "(no body)";
  const tools = body["tools"];
  if (!Array.isArray(tools) || tools.length === 0) return "(none)";
  const parts = tools.map((t) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) return "?";
    const td = t as Record<string, unknown>;
    const name = typeof td["name"] === "string" ? td["name"] : "?";
    const type = td["type"];
    if (typeof type === "string" && type !== "custom") return `${name}:${type}`;
    if (!("input_schema" in td)) return `${name}:no-schema`;
    return name;
  });
  return `[${parts.join(", ")}]`;
}

/** Compact description of `tool_choice`. */
function describeToolChoice(body: Record<string, unknown> | null): string {
  if (!body) return "auto";
  const tc = body["tool_choice"];
  if (!tc || typeof tc !== "object") return String(tc ?? "auto");
  const obj = tc as Record<string, unknown>;
  const type = obj["type"];
  const name = obj["name"];
  return typeof name === "string" ? `${type}:${name}` : String(type ?? "auto");
}

/**
 * Copy upstream response headers for forwarding to the client, dropping the
 * hop-by-hop/framing headers we manage ourselves (content-length is dropped
 * because the body may be rewritten before it is sent, which would desync the
 * declared length).
 */
function forwardHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (lk === "content-length" || lk === "transfer-encoding") continue;
    out[k] = v;
  }
  return out;
}

export function createProxyServer(opts: CreateProxyOpts = {}): ProxyServer {
  const config = resolveConfig(opts);
  const upstreamKeys: string[] = Array.isArray(config.upstreamApiKey)
    ? config.upstreamApiKey.filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      )
    : typeof config.upstreamApiKey === "string" &&
        config.upstreamApiKey.length > 0
      ? [config.upstreamApiKey]
      : [];

  const keyStates: KeyState[] = upstreamKeys.map((k) => ({
    key: k,
    keyId: maskKey(k),
    rateLimitedUntil: 0,
    successModels: new Set<string>(),
    modelFails: new Map<string, number>(),
  }));

  const betaFlagBlacklist = new Set(config.blacklistBetaFlags);

  const upstreamAgent = config.upstreamBaseUrl.startsWith("https:")
    ? new https.Agent({
        keepAlive: true,
        maxSockets: 256,
        maxFreeSockets: 32,
      })
    : new http.Agent({
        keepAlive: true,
        maxSockets: 256,
        maxFreeSockets: 32,
      });

  function selectKey(tried: Set<number>, model: string | null): number {
    if (keyStates.length === 0) return 0;
    const now = Date.now();

    const pick = (pool: number[]): number =>
      pool[Math.floor(Math.random() * pool.length)];

    // Fresh, usable keys: not yet tried, not disabled, not rate-limited.
    const fresh = keyStates
      .map((_, i) => i)
      .filter(
        (i) =>
          !tried.has(i) &&
          !keyStates[i].authFailed &&
          keyStates[i].rateLimitedUntil <= now,
      );

    if (fresh.length > 0) {
      // Prefer keys that have already served this model successfully so we
      // route to known-good pairs first; only fall back to unproven keys
      // when no known-good key is available.
      if (model) {
        const preferred = fresh.filter((i) =>
          keyStates[i].successModels?.has(model),
        );
        if (preferred.length > 0) return pick(preferred);
      }
      return pick(fresh);
    }

    // No fresh keys — fall back to untried keys that aren't permanently bad
    // (may be rate-limited; choose the one whose cooldown expires soonest).
    const untried = keyStates
      .map((_, i) => i)
      .filter((i) => !tried.has(i) && !keyStates[i].authFailed);
    if (untried.length > 0) {
      return untried.reduce((best, i) =>
        keyStates[i].rateLimitedUntil < keyStates[best].rateLimitedUntil
          ? i
          : best,
      );
    }

    // Everything is either tried or auth-failed. As a last resort, avoid
    // auth-failed keys if any other key exists.
    const nonAuthFailed = keyStates
      .map((_, i) => i)
      .filter((i) => !keyStates[i].authFailed);
    if (nonAuthFailed.length > 0) {
      return pick(nonAuthFailed);
    }

    return pick(keyStates.map((_, i) => i));
  }

  function availableKeyIds(exclude?: number): string[] {
    const now = Date.now();
    return keyStates
      .map((k, i) => ({ k, i }))
      .filter(
        ({ k, i }) =>
          i !== exclude && !k.authFailed && k.rateLimitedUntil <= now,
      )
      .map(({ k }) => k.keyId);
  }

  // Record a clean success for a (key, model) pair so future requests for the
  // same model prefer it. Resets the consecutive-failure counter for the pair.
  function recordSuccess(keyIndex: number, model: string | null): void {
    if (!model || keyStates.length === 0) return;
    const s = keyStates[keyIndex];
    s.modelFails?.delete(model);
    if (s.successModels && !s.successModels.has(model)) {
      s.successModels.add(model);
      console.log(`[vsllm-proxy] learned key=${s.keyId} serves model=${model}`);
    }
  }

  // Record a failure for a (key, model) pair. Only pairs that were previously
  // learned are tracked — there is nothing to demote for an unproven pair. When
  // the consecutive-failure count reaches the configured threshold, the model
  // is evicted from the key's preferred list so it stops being favoured until
  // it earns the spot back with a clean success.
  function recordFailure(
    keyIndex: number,
    model: string | null,
    status?: number,
  ): void {
    if (!model || keyStates.length === 0) return;
    const s = keyStates[keyIndex];
    if (!s.successModels?.has(model)) return;
    const fails = (s.modelFails?.get(model) ?? 0) + 1;
    s.modelFails?.set(model, fails);
    if (fails >= config.affinityFailThreshold) {
      s.successModels.delete(model);
      s.modelFails?.delete(model);
      console.warn(
        `[vsllm-proxy] evicted key=${s.keyId} from model=${model} ` +
          `after ${fails} consecutive failures (last status ${status ?? "N/A"})`,
      );
    }
  }

  // Wipe all affinity for a key — used when the key is globally disabled by an
  // auth failure so it can never be preferred again.
  function clearAffinity(keyIndex: number): void {
    if (keyStates.length === 0) return;
    const s = keyStates[keyIndex];
    s.successModels?.clear();
    s.modelFails?.clear();
  }

  function resolveAuth(
    req: IncomingMessage,
    keyIndex: number,
  ): { auth: string | null; rawKey: string | null; keyId: string } {
    if (keyStates.length > 0) {
      const entry = keyStates[keyIndex % keyStates.length];
      return {
        auth: `Bearer ${entry.key}`,
        rawKey: entry.key,
        keyId: entry.keyId,
      };
    }

    const hdr = req.headers["authorization"];
    if (hdr) {
      const rawKey =
        typeof hdr === "string" ? hdr.replace(/^Bearer\s+/i, "").trim() : null;
      return {
        auth: hdr,
        rawKey,
        keyId: rawKey ? maskKey(rawKey) : "(caller)",
      };
    }

    return { auth: null, rawKey: null, keyId: "(none)" };
  }

  function buildUpstreamHeaders(
    req: IncomingMessage,
    auth: string | null,
    rawKey: string | null,
    bodyLen: number,
    sessionId: string | null,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    // Track which headers the caller supplied so the configured defaults
    // below only fill in gaps instead of overriding caller values.
    const clientSent = new Set<string>();

    // The anthropic-beta header is special: it is a comma-separated list of
    // feature flags. We capture the caller's value separately so it can be
    // split, blacklisted, and merged with the proxy's configured flags below
    // rather than being blindly overwritten.
    let clientBeta: string | undefined;
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (v === undefined) continue;
      clientSent.add(lk);
      if (lk === "anthropic-beta") {
        clientBeta = Array.isArray(v) ? v.join(",") : v;
        continue;
      }
      out[k] = Array.isArray(v) ? v[0] : v;
    }

    out["host"] = config.upstreamHost;
    if (auth) out["authorization"] = auth;
    delete out["x-api-key"];
    delete out["accept-encoding"];
    if (bodyLen > 0) out["content-length"] = String(bodyLen);
    if (!out["accept"]) out["accept"] = "application/json";

    // Apply configured defaults only for headers the caller did NOT supply.
    // Headers in ALWAYS_OVERRIDE_HEADERS (e.g. user-agent) always win so the
    // proxy presents a consistent Claude Code identity upstream.
    // anthropic-beta is skipped here — it is always merged below so the
    // proxy's flags and the caller's flags are combined.
    if (config.upstreamHeaders) {
      for (const [k, v] of Object.entries(config.upstreamHeaders)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === "anthropic-beta") continue;
        if (ALWAYS_OVERRIDE_HEADERS.has(lk) || !clientSent.has(lk)) {
          out[k] = v;
        }
      }
    }

    // Merge the proxy's configured flags (always kept) with the caller's flags
    // (filtered against the blacklist), de-duplicate, and re-join.
    const merged = mergeFlagHeader(
      config.upstreamHeaders?.["anthropic-beta"],
      clientBeta,
      betaFlagBlacklist,
    );

    if (merged) {
      out["anthropic-beta"] = merged;
    } else {
      delete out["anthropic-beta"];
    }

    if (sessionId) out["x-claude-code-session-id"] = sessionId;
    return out;
  }

  /**
   * Write a chunk to the client response, applying proper backpressure: if the
   * client socket's buffer is full, pause the upstream until it drains so we
   * never buffer an unbounded stream in memory.
   */
  function writeWithBackpressure(
    res: ServerResponse,
    upRes: IncomingMessage,
    chunk: Buffer,
  ): void {
    if (chunk.length === 0) return;
    if (!res.write(chunk)) {
      upRes.pause();
      res.once("drain", () => upRes.resume());
    }
  }

  function attemptOnce(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPath: string,
    body: Buffer | null,
    keyIndex: number,
    sessionId: string | null,
    billingHeader: string | null,
    toolRenameMap: Map<string, string> | null,
  ): Promise<AttemptResult> {
    const upstream = new URL(upstreamPath, config.upstreamBaseUrl);
    const { auth, rawKey, keyId } = resolveAuth(req, keyIndex);
    if (!auth) {
      respond(res, 401, {
        error: {
          message:
            "No API key. Supply an Authorization: Bearer <key> header or set upstreamApiKey in config.json.",
          type: "auth_error",
        },
      });

      return Promise.resolve({ ok: true, committed: true });
    }

    const outHeaders = buildUpstreamHeaders(
      req,
      auth,
      rawKey,
      body ? body.length : 0,
      sessionId,
    );
    if (billingHeader) {
      outHeaders["x-anthropic-billing-header"] = billingHeader;
    }
    const transport = upstream.protocol === "https:" ? https : http;
    const reqMethod = req.method ?? "?";

    console.log(
      `[vsllm-proxy] outbound key=${keyId} ${reqMethod} ${upstreamPath}`,
    );

    return new Promise((resolve) => {
      let connectionTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let upResRef: IncomingMessage | null = null;
      let proxyReq: http.ClientRequest;

      function finish(result: AttemptResult): void {
        if (settled) return;
        settled = true;
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
        req.off("close", onClientClose);
        resolve(result);
      }

      // Memory-leak fix: if the client disconnects before we have finished
      // writing the response, destroy the in-flight upstream request and
      // response so we release the pooled socket immediately instead of
      // holding it (and buffering into a dead response) until upstream ends.
      function onClientClose(): void {
        if (settled) return;
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }

        try {
          proxyReq.destroy();
        } catch {}
        if (upResRef) {
          try {
            upResRef.destroy();
          } catch {}
        }

        console.warn(
          `[vsllm-proxy] client-disconnected key=${keyId} ${reqMethod} ${upstreamPath}`,
        );

        finish({ ok: true, committed: true });
      }

      req.on("close", onClientClose);

      proxyReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
          method: reqMethod,
          path: `${upstream.pathname}${upstream.search}`,
          headers: outHeaders,
          agent: upstreamAgent,
        },
        (upRes) => {
          upResRef = upRes;
          if (connectionTimer) {
            clearTimeout(connectionTimer);
            connectionTimer = null;
          }

          const status = upRes.statusCode || 502;
          const clientHeaders = flattenHeaders(req.headers);
          const capturedHeaders = flattenHeaders(upRes.headers);

          if (RETRY_STATUS.has(status)) {
            const rateLimitMs = parseRateLimit(status, capturedHeaders);
            console.warn(
              `[vsllm-proxy] fail key=${keyId} status=${status} ${reqMethod} ${upstreamPath}` +
                (rateLimitMs > 0
                  ? ` retry_after=${Math.ceil(rateLimitMs / 1000)}s`
                  : ""),
            );

            captureAndLogFailure(
              "retry",
              reqMethod,
              upstreamPath,
              keyId,
              clientHeaders,
              outHeaders,
              body,
              capturedHeaders,
              upRes,
              status,
              `status ${status}`,
            ).then(() =>
              finish({
                ok: false,
                status,
                reason: `status ${status}`,
                rateLimitMs,
              }),
            );

            return;
          }

          // Auth failures (401/403): when the key itself is rejected and at
          // least one other non-disabled key exists, fail over to the next
          // key instead of returning the error to the client. The offending
          // key is disabled in forward() so it is skipped on subsequent
          // attempts and requests. When no other key is available the error
          // falls through to the generic non-2xx path below and is forwarded.
          if (
            AUTH_FAIL_STATUS.has(status) &&
            keyStates.some((_, i) => i !== keyIndex && !keyStates[i].authFailed)
          ) {
            console.warn(
              `[vsllm-proxy] auth-fail key=${keyId} status=${status} ${reqMethod} ${upstreamPath} — failing over to another key`,
            );

            captureAndLogFailure(
              "auth-fail",
              reqMethod,
              upstreamPath,
              keyId,
              clientHeaders,
              outHeaders,
              body,
              capturedHeaders,
              upRes,
              status,
              `auth status ${status}`,
            ).then(() =>
              finish({
                ok: false,
                status,
                reason: `auth status ${status}`,
                authFailed: true,
              }),
            );

            return;
          }

          // Non-2xx, non-retryable: capture + log the request/response, then
          // forward the buffered body to the client. Error bodies are small, so
          // buffering them is preferable to losing them in a streamed pipe.
          if (status < 200 || status >= 300) {
            console.warn(
              `[vsllm-proxy] fail key=${keyId} status=${status} ${reqMethod} ${upstreamPath}`,
            );

            captureAndLogFailure(
              "upstream",
              reqMethod,
              upstreamPath,
              keyId,
              clientHeaders,
              outHeaders,
              body,
              capturedHeaders,
              upRes,
              status,
              `status ${status}`,
            ).then((resBody) => {
              if (!res.headersSent && !res.writableEnded) {
                res.writeHead(status, forwardHeaders(upRes.headers));
                res.end(resBody ?? "");
              }
              finish({ ok: true, committed: true });
            });

            return;
          }

          // 2xx: forward the response to the client. For SSE streams we peek at
          // the first event(s) to check for a stream-level error, then flush
          // the buffer and pipe the rest directly so the client receives data
          // in real time. For non-SSE responses we buffer fully (same as
          // before) since there is no streaming benefit.
          if (res.headersSent || res.writableEnded) {
            upRes.resume();
            finish({ ok: true, committed: true });
            return;
          }

          const fwdHeaders = forwardHeaders(upRes.headers);

          const contentType = String(
            upRes.headers["content-type"] || "",
          ).toLowerCase();

          const isSSE = contentType.includes("text/event-stream");
          // SSE tool-name rewriter: only when request tools were renamed.
          const sseRewriter =
            isSSE && toolRenameMap && toolRenameMap.size > 0
              ? new SseToolNameRewriter(toolRenameMap)
              : null;

          const chunks: Buffer[] = [];
          let streaming = false;
          const streamStartTime = Date.now();

          const beginStream = () => {
            streaming = true;
            console.log(
              `[vsllm-proxy] stream-start key=${keyId} ${reqMethod} ${upstreamPath}`,
            );
            res.writeHead(status, fwdHeaders);
            const buffered = sseRewriter
              ? sseRewriter.push(Buffer.concat(chunks))
              : Buffer.concat(chunks);
            // Release the buffered chunks so they can be GC'd while the
            // (potentially long-lived) stream continues.
            chunks.length = 0;
            writeWithBackpressure(res, upRes, buffered);
          };

          upRes.on("data", (c: Buffer) => {
            if (streaming) {
              writeWithBackpressure(
                res,
                upRes,
                sseRewriter ? sseRewriter.push(c) : c,
              );
              return;
            }

            chunks.push(c);
            const buf = Buffer.concat(chunks).toString("utf8");

            // While buffering, check for stream-level errors so we can retry.
            if (isStreamError(buf)) {
              return;
            }

            // For SSE: once we have at least one complete line we are past the
            // point where the upstream would have sent an error event, so it
            // is safe to begin streaming to the client.
            if (isSSE && buf.includes("\n")) {
              beginStream();
            }
          });

          upRes.on("error", () => {
            if (!res.writableEnded) {
              try {
                res.end();
              } catch {}
            }

            chunks.length = 0;
            if (streaming) {
              const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(
                1,
              );
              console.warn(
                `[vsllm-proxy] stream-error key=${keyId} ${reqMethod} ${upstreamPath} (${elapsed}s)`,
              );
            }

            finish({ ok: true, committed: true });
          });

          upRes.on("end", () => {
            if (streaming) {
              if (sseRewriter) {
                // Best-effort flush of the final partial line before closing.
                writeWithBackpressure(res, upRes, sseRewriter.flush());
              }
              res.end();
              const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(
                1,
              );

              console.log(
                `[vsllm-proxy] stream-end key=${keyId} ${reqMethod} ${upstreamPath} (${elapsed}s)`,
              );

              finish({ ok: true, committed: true, served: true });
              return;
            }

            const resBody = Buffer.concat(chunks);
            chunks.length = 0;
            const errReason = isStreamError(resBody.toString("utf8"));

            if (errReason) {
              console.warn(
                `[vsllm-proxy] fail key=${keyId} stream-error ${reqMethod} ${upstreamPath} (${errReason})`,
              );

              finish({ ok: false, reason: `stream error: ${errReason}` });
              return;
            }

            const finalResBody =
              toolRenameMap && toolRenameMap.size > 0
                ? remapJsonResponseToolNames(resBody, toolRenameMap)
                : resBody;
            res.writeHead(status, fwdHeaders);
            res.end(finalResBody);
            finish({ ok: true, committed: true, served: true });
          });
        },
      );

      connectionTimer = setTimeout(() => {
        proxyReq.destroy(new Error("upstream connection timeout"));
      }, config.requestTimeoutMs);
      if (connectionTimer.unref) connectionTimer.unref();

      proxyReq.on("error", (err: Error) => {
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }

        console.warn(
          `[vsllm-proxy] fail key=${keyId} error ${reqMethod} ${upstreamPath} (${err.message})`,
        );

        logFailure(
          "error",
          reqMethod,
          upstreamPath,
          keyId,
          flattenHeaders(req.headers),
          outHeaders,
          body,
          null,
          null,
          null,
          err.message,
        );

        finish({ ok: false, reason: err.message });
      });

      if (body && body.length) proxyReq.write(body);
      proxyReq.end();
    });
  }

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPath: string,
    body: Buffer | null,
    sessionId: string | null,
    billingHeader: string | null,
    toolRenameMap: Map<string, string> | null,
  ): Promise<void> {
    const tried = new Set<number>();
    let lastReason = "no attempts";
    const model = extractModel(body);
    const maxAttempts =
      keyStates.length > 0
        ? Math.max(config.retryAttempts, keyStates.length)
        : config.retryAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (res.writableEnded || res.headersSent) return;

      const keyIndex = selectKey(tried, model);
      tried.add(keyIndex);

      const result = await attemptOnce(
        req,
        res,
        upstreamPath,
        body,
        keyIndex,
        sessionId,
        billingHeader,
        toolRenameMap,
      );
      if (result.ok) {
        // Remember that this key successfully served this model so future
        // requests for the same model prefer it over unproven keys.
        if (result.served) recordSuccess(keyIndex, model);
        return;
      }

      lastReason = result.reason || lastReason;

      // Auth failures (401/403): disable the key for the lifetime of the
      // process, wipe all of its learned affinities, and retry immediately
      // with a different key — no backoff sleep.
      if (result.authFailed && keyStates.length > 0) {
        keyStates[keyIndex].authFailed = true;
        clearAffinity(keyIndex);
        console.warn(
          `[vsllm-proxy] disabled key=${keyStates[keyIndex].keyId} ` +
            `(auth status ${result.status})` +
            (availableKeyIds().length > 0
              ? ` available=${availableKeyIds().join(",")}`
              : " (no other keys available)"),
        );
        continue;
      }

      // Any other failure (rate limit, 5xx, connection error, stream error)
      // counts against the (key, model) pair's affinity. A few transient
      // failures are tolerated; sustained failure evicts the pair so the
      // proxy stops routing to a key that keeps dying for this model.
      recordFailure(keyIndex, model, result.status);

      if (
        result.rateLimitMs &&
        result.rateLimitMs > 0 &&
        keyStates.length > 0
      ) {
        keyStates[keyIndex].rateLimitedUntil = Date.now() + result.rateLimitMs;
        const avail = availableKeyIds(keyIndex);
        console.warn(
          `[vsllm-proxy] rate-limited key=${keyStates[keyIndex].keyId} ` +
            `cooldown=${Math.ceil(result.rateLimitMs / 1000)}s` +
            (avail.length > 0
              ? ` available=${avail.join(",")}`
              : " (no other keys available)"),
        );
      }

      const more = attempt < maxAttempts;
      console.warn(
        `[vsllm-proxy] retry ${attempt}/${maxAttempts} (${lastReason})` +
          (more
            ? ` — trying next key in ${config.retryIntervalMs}ms`
            : " — giving up"),
      );
      if (more) await sleep(config.retryIntervalMs);
    }

    if (!res.headersSent && !res.writableEnded) {
      respond(res, 502, {
        error: {
          message: `upstream failed after ${config.retryAttempts} attempts: ${lastReason}`,
          type: "upstream_unavailable",
        },
      });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {}
    }
  }

  function maybeInjectBilling(buf: Buffer): {
    buf: Buffer;
    header: string | null;
    toolRenameMap: Map<string, string> | null;
  } {
    if (!buf || buf.length === 0)
      return { buf, header: null, toolRenameMap: null };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { buf, header: null, toolRenameMap: null };
    }
    if (!parsed || typeof parsed !== "object")
      return { buf, header: null, toolRenameMap: null };
    // The billing header + body attestation are derived from the request body,
    // so they must be recomputed for every request. The tool rename map is
    // returned so tool_use names in the response can be mapped back.
    const {
      body: transformed,
      header,
      toolRenameMap,
    } = applyAnthropicBilling(parsed);
    console.log(`[vsllm-proxy] billing ${header}`);
    return {
      buf: Buffer.from(JSON.stringify(transformed)),
      header,
      toolRenameMap,
    };
  }

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const pathname = (url.pathname.replace(/\/+$/, "") || "/").replace(
      /^\/v1\/v1(\/|$)/,
      "/v1$1",
    );

    if (pathname === "/" || pathname === "/health" || pathname === "/healthz") {
      respond(res, 200, { status: "ok", upstream: config.upstreamBaseUrl });
      return;
    }

    const routed = route(pathname);
    if (!routed) {
      respond(res, 404, {
        error: {
          message: `not found: ${pathname}`,
          type: "invalid_request_error",
        },
      });
      return;
    }

    try {
      const raw = await readBody(req);
      let body: Buffer;
      let sessionId: string | null = null;
      let billingHeader: string | null = null;
      let toolRenameMap: Map<string, string> | null = null;

      if (routed.callType === "messages") {
        const prefilled = maybeApplyFix(raw, routed.callType);
        const result = applyMessagesFix(prefilled);
        const injected = maybeInjectBilling(result.buf);
        body = injected.buf;
        billingHeader = injected.header;
        toolRenameMap = injected.toolRenameMap;
        sessionId = result.sessionId;
      } else if (routed.callType) {
        body = maybeApplyFix(raw, routed.callType);
      } else {
        body = raw;
      }

      // OAuth-subscription requests need ?beta=true on /v1/messages; append it
      // to the upstream path so the request line carries it through.
      const upstreamPath =
        routed.callType === "messages"
          ? withBetaQuery(routed.upstreamPath)
          : routed.upstreamPath;

      if (config.enableRequestLogging) {
        let parsedBody: Record<string, unknown> | null = null;
        try {
          if (body && body.length) {
            parsedBody = JSON.parse(body.toString("utf8")) as Record<
              string,
              unknown
            >;
          }
        } catch {
          parsedBody = null;
        }

        if (parsedBody) {
          const props = extractThinkingProps(parsedBody);
          console.log(
            `[vsllm-proxy] ${req.method} ${pathname} ${formatThinkingLog(props)}`,
          );
          // For /v1/messages, log the tool set + tool_choice actually being
          // sent upstream (post-transform) so tool-call issues (e.g. a missing
          // WebSearch vs a working WebFetch) are visible at a glance.
          if (routed.callType === "messages") {
            console.log(
              `[vsllm-proxy] upstream-tools model=${String(props.model ?? "?")} ` +
                `tools=${describeTools(parsedBody)} ` +
                `tool_choice=${describeToolChoice(parsedBody)}`,
            );
          }
        } else {
          console.log(
            `[vsllm-proxy] ${req.method} ${pathname} body=non-JSON|empty`,
          );
        }
      }

      await forward(
        req,
        res,
        upstreamPath,
        body,
        sessionId,
        billingHeader,
        toolRenameMap,
      );
    } catch (err: unknown) {
      if (!res.headersSent && !res.writableEnded) {
        respond(res, 500, {
          error: {
            message: String(
              (err && typeof err === "object" && "message" in err
                ? err.message
                : err) || err,
            ),
            type: "proxy_error",
          },
        });
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {}
      }
    }
  };

  const server = http.createServer(handler) as ProxyServer;
  server.config = config;
  server.timeout = 0;
  server.keepAliveTimeout = 120_000;
  server.requestTimeout = 0;
  server.headersTimeout = 130_000;
  return server;
}

export function maybeApplyFix(buf: Buffer, callType: string): Buffer {
  if (!buf || buf.length === 0) return buf;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return buf;
  }

  if (!body || typeof body !== "object") return buf;
  const changed = applyPrefillFix(body, callType);
  if (!changed) return buf;
  return Buffer.from(JSON.stringify(body));
}

export function applyMessagesFix(buf: Buffer): {
  buf: Buffer;
  sessionId: string;
} {
  if (!buf || buf.length === 0) {
    return { buf, sessionId: "" };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { buf, sessionId: "" };
  }

  if (!body || typeof body !== "object") {
    return { buf, sessionId: "" };
  }

  let sessionId: string = randomUUID();
  const existing = (body.metadata as Record<string, unknown> | undefined)
    ?.user_id;

  if (typeof existing === "string" && existing.length > 0) {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>;
      if (
        typeof parsed.session_id === "string" &&
        parsed.session_id.length > 0
      ) {
        sessionId = parsed.session_id;
      }
    } catch {}
  }

  const userId = JSON.stringify({ session_id: sessionId });
  body.metadata = { user_id: userId };
  return { buf: Buffer.from(JSON.stringify(body)), sessionId };
}

export function route(pathname: string): RouteResult | null {
  if (pathname === "/v1/chat/completions") {
    return { upstreamPath: "/v1/chat/completions", callType: "completion" };
  }

  if (pathname === "/v1/responses") {
    return { upstreamPath: "/v1/responses", callType: "responses" };
  }

  if (pathname === "/v1/completions") {
    return { upstreamPath: "/v1/completions", callType: "completion" };
  }

  if (pathname === "/v1/messages") {
    return { upstreamPath: "/v1/messages", callType: "messages" };
  }

  if (pathname.startsWith("/v1/")) {
    return { upstreamPath: pathname, callType: null };
  }

  return null;
}

export { resolveConfig, resolvePort, loadConfigFile } from "./config.js";
export { modelNeedsFix } from "./prefill-fix.js";
export { extractThinkingProps, formatThinkingLog } from "./thinking-restore.js";
