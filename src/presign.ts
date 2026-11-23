import { PublicKey, type VersionedMessage, type VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./transaction";
import type { GuardIssue } from "./types";

export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export type ResolvedLookups = { writable: PublicKey[]; readonly: PublicKey[] };

// Every account the transaction is allowed to write to: the writable band of the static keys plus
// the writable accounts pulled from lookup tables. Roles come from the message itself, so this is
// the same notion of "writable" the post-signature guard compares against.
export function listWritableAccounts(message: VersionedMessage, resolved?: ResolvedLookups): string[] {
  const keys = [...message.staticAccountKeys, ...(resolved?.writable ?? []), ...(resolved?.readonly ?? [])];
  const writable: string[] = [];
  keys.forEach((key, index) => {
    if (message.isAccountWritable(index)) {
      writable.push(key.toBase58());
    }
  });
  return writable;
}

export type MinOutAudit = {
  // "instruction" only when the trailing fields decoded from Jupiter's route instruction match the
  // quote exactly; otherwise the honest fallback is the quote-derived limit.
  source: "instruction" | "quote";
  quotedOutAmount: string;
  slippageBps: number;
  platformFeeBps: number | null;
  minOutAmount: string;
};

// Jupiter's in-based route instruction ends with four fixed fields:
// inAmount (u64), quotedOutAmount (u64), slippageBps (u16), platformFeeBps (u8) — 19 bytes.
// The on-chain program derives the enforced minimum as quotedOut * (10000 - slippage) / 10000.
// We only claim "decoded from the instruction" when those bytes reproduce the quoted numbers, so a
// changed layout or a different instruction can never masquerade as the real limit.
export function auditMinOut(
  transaction: VersionedTransaction,
  resolved: ResolvedLookups | undefined,
  order: { amount: string; outAmount: string; slippageBps: number },
): MinOutAudit {
  const message = transaction.message;
  const keys = [...message.staticAccountKeys, ...(resolved?.writable ?? []), ...(resolved?.readonly ?? [])];

  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program || program.toBase58() !== JUPITER_PROGRAM_ID) {
      continue;
    }
    const data = instruction.data;
    if (data.length < 27) {
      continue;
    }
    const len = data.length;
    const inAmount = readU64LE(data, len - 19);
    const quotedOut = readU64LE(data, len - 11);
    const slippage = readU16LE(data, len - 3);
    const platformFeeBps = data[len - 1];
    if (
      inAmount.toString() === order.amount &&
      quotedOut.toString() === order.outAmount &&
      slippage === order.slippageBps
    ) {
      return {
        source: "instruction",
        quotedOutAmount: quotedOut.toString(),
        slippageBps: slippage,
        platformFeeBps,
        minOutAmount: minOut(quotedOut, slippage).toString(),
      };
    }
  }

  const quotedOut = BigInt(order.outAmount);
  return {
    source: "quote",
    quotedOutAmount: order.outAmount,
    slippageBps: order.slippageBps,
    platformFeeBps: null,
    minOutAmount: minOut(quotedOut, order.slippageBps).toString(),
  };
}

function minOut(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / BigInt(10_000);
}

export type TokenAccountAudit = {
  mint: string;
  owner: string;
  amount: string;
  delegate: string | null;
  delegatedAmount: string;
  closeAuthority: string | null;
  state: number;
};

// SPL Token and Token-2022 share the same first 165 bytes of account data:
// mint 0..32, owner 32..64, amount 64..72, delegate COption 72..108, state 108,
// isNative COption 109..121, delegatedAmount 121..129, closeAuthority COption 129..165.
// A delegate set here outlives any single swap, so it has to be surfaced before signing.
export function parseTokenAccount(data: Uint8Array): TokenAccountAudit | null {
  if (data.length < 165) {
    return null;
  }
  const delegateTag = readU32LE(data, 72);
  const closeTag = readU32LE(data, 129);
  return {
    mint: new PublicKey(data.slice(0, 32)).toBase58(),
    owner: new PublicKey(data.slice(32, 64)).toBase58(),
    amount: readU64LE(data, 64).toString(),
    delegate: delegateTag === 1 ? new PublicKey(data.slice(76, 108)).toBase58() : null,
    delegatedAmount: readU64LE(data, 121).toString(),
    closeAuthority: closeTag === 1 ? new PublicKey(data.slice(133, 165)).toBase58() : null,
    state: data[108],
  };
}

