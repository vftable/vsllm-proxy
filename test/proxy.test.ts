import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  createProxyServer,
  route,
  maybeApplyFix,
  applyMessagesFix,
  resolveConfig,
  isStreamError,
} from "../src/proxy.js";
import {
  extractThinkingProps,
  formatThinkingLog,
} from "../src/thinking-restore.js";
import type { ProxyServer } from "../src/types.js";

test("route maps the three primary endpoints", () => {
  assert.deepEqual(route("/v1/chat/completions"), {
    upstreamPath: "/v1/chat/completions",
    callType: "completion",
  });
  assert.deepEqual(route("/v1/responses"), {
    upstreamPath: "/v1/responses",
    callType: "responses",
  });
  assert.deepEqual(route("/v1/completions"), {
    upstreamPath: "/v1/completions",
    callType: "completion",
  });
});

test("route forwards /v1/models verbatim (no prefill fix)", () => {
  assert.deepEqual(route("/v1/models"), {
    upstreamPath: "/v1/models",
    callType: null,
  });
});

test("route maps /v1/messages to the messages call type", () => {
  assert.deepEqual(route("/v1/messages"), {
    upstreamPath: "/v1/messages",
    callType: "messages",
  });
});

test("route passes through arbitrary /v1 paths", () => {
  assert.deepEqual(route("/v1/embeddings"), {
    upstreamPath: "/v1/embeddings",
    callType: null,
  });
});

test("route returns null for unknown roots", () => {
  assert.equal(route("/foo"), null);
  assert.equal(route("/"), null);
});

test("maybeApplyFix passes through non-JSON bodies", () => {
  const buf = Buffer.from("not json");
  assert.equal(maybeApplyFix(buf, "completion"), buf);
});

test("maybeApplyFix forwards the body without _callType on the success path", () => {
  const out = maybeApplyFix(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      }),
    ),
    "completion",
  );
  assert.equal(JSON.parse(out.toString())._callType, undefined);
});

test("maybeApplyFix never leaks _callType on the no-op path", () => {
  const out = maybeApplyFix(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      }),
    ),
    "completion",
  );
  const parsed = JSON.parse(out.toString());
  assert.equal(parsed._callType, undefined);
  assert.equal(parsed.model, "claude-sonnet-4-5");
  assert.equal(parsed.messages.length, 2);
});

test("applyMessagesFix preserves session_id from caller user_id and strips extra fields", () => {
  const { buf, sessionId } = applyMessagesFix(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        metadata: {
          user_id: '{"session_id":"my-session","extra":"stripped"}',
          other: "gone",
        },
      }),
    ),
  );
  const parsed = JSON.parse(buf.toString());
  assert.deepEqual(parsed.metadata, {
    user_id: '{"session_id":"my-session"}',
  });
  assert.equal(sessionId, "my-session");
});

test("applyMessagesFix normalizes non-JSON user_id to new session_id", () => {
  const { buf, sessionId } = applyMessagesFix(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "caller-supplied-id" },
      }),
    ),
  );
  const parsed = JSON.parse(buf.toString());
  const inner = JSON.parse(parsed.metadata.user_id);
  assert.match(
    inner.session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(sessionId, inner.session_id);
});

test("applyMessagesFix generates a uuid session_id when user_id missing", () => {
  const { buf, sessionId } = applyMessagesFix(
    Buffer.from(JSON.stringify({ model: "claude-sonnet-4-6", messages: [] })),
  );
  const parsed = JSON.parse(buf.toString());
  const userId = parsed.metadata.user_id;
  assert.equal(typeof userId, "string");
  const inner = JSON.parse(userId);
  assert.equal(typeof inner.session_id, "string");
  assert.match(
    inner.session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(sessionId, inner.session_id);
});

test("applyMessagesFix generates a uuid session_id when metadata missing", () => {
  const { buf, sessionId } = applyMessagesFix(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [],
        metadata: { other: "kept?" },
      }),
    ),
  );
  const parsed = JSON.parse(buf.toString());
  const userId = parsed.metadata.user_id;
  assert.equal(typeof userId, "string");
  const inner = JSON.parse(userId);
  assert.match(
    inner.session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(sessionId, inner.session_id);
});

test("applyMessagesFix passes through non-JSON bodies", () => {
  const buf = Buffer.from("not json");
  const { buf: out, sessionId } = applyMessagesFix(buf);
  assert.deepEqual(out, buf);
  assert.equal(sessionId, "");
});

async function boot(
  {
    upstreamHandler,
  }: {
    upstreamHandler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => void;
  },
  proxyOpts: Record<string, unknown> = {},
): Promise<{ proxy: ProxyServer; upstream: http.Server }> {
  const upstream = http.createServer(upstreamHandler);
  await new Promise<void>((r) => upstream.listen(0, r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy = createProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamApiKey: "test-key",
    retryAttempts: 10,
    retryIntervalMs: 10,
    ...proxyOpts,
  } as any);
  await new Promise<void>((r) => proxy.listen(0, r));
  return { proxy, upstream };
}

function close(srv: http.Server | ProxyServer): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}

