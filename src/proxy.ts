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
import {
  extractThinkingProps,
  formatThinkingLog,
} from "./thinking-restore.js";

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

function prettyBody(body: Buffer | string | null): string {
  if (!body) return "(empty)";
  const str = typeof body === "string" ? body : body.toString("utf8");
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
  }));

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

  function selectKey(tried: Set<number>): number {
    if (keyStates.length === 0) return 0;
    const now = Date.now();

    const available = keyStates
      .map((_, i) => i)
      .filter((i) => !tried.has(i) && keyStates[i].rateLimitedUntil <= now);

    if (available.length === 1) return available[0];
    if (available.length > 1) {
      return available[Math.floor(Math.random() * available.length)];
    }

    const untried = keyStates.map((_, i) => i).filter((i) => !tried.has(i));
    if (untried.length > 0) {
      return untried.reduce((best, i) =>
        keyStates[i].rateLimitedUntil < keyStates[best].rateLimitedUntil
          ? i
          : best,
      );
    }

    return Math.floor(Math.random() * keyStates.length);
  }

  function availableKeyIds(exclude?: number): string[] {
    const now = Date.now();
    return keyStates
      .map((k, i) => ({ k, i }))
      .filter(({ k, i }) => i !== exclude && k.rateLimitedUntil <= now)
      .map(({ k }) => k.keyId);
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
        typeof hdr === "string"
          ? hdr.replace(/^Bearer\s+/i, "").trim()
          : null;
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
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (v !== undefined) out[k] = Array.isArray(v) ? v[0] : v;
    }
    out["host"] = config.upstreamHost;
    if (auth) out["authorization"] = auth;
    delete out["x-api-key"];
    if (bodyLen > 0) out["content-length"] = String(bodyLen);
    if (!out["accept"]) out["accept"] = "application/json";
    if (config.upstreamHeaders) {
      for (const [k, v] of Object.entries(config.upstreamHeaders)) {
        if (v !== undefined) out[k] = v;
      }
    }
    if (sessionId) out["x-claude-code-session-id"] = sessionId;
    return out;
  }

  function attemptOnce(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPath: string,
    body: Buffer | null,
    keyIndex: number,
    sessionId: string | null,
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
    const transport = upstream.protocol === "https:" ? https : http;
    const reqMethod = req.method ?? "?";

    console.log(
      `[vsllm-proxy] outbound key=${keyId} ${reqMethod} ${upstreamPath}`,
    );

    return new Promise((resolve) => {
      let connectionTimer: ReturnType<typeof setTimeout> | null = null;

      const proxyReq = transport.request(
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
              resolve({
                ok: false,
                status,
                reason: `status ${status}`,
                rateLimitMs,
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
                const fwdHeaders: Record<string, string | string[]> = {};
                for (const [k, v] of Object.entries(upRes.headers)) {
                  if (v === undefined) continue;
                  const lk = k.toLowerCase();
                  if (lk === "content-length" || lk === "transfer-encoding") {
                    continue;
                  }
                  fwdHeaders[k] = v;
                }
                res.writeHead(status, fwdHeaders);
                res.end(resBody ?? "");
              }
              resolve({ ok: true, committed: true });
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
            resolve({ ok: true, committed: true });
            return;
          }

          const fwdHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            const lk = k.toLowerCase();
            if (lk === "content-length" || lk === "transfer-encoding") {
              continue;
            }
            fwdHeaders[k] = v;
          }

          const contentType = String(
            upRes.headers["content-type"] || "",
          ).toLowerCase();
          const isSSE = contentType.includes("text/event-stream");

          const chunks: Buffer[] = [];
          let streaming = false;
          const streamStartTime = Date.now();

          const beginStream = () => {
            streaming = true;
            console.log(
              `[vsllm-proxy] stream-start key=${keyId} ${reqMethod} ${upstreamPath}`,
            );
            res.writeHead(status, fwdHeaders);
            const buffered = Buffer.concat(chunks);
            if (buffered.length) {
              if (!res.write(buffered)) {
                upRes.pause();
                res.once("drain", () => upRes.resume());
              }
            }
          };

          upRes.on("data", (c: Buffer) => {
            if (streaming) {
              if (!res.write(c)) {
                upRes.pause();
                res.once("drain", () => upRes.resume());
              }
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
            if (streaming) {
              const elapsed = (
                (Date.now() - streamStartTime) / 1000
              ).toFixed(1);
              console.warn(
                `[vsllm-proxy] stream-error key=${keyId} ${reqMethod} ${upstreamPath} (${elapsed}s)`,
              );
            }
            resolve({ ok: true, committed: true });
          });

          upRes.on("end", () => {
            if (streaming) {
              res.end();
              const elapsed = (
                (Date.now() - streamStartTime) / 1000
              ).toFixed(1);
              console.log(
                `[vsllm-proxy] stream-end key=${keyId} ${reqMethod} ${upstreamPath} (${elapsed}s)`,
              );
              resolve({ ok: true, committed: true });
              return;
            }

            const resBody = Buffer.concat(chunks);
            const errReason = isStreamError(resBody.toString("utf8"));

            if (errReason) {
              console.warn(
                `[vsllm-proxy] fail key=${keyId} stream-error ${reqMethod} ${upstreamPath} (${errReason})`,
              );
              resolve({ ok: false, reason: `stream error: ${errReason}` });
              return;
            }

            res.writeHead(status, fwdHeaders);
            res.end(resBody);
            resolve({ ok: true, committed: true });
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
        resolve({ ok: false, reason: err.message });
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
  ): Promise<void> {
    const tried = new Set<number>();
    let lastReason = "no attempts";
    const maxAttempts =
      keyStates.length > 0
        ? Math.max(config.retryAttempts, keyStates.length)
        : config.retryAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (res.writableEnded || res.headersSent) return;

      const keyIndex = selectKey(tried);
      tried.add(keyIndex);

      const result = await attemptOnce(
        req,
        res,
        upstreamPath,
        body,
        keyIndex,
        sessionId,
      );
      if (result.ok) return;

      lastReason = result.reason || lastReason;

      if (result.rateLimitMs && result.rateLimitMs > 0 && keyStates.length > 0) {
        keyStates[keyIndex].rateLimitedUntil =
          Date.now() + result.rateLimitMs;
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
      if (routed.callType === "messages") {
        const prefilled = maybeApplyFix(raw, routed.callType);
        const result = applyMessagesFix(prefilled);
        body = result.buf;
        sessionId = result.sessionId;
      } else if (routed.callType) {
        body = maybeApplyFix(raw, routed.callType);
      } else {
        body = raw;
      }

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
        } else {
          console.log(
            `[vsllm-proxy] ${req.method} ${pathname} body=non-JSON|empty`,
          );
        }
      }

      await forward(req, res, routed.upstreamPath, body, sessionId);
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
export {
  extractThinkingProps,
  formatThinkingLog,
} from "./thinking-restore.js";
