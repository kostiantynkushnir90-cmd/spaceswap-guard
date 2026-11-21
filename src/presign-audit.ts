import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { base64ToBytes } from "./base64";
import { SwapGuardError } from "./errors";
import {
  associatedTokenAddress,
  auditMinOut,
  findUnexpectedUserWritable,
  listWritableAccounts,
  mintRiskIssues,
  parseMintRisk,
  parseTokenAccount,
  type ResolvedLookups,
} from "./presign";
import { auditPostStateAuthorities } from "./poststate-audit";
import { assertOrderSignable, validateSwapRequest } from "./rules";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, inspectSwapTransaction } from "./transaction";
import type {
  GuardIssue,
  OrderResponse,
  PostStateVerdict,
  PreSignAudit,
  SimulatedPostState,
  SwapRequest,
  TokenAccountStatus,
} from "./types";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export type PreSignDeps = {
  getOrder: (request: SwapRequest & { taker: string }) => Promise<OrderResponse>;
  getBlockHeight: () => Promise<number>;
  getAddressLookupTableAccounts: (keys: PublicKey[]) => Promise<(AddressLookupTableAccount | null)[]>;
  // Owner program and raw data for each address, or null when the account does not exist yet.
  getAccountInfo: (addresses: string[]) => Promise<Record<string, { owner: string; data: Uint8Array } | null>>;
  // Second-line simulation of the prepared (unsigned) bytes. sigVerify:false on the RPC side lets an
  // unsigned transaction simulate, so the verdict is known BEFORE the wallet is asked to sign and the
  // signature itself can stand in for consent when no verdict could be obtained. A simulation that ran
  // and failed blocks the swap instead — consent cannot make a failing transaction succeed.
  simulatePostState?: (
    transaction: VersionedTransaction,
    addresses: string[],
  ) => Promise<SimulatedPostState>;
  now?: () => number;
};

async function resolveLookups(
  transaction: VersionedTransaction,
  resolver: (keys: PublicKey[]) => Promise<(AddressLookupTableAccount | null)[]>,
): Promise<ResolvedLookups | undefined> {
  const lookups = transaction.message.addressTableLookups;
  if (lookups.length === 0) {
    return { writable: [], readonly: [] };
  }
  const tables = await resolver(lookups.map((lookup) => lookup.accountKey));
  const writable: PublicKey[] = [];
  const readonly: PublicKey[] = [];
  for (let index = 0; index < lookups.length; index += 1) {
    const table = tables[index];
    if (!table) {
      return undefined;
    }
    for (const offset of lookups[index].writableIndexes) {
      const key = table.state.addresses[offset];
      if (key) writable.push(key);
    }
    for (const offset of lookups[index].readonlyIndexes) {
      const key = table.state.addresses[offset];
      if (key) readonly.push(key);
    }
  }
  return { writable, readonly };
}

function blockIf(issues: GuardIssue[]): void {
  if (issues.some((issue) => issue.level === "block")) {
    throw new SwapGuardError(issues);
  }
}

// Fetch the order and audit it before the wallet is ever asked to sign. The same guard rules the
// swap flow enforces run here too, so a drain instruction or a stale order is rejected before the
// user even sees the confirmation. The returned order is handed straight to the swap flow as the
// prepared order, so the transaction the user confirmed is the one that gets signed.
export async function preparePreSignAudit(
  params: { request: SwapRequest; taker: string; publicKey: PublicKey; feeConfigured: boolean },
  deps: PreSignDeps,
): Promise<{ order: OrderResponse; audit: PreSignAudit }> {
  const { request, taker, publicKey, feeConfigured } = params;
  blockIf(validateSwapRequest(request));

  const order = await deps.getOrder({ ...request, taker });
  if (
    order.inputMint !== request.inputMint ||
    order.outputMint !== request.outputMint ||
    order.amount !== request.amount ||
    order.slippageBps !== request.slippageBps
  ) {
    throw new SwapGuardError([
      { level: "block", code: "ORDER_MISMATCH", message: "The order does not match the request parameters. Refresh the quote." },
    ]);
  }
  if (order.feeMint !== order.inputMint && order.feeMint !== order.outputMint) {
    throw new SwapGuardError([
      { level: "block", code: "FEE_MINT_UNSUPPORTED", message: "The fee is charged in a token outside the swap pair. The MVP cannot confirm it transparently." },
    ]);
  }

  let currentBlockHeight: number | undefined;
  let rpcWarning: GuardIssue | null = null;
  try {
    currentBlockHeight = await deps.getBlockHeight();
  } catch {
    rpcWarning = {
      level: "warn",
      code: "RPC_UNAVAILABLE",
      message:
        "Blockhash freshness could not be verified through the RPC. If the blockhash has passed, the transaction simply never lands in a block — funds are not lost.",
    };
  }

  const nowMs = deps.now?.() ?? Date.now();
  const signableIssues = assertOrderSignable(order, { nowMs, currentBlockHeight, feeConfigured });
  blockIf(signableIssues);

  const transaction = VersionedTransaction.deserialize(base64ToBytes(order.transaction));
  if (transaction.version !== 0) {
    throw new SwapGuardError([
      { level: "block", code: "UNSUPPORTED_TX_VERSION", message: "Only transaction version 0 is supported." },
    ]);
  }
  const signerIndex = transaction.message.staticAccountKeys.findIndex((key) => key.equals(publicKey));
  if (signerIndex < 0 || !transaction.message.isAccountSigner(signerIndex)) {
    throw new SwapGuardError([
      { level: "block", code: "TAKER_NOT_SIGNER", message: "Your wallet is not a signer of this transaction. Swap blocked." },
    ]);
  }

  let resolved: ResolvedLookups | undefined;
  try {
    resolved = await resolveLookups(transaction, deps.getAddressLookupTableAccounts);
  } catch {
    resolved = undefined;
  }
  if (!resolved && transaction.message.addressTableLookups.length > 0) {
    throw new SwapGuardError([
      {
        level: "block",
        code: "UNRESOLVED_ACCOUNTS",
        message:
          "The RPC did not answer the transaction's address lookup tables, so it cannot be fully verified before signing. Try again in a few seconds.",
      },
    ]);
  }

  // The transaction and the router name come from the same Jupiter response, so the router it
  // reported is what this build is expected to call.
  const txIssues = inspectSwapTransaction(transaction, resolved, order.router);
  blockIf(txIssues);

  const minOut = auditMinOut(transaction, resolved, order);
  const writableAccounts = listWritableAccounts(transaction.message, resolved);

  const atasFor = (mint: string): string[] => [
    associatedTokenAddress(new PublicKey(mint), publicKey, TOKEN_PROGRAM_ID).toBase58(),
    associatedTokenAddress(new PublicKey(mint), publicKey, TOKEN_2022_PROGRAM_ID).toBase58(),
  ];
  // A multi-hop route writes to the user's ATA for every mint it touches, not just input/output.
  // Whitelist each route mint's ATA (plus wrapped SOL) so a legitimate intermediate hop is not blocked;
  // a writable user token account whose mint is NOT in the route stays a hard drain block.
  const routeMints = [...new Set([...(order.routeMints ?? []), request.inputMint, request.outputMint])];
  const inputAtas = atasFor(request.inputMint);
  const outputAtas = atasFor(request.outputMint);
  const wsolAtas = atasFor(WSOL_MINT.toBase58());
  const routeAtas = routeMints.flatMap(atasFor);
  const expectedUserAccounts = new Set<string>([...routeAtas, ...wsolAtas]);
  const addresses = [...new Set([...writableAccounts, ...routeAtas, ...wsolAtas, ...routeMints])];

  let infos: Record<string, { owner: string; data: Uint8Array } | null> = {};
  let accountsReadable = true;
  try {
    infos = await deps.getAccountInfo(addresses);
  } catch {
    accountsReadable = false;
  }

  const writableOwners: Record<string, string | null> = {};
  if (accountsReadable) {
    for (const address of writableAccounts) {
      writableOwners[address] = infos[address]?.owner ?? null;
    }
  }

  // Hard bound on CPI reach: a writable token account owned by the user that is not part of this swap
  // is a drain vector an instruction decode cannot see, so block before the wallet is asked to sign.
  // When the RPC did not answer we keep the existing warning instead of breaking swaps on a hiccup.
  if (accountsReadable) {
    const unexpected = findUnexpectedUserWritable(writableAccounts, infos, taker, expectedUserAccounts);
    if (unexpected.length > 0) {
      throw new SwapGuardError([
        {
          level: "block",
          code: "DRAIN_WRITABLE_ACCOUNT",
          message:
            `The transaction has write permission on your token account that is not part of this swap: ${unexpected.join(", ")}. ` +
            "The writable-account set is fixed at signing and bounds everything inner program calls (CPI) can reach, so a foreign program could delegate or rewrite authority on this account. " +
            "The signature is blocked before sending — this costs no network fee. Refresh the quote; if it repeats, check the transaction in an explorer and use another wallet.",
          params: { accounts: unexpected.join(", ") },
        },
      ]);
    }
  }

  // Token-2022 mint extensions are the airdrop-drain vector an instruction decode cannot see: a
  // permanent delegate or a transfer hook moves funds at runtime, inside the writable bound. Read
  // both mints and surface the issuer custody powers; the panel gates them behind explicit consent.
  const mintIssues: GuardIssue[] = [];
  if (accountsReadable) {
    for (const mint of routeMints) {
      const info = infos[mint];
      if (!info || (info.owner !== TOKEN_PROGRAM_ID.toBase58() && info.owner !== TOKEN_2022_PROGRAM_ID.toBase58())) {
        continue;
      }
      const risk = parseMintRisk(info.data);
      if (risk) {
        mintIssues.push(...mintRiskIssues(mint, risk));
      }
    }
  }
  blockIf(mintIssues);

  const tokenPrograms = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
  const accountStatus = (candidates: string[]): TokenAccountStatus => {
    if (!accountsReadable) {
      return { kind: "unreadable" };
    }
    for (const address of candidates) {
      const info = infos[address];
      if (info && tokenPrograms.has(info.owner)) {
        const parsed = parseTokenAccount(info.data);
        if (parsed) {
          return { kind: "present", audit: parsed };
        }
      }
    }
    return { kind: "absent" };
  };

  // Second line for the CPI-hidden authority change, run here on the prepared bytes so a detected
  // drain blocks BEFORE the wallet signs, and an unavailable simulation is disclosed in the same panel
  // the user already reads — the confirm button then names the consent the signature carries.
  let postState: PostStateVerdict | undefined;
  const postStateIssues: GuardIssue[] = [];
  if (deps.simulatePostState) {
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey, inputMint: request.inputMint, outputMint: request.outputMint, routeMints },
      { getAccountInfo: deps.getAccountInfo, simulatePostState: deps.simulatePostState },
    );
    blockIf(issues);
    postStateIssues.push(...issues.filter((issue) => issue.level === "warn"));
    postState = {
      status: issues.some((issue) => issue.code === "POST_STATE_UNAVAILABLE") ? "unavailable" : "verified",
      issues,
    };
  }

  const warnings: GuardIssue[] = [
    ...(rpcWarning ? [rpcWarning] : []),
    ...signableIssues.filter((issue) => issue.level === "warn"),
    ...txIssues.filter((issue) => issue.level === "warn"),
    ...mintIssues.filter((issue) => issue.level === "warn"),
    ...postStateIssues,
  ];
  if (!accountsReadable) {
    warnings.push({
      level: "warn",
      code: "RPC_UNAVAILABLE",
      message:
        "Token accounts could not be read through the RPC, so delegates and account owners were not verified. This alone does not block the swap.",
    });
  }

  const audit: PreSignAudit = {
    minOut,
    writableAccounts,
    writableOwners,
    accountsReadable,
    inputAccount: accountStatus(inputAtas),
    outputAccount: accountStatus(outputAtas),
    warnings,
    postState,
    issuerConsentRequired: mintIssues.some(
      (issue) => issue.code === "ISSUER_PERMANENT_DELEGATE" || issue.code === "ISSUER_TRANSFER_HOOK",
    ),
  };
  return { order, audit };
}