// Token-2022 mint layout: base Mint is 82 bytes (freezeAuthority COption at 46..82). When extensions
// exist the account is padded to ACCOUNT_SIZE (165), an AccountType byte (1 = Mint) sits at 165, and
// the TLV extension stream starts at 166. Each TLV entry is u16 LE type, u16 LE length, then value.
const MINT_BASE_LEN = 82;
const MINT_ACCOUNT_TYPE_INDEX = 165;
const MINT_TLV_START = 166;
const MINT_ACCOUNT_TYPE = 1;

const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_MINT_CLOSE_AUTHORITY = 3;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_NON_TRANSFERABLE = 9;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_PAUSABLE_CONFIG = 26;

export type MintRisk = {
  freezeAuthority: string | null;
  permanentDelegate: string | null;
  transferHook: string | null;
  mintCloseAuthority: string | null;
  transferFee: boolean;
  nonTransferable: boolean;
  defaultFrozen: boolean;
  pausable: boolean;
};

// OptionalNonZeroPubkey: 32 bytes, all-zero means "none".
function readOptionalPubkey(data: Uint8Array, offset: number): string | null {
  if (offset + 32 > data.length) {
    return null;
  }
  const slice = data.subarray(offset, offset + 32);
  if (slice.every((byte) => byte === 0)) {
    return null;
  }
  return new PublicKey(slice).toBase58();
}

export function parseMintRisk(data: Uint8Array): MintRisk | null {
  if (data.length < MINT_BASE_LEN) {
    return null;
  }
  const risk: MintRisk = {
    freezeAuthority: readU32LE(data, 46) === 1 ? readOptionalPubkey(data, 50) : null,
    permanentDelegate: null,
    transferHook: null,
    mintCloseAuthority: null,
    transferFee: false,
    nonTransferable: false,
    defaultFrozen: false,
    pausable: false,
  };
  if (data.length <= MINT_ACCOUNT_TYPE_INDEX || data[MINT_ACCOUNT_TYPE_INDEX] !== MINT_ACCOUNT_TYPE) {
    return risk;
  }
  let offset = MINT_TLV_START;
  while (offset + 4 <= data.length) {
    const type = readU16LE(data, offset);
    const length = readU16LE(data, offset + 2);
    const valueStart = offset + 4;
    if (valueStart + length > data.length) {
      break;
    }
    const value = data.subarray(valueStart, valueStart + length);
    switch (type) {
      case EXT_PERMANENT_DELEGATE:
        risk.permanentDelegate = readOptionalPubkey(value, 0);
        break;
      case EXT_TRANSFER_HOOK:
        risk.transferHook = readOptionalPubkey(value, 0);
        break;
      case EXT_MINT_CLOSE_AUTHORITY:
        risk.mintCloseAuthority = readOptionalPubkey(value, 0);
        break;
      case EXT_TRANSFER_FEE_CONFIG:
        risk.transferFee = true;
        break;
      case EXT_NON_TRANSFERABLE:
        risk.nonTransferable = true;
        break;
      case EXT_DEFAULT_ACCOUNT_STATE:
        risk.defaultFrozen = length >= 1 && value[0] === 2;
        break;
      case EXT_PAUSABLE_CONFIG:
        risk.pausable = true;
        break;
    }
    offset = valueStart + length;
  }
  return risk;
}

