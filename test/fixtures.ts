// Fixture builders for the guard tests. These construct REAL version-0 Solana transactions with
// the same shape as a Jupiter Swap V2 route — no network and no wallet needed to inspect them.
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/transaction";
import { ATA_PROGRAM_ID, JUPITER_PROGRAM_ID, associatedTokenAddress } from "../src/presign";
import type { OrderResponse } from "../src/types";

export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const JUPITER_PROGRAM = new PublicKey(JUPITER_PROGRAM_ID);

export const BLOCKHASH = "Gy3Cy5QaNKfJrS5rWvnYpvQ9rUjcNQeTLuxQHpXb8EqH";

export const AMOUNT = 1_000_000n; // 0.001 SOL-lamports
export const OUT_AMOUNT = 995_000n;
export const SLIPPAGE_BPS = 50;
export const PLATFORM_FEE_BPS = 50;

export type Actors = {
  taker: PublicKey;
  mintIn: PublicKey;
  mintOut: PublicKey;
  ataIn: PublicKey;
  ataOut: PublicKey;
  victimAta: PublicKey;
  victimMint: PublicKey;
  drainDelegate: PublicKey;
  unknownProgram: PublicKey;
};

export function makeActors(): Actors {
  const taker = Keypair.generate().publicKey;
  const mintIn = Keypair.generate().publicKey;
  const mintOut = Keypair.generate().publicKey;
  const victimMint = Keypair.generate().publicKey;
  return {
    taker,
    mintIn,
    mintOut,
    ataIn: associatedTokenAddress(mintIn, taker),
    ataOut: associatedTokenAddress(mintOut, taker),
    victimAta: associatedTokenAddress(victimMint, taker),
    victimMint,
    drainDelegate: Keypair.generate().publicKey,
    unknownProgram: Keypair.generate().publicKey,
  };
}

// Jupiter's in-based route instruction ends with inAmount (u64), quotedOutAmount (u64),
// slippageBps (u16), platformFeeBps (u8). swapAccounts are the key accounts of the swap itself;
// `extraWritable` appends accounts as writable — used to stage a drain reachable by CPI.
export function jupiterRouteInstruction(
  actors: Actors,
  opts: { extraWritable?: PublicKey[] } = {},
): TransactionInstruction {
  const data = Buffer.alloc(8 + 12 + 19);
  // anchor discriminator + filler payload are irrelevant to the guard; the trailing 19 bytes matter.
  u64LE(data, 20, AMOUNT);
  u64LE(data, 28, OUT_AMOUNT);
  data.writeUInt16LE(SLIPPAGE_BPS, 36);
  data[38] = PLATFORM_FEE_BPS;
  const keys = [
    { pubkey: actors.taker, isSigner: true, isWritable: true },
    { pubkey: actors.ataIn, isSigner: false, isWritable: true },
    { pubkey: actors.ataOut, isSigner: false, isWritable: true },
    { pubkey: actors.mintIn, isSigner: false, isWritable: false },
    { pubkey: actors.mintOut, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  for (const account of opts.extraWritable ?? []) {
    keys.push({ pubkey: account, isSigner: false, isWritable: true });
  }
  return { programId: JUPITER_PROGRAM, keys, data };
}

// SPL Token Approve: delegate may spend up to `delegatedAmount` from this account, forever,
// until revoked. This is the classic airdrop-drain instruction.
export function tokenApproveInstruction(account: PublicKey, owner: PublicKey, delegate: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  data[0] = 4; // Approve
  u64LE(data, 1, 2n ** 64n - 1n);
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
    ],
    data,
  };
}

// SPL Token SetAuthority: hands the account's authority to another key — the airdrop-drain variant.
export function tokenSetAuthorityInstruction(account: PublicKey, owner: PublicKey, newAuthority: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1 + 1 + 1 + 32);
  data[0] = 6; // SetAuthority
  data[1] = 0; // AuthorityType::MintTokens is 0; Account owner authority is 4
  data[1] = 4;
  data[2] = 1; // Some(newAuthority)
  newAuthority.toBuffer().copy(data, 3);
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

// SPL Token ApproveChecked (id 13): a scoped delegate — still a delegation, still blocked.
export function tokenApproveCheckedInstruction(account: PublicKey, mint: PublicKey, owner: PublicKey, delegate: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1 + 8 + 8);
  data[0] = 13;
  u64LE(data, 1, 1000n);
  u64LE(data, 9, 1n);
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
    ],
    data,
  };
}

export function computeBudgetInstruction(units = 200_000): TransactionInstruction {
  const data = Buffer.alloc(5);
  data[0] = 1; // SetComputeUnitLimit
  data.writeUInt32LE(units, 1);
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data };
}

export function computeBudgetPriceInstruction(microLamports: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 2; // SetComputeUnitPrice
  u64LE(data, 1, microLamports);
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data };
}

export function createAtaInstruction(funder: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return {
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0]),
  };
}

export function memoInstruction(text: string): TransactionInstruction {
  return {
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, "utf8"),
  };
}

// A legitimate swap: compute budget, output ATA creation, the Jupiter route, nothing else.
export function buildLegitSwap(actors: Actors, opts: { extraInstructions?: TransactionInstruction[] } = {}): VersionedTransaction {
  const instructions: TransactionInstruction[] = [
    computeBudgetInstruction(),
    createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
    jupiterRouteInstruction(actors),
    ...(opts.extraInstructions ?? []),
  ];
  return compile(instructions, actors.taker);
}

