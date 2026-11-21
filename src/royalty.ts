// The royalty arithmetic behind COMMERCIAL_TERMS.md. Kept as pure BigInt math on strings so a
// partner can recompute the exact invoice from public chain data, with no float rounding and no
// shared state: same totals in, same due out, in any language that has integers.

export const ROYALTY_BPS = 1_000;

const BPS_DENOMINATOR = 10_000n;

// `received` is what actually landed on the partner's own referral accounts, so Jupiter's 2,000 bps
// share is already excluded from the base and is never paid on twice.
export function royaltyDue(received: Record<string, string>, royaltyBps = ROYALTY_BPS): Record<string, string> {
  if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > 10_000) {
    throw new Error("Invalid royalty input.");
  }

  const due: Record<string, string> = {};
  for (const [mint, amount] of Object.entries(received)) {
    const value = BigInt(amount);
    if (value < 0n) {
      throw new Error("Invalid royalty input.");
    }
    due[mint] = ((value * BigInt(royaltyBps)) / BPS_DENOMINATOR).toString();
  }
  return due;
}