// Permanent delegate and transfer hook are issuer custody powers, not a proof of theft: regulated
// tokenized equities (xStocks, Backpack Securities) ship both by design, so a hard block would ban
// the whole category. For a mint the user actually trades they stay loud warnings and the confirm
// panel gates the swap behind an explicit consent checkbox, because he keeps that token afterwards.
// The user's OWN accounts remain protected by the writable bound, the instruction decode and the
// post-state authority check, which stay hard blocks.
export function mintRiskIssues(mint: string, risk: MintRisk): GuardIssue[] {
  const issues: GuardIssue[] = [];
  if (risk.permanentDelegate) {
    issues.push({
      level: "warn",
      code: "ISSUER_PERMANENT_DELEGATE",
      message:
        `Token ${mint} has a permanent delegate ${risk.permanentDelegate}: the issuer can move or burn your tokens at any time without your signature. Tokenized equities and other regulated tokens are built this way. The swap proceeds only after your explicit consent in the confirmation window.`,
      params: { mint, delegate: risk.permanentDelegate },
    });
  }
  if (risk.transferHook) {
    issues.push({
      level: "warn",
      code: "ISSUER_TRANSFER_HOOK",
      message:
        `Token ${mint} calls the issuer's program (transfer hook) ${risk.transferHook} on every transfer. Its code cannot be verified; it acts only within the accounts of this transaction. The swap proceeds only after your explicit consent in the confirmation window.`,
      params: { mint, hook: risk.transferHook },
    });
  }
  if (risk.freezeAuthority) {
    issues.push({
      level: "warn",
      code: "MINT_FREEZE_AUTHORITY",
      message: `Token ${mint} has a freeze authority ${risk.freezeAuthority}: its owner can freeze your token account and block selling.`,
      params: { mint, authority: risk.freezeAuthority },
    });
  }
  if (risk.mintCloseAuthority) {
    issues.push({
      level: "warn",
      code: "MINT_CLOSE_AUTHORITY",
      message: `Token ${mint} has a close authority ${risk.mintCloseAuthority}: the mint can be closed, breaking transfers.`,
      params: { mint, authority: risk.mintCloseAuthority },
    });
  }
  if (risk.transferFee) {
    issues.push({
      level: "warn",
      code: "MINT_TRANSFER_FEE",
      message: `Token ${mint} charges a fee on every transfer (transfer fee): you will receive less than the quote shows.`,
      params: { mint },
    });
  }
  if (risk.nonTransferable) {
    issues.push({
      level: "warn",
      code: "MINT_NON_TRANSFERABLE",
      message: `Token ${mint} cannot be transferred (non-transferable): once bought, it cannot be sold.`,
      params: { mint },
    });
  }
  if (risk.defaultFrozen) {
    issues.push({
      level: "warn",
      code: "MINT_DEFAULT_FROZEN",
      message: `New accounts of token ${mint} are created frozen: selling may be blocked.`,
      params: { mint },
    });
  }
  if (risk.pausable) {
    issues.push({
      level: "warn",
      code: "MINT_PAUSABLE",
      message: `Transfers of token ${mint} can be paused (pausable): the owner can stop selling at any moment.`,
      params: { mint },
    });
  }
  return issues;
}

// A mint the route merely passes through is not a token the user keeps, so its issuer powers cannot
// stand in for consent to the swap — that would gate a pair whose own endpoints are clean. They are
// still disclosed, because a permanent delegate or a transfer hook acts inside this very transaction
// and a transfer fee quietly reduces what lands. The user's OWN accounts stay protected by the
// writable bound and the post-state authority check, which remain hard blocks.
const PASSTHROUGH_POWERS: Array<[keyof MintRisk, string]> = [
  ["permanentDelegate", "permanent delegate"],
  ["transferHook", "transfer hook"],
  ["transferFee", "transfer fee"],
];

export function passThroughMintIssue(mint: string, risk: MintRisk): GuardIssue | null {
  const powers = PASSTHROUGH_POWERS.filter(([field]) => Boolean(risk[field])).map(([, label]) => label);
  if (powers.length === 0) {
    return null;
  }
  return {
    level: "warn",
    code: "ROUTE_PASSTHROUGH_ISSUER_POWERS",
    message:
      `Token ${mint} is only an intermediate hop of this route — you do not keep it. Its issuer holds: ${powers.join(", ")}. ` +
      "Your consent is not required for it: the transaction can only write to the accounts fixed when you sign, and permanent authorities on your own accounts are compared after simulation.",
    params: { mint, powers: powers.join(", ") },
  };
}

