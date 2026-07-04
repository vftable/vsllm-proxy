import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { execSync } from "node:child_process";
import type { ProxyConfig, CreateProxyOpts } from "./types.js";

const CLAUDE_CODE_BETA_FLAGS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  // "redact-thinking-2026-02-12",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
];

function detectClaudeCodeVersion(): string {
  try {
    const out = execSync("claude --version 2>&1", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const m = out.match(/\d+\.\d+\.\d+/);
    if (m) return m[0];
  } catch {}
  return "2.1.185";
}

function detectNodeVersion(): string {
  return `v${process.versions.node}`;
}

function detectPlatform(): { arch: string; os: string } {
  const arch =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch;
  const platform =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "MacOS"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;
  return { arch, os: platform };
}

function buildDefaultUpstreamHeaders(): Record<string, string> {
  const ccVersion = detectClaudeCodeVersion();
  const nodeVersion = detectNodeVersion();
  const { arch, os } = detectPlatform();
  return {
    "user-agent": `claude-cli/${ccVersion} (external, cli)`,
    "x-app": "cli",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": nodeVersion,
    "x-stainless-package-version": ccVersion,
    "x-stainless-timeout": "600",
    "x-stainless-lang": "js",
    "x-stainless-arch": arch,
    "x-stainless-os": os,
    "x-stainless-retry-count": "0",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CODE_BETA_FLAGS.join(","),
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

const DEFAULTS: ProxyConfig = {
  port: null,
  upstreamBaseUrl: "https://api.openai.com",
  upstreamApiKey: "",
  upstreamHost: "",
  upstreamHeaders: buildDefaultUpstreamHeaders(),
  requestTimeoutMs: 600_000,
  retryAttempts: 10,
  retryIntervalMs: 3000,
  enableRequestLogging: true,
};

export function loadConfigFile(): Record<string, unknown> {
  const file = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.join(__dirname, "..", "config.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    return (JSON.parse(raw) as Record<string, unknown>) || {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[vsllm-proxy] could not parse ${file}: ${(err as Error).message}`,
      );
    }
    return {};
  }
}

export function resolveConfig(opts: CreateProxyOpts = {}): ProxyConfig {
  const file = opts._skipFile ? {} : loadConfigFile();
  const pick = (key: keyof ProxyConfig, dflt: unknown) =>
    opts[key] ?? file[key] ?? dflt;

  const upstreamBase = String(
    pick("upstreamBaseUrl", DEFAULTS.upstreamBaseUrl),
  ).replace(/\/+$/, "");
  return {
    port: parseInt(String(pick("port", 0)), 10) || null,
    upstreamBaseUrl: upstreamBase,
    upstreamApiKey: pick("upstreamApiKey", DEFAULTS.upstreamApiKey) as
      | string
      | string[],
    upstreamHost: String(
      pick("upstreamHost", "") || new URL(upstreamBase).host,
    ),
    requestTimeoutMs: parseInt(
      String(pick("requestTimeoutMs", DEFAULTS.requestTimeoutMs)),
      10,
    ),
    retryAttempts: parseInt(
      String(pick("retryAttempts", DEFAULTS.retryAttempts)),
      10,
    ),
    retryIntervalMs: parseInt(
      String(pick("retryIntervalMs", DEFAULTS.retryIntervalMs)),
      10,
    ),
    enableRequestLogging: !!pick(
      "enableRequestLogging",
      DEFAULTS.enableRequestLogging,
    ),
    upstreamHeaders: {
      ...DEFAULTS.upstreamHeaders,
      ...((pick("upstreamHeaders", {}) as Record<string, string>) || {}),
    },
  };
}

export function resolvePort(config: ProxyConfig): number {
  const fromEnv = parseInt(process.env.PORT ?? "", 10);
  if (Number.isFinite(fromEnv)) return fromEnv;
  const fromCfg = parseInt(String(config.port), 10);
  return Number.isFinite(fromCfg) ? fromCfg : 8787;
}
