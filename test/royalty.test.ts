// The royalty is a claim we make against a partner, so the arithmetic that produces the invoice is
// published and tested here rather than hidden in a billing backend: 10% of what actually landed on
// the partner's own referral accounts, per mint, rounded down, in the token it was received in.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ROYALTY_BPS, royaltyDue } from "../src/royalty";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

describe("royaltyDue", () => {
  test("is one tenth of the landed commission by default", () => {
    assert.equal(ROYALTY_BPS, 1_000);
    assert.deepEqual(royaltyDue({ [USDC]: "600" }), { [USDC]: "60" });
  });

  test("rounds each mint down, so the sum never exceeds what is owed", () => {
    assert.deepEqual(royaltyDue({ [USDC]: "999", [SOL]: "1" }), { [USDC]: "99", [SOL]: "0" });
  });

  test("honours a negotiated rate", () => {
    assert.deepEqual(royaltyDue({ [USDC]: "600" }, 2_000), { [USDC]: "120" });
    assert.deepEqual(royaltyDue({ [USDC]: "600" }, 0), { [USDC]: "0" });
    assert.deepEqual(royaltyDue({ [USDC]: "600" }, 10_000), { [USDC]: "600" });
  });

  test("owes nothing on an account that earned nothing", () => {
    assert.deepEqual(royaltyDue({}), {});
    assert.deepEqual(royaltyDue({ [USDC]: "0" }), { [USDC]: "0" });
  });

  test("stays exact far above the token unit", () => {
    assert.deepEqual(royaltyDue({ [USDC]: "123456789012345" }), { [USDC]: "12345678901234" });
  });

  test("refuses a rate outside bps, and a negative landing", () => {
    assert.throws(() => royaltyDue({ [USDC]: "600" }, -1), /Invalid royalty input\./);
    assert.throws(() => royaltyDue({ [USDC]: "600" }, 10_001), /Invalid royalty input\./);
    assert.throws(() => royaltyDue({ [USDC]: "600" }, 1.5), /Invalid royalty input\./);
    assert.throws(() => royaltyDue({ [USDC]: "-1" }), /Invalid royalty input\./);
  });
});