export function buildSwapWithApproveDrain(actors: Actors): VersionedTransaction {
  return buildLegitSwap(actors, {
    extraInstructions: [tokenApproveInstruction(actors.victimAta, actors.taker, actors.drainDelegate)],
  });
}

export function buildSwapWithSetAuthorityDrain(actors: Actors): VersionedTransaction {
  return buildLegitSwap(actors, {
    extraInstructions: [tokenSetAuthorityInstruction(actors.victimAta, actors.taker, actors.drainDelegate)],
  });
}

export function buildSwapWithApproveCheckedDrain(actors: Actors): VersionedTransaction {
  return buildLegitSwap(actors, {
    extraInstructions: [tokenApproveCheckedInstruction(actors.victimAta, actors.victimMint, actors.taker, actors.drainDelegate)],
  });
}

// No visible Approve instruction at all — but the drain account is made WRITABLE, so a CPI inside
// the route could call Approve on it. The writable-bound check exists exactly for this.
export function buildSwapWithHiddenWritableDrain(actors: Actors): VersionedTransaction {
  const instructions = [
    computeBudgetInstruction(),
    createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
    jupiterRouteInstruction(actors, { extraWritable: [actors.victimAta] }),
  ];
  return compile(instructions, actors.taker);
}

export function compile(instructions: TransactionInstruction[], payer: PublicKey): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function serialize(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}

export function makeOrder(actors: Actors, transaction: VersionedTransaction, overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    inputMint: actors.mintIn.toBase58(),
    outputMint: actors.mintOut.toBase58(),
    amount: AMOUNT.toString(),
    inAmount: AMOUNT.toString(),
    outAmount: OUT_AMOUNT.toString(),
    slippageBps: SLIPPAGE_BPS,
    feeBps: PLATFORM_FEE_BPS,
    feeMint: actors.mintIn.toBase58(),
    router: "metis",
    requestId: "test-request",
    fetchedAt: Date.now(),
    transaction: serialize(transaction),
    transactionVersion: 0,
    ...overrides,
  };
}

// --- raw account-data encoders (mirror the SPL layouts parseTokenAccount / parseMintRisk read) ---

export function encodeTokenAccount(params: {
  mint: PublicKey;
  owner: PublicKey;
  amount?: bigint;
  delegate?: PublicKey;
  delegatedAmount?: bigint;
  closeAuthority?: PublicKey;
  state?: number;
}): Uint8Array {
  const data = new Uint8Array(165);
  params.mint.toBuffer().copy(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 0);
  params.owner.toBuffer().copy(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 32);
  u64LE(data, 64, params.amount ?? 1_000_000n);
  if (params.delegate) {
    data[72] = 1; // COption tag Some
    params.delegate.toBuffer().copy(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 76);
    u64LE(data, 121, params.delegatedAmount ?? 1_000n);
  }
  data[108] = params.state ?? 1;
  if (params.closeAuthority) {
    data[129] = 1;
    params.closeAuthority.toBuffer().copy(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 133);
  }
  return data;
}

// Base SPL mint (82 bytes): supply@36, decimals@44, freeze COption tag@46 + key@50.
export function encodeMintBase(params: { freezeAuthority?: PublicKey } = {}): Uint8Array {
  const data = new Uint8Array(82);
  u64LE(data, 36, 1_000_000_000n);
  data[44] = 9;
  if (params.freezeAuthority) {
    data[46] = 1;
    params.freezeAuthority.toBuffer().copy(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 50);
  }
  return data;
}

// Token-2022 mint with TLV extensions: base (82) padded to 165, account-type byte at 165, then
// u16 type / u16 length / value entries from 166.
export function encodeMint2022(params: {
  permanentDelegate?: PublicKey;
  transferHook?: PublicKey;
  freezeAuthority?: PublicKey;
}): Uint8Array {
  const entries: { type: number; value: Uint8Array }[] = [];
  if (params.permanentDelegate) {
    entries.push({ type: 12, value: params.permanentDelegate.toBuffer() });
  }
  if (params.transferHook) {
    const value = new Uint8Array(33);
    params.transferHook.toBuffer().copy(value, 0);
    value[32] = 1; // writable authority flag byte
    entries.push({ type: 14, value });
  }
  const total = 166 + entries.reduce((size, entry) => size + 4 + entry.value.length, 0);
  const data = new Uint8Array(total);
  data.set(encodeMintBase({ freezeAuthority: params.freezeAuthority }), 0);
  data[165] = 1; // AccountType::Mint
  let offset = 166;
  for (const entry of entries) {
    data[offset] = entry.type & 0xff;
    data[offset + 1] = entry.type >> 8;
    data[offset + 2] = entry.value.length & 0xff;
    data[offset + 3] = entry.value.length >> 8;
    data.set(entry.value, offset + 4);
    offset += 4 + entry.value.length;
  }
  return data;
}

function u64LE(target: Uint8Array, offset: number, value: bigint) {
  let v = value;
  for (let index = 0; index < 8; index += 1) {
    target[offset + index] = Number(v & 0xffn);
    v >>= 8n;
  }
  return target;
}

export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };
