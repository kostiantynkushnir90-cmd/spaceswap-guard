// Limits enforced by the guard. These values mirror the deployed SpaceSwap backend;
// RULES.md explains where each one is applied.
export const MAX_SLIPPAGE_BPS = 500;
export const HIGH_SLIPPAGE_WARNING_BPS = 100;
export const QUOTE_MAX_AGE_MS = 20_000;
// A blockhash stays valid for 150 blocks; a gap larger than that between Jupiter's
// lastValidBlockHeight and our reading means the two counters are not on the same scale.
export const BLOCKHASH_LIFETIME_BLOCKS = 150;
export const BLOCK_EXPIRY_SAFETY_MARGIN = 5;
