import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import {
  associatedTokenAddress,
  parseTokenAccount,
  postStateAuthorityIssues,
  type PostStateAccount,
} from "./presign";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./transaction";
import type { GuardIssue, SimulatedPostState } from "./types";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export type PostStateDeps = {
  // Current on-chain state of the user's token accounts, read as close to signing as possible.
  getAccountInfo: (addresses: string[]) => Promise<Record<string, { owner: string; data: Uint8Array } | null>>;
  // Post-state account data per address from simulating the prepared bytes. null means no verdict
  // could be obtained (RPC error / rate-limit / missing data): the caller discloses that before the
  // wallet signs, so the signature itself carries the user's consent to send without the second check.
  // An executionError means the simulation ran and the transaction failed on-chain logic — the caller
  // blocks instead, because consenting cannot make a failing swap succeed.
  simulatePostState: (
    transaction: VersionedTransaction,
    addresses: string[],
  ) => Promise<SimulatedPostState>;
};

function unavailableWarning(): GuardIssue {
  return {
    level: "warn",
    code: "POST_STATE_UNAVAILABLE",
    message:
      "The second check for delegate, owner and close-authority changes on token accounts did not complete: the RPC did not answer the simulation or data is missing. " +
      "Review the results of the other checks. Signing in the wallet means your consent to send the swap without the second check; cancelling costs nothing.",
  };
}

// The shared parser reads the authority fields, but treats unknown COption tags as unset. Reject
// malformed base layouts here rather than letting corrupt data masquerade as a clean account.
function parseAuthorityAccount(data: Uint8Array) {
  if (!(data instanceof Uint8Array) || data.length < 165) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if ([72, 109, 129].some((offset) => view.getUint32(offset, true) > 1)) return null;
  if (data[108] !== 1 && data[108] !== 2) return null;
  return parseTokenAccount(data);
}

// Simulation cannot rule out state changes between this check and execution.
export async function auditPostStateAuthorities(
  params: { transaction: VersionedTransaction; publicKey: PublicKey; inputMint: string; outputMint: string; routeMints?: string[] },
  deps: PostStateDeps,
): Promise<GuardIssue[]> {
  const { transaction, publicKey, inputMint, outputMint, routeMints } = params;
  // Cover the complete route in one simulation. Never silently verify only the first part of it.
  const mints = [...new Set([inputMint, outputMint, WSOL_MINT.toBase58(), ...(routeMints ?? [])])];
  const expectedAccounts = new Map<string, { mint: string; program: string }>();
  for (const mint of mints) {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const address = associatedTokenAddress(new PublicKey(mint), publicKey, program).toBase58();
      expectedAccounts.set(address, { mint, program: program.toBase58() });
    }
  }
  const addresses = [...expectedAccounts.keys()];
  if (addresses.length > 64) return [unavailableWarning()];

  let preInfos: Record<string, { owner: string; data: Uint8Array } | null>;
  try {
    preInfos = await deps.getAccountInfo(addresses);
  } catch {
    return [unavailableWarning()];
  }

  let postState: SimulatedPostState;
  try {
    postState = await deps.simulatePostState(transaction, addresses);
  } catch {
    postState = null;
  }
  if (postState && "executionError" in postState) {
    return [
      {
        level: "block",
        code: "SIMULATION_EXECUTION_FAILED",
        message:
          "Simulating the prepared transaction ended in an execution error, so on-chain this swap would most likely fail too. " +
          "Most often the price moved beyond your slippage, or the wallet lacks funds for the amount and fees. " +
          "Raise the slippage, refresh the quote, or change the amount or pair. The signature is blocked before sending — this costs no network fee. " +
          "Network code: " + postState.executionError,
        params: { error: String(postState.executionError) },
      },
    ];
  }
  if (!postState) {
    return [unavailableWarning()];
  }

  const comparisons: PostStateAccount[] = [];
  let complete = true;
  for (const [address, expected] of expectedAccounts) {
    // Missing keys (including truncated RPC maps) are not evidence that an account is absent.
    if (!Object.hasOwn(preInfos, address) || !Object.hasOwn(postState, address)) {
      complete = false;
      continue;
    }
    const preInfo = preInfos[address];
    const pre = preInfo?.owner === expected.program ? parseAuthorityAccount(preInfo.data) : null;
    const postData = postState[address];
    const post = postData === null ? null : parseAuthorityAccount(postData);
    if ((preInfo !== null && !pre) || (postData !== null && !post)) {
      complete = false;
      continue;
    }
    if ((pre && pre.mint !== expected.mint) || (post && post.mint !== expected.mint)) {
      complete = false;
    }
    // Explicitly closed or absent accounts have no surviving authority to compare.
    if (!post) continue;
    comparisons.push({
      address,
      // For a confirmed creation, compare against the wallet's expected ATA authorities without
      // changing the shared helper's no-pre behaviour for its other callers.
      pre: pre ?? { ...post, mint: expected.mint, owner: publicKey.toBase58(), delegate: null, closeAuthority: null },
      post,
    });
  }
  const issues = postStateAuthorityIssues(comparisons);
  // Keep scanning incomplete results: a proven authority change must still block before signing.
  if (issues.length > 0) return issues;
  return complete ? [] : [unavailableWarning()];
}
