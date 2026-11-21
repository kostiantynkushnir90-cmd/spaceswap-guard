// Base58 mint format check only — the same validation the deployed guard performs.
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidMintFormat(mint: string): boolean {
  return MINT_RE.test(mint);
}
