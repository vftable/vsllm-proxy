import test from "node:test";
import assert from "node:assert";
import { xxHash64, xxHash64Hex } from "../src/xxhash64.js";
// hash-wasm is the exact library the anthropic-billing-header plugin uses to
// compute cch. It is a devDependency here ONLY to cross-validate that the
// pure-TS implementation produces byte-identical digests.
import { createXXHash64 } from "hash-wasm";

// The plugin calls createXXHash64(seedLow, seedHigh); mirror that exactly. The
// cast bypasses the library's single-arg TS signature so the call matches the
// plugin's runtime behavior verbatim.
const createXXHash64Any = createXXHash64 as unknown as (
  seedLow?: number,
  seedHigh?: number,
) => Promise<{
  init: () => unknown;
  update: (data: Buffer | Uint8Array) => unknown;
  digest: (outputType: "hex" | "binary") => string | Uint8Array;
}>;

async function hashWasmHex(
  data: Uint8Array,
  seedHigh: number,
  seedLow: number,
): Promise<string> {
  const hasher = await createXXHash64Any(seedLow, seedHigh);
  hasher.init();
  hasher.update(Buffer.from(data));
  return hasher.digest("hex") as string;
}

// Deterministic pseudo-byte generator (no Math.random, for reproducibility).
function detBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

function utf8(s: string): Uint8Array {
  return Buffer.from(s, "utf8");
}

const SEEDS: Array<{ name: string; high: number; low: number }> = [
  { name: "seed=0", high: 0, low: 0 },
  // The real Claude Code seed (v2.1.138+). high != 0, so this case catches any
  // seed-combination divergence between the pure-TS impl and hash-wasm.
  { name: "cc-current", high: 0x4d659218, low: 0xe32a3268 },
];

const INPUTS: Array<{ name: string; data: Uint8Array }> = [
  { name: "empty", data: utf8("") },
  { name: "1 byte", data: utf8("a") },
  { name: "3 bytes", data: utf8("abc") },
  { name: "31 bytes (under one stripe)", data: detBytes(31) },
  { name: "32 bytes (one stripe)", data: detBytes(32) },
  { name: "33 bytes", data: detBytes(33) },
  { name: "64 bytes (two stripes)", data: detBytes(64) },
  { name: "100 bytes (stripe + 8+4+1 tails)", data: detBytes(100) },
  { name: "300 bytes (many stripes)", data: detBytes(300) },
  {
    name: "real-ish body preimage",
    data: utf8(
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: ' +
        'cc_version=2.1.196.abc; cc_entrypoint=cli; cch=00000;"},' +
        '{"type":"text","text":"You are Claude Code, Anthropic\\u0027s official CLI for Claude."}],' +
        '"messages":[{"role":"user","content":"Hello world"}],"model":"","max_tokens":1024}',
    ),
  },
];

test("xxHash64 of empty input at seed 0 matches the canonical vector", () => {
  // The single most widely-cited xxHash64 reference value.
  assert.equal(xxHash64Hex(new Uint8Array(0), 0, 0), "ef46db3751d8e999");
  assert.equal(
    xxHash64(new Uint8Array(0), 0, 0).toString(16),
    "ef46db3751d8e999",
  );
});

for (const seed of SEEDS) {
  for (const input of INPUTS) {
    test(`xxHash64 matches hash-wasm [${seed.name}] [${input.name}]`, async () => {
      const mine = xxHash64Hex(input.data, seed.high, seed.low);
      const theirs = await hashWasmHex(input.data, seed.high, seed.low);
      assert.equal(
        mine,
        theirs,
        `divergence for ${seed.name} / ${input.name}: pure-ts=${mine} hash-wasm=${theirs}`,
      );
    });
  }
}

test("xxHash64 masked cch is the lower 20 bits as 5 hex chars", () => {
  // The cch token is (full & 0xFFFFF) formatted as 5 lowercase hex chars.
  const data = utf8("Hello world from a billing attestation test");
  const full = xxHash64(data, 0x4d659218, 0xe32a3268);
  const masked = full & 0xfffffn;
  const cch = masked.toString(16).padStart(5, "0");
  assert.equal(cch.length, 5);
  assert.match(cch, /^[0-9a-f]{5}$/);
  assert.equal(masked <= 0xfffffn, true);
});