export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return address;
}

// The writable set is fixed at signing and bounds everything an inner program call (CPI) can reach:
// a router invoked inside the swap cannot gain write access to an account outside this set, nor turn
// a readonly account writable. A legitimate swap only needs to write to the user's own input, output
// and wrapped-SOL token accounts. Any OTHER writable token account owned by the user is extra drain
// reach — an inner call could approve or re-authority it — so the caller blocks it. Accounts that do
// not exist yet, or are owned by a program other than SPL Token / Token-2022, are not the user's funds.
export function findUnexpectedUserWritable(
  writableAccounts: string[],
  infos: Record<string, { owner: string; data: Uint8Array } | null>,
  taker: string,
  expected: Set<string>,
): string[] {
  const tokenPrograms = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
  const unexpected: string[] = [];
  for (const address of writableAccounts) {
    if (expected.has(address)) {
      continue;
    }
    const info = infos[address];
    if (!info || !tokenPrograms.has(info.owner)) {
      continue;
    }
    const parsed = parseTokenAccount(info.data);
    if (parsed && parsed.owner === taker) {
      unexpected.push(address);
    }
  }
  return unexpected;
}

export type PostStateAccount = {
  address: string;
  pre: TokenAccountAudit | null;
  post: TokenAccountAudit | null;
};

// The residual CPI-hidden drain the static writable bound and the top-level instruction decode cannot
// see: a swap that approves a delegate or rewrites owner/closeAuthority on the user's own token
// account, which is legitimately writable for the trade. Unlike a transfer inside the trade, that
// authority outlives the transaction and nothing in the swap expires it, so it can empty the account
// later. Simulating the exact transaction bytes and comparing only the fields that survive settlement
// catches it; amounts legitimately change during a swap, so they are not compared. An account missing
// on either side cannot be asserted and is skipped — the caller warns when nothing could be compared.
export function postStateAuthorityIssues(accounts: PostStateAccount[]): GuardIssue[] {
  const changed: string[] = [];
  for (const { address, pre, post } of accounts) {
    if (!pre || !post) {
      continue;
    }
    const fields: string[] = [];
    if (post.delegate !== pre.delegate) fields.push("delegate");
    if (post.owner !== pre.owner) fields.push("owner");
    if (post.closeAuthority !== pre.closeAuthority) fields.push("closeAuthority");
    if (fields.length > 0) {
      changed.push(`${address} (${fields.join(", ")})`);
    }
  }
  if (changed.length === 0) {
    return [];
  }
  return [
    {
      level: "block",
      code: "POST_STATE_AUTHORITY_CHANGED",
      message:
        `Simulating the signed transaction showed the swap would change permanent authorities on your token accounts: ${changed.join("; ")}. ` +
        "A delegate, an ownership change or a close authority outlives the swap itself and is never reset inside it, so such an account could be emptied later. " +
        "The signature was refused before sending — this costs no network fee. Refresh the quote; if it repeats, check the transaction in an explorer and use another wallet.",
      params: { accounts: changed.join("; ") },
    },
  ];
}

const PROGRAM_LABELS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  [TOKEN_PROGRAM_ID.toBase58()]: "SPL Token",
  [TOKEN_2022_PROGRAM_ID.toBase58()]: "Token-2022",
  [ATA_PROGRAM_ID.toBase58()]: "ATA",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  [JUPITER_PROGRAM_ID]: "Jupiter",
  REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3: "Referral",
};

export function programLabel(program: string): string | undefined {
  return PROGRAM_LABELS[program];
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(data[offset + index]);
  }
  return value;
}

function readU32LE(data: Uint8Array, offset: number): number {
  let value = 0;
  for (let index = 3; index >= 0; index -= 1) {
    value = value * 256 + data[offset + index];
  }
  return value;
}

function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset] + data[offset + 1] * 256;
}