function proxyRequest(
  port: number,
  {
    path,
    method = "POST",
    headers = {},
    body,
  }: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("e2e: prefill fix is applied before forwarding to upstream", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      captured = parsed;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      },
    });

    assert.equal(captured.messages.length, 3);
    assert.deepEqual(captured.messages[2], {
      role: "user",
      content: "continue",
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: non-Claude-4.6+ requests forward unchanged", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/responses",
      body: {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      },
    });
    assert.equal(captured.messages.length, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/v1 prefix is collapsed to /v1 before forwarding", async () => {
  let hitPath: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      hitPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(hitPath, "/v1/chat/completions");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/models forwards verbatim with no body mutation", async () => {
  let hitPath: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      hitPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/models",
      method: "GET",
    });
    assert.equal(hitPath, "/v1/models");
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { data: [{ id: "gpt-4o" }] });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: upstream API key is injected when caller omits Authorization", async () => {
  let authHeader: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      authHeader = req.headers["authorization"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(authHeader, "Bearer test-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: configured upstreamApiKey is preferred over caller Authorization", async () => {
  let authHeader: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      authHeader = req.headers["authorization"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer caller-key" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(authHeader, "Bearer test-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: caller Authorization is used as fallback when no upstreamApiKey", async () => {
  let authHeader: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        authHeader = req.headers["authorization"];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: "" },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer caller-key" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(authHeader, "Bearer caller-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: client anthropic-beta flags are merged with config flags", async () => {
  let received: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        received = req.headers["anthropic-beta"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamHeaders: { "anthropic-beta": "config-a,config-b" } },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "anthropic-beta": "client-x,client-y" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    const flags = (received ?? "").split(",").sort();
    assert.deepEqual(
      flags,
      ["client-x", "client-y", "config-a", "config-b"],
      `got: ${received}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: blacklisted client anthropic-beta flags are stripped", async () => {
  let received: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        received = req.headers["anthropic-beta"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamHeaders: { "anthropic-beta": "config-a" },
      blacklistBetaFlags: ["bad-flag"],
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "anthropic-beta": "good-flag,bad-flag" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    const flags = (received ?? "").split(",").sort();
    assert.deepEqual(flags, ["config-a", "good-flag"], `got: ${received}`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: blacklist does not strip config-provided beta flags", async () => {
  let received: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        received = req.headers["anthropic-beta"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamHeaders: { "anthropic-beta": "config-a,blocked-cfg" },
      blacklistBetaFlags: ["blocked-cfg"],
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "anthropic-beta": "blocked-cfg,client-ok" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    const flags = (received ?? "").split(",").sort();
    // config's "blocked-cfg" survives the blacklist; client's "blocked-cfg" is deduped.
    assert.deepEqual(
      flags,
      ["blocked-cfg", "client-ok", "config-a"],
      `got: ${received}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: duplicate anthropic-beta flags are de-duplicated", async () => {
  let received: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        received = req.headers["anthropic-beta"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamHeaders: { "anthropic-beta": "shared,config-only" } },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "anthropic-beta": "shared,client-only" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    const flags = (received ?? "").split(",");
    assert.equal(
      flags.filter((f) => f === "shared").length,
      1,
      `"shared" must appear exactly once, got: ${received}`,
    );
    assert.ok(flags.includes("config-only"));
    assert.ok(flags.includes("client-only"));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: config beta flags used verbatim when client sends none", async () => {
  let received: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        received = req.headers["anthropic-beta"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamHeaders: { "anthropic-beta": "config-a,config-b" } },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    const flags = (received ?? "").split(",").sort();
    assert.deepEqual(flags, ["config-a", "config-b"], `got: ${received}`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: all client beta flags blacklisted leaves only config flags", async () => {
  let received: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        received = req.headers["anthropic-beta"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamHeaders: { "anthropic-beta": "config-a" },
      blacklistBetaFlags: ["client-a", "client-b"],
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "anthropic-beta": "client-a,client-b" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(received, "config-a", `got: ${received}`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: client-supplied headers take precedence over config defaults", async () => {
  let customHdr: string | undefined;
  let anthropicVersion: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        customHdr = req.headers["x-custom-hdr"] as string | undefined;
        anthropicVersion = req.headers["anthropic-version"] as
          string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamHeaders: {
        "x-custom-hdr": "config-default",
        "anthropic-version": "config-version",
      },
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    // Client supplies x-custom-hdr but NOT anthropic-version.
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "x-custom-hdr": "client-value" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    // Client header wins for non-controlled headers.
    assert.equal(
      customHdr,
      "client-value",
      `client header should win, got: ${customHdr}`,
    );
    // Missing client header falls back to config default.
    assert.equal(
      anthropicVersion,
      "config-version",
      `missing header should use default, got: ${anthropicVersion}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: config user-agent always wins over client-supplied value", async () => {
  let userAgent: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        userAgent = req.headers["user-agent"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamHeaders: { "user-agent": "claude-cli/9.9.9 (external, cli)" },
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { "user-agent": "intruder-agent/1.0" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(
      userAgent,
      "claude-cli/9.9.9 (external, cli)",
      `config user-agent must always win, got: ${userAgent}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: config defaults used when client sends no custom headers", async () => {
  let userAgent: string | undefined;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        userAgent = req.headers["user-agent"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamHeaders: { "user-agent": "config-default-agent" },
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(
      userAgent,
      "config-default-agent",
      `default should be used when client omits header, got: ${userAgent}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: upstreamApiKey array keys are all selectable (distinct models)", async () => {
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        seen.push(req.headers["authorization"] ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b", "key-c"] },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    // A distinct model per request means no sticky learning pins traffic to
    // a single key, so random selection should reach every key.
    for (let i = 0; i < 30; i++) {
      await proxyRequest(port, {
        path: "/v1/chat/completions",
        body: {
          model: `model-${i}`,
          messages: [{ role: "user", content: "hi" }],
        },
      });
    }
    const seenSet = new Set(seen);
    assert.ok(seenSet.has("Bearer key-a"), "key-a should be used");
    assert.ok(seenSet.has("Bearer key-b"), "key-b should be used");
    assert.ok(seenSet.has("Bearer key-c"), "key-c should be used");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: successful model+key pair is preferred on subsequent requests", async () => {
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        seen.push(req.headers["authorization"] ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b", "key-c"] },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const reqBody = {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    };
    // First request picks a key at random and learns it for this model.
    await proxyRequest(port, reqBody);
    const learned = seen[0];
    assert.ok(learned, "first request should have hit a key");

    // All subsequent requests for the same model must prefer the learned key.
    seen.length = 0;
    for (let i = 0; i < 15; i++) {
      await proxyRequest(port, reqBody);
    }
    assert.ok(
      seen.every((s) => s === learned),
      `expected all follow-up requests to use learned key ${learned}, got: ${seen.join(", ")}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: different models learn independently", async () => {
  const byModel: Record<string, string[]> = {};
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
          model?: string;
        };
        const m = parsed.model ?? "?";
        (byModel[m] ??= []).push(req.headers["authorization"] ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b"] },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const send = (model: string) =>
      proxyRequest(port, {
        path: "/v1/chat/completions",
        body: { model, messages: [{ role: "user", content: "hi" }] },
      });

    // Seed each model so it learns a key, then verify it sticks to that key.
    await send("alpha");
    await send("beta");
    const alphaKey = byModel["alpha"][0];
    const betaKey = byModel["beta"][0];
    for (let i = 0; i < 10; i++) {
      await send("alpha");
      await send("beta");
    }
    assert.ok(
      byModel["alpha"].every((k) => k === alphaKey),
      `alpha should stick to ${alphaKey}`,
    );
    assert.ok(
      byModel["beta"].every((k) => k === betaKey),
      `beta should stick to ${betaKey}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: keys rotate across retries within a single request", async () => {
  const seen: string[] = [];
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        seen.push(req.headers["authorization"] ?? "");
        if (hits < 3) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temp" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b", "key-c"], retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.equal(hits, 3);
    // Three different keys should have been used (order is random)
    assert.equal(
      new Set(seen).size,
      3,
      "expected 3 distinct keys, got: " + seen.join(", "),
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: rate-limited keys are skipped on subsequent requests", async () => {
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(auth);
        if (auth === "Bearer key-a") {
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "120",
          });
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b", "key-c"], retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    // First request: might hit key-a first (rate-limited) then succeed with another key
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    seen.length = 0;
    // Second request: key-a should be rate-limited and skipped
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    // key-a should NOT appear in the second request's attempts
    assert.ok(
      !seen.includes("Bearer key-a"),
      "rate-limited key-a should not be used: " + seen.join(", "),
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 401 unauthorized key fails over to another working key", async () => {
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(auth);
        if (auth === "Bearer bad-key") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["bad-key", "good-key"], retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.ok(seen.includes("Bearer good-key"), "should have tried good-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 403 forbidden key fails over to another working key", async () => {
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(auth);
        if (auth === "Bearer bad-key") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "forbidden" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["bad-key", "good-key"], retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.ok(seen.includes("Bearer good-key"), "should have tried good-key");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: single key 401 is forwarded to the client without retry", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 401);
    assert.equal(hits, 1, "single-key 401 must not retry");
    assert.deepEqual(JSON.parse(out.body), {
      error: { message: "invalid key" },
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: all keys returning 401 forwards the error to the client", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid key" } }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b"], retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 401);
    assert.equal(hits, 2, "should try each key exactly once");
    assert.deepEqual(JSON.parse(out.body), {
      error: { message: "invalid key" },
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: auth-failed key is skipped on subsequent requests", async () => {
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(auth);
        if (auth === "Bearer key-a") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { upstreamApiKey: ["key-a", "key-b", "key-c"], retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;

    // Phase 1: send requests with distinct models (so sticky learning can't
    // pin traffic to one good key) until key-a is hit and disabled.
    for (let i = 0; i < 30; i++) {
      seen.length = 0;
      await proxyRequest(port, {
        path: "/v1/chat/completions",
        body: {
          model: `probe-${i}`,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      if (seen.includes("Bearer key-a")) break;
    }
    assert.ok(
      seen.includes("Bearer key-a"),
      "phase 1 should have triggered key-a's 401",
    );

    // Phase 2: key-a is now globally disabled — it must not be selected again.
    seen.length = 0;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.ok(
      !seen.includes("Bearer key-a"),
      "auth-failed key-a should not be used: " + seen.join(", "),
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 401 is not retried when no upstreamApiKey is configured", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid caller key" } }));
      },
    },
    { upstreamApiKey: "", retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer caller-key" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 401);
    assert.equal(hits, 1, "no failover possible without configured keys");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: sustained failures evict a learned model+key pair", async () => {
  // With threshold=1 a single failure is enough to evict, making the test
  // fully deterministic.
  let phase = 1;
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(auth);
        const isKeyA = auth === "Bearer key-a";
        if (phase === 1) {
          // Only key-a works so it alone gets learned.
          if (isKeyA) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "temp" }));
          }
          return;
        }
        // Phase 2+: key-a is now broken, key-b serves the failover.
        if (isKeyA) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temp" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      },
    },
    {
      upstreamApiKey: ["key-a", "key-b"],
      retryIntervalMs: 5,
      affinityFailThreshold: 1,
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const send = () =>
      proxyRequest(port, {
        path: "/v1/chat/completions",
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    // Phase 1: learn key-a for gpt-4o.
    await send();

    // Phase 2: key-a fails (evicted at threshold=1), key-b serves failover.
    phase = 2;
    seen.length = 0;
    await send();
    assert.ok(
      seen.includes("Bearer key-a"),
      "key-a should have been tried first (preferred) and failed",
    );

    // Phase 3: key-a must no longer be preferred — key-b is the only learned
    // key, so it should be selected directly in a single attempt.
    seen.length = 0;
    await send();
    assert.deepEqual(
      seen,
      ["Bearer key-b"],
      `evicted key-a should not be preferred, got: ${seen.join(", ")}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 429 rate-limit errors evict a learned model+key pair", async () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => warns.push(args.join(" "));
  let phase = 1;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        if (phase === 1) {
          if (auth === "Bearer key-a") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "temp" }));
          }
          return;
        }
        if (auth === "Bearer key-a") {
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "120",
          });
          res.end(JSON.stringify({ error: "rate limited" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      },
    },
    {
      upstreamApiKey: ["key-a", "key-b"],
      retryIntervalMs: 5,
      affinityFailThreshold: 1,
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const send = () =>
      proxyRequest(port, {
        path: "/v1/chat/completions",
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    // Phase 1: learn key-a.
    await send();
    // Phase 2: key-a returns 429 — should be evicted immediately.
    phase = 2;
    await send();

    const evicted = warns.find(
      (l) => l.includes("evicted key=") && l.includes("model=gpt-4o"),
    );
    assert.ok(
      evicted,
      `expected an eviction warning for gpt-4o, got: ${warns.filter((w) => w.includes("evicted")).join(" | ")}`,
    );
  } finally {
    console.warn = origWarn;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: transient failure below threshold does not evict", async () => {
  // threshold=5: a single blip must NOT evict the pair.
  let phase = 1;
  const seen: string[] = [];
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(auth);
        const isKeyA = auth === "Bearer key-a";
        if (phase === 1) {
          res.writeHead(isKeyA ? 200 : 500, {
            "content-type": "application/json",
          });
          res.end(
            isKeyA
              ? JSON.stringify({ ok: true })
              : JSON.stringify({ error: "temp" }),
          );
          return;
        }
        if (phase === 2) {
          // key-a blips once, key-b serves.
          res.writeHead(isKeyA ? 500 : 200, {
            "content-type": "application/json",
          });
          res.end(
            isKeyA
              ? JSON.stringify({ error: "temp" })
              : JSON.stringify({ ok: true }),
          );
          return;
        }
        // Phase 3: both keys work again.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    {
      upstreamApiKey: ["key-a", "key-b"],
      retryIntervalMs: 5,
      affinityFailThreshold: 5,
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const send = () =>
      proxyRequest(port, {
        path: "/v1/chat/completions",
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    await send(); // phase 1: learn key-a
    phase = 2;
    await send(); // phase 2: key-a blips once (fails=1, not evicted)

    // Phase 3: key-a should still be preferred (not evicted), so it should be
    // selected at least once across several requests.
    phase = 3;
    seen.length = 0;
    for (let i = 0; i < 20; i++) await send();
    assert.ok(
      seen.includes("Bearer key-a"),
      "key-a should still be preferred after a single transient failure: " +
        seen.join(", "),
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: evicted pair re-learns after a clean success", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));
  let phase = 1;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        const auth = req.headers["authorization"] ?? "";
        const isKeyA = auth === "Bearer key-a";
        if (phase === 1) {
          res.writeHead(isKeyA ? 200 : 500, {
            "content-type": "application/json",
          });
          res.end(
            isKeyA
              ? JSON.stringify({ ok: true })
              : JSON.stringify({ error: "temp" }),
          );
          return;
        }
        if (phase === 2) {
          res.writeHead(isKeyA ? 500 : 200, {
            "content-type": "application/json",
          });
          res.end(
            isKeyA
              ? JSON.stringify({ error: "temp" })
              : JSON.stringify({ ok: true }),
          );
          return;
        }
        // Phase 3: key-a works again, key-b broken — key-a must serve the
        // failover and be re-learned.
        res.writeHead(isKeyA ? 200 : 500, {
          "content-type": "application/json",
        });
        res.end(
          isKeyA
            ? JSON.stringify({ ok: true })
            : JSON.stringify({ error: "temp" }),
        );
      },
    },
    {
      upstreamApiKey: ["key-a", "key-b"],
      retryIntervalMs: 5,
      affinityFailThreshold: 1,
    },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const send = () =>
      proxyRequest(port, {
        path: "/v1/chat/completions",
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    await send(); // phase 1: learn key-a
    phase = 2;
    await send(); // phase 2: evict key-a, learn key-b
    // Count "learned" logs for gpt-4o so far (key-a in phase 1, key-b in phase 2).
    const learnedBefore = logs.filter(
      (l) => l.includes("learned") && l.includes("gpt-4o"),
    ).length;

    // Phase 3: key-a works again, key-b broken — key-a must serve the
    // failover and be re-learned (only key-a can produce a new "learned").
    phase = 3;
    await send();
    const learnedAfter = logs.filter(
      (l) => l.includes("learned") && l.includes("gpt-4o"),
    ).length;
    assert.ok(
      learnedAfter > learnedBefore,
      "key-a should be re-learned after a clean success post-eviction",
    );
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages overwrites metadata and sets anthropic-version header", async () => {
  let captured: any;
  let sessionHeader: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      sessionHeader = req.headers["x-claude-code-session-id"] as
        string | undefined;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        metadata: {
          user_id: '{"session_id":"my-session","extra":"stripped"}',
        },
      },
    });
    assert.equal(sessionHeader, "my-session");
    assert.deepEqual(captured.metadata, {
      user_id: '{"session_id":"my-session"}',
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages generates uuid session_id when metadata missing", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const userId = captured.metadata.user_id;
    assert.equal(typeof userId, "string");
    const inner = JSON.parse(userId);
    assert.match(
      inner.session_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages injects billing header as first system block", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        system: [
          {
            type: "text",
            text: "You are a careful assistant.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    });
    assert.ok(Array.isArray(captured.system), "system must be an array");
    const sys = captured.system as Array<{ type: string; text: string }>;
    // v0.6.0 order: [billing, identity, ...original]
    assert.equal(sys.length, 3);
    assert.ok(
      sys[0].text.startsWith("x-anthropic-billing-header:"),
      `first block must be billing header, got: ${sys[0].text}`,
    );
    assert.ok(sys[0].text.includes("cc_version="));
    assert.ok(sys[0].text.includes("cc_entrypoint=cli"));
    assert.equal(
      sys[1].text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    // Original (non-identity) block preserved with its cache_control.
    assert.equal(sys[2].text, "You are a careful assistant.");
    assert.deepEqual((sys[2] as { cache_control?: unknown }).cache_control, {
      type: "ephemeral",
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages replaces an existing billing header from the client", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: LEGITIMATE_CLIENT_VALUE",
          },
          {
            type: "text",
            text: "You are Claude Code.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    });
    const sys = captured.system as Array<{ type: string; text: string }>;
    // Client billing block stripped (replaced, not duplicated); identity
    // inserted at [1]; the non-identity "You are Claude Code." block preserved.
    assert.equal(sys.length, 3);
    assert.ok(
      sys[0].text.startsWith("x-anthropic-billing-header:"),
      "first block must be billing header",
    );
    // The client's value must have been replaced.
    assert.ok(
      !sys[0].text.includes("LEGITIMATE_CLIENT_VALUE"),
      `client billing value must be replaced, got: ${sys[0].text}`,
    );
    // Exactly one billing block survives.
    assert.equal(
      sys.filter((s) => s.text.startsWith("x-anthropic-billing-header:"))
        .length,
      1,
    );
    assert.equal(
      sys[1].text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    assert.equal(sys[2].text, "You are Claude Code.");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages converts string system to array with billing header", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        system: "You are Claude Code.",
      },
    });
    const sys = captured.system as Array<{ type: string; text: string }>;
    assert.ok(Array.isArray(sys));
    assert.equal(sys.length, 3);
    assert.ok(sys[0].text.startsWith("x-anthropic-billing-header:"));
    assert.equal(
      sys[1].text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    assert.equal(sys[2].text, "You are Claude Code.");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: billing header is not injected for non-messages endpoints", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(captured.system, undefined, "system must not be added");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages billing header matches v0.6.0 spec for 'hey'", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hey" }],
      },
    });
    const sys = captured.system as Array<{ type: string; text: string }>;
    assert.ok(Array.isArray(sys));
    const billing = sys[0].text;
    // "hey" (length 3) samples "000"; suffix = sha256("59cf53e54c780002.1.196")[:3].
    const expectedSuffix = createHash("sha256")
      .update("59cf53e54c780002.1.196", "utf8")
      .digest("hex")
      .slice(0, 3);
    assert.ok(
      billing.includes(`cc_version=2.1.196.${expectedSuffix};`),
      `cc_version mismatch: ${billing}`,
    );
    assert.ok(billing.includes("cc_entrypoint=cli;"));
    assert.match(billing, /cch=[0-9a-f]{5};/);
    // Billing block must not carry cache_control.
    assert.equal(
      (sys[0] as { cache_control?: unknown }).cache_control,
      undefined,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages sets x-anthropic-billing-header and ?beta=true upstream", async () => {
  let billingHeader: string | undefined;
  let hitPath: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      billingHeader = req.headers["x-anthropic-billing-header"] as
        string | undefined;
      hitPath = req.url;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.ok(billingHeader, "x-anthropic-billing-header must be set upstream");
    assert.match(
      billingHeader!,
      /^cc_version=2\.1\.196\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
    assert.ok(
      hitPath?.includes("/v1/messages?beta=true"),
      `upstream path must include ?beta=true, got: ${hitPath}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: x-anthropic-billing-header is not sent for non-messages endpoints", async () => {
  let billingHeader: string | undefined;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      billingHeader = req.headers["x-anthropic-billing-header"] as
        string | undefined;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(
      billingHeader,
      undefined,
      "billing header must not leak to non-messages endpoints",
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages forwards the CC decoy tools upstream when none are supplied", async () => {
  // Decoys default ON: the full CC native tool set is always advertised, even
  // when the client supplies no tools[]. No env override needed.
  const prevDecoys = process.env["PROXY_CC_DECOY_TOOLS"];
  delete process.env["PROXY_CC_DECOY_TOOLS"];
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const tools = captured.tools as Array<{
      name: string;
      description: string;
    }>;
    assert.ok(Array.isArray(tools), "tools[] must be injected upstream");
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.ok(byName.has("Bash"), "Bash decoy missing");
    assert.ok(byName.has("Read"), "Read decoy missing");
    assert.ok(byName.has("Agent"), "Agent decoy missing");
    // CC names are filled with generic "unavailable" stubs.
    assert.equal(
      byName.get("Bash")!.description,
      "This tool is currently unavailable.",
    );
    assert.equal(
      byName.get("WebSearch")!.description,
      "This tool is currently unavailable.",
    );
  } finally {
    if (prevDecoys === undefined) delete process.env["PROXY_CC_DECOY_TOOLS"];
    else process.env["PROXY_CC_DECOY_TOOLS"] = prevDecoys;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages logs the upstream tool set and tool_choice", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => void logs.push(args.join(" "));
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "webfetch",
            description: "d",
            input_schema: { type: "object" },
          },
          {
            name: "websearch",
            description: "d",
            input_schema: { type: "object" },
          },
          {
            type: "web_search_20250305",
            name: "web_search",
          } as any,
        ],
        tool_choice: { type: "tool", name: "websearch" },
      },
    });
    const line = logs.find((l) => l.includes("upstream-tools"));
    assert.ok(
      line,
      `expected an upstream-tools log line, got: ${logs.join(" | ")}`,
    );
    // Renamed user tools appear bare; server tool appears with its type tag.
    assert.ok(line!.includes("WebFetch"), line);
    assert.ok(line!.includes("WebSearch"), line);
    assert.ok(line!.includes("web_search:web_search_20250305"), line);
    // tool_choice reflects the renamed name.
    assert.ok(line!.includes("tool:WebSearch"), line);
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages maps tool_use names in JSON responses back to client names", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      // Upstream sees the renamed tool; respond with a tool_use using it.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "GetUser",
              input: { q: 1 },
            },
          ],
          stop_reason: "tool_use",
        }),
      );
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "get_user",
            description: "d",
            input_schema: { type: "object" },
          },
        ],
      },
    });
    // Upstream received the renamed tool name.
    const upTools = captured.tools as Array<{ name: string }>;
    assert.ok(upTools.some((t) => t.name === "GetUser"));
    // Client receives the ORIGINAL tool name in the tool_use.
    const resp = JSON.parse(out.body);
    const tu = resp.content.find((b: any) => b.type === "tool_use");
    assert.equal(tu.name, "get_user", `got: ${out.body}`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages maps tool_use names in SSE streams back to client names", async () => {
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"stop_reason":null}}\n\n',
      );
      res.write(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"GetUser","input":{}}}\n\n',
      );
      res.write(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}\n\n',
      );
      res.write(
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      );
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        tools: [
          {
            name: "get_user",
            description: "d",
            input_schema: { type: "object" },
          },
        ],
      },
    });
    assert.ok(
      out.body.includes('"name":"get_user"'),
      `expected remapped name in stream: ${out.body}`,
    );
    assert.ok(
      !out.body.includes('"name":"GetUser"'),
      `upstream name leaked into stream: ${out.body}`,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: /v1/messages billing header recomputes per-request", async () => {
  const captured: string[] = [];
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const sys = parsed.system as Array<{ text: string }>;
      captured.push(sys?.[0]?.text ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hey" }],
      },
    });
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "world" }],
      },
    });
    assert.equal(captured.length, 2);
    assert.notEqual(
      captured[0],
      captured[1],
      "different messages must produce different billing headers",
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: prefill fix is applied to /v1/messages when last message is assistant", async () => {
  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hi back" },
        ],
      },
    });
    assert.equal(captured.messages.length, 3);
    assert.deepEqual(captured.messages[2], {
      role: "user",
      content: "continue",
    });
    const userId = captured.metadata.user_id;
    assert.equal(typeof userId, "string");
    const inner = JSON.parse(userId);
    assert.match(
      inner.session_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: retries a retryable status then succeeds", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temp" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hits }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.equal(hits, 3);
    assert.deepEqual(JSON.parse(out.body), { ok: true, hits: 3 });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: retries a connection refusal then succeeds when upstream comes up", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      if (hits === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.ok(hits >= 2, `expected at least 2 upstream hits, got ${hits}`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: gives up after retryAttempts and returns 502", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate limited" }));
      },
    },
    { retryAttempts: 3, retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 502);
    assert.equal(hits, 3);
    const parsed = JSON.parse(out.body);
    assert.equal(parsed.error.type, "upstream_unavailable");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 2xx with SSE error body is retried and ultimately succeeds", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        if (hits < 2) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            'data: {"error":{"message":"overloaded","type":"overloaded_error"}}\n\n',
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"id":"evt_1","choices":[]}\n\ndata: [DONE]\n');
      },
    },
    { retryAttempts: 3, retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.equal(hits, 2);
    assert.ok(out.body.includes("[DONE]"));
    assert.ok(!out.body.includes("overloaded"));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 2xx with SSE error body is retried up to retryAttempts then returns 502", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        hits++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"error":{"message":"overloaded","type":"overloaded_error"}}\n\n',
        );
      },
    },
    { retryAttempts: 3, retryIntervalMs: 5 },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 502);
    assert.equal(hits, 3);
    const parsed = JSON.parse(out.body);
    assert.equal(parsed.error.type, "upstream_unavailable");
    assert.ok(parsed.error.message.includes("stream error: overloaded"));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: 2xx with non-error JSON body is forwarded unchanged", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hits }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 200);
    assert.equal(hits, 1);
    assert.deepEqual(JSON.parse(out.body), { ok: true, hits: 1 });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: non-retryable status (400) is returned immediately, not retried", async () => {
  let hits = 0;
  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      hits++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(out.status, 400);
    assert.equal(hits, 1, "400 must not be retried");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: non-2xx response is logged with bodies and headers, then forwarded", async () => {
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...args: any[]) => errs.push(args.join(" "));

  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unprocessable" } }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    const out = await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "trigger-error" }],
      },
    });

    // Response is still forwarded unchanged to the client.
    assert.equal(out.status, 422);
    assert.deepEqual(JSON.parse(out.body), {
      error: { message: "unprocessable" },
    });

    const log = errs.find((l) => l.includes("upstream FAILURE"));
    assert.ok(log, `expected failure log, got: ${errs.join("\n")}`);
    assert.ok(log.includes("status: 422"), log);
    assert.ok(log.includes("POST /v1/chat/completions"), log);
    assert.ok(log.includes("client request headers:"), log);
    assert.ok(log.includes("upstream request headers:"), log);
    assert.ok(log.includes("response headers:"), log);
    assert.ok(log.includes("trigger-error"), log); // request body
    assert.ok(log.includes("unprocessable"), log); // response body
  } finally {
    console.error = origErr;
    await close(proxy);
    await close(upstream);
  }
});

test("resolveConfig reads config.json values", () => {
  const cfg = resolveConfig();
  assert.equal(cfg.retryAttempts, 10);
  assert.equal(cfg.retryIntervalMs, 3000);
  assert.ok(cfg.upstreamBaseUrl.length > 0);
});

test("resolveConfig opts override config.json", () => {
  const cfg = resolveConfig({ retryAttempts: 2, retryIntervalMs: 50 });
  assert.equal(cfg.retryAttempts, 2);
  assert.equal(cfg.retryIntervalMs, 50);
});

test("default upstreamHeaders are populated with dynamic versions", () => {
  const cfg = resolveConfig({ _skipFile: true });
  assert.match(
    cfg.upstreamHeaders["user-agent"],
    /^claude-cli\/\d+\.\d+\.\d+ /,
  );
  assert.match(
    cfg.upstreamHeaders["x-stainless-package-version"],
    /^\d+\.\d+\.\d+$/,
  );
  assert.match(
    cfg.upstreamHeaders["x-stainless-runtime-version"],
    /^v\d+\.\d+\.\d+$/,
  );
  assert.equal(cfg.upstreamHeaders["x-stainless-runtime"], "node");
  assert.ok(cfg.upstreamHeaders["x-stainless-arch"].length > 0);
  assert.ok(cfg.upstreamHeaders["x-stainless-os"].length > 0);
  assert.equal(
    cfg.upstreamHeaders["anthropic-dangerous-direct-browser-access"],
    "true",
  );
  assert.ok(
    cfg.upstreamHeaders["anthropic-beta"].includes("claude-code-20250219"),
  );
});

test("upstreamHeaders from opts override defaults", () => {
  const cfg = resolveConfig({
    _skipFile: true,
    upstreamHeaders: { "x-app": "custom", "x-stainless-os": "Linux" },
  });
  assert.equal(cfg.upstreamHeaders["x-app"], "custom");
  assert.equal(cfg.upstreamHeaders["x-stainless-os"], "Linux");
  assert.match(
    cfg.upstreamHeaders["user-agent"],
    /^claude-cli\/\d+\.\d+\.\d+ /,
  );
});

test("extractThinkingProps captures model and known thinking keys", () => {
  const props = extractThinkingProps({
    model: "claude-sonnet-4-6",
    messages: [],
    thinking_budget: 16000,
    reasoning_effort: "high",
  });
  assert.deepEqual(props, {
    model: "claude-sonnet-4-6",
    thinking_budget: 16000,
    reasoning_effort: "high",
  });
});

test("extractThinkingProps returns empty for null/empty bodies", () => {
  assert.deepEqual(extractThinkingProps(null), {});
  assert.deepEqual(extractThinkingProps({}), {});
  assert.deepEqual(extractThinkingProps(undefined), {});
});

test("formatThinkingLog serializes props into key=value pairs", () => {
  const line = formatThinkingLog({
    model: "gpt-4o",
    thinking: true,
  });
  assert.ok(line.includes("model=gpt-4o"));
  assert.ok(line.includes("thinking=true"));
});

test("formatThinkingLog serializes objects as JSON", () => {
  const line = formatThinkingLog({
    model: "x",
    thinking: { type: "enabled", budget_tokens: 2000 },
  });
  assert.ok(line.includes('thinking={"type":"enabled","budget_tokens":2000}'));
});

test("isStreamError detects a JSON object error body", () => {
  const reason = isStreamError(
    JSON.stringify({
      error: { message: "overloaded", type: "overloaded_error" },
    }),
  );
  assert.equal(reason, "overloaded");
});

test("isStreamError detects a top-level error string", () => {
  const reason = isStreamError(JSON.stringify({ error: "rate limited" }));
  assert.equal(reason, "rate limited");
});

test("isStreamError detects a type=error... body", () => {
  const reason = isStreamError(
    JSON.stringify({ type: "error", message: "internal error" }),
  );
  assert.equal(reason, "internal error");
});

test("isStreamError detects an SSE data: line carrying an error", () => {
  const sse =
    'data: {"id":"evt_1"}\n\n' +
    'data: {"error":{"message":"stream interrupted","type":"server_error"}}\n\n' +
    "data: [DONE]\n";
  const reason = isStreamError(sse);
  assert.equal(reason, "stream interrupted");
});

test("isStreamError returns null for a clean SSE stream", () => {
  const sse = 'data: {"id":"evt_1","choices":[]}\n\n' + "data: [DONE]\n";
  assert.equal(isStreamError(sse), null);
});

test("isStreamError returns null for empty or non-error body", () => {
  assert.equal(isStreamError(""), null);
  assert.equal(isStreamError("   "), null);
  assert.equal(isStreamError(JSON.stringify({ ok: true })), null);
  assert.equal(isStreamError('data: {"id":"evt_1"}\n\n'), null);
});

test("isStreamError skips malformed SSE data lines without throwing", () => {
  const sse = "data: not-json\n\n" + 'data: {"error":"boom"}\n\n';
  assert.equal(isStreamError(sse), "boom");
});

test("e2e: logs model and thinking properties to stdout", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));

  let captured: any;
  const { proxy, upstream } = await boot({
    upstreamHandler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        thinking_budget: 16000,
      },
    });

    assert.equal(captured.model, "claude-sonnet-4-6");
    const logLine = logs.find((l) =>
      l.includes("[vsllm-proxy] POST /v1/chat/completions"),
    );
    assert.ok(logLine, `expected log line, got: ${logs.join("\n")}`);
    assert.ok(logLine.includes("model=claude-sonnet-4-6"), logLine);
    assert.ok(logLine.includes("thinking_budget=16000"), logLine);
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: logs non-JSON body correctly", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));

  const { proxy, upstream } = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: "not json",
    });

    const logLine = logs.find((l) =>
      l.includes("[vsllm-proxy] POST /v1/chat/completions"),
    );
    assert.ok(logLine, `expected log line, got: ${logs.join("\n")}`);
    assert.ok(logLine.includes("body=non-JSON|empty"), logLine);
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});

test("e2e: logging disabled when enableRequestLogging is false", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));

  const { proxy, upstream } = await boot(
    {
      upstreamHandler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
    { enableRequestLogging: false },
  );

  try {
    const port = (proxy.address() as { port: number }).port;
    await proxyRequest(port, {
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });

    const logLine = logs.find((l) =>
      l.includes("[vsllm-proxy] POST /v1/chat/completions"),
    );
    assert.equal(logLine, undefined, "logging should be silent when disabled");
  } finally {
    console.log = origLog;
    await close(proxy);
    await close(upstream);
  }
});
