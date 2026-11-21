import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { GuardIssue } from "./types";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// SPL Token / Token-2022 share the low instruction discriminators (first data byte).
// The three that hand control of funds to another address are the classic airdrop-drain vectors:
// an "airdrop claim" that secretly asks you to delegate or re-sign authority over your token account.
const SPL_INSTRUCTION_APPROVE = 4;
const SPL_INSTRUCTION_SET_AUTHORITY = 6;
const SPL_INSTRUCTION_APPROVE_CHECKED = 13;

// Programs we expect to see at the top level of a Jupiter Swap V2 transaction. Anything outside
// this set is only advisory (warn) so a newer routing program never blocks a legitimate swap.
export const KNOWN_PROGRAMS = new Set<string>(
  [
    "11111111111111111111111111111111", // System Program
    TOKEN_PROGRAM_ID.toBase58(), // SPL Token
    TOKEN_2022_PROGRAM_ID.toBase58(), // Token-2022
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
    "ComputeBudget111111111111111111111111111111", // Compute Budget
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter aggregator
    "REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3", // Jupiter referral
  ].map((value) => new PublicKey(value).toBase58()),
);

/**
 * Inspect the instructions of a swap transaction before the wallet is asked to sign.
 * A legitimate Jupiter swap for the curated tokens never delegates or re-signs token
 * authority, so any SetAuthority / Approve / ApproveChecked is treated as a hard block.
 */
export function inspectSwapTransaction(
  transaction: VersionedTransaction,
  accountKeysFromLookups?: { writable: PublicKey[]; readonly: PublicKey[] },
): GuardIssue[] {
  const message = transaction.message;

  // Resolve the full key order manually (static, then lookup-writable, then lookup-readonly) instead
  // of message.getAccountKeys(), which throws whenever lookup tables are unresolved. Falling back to
  // static-only keys lets the guard still audit the swap program ids and degrade to a warning.
  const accountKeys: (PublicKey | undefined)[] = [
    ...message.staticAccountKeys,
    ...(accountKeysFromLookups ? [...accountKeysFromLookups.writable, ...accountKeysFromLookups.readonly] : []),
  ];

  const blockByCode = new Map<string, GuardIssue>();
  const unknownPrograms = new Set<string>();
  let usesToken2022 = false;
  let hasUnresolvedProgram = false;

  for (const instruction of message.compiledInstructions) {
    const programId = accountKeys[instruction.programIdIndex];
    if (!programId) {
      hasUnresolvedProgram = true;
      continue;
    }

    const programBase58 = programId.toBase58();
    const isTokenProgram = programId.equals(TOKEN_PROGRAM_ID);
    const isToken2022Program = programId.equals(TOKEN_2022_PROGRAM_ID);
    if (isToken2022Program) {
      usesToken2022 = true;
    }

    if ((isTokenProgram || isToken2022Program) && instruction.data.length > 0) {
      const discriminator = instruction.data[0];
      if (discriminator === SPL_INSTRUCTION_SET_AUTHORITY) {
        blockByCode.set("DRAIN_SET_AUTHORITY", {
          level: "block",
          code: "DRAIN_SET_AUTHORITY",
          message:
            "The transaction changes (SetAuthority) the ownership power of your token account. This is a typical airdrop drain — the signature is blocked.",
        });
      } else if (discriminator === SPL_INSTRUCTION_APPROVE) {
        blockByCode.set("DRAIN_APPROVE", {
          level: "block",
          code: "DRAIN_APPROVE",
          message:
            "The transaction delegates the right to spend your tokens (Approve). A legitimate swap never does this — the signature is blocked.",
        });
      } else if (discriminator === SPL_INSTRUCTION_APPROVE_CHECKED) {
        blockByCode.set("DRAIN_APPROVE_CHECKED", {
          level: "block",
          code: "DRAIN_APPROVE_CHECKED",
          message:
            "The transaction delegates the right to spend your tokens (ApproveChecked). A legitimate swap never does this — the signature is blocked.",
        });
      }
    }

    if (!KNOWN_PROGRAMS.has(programBase58)) {
      unknownPrograms.add(programBase58);
    }
  }

  const issues: GuardIssue[] = [...blockByCode.values()];

  if (usesToken2022) {
    issues.push({
      level: "warn",
      code: "TOKEN_2022_IN_TX",
      message:
        "The transaction involves Token-2022. Make sure the token has no hook extensions (transfer hook, permanent delegate).",
    });
  }

  if (hasUnresolvedProgram) {
    issues.push({
      level: "warn",
      code: "UNRESOLVED_ACCOUNTS",
      message: "Some lookup-table addresses of the transaction could not be resolved. Check the transaction details before signing.",
    });
  }

  for (const program of unknownPrograms) {
    issues.push({
      level: "warn",
      code: "UNKNOWN_PROGRAM",
      message: `The transaction calls an unknown program ${program.slice(0, 8)}…. We cannot verify it.`,
      params: { program },
    });
  }

  return issues;
}
