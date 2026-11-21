import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { AMOUNT, OUT_AMOUNT, SLIPPAGE_BPS, makeActors } from "./fixtures";
import { assertOrderSignable, evaluateQuoteFreshness, evaluateQuoteWarnings, validateSwapRequest } from "../src/rules";
import type { OrderResponse } from "../src/types";

const actors = makeActors();
const baseRequest = {
  inputMint: actors.mintIn.toBase58(),
  outputMint: actors.mintOut.toBase58(),
  amount: AMOUNT.toString(),
  slippageBps: SLIPPAGE_BPS,
};

describe("validateSwapRequest", () => {
  test("accepts a well-formed request", () => {
    assert.deepEqual(validateSwapRequest(baseRequest), []);
  });

  test("blocks malformed mints", () => {
    const issues = validateSwapRequest({ ...baseRequest, inputMint: "0OIl" });
    assert.deepEqual(issues.map((i) => i.code), ["INVALID_MINT"]);
    assert.equal(issues[0].level, "block");
  });

  test("blocks swapping a token for itself", () => {
    const issues = validateSwapRequest({ ...baseRequest, outputMint: baseRequest.inputMint });
    assert.deepEqual(issues.map((i) => i.code), ["SAME_TOKEN"]);
  });

  test("blocks non-positive or fractional amounts", () => {
    for (const amount of ["0", "-5", "1.5", ""]) {
      const issues = validateSwapRequest({ ...baseRequest, amount });
      assert.ok(issues.some((i) => i.code === "INVALID_AMOUNT" && i.level === "block"), `amount ${JSON.stringify(amount)}`);
    }
  });

  test("blocks slippage outside 1..500 bps", () => {
    for (const slippageBps of [0, 501, 1.5, NaN]) {
      const issues = validateSwapRequest({ ...baseRequest, slippageBps });
      assert.ok(issues.some((i) => i.code === "INVALID_SLIPPAGE" && i.level === "block"), `slippage ${slippageBps}`);
    }
    assert.deepEqual(validateSwapRequest({ ...baseRequest, slippageBps: 500 }), []);
  });
});

describe("evaluateQuoteFreshness", () => {
  const nowMs = 1_000_000_000_000;

  test("blocks a quote older than the freshness window", () => {
    const issues = evaluateQuoteFreshness({ fetchedAt: nowMs - 60_000 }, { nowMs });
    assert.deepEqual(issues.map((i) => i.code), ["QUOTE_STALE"]);
  });

  test("blocks an expired RFQ offer", () => {
    const issues = evaluateQuoteFreshness({ fetchedAt: nowMs - 1000, expireAt: nowMs - 1 }, { nowMs });
    assert.ok(issues.some((i) => i.code === "RFQ_EXPIRED" && i.level === "block"));
  });

  test("warns (not blocks) when the RPC block height is on a different scale", () => {
    const issues = evaluateQuoteFreshness(
      { fetchedAt: nowMs - 1000, lastValidBlockHeight: 1_000 },
      { nowMs, currentBlockHeight: 5_000_000 },
    );
    assert.deepEqual(issues.map((i) => i.code), ["BLOCK_HEIGHT_MISMATCH"]);
    assert.equal(issues[0].level, "warn");
  });

  test("blocks when the blockhash expires within the safety margin", () => {
    const issues = evaluateQuoteFreshness(
      { fetchedAt: nowMs - 1000, lastValidBlockHeight: 105 },
      { nowMs, currentBlockHeight: 102 },
    );
    assert.deepEqual(issues.map((i) => i.code), ["BLOCKHASH_EXPIRING"]);
    assert.equal(issues[0].level, "block");
  });
});

describe("evaluateQuoteWarnings", () => {
  test("warns on high slippage and unknown routers, without blocking", () => {
    const issues = evaluateQuoteWarnings({ slippageBps: 300, router: "some-new-router" });
    assert.deepEqual(issues.map((i) => i.code).sort(), ["HIGH_SLIPPAGE", "UNKNOWN_ROUTER"]);
    assert.ok(issues.every((i) => i.level === "warn"));
  });

  test("keeps the curated router allowlist quiet", () => {
    assert.deepEqual(evaluateQuoteWarnings({ slippageBps: 50, router: "Metis" }), []);
    assert.deepEqual(evaluateQuoteWarnings({ slippageBps: 50, router: "jupiterz" }), []);
  });
});

describe("assertOrderSignable", () => {
  const context = { nowMs: Date.now(), feeConfigured: true };
  const order = {
    ...baseRequest,
    inAmount: AMOUNT.toString(),
    outAmount: OUT_AMOUNT.toString(),
    feeBps: 50,
    feeMint: baseRequest.inputMint,
    router: "metis",
    requestId: "r",
    fetchedAt: Date.now(),
  } satisfies Omit<OrderResponse, "transaction">;

  test("blocks an order without a transaction", () => {
    const issues = assertOrderSignable({ ...order, transaction: "" }, context);
    assert.ok(issues.some((i) => i.code === "EMPTY_TRANSACTION" && i.level === "block"));
  });

  test("blocks unsupported transaction versions", () => {
    const issues = assertOrderSignable({ ...order, transaction: "AA==", transactionVersion: 1 }, context);
    assert.ok(issues.some((i) => i.code === "UNSUPPORTED_TX_VERSION" && i.level === "block"));
  });

  test("blocks when the platform fee is not configured, instead of silently swapping fee-free", () => {
    const issues = assertOrderSignable({ ...order, transaction: "AA==" }, { ...context, feeConfigured: false });
    assert.ok(issues.some((i) => i.code === "FEE_SETUP_REQUIRED" && i.level === "block"));
  });
});
