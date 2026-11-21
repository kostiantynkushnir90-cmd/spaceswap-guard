import type { TokenAccountAudit } from "./presign";

export type GuardIssue = {
  level: "block" | "warn";
  code: string;
  message: string;
};

export type SwapRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
};

export type PlatformFee = {
  amount?: string;
  feeBps?: number;
  feeMint?: string;
};

export type QuoteResponse = SwapRequest & {
  inAmount: string;
  outAmount: string;
  feeBps: number;
  feeMint: string;
  platformFee?: PlatformFee;
  router: string;
  requestId: string;
  fetchedAt: number;
  lastValidBlockHeight?: number;
  expireAt?: number;
  // Every mint the route touches (input, output and intermediate hops). The pre-sign guard whitelists
  // the user's ATA for each of these so a legitimate multi-hop swap is not mistaken for a drain.
  routeMints?: string[];
  transaction: null;
};

export type OrderResponse = Omit<QuoteResponse, "transaction"> & {
  // VersionedTransaction serialized to base64, exactly as returned by Jupiter's swap API.
  transaction: string;
  transactionVersion?: 0 | 1;
  mode?: string;
  referralAccount?: string;
};

export type TokenAccountStatus =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "present"; audit: TokenAccountAudit };

// Result of the second-line simulation, run on the prepared bytes BEFORE the wallet signs. When the
// simulation could not run, the pre-sign panel says so and the confirm button becomes an explicit
// "sign and send without the second check" — the wallet signature is then the user's consent.
export type PostStateVerdict = {
  status: "verified" | "unavailable";
  issues: GuardIssue[];
};

// Post-state bytes per address, an execution failure of the simulation itself, or null when no
// verdict could be obtained. The three outcomes carry different user-facing consequences.
export type SimulatedPostState = Record<string, Uint8Array | null> | { executionError: string } | null;

import type { MinOutAudit } from "./presign";

// The three facts shown to the user before the wallet is asked to sign: the minimum output encoded
// in the route instruction, the accounts the transaction may write to, and any delegate authority
// that survives settlement on the user's token accounts.
export type PreSignAudit = {
  minOut: MinOutAudit;
  writableAccounts: string[];
  writableOwners: Record<string, string | null>;
  accountsReadable: boolean;
  inputAccount: TokenAccountStatus;
  outputAccount: TokenAccountStatus;
  warnings: GuardIssue[];
  postState?: PostStateVerdict;
  // Issuer custody powers (permanent delegate / transfer hook) on a route mint: the swap is allowed
  // only after the user ticks the explicit consent checkbox in the confirm panel.
  issuerConsentRequired: boolean;
};
