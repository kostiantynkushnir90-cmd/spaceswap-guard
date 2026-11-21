import type { VersionedMessage } from "@solana/web3.js";
import { base64ToBytes, bytesToBase64 } from "./base64";

// A wallet must never be able to hand back a transaction that does something different from the one
// the guard audited. Comparing serialized bytes catches that, but also rejects honest wallets that
// re-encode an equivalent message (keys sorted differently, lookup tables listed in another order),
// which would disable swapping for those users. So equality is defined by effect instead:
// the same accounts with the same permissions, executed by the same instructions in the same order,
// against the same blockhash and the same lookup tables.
export type MessageChange =
  | "version"
  | "signatureSlots"
  | "blockhash"
  | "accountRoles"
  | "lookupTables"
  | "instructions";

const CHANGE_LABELS: Record<MessageChange, string> = {
  version: "transaction version",
  signatureSlots: "number of signer slots",
  blockhash: "blockhash",
  accountRoles: "account permissions",
  lookupTables: "address lookup tables",
  instructions: "instructions",
};

export function describeMessageChanges(changes: MessageChange[]): string {
  return changes.map((change) => CHANGE_LABELS[change]).join(", ");
}

/**
 * A short shape summary used when the signed message really changed. Jupiter only executes the exact
 * transaction it issued with the requestId, so the user needs to know what the wallet handed back —
 * the counts are what identify the offending wallet behaviour without asking them to read bytes.
 */
export function describeMessageShape(message: VersionedMessage): string {
  const lookupAccounts = message.addressTableLookups.reduce(
    (count, lookup) => count + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
    0,
  );
  return [
    `${message.compiledInstructions.length} instr.`,
    `${message.staticAccountKeys.length + lookupAccounts} accts`,
    `${message.addressTableLookups.length} tables`,
    `${message.header.numRequiredSignatures} sigs`,
  ].join(", ");
}

// One identity per referenced account. Static keys are their own address; accounts pulled from a
// lookup table are identified by the table plus the offset inside it, so nothing has to be fetched
// from the RPC to compare two messages. When the caller resolved both messages' tables against the
// network, identities become the real addresses instead: wallets (Phantom) recompile the message and
// move accounts between static keys and table offsets, which is a re-encoding, not a tamper.
export type ResolvedAddresses = { writable: string[]; readonly: string[] };
export type ResolvedMessages = { before: ResolvedAddresses; after: ResolvedAddresses };

function accountRefs(message: VersionedMessage, resolved?: ResolvedAddresses): string[] {
  const refs = message.staticAccountKeys.map((key) => key.toBase58());
  if (resolved) {
    refs.push(...resolved.writable, ...resolved.readonly);
    return refs;
  }
  for (const lookup of message.addressTableLookups) {
    const table = lookup.accountKey.toBase58();
    for (const offset of lookup.writableIndexes) {
      refs.push(`alt:${table}:${offset}`);
    }
  }
  for (const lookup of message.addressTableLookups) {
    const table = lookup.accountKey.toBase58();
    for (const offset of lookup.readonlyIndexes) {
      refs.push(`alt:${table}:${offset}`);
    }
  }
  return refs;
}

function resolveRef(refs: string[], index: number): string {
  return refs[index] ?? `missing:${index}`;
}

function roleEntries(message: VersionedMessage, refs: string[]): string[] {
  return refs
    .map((ref, index) => `${ref}=${message.isAccountSigner(index) ? "s" : "-"}${message.isAccountWritable(index) ? "w" : "-"}`)
    .sort();
}

function instructionEntries(message: VersionedMessage, refs: string[]): string[] {
  return message.compiledInstructions.map((instruction) => {
    const accounts = instruction.accountKeyIndexes.map((index) => resolveRef(refs, index)).join(",");
    return `p=${resolveRef(refs, instruction.programIdIndex)}|a=${accounts}|d=${bytesToBase64(instruction.data)}`;
  });
}

function lookupEntries(message: VersionedMessage, resolved?: ResolvedAddresses): string[] {
  if (resolved) {
    return [
      ...resolved.writable.map((address) => `${address}=w`),
      ...resolved.readonly.map((address) => `${address}=r`),
    ].sort();
  }
  return message.addressTableLookups
    .map(
      (lookup) =>
        `${lookup.accountKey.toBase58()}|w=${[...lookup.writableIndexes].sort((a, b) => a - b).join(",")}|r=${[...lookup.readonlyIndexes].sort((a, b) => a - b).join(",")}`,
    )
    .sort();
}

/**
 * Return every semantic difference between the audited message and the one the wallet returned.
 * An empty array means the signed transaction would do exactly what was shown to the user, even if
 * its bytes were re-encoded by the wallet. Pass `resolved` (both messages' lookup tables resolved
 * against the network) to compare real account identities across a wallet recompilation.
 */
export function diffMessages(
  before: VersionedMessage,
  after: VersionedMessage,
  resolved?: ResolvedMessages,
): MessageChange[] {
  const changes: MessageChange[] = [];

  if (before.version !== after.version) {
    changes.push("version");
    return changes;
  }

  if (
    before.header.numRequiredSignatures !== after.header.numRequiredSignatures ||
    before.header.numReadonlySignedAccounts !== after.header.numReadonlySignedAccounts ||
    before.header.numReadonlyUnsignedAccounts !== after.header.numReadonlyUnsignedAccounts
  ) {
    changes.push("signatureSlots");
  }

  if (before.recentBlockhash !== after.recentBlockhash) {
    changes.push("blockhash");
  }

  if (lookupEntries(before, resolved?.before).join(";") !== lookupEntries(after, resolved?.after).join(";")) {
    changes.push("lookupTables");
  }

  const refsBefore = accountRefs(before, resolved?.before);
  const refsAfter = accountRefs(after, resolved?.after);

  if (roleEntries(before, refsBefore).join(";") !== roleEntries(after, refsAfter).join(";")) {
    changes.push("accountRoles");
  }

  if (instructionEntries(before, refsBefore).join(";") !== instructionEntries(after, refsAfter).join(";")) {
    changes.push("instructions");
  }

  return changes;
}

// Programs a wallet may add on its own. Neither can move funds: Compute Budget only changes how much
// SOL the user pays the network, Memo only writes a string. Everything else has to be signed exactly
// as it was audited.
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const BENIGN_PROGRAM_NAMES: Record<string, string> = {
  [COMPUTE_BUDGET_PROGRAM]: "ComputeBudget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};

// Assertion programs a wallet uses to re-check the simulated outcome on-chain (Lighthouse),
// their instructions only read state, write into accounts the program itself owns, or fail the whole
// transaction, so they cannot move funds — but unlike Compute Budget they do bring a brand-new
// writable account, and that account has to be proven in the network before we send the signature
// anywhere. See `assertionAccounts`.
const ASSERTION_PROGRAM_NAMES: Record<string, string> = {
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse",
};

// A new account an assertion instruction brings along, kept with the program that must own it.
export type AssertionAccount = { address: string; program: string };

export function assertionProgramName(program: string): string | undefined {
  return ASSERTION_PROGRAM_NAMES[program];
}

export type MessageVerdict =
  | { kind: "unchanged" }
  | {
      kind: "benign-additions";
      programs: string[];
      // New writable accounts an assertion program brought along. They are only safe once the
      // network confirms each one is brand new or already owned by that program, so the caller has
      // to check before sending the signature anywhere.
      assertionAccounts: AssertionAccount[];
    }
  | {
      // The wallet could not reproduce Jupiter's compute budget instructions but changed nothing that
      // can move funds. Wallets with their own fee estimation (Solflare has no off switch) do this on
      // every signature, so it is worth allowing — inside a ceiling, see `feeCeilingAllows`.
      kind: "wallet-fees-only";
      programs: string[];
      assertionAccounts: AssertionAccount[];
    }
  | {
      kind: "modified";
      changes: MessageChange[];
      added: string[];
      addedAccounts: string[];
      mismatch: string[];
      // True when the wallet replaced Jupiter's compute budget and the swap stayed blocked anyway,
      // which tells the UI to name the wallet's own fee estimation as the cause.
      walletRewroteFees: boolean;
    };

/**
 * Decide whether the wallet only touched things that cannot change where the user's money goes.
 * Required: the audited instructions survive untouched as an ordered subsequence, every added
 * instruction belongs to Compute Budget (with no accounts), Memo (with accounts the guard already
 * saw) or a known assertion program, and every new account is either one of those program ids as a
 * plain read-only account or the account the assertion instruction itself brings along.
 * The one tolerated exception: the audited instructions may lose Jupiter's own compute budget, as
 * long as everything else passes the same rules and the fee the wallet substituted is negligible.
 */
export function classifyMessageChange(
  before: VersionedMessage,
  after: VersionedMessage,
  resolved?: ResolvedMessages,
): MessageVerdict {
  const changes = diffMessages(before, after, resolved);
  if (changes.length === 0) {
    return { kind: "unchanged" };
  }

  // With resolved identities a different table layout is only a re-encoding: the real addresses and
  // their roles are compared below, and any actual account swap surfaces there. Without resolution
  // a table change could hide a different address behind the same offset, so it stays a hard block.
  const hard = changes.filter(
    (change) =>
      change === "version" || change === "blockhash" || (change === "lookupTables" && resolved === undefined),
  );
  if (hard.length > 0) {
    return modified(changes, [], [], []);
  }

  // Signer slots are never allowed to move; only the read-only unsigned band may grow, and that is
  // exactly what appending a Compute Budget or Memo program does.
  if (
    before.header.numRequiredSignatures !== after.header.numRequiredSignatures ||
    before.header.numReadonlySignedAccounts !== after.header.numReadonlySignedAccounts
  ) {
    return modified(changes, [], [], []);
  }

  const refsBefore = accountRefs(before, resolved?.before);
  const refsAfter = accountRefs(after, resolved?.after);
  const beforeInstructions = instructionEntries(before, refsBefore);
  const afterInstructions = instructionEntries(after, refsAfter);

  const matched = matchSubsequence(beforeInstructions, afterInstructions);
  if (!matched) {
    // The audited instructions did not survive as-is, so "what the wallet added" would be a guess:
    // report instead which audited instruction differs and in which field.
    const lost = lostInstructions(beforeInstructions, afterInstructions);
    const feesOnly = lost.length > 0 && lost.every(({ entry }) => isComputeBudget(entry));
    if (!feesOnly) {
      return modified(changes, [], [], explainMismatches(lost, afterInstructions));
    }
    // Jupiter's own compute budget is the only thing missing, so grade the rest against the same
    // rules as a plain wallet addition, then make sure the fee the wallet substituted stays tiny.
    const kept = matchSubsequence(
      beforeInstructions.filter((entry) => !isComputeBudget(entry)),
      afterInstructions,
    );
    if (!kept) {
      return modified(changes, [], [], explainMismatches(lost, afterInstructions), true);
    }
    const extras = classifyExtras({ before, after, refsBefore, refsAfter, afterInstructions, matched: kept, changes });
    if (extras.kind === "reject") {
      return extras.verdict;
    }
    if (!feeCeilingAllows(afterInstructions)) {
      return modified(changes, [], [], explainMismatches(lost, afterInstructions), true);
    }
    return { kind: "wallet-fees-only", programs: extras.programs, assertionAccounts: extras.assertionAccounts };
  }

  const extras = classifyExtras({ before, after, refsBefore, refsAfter, afterInstructions, matched, changes });
  return extras.kind === "ok"
    ? { kind: "benign-additions", programs: extras.programs, assertionAccounts: extras.assertionAccounts }
    : extras.verdict;
}

function modified(
  changes: MessageChange[],
  added: string[],
  addedAccounts: string[],
  mismatch: string[],
  walletRewroteFees = false,
): ModifiedMessage {
  return { kind: "modified", changes, added, addedAccounts, mismatch, walletRewroteFees };
}

type ModifiedMessage = Extract<MessageVerdict, { kind: "modified" }>;

type Extras =
  | { kind: "ok"; programs: string[]; assertionAccounts: AssertionAccount[] }
  | { kind: "reject"; verdict: ModifiedMessage };

// Validate everything in the signed message that is not one of the audited instructions.
function classifyExtras(args: {
  before: VersionedMessage;
  after: VersionedMessage;
  refsBefore: string[];
  refsAfter: string[];
  afterInstructions: string[];
  matched: Set<number>;
  changes: MessageChange[];
}): Extras {
  const { before, after, refsBefore, refsAfter, afterInstructions, matched, changes } = args;

  const extraInstructions = afterInstructions.filter((_, index) => !matched.has(index));
  const unexpectedAccounts = accountsNotInAudit(before, after, refsBefore, refsAfter, extraInstructions);
  const reject = () => ({
    kind: "reject" as const,
    verdict: modified(changes, describeAdded(afterInstructions, matched), unexpectedAccounts, []),
  });
  if (extraInstructions.length === 0) {
    return reject();
  }

  const addedPrograms = new Set<string>();
  const assertionAccounts: AssertionAccount[] = [];
  for (const entry of extraInstructions) {
    const program = programOf(entry);
    const name = knownProgramName(program);
    const accounts = accountsOf(entry);
    if (!name) {
      return reject();
    }
    if (name === "ComputeBudget" && accounts.length > 0) {
      return reject();
    }

    const isNew = accounts.filter((account) => account !== program && !refsBefore.includes(account));
    if (isNew.length > 0 && ASSERTION_PROGRAM_NAMES[program] === undefined) {
      // Compute Budget and Memo may not drag anything new into the transaction.
      return reject();
    }
    // An account hidden behind a lookup table cannot be named, and therefore cannot be proven in the
    // network later, so an assertion account has to arrive as a plain static key.
    if (isNew.some((account) => account.startsWith("alt:"))) {
      return reject();
    }
    for (const account of isNew) {
      assertionAccounts.push({ address: account, program });
    }
    addedPrograms.add(name);
  }

  const allowedAssertionAccounts = new Set(assertionAccounts.map((account) => account.address));
  const extraPrograms = new Set(extraInstructions.map(programOf));
  const addedAccounts = extraEntries(roleEntries(before, refsBefore), roleEntries(after, refsAfter));
  for (const entry of addedAccounts) {
    const separator = entry.lastIndexOf("=");
    const ref = entry.slice(0, separator);
    const roles = entry.slice(separator + 1);
    if (roles === "--" && (BENIGN_PROGRAM_NAMES[ref] !== undefined || extraPrograms.has(ref))) {
      continue;
    }
    if (roles === "-w" && allowedAssertionAccounts.has(ref)) {
      continue;
    }
    return reject();
  }

  return { kind: "ok", programs: [...addedPrograms], assertionAccounts };
}

// Accounts the signed message carries that the audited one did not, minus the programs the wallet is
// allowed to call. These are the addresses money could move to, so the user has to be able to look
// them up: the short label is enough for ComputeBudget, not for something unknown.
const UNEXPECTED_ACCOUNT_LIMIT = 3;

function accountsNotInAudit(
  before: VersionedMessage,
  after: VersionedMessage,
  refsBefore: string[],
  refsAfter: string[],
  extraInstructions: string[],
): string[] {
  const programs = new Set(extraInstructions.map(programOf));
  const added = [
    ...new Set(
      extraEntries(roleEntries(before, refsBefore), roleEntries(after, refsAfter))
        .map((entry) => entry.slice(0, entry.lastIndexOf("=")))
        .filter((ref) => PROGRAM_LABELS[ref] === undefined && !programs.has(ref)),
    ),
  ];
  return added.slice(0, UNEXPECTED_ACCOUNT_LIMIT).map((ref) => (ref.startsWith("alt:") ? ref.slice(4).replace(":", "#") : ref));
}

function isComputeBudget(entry: string): boolean {
  return programOf(entry) === COMPUTE_BUDGET_PROGRAM;
}

// A wallet-substituted compute budget cannot move tokens, but it is paid from the user's SOL, so it
// is only allowed while the worst case stays under one percent of a SOL. The compute limit of a
// single transaction is capped by the network, so that is the multiplier for the price per unit.
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 10_000_000;

function feeCeilingAllows(entries: string[]): boolean {
  let units = MAX_COMPUTE_UNITS;
  let microLamportsPerUnit = 0;
  for (const entry of entries) {
    if (!isComputeBudget(entry)) {
      continue;
    }
    const data = base64ToBytes(dataOf(entry));
    // 1 = SetComputeUnitLimit (u32), 2 = SetComputeUnitPrice (u64 micro-lamports per unit).
    if (data[0] === 1 && data.length >= 5) {
      units = Math.min(units, readLittle(data, 1, 4));
    } else if (data[0] === 2 && data.length >= 9) {
      microLamportsPerUnit = Math.max(microLamportsPerUnit, readLittle(data, 1, 8));
    }
  }
  return units * microLamportsPerUnit <= MAX_WALLET_PRIORITY_FEE_LAMPORTS * 1_000_000;
}

function readLittle(value: Uint8Array, offset: number, bytes: number): number {
  let result = 0;
  for (let index = bytes - 1; index >= 0; index -= 1) {
    result = result * 256 + (value[offset + index] ?? 0);
  }
  return result;
}

// Positions in `after` that carry each audited instruction, or null when one of them is gone,
// changed or reordered.
function matchSubsequence(before: string[], after: string[]): Set<number> | null {
  const matched = new Set<number>();
  let position = 0;
  for (const entry of before) {
    let index = position;
    while (index < after.length && after[index] !== entry) {
      index += 1;
    }
    if (index === after.length) {
      return null;
    }
    matched.add(index);
    position = index + 1;
  }
  return matched;
}

function accountsOf(entry: string): string[] {
  const accounts = entry.slice(entry.indexOf("|a=") + 3, entry.indexOf("|d="));
  return accounts === "" ? [] : accounts.split(",");
}

function programOf(entry: string): string {
  return entry.slice(2, entry.indexOf("|"));
}

function extraEntries(before: string[], after: string[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of before) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  const extra: string[] = [];
  for (const entry of after) {
    const remaining = counts.get(entry) ?? 0;
    if (remaining > 0) {
      counts.set(entry, remaining - 1);
    } else {
      extra.push(entry);
    }
  }
  return extra;
}

// Unknown programs are printed in full: a truncated address cannot be checked on a block explorer,
// and an unverified program is exactly what the user needs to look up.
function describeAdded(after: string[], matched: Set<number>): string[] {
  return [...new Set(after.filter((_, index) => !matched.has(index)).map((entry) => addedLabel(programOf(entry))))];
}

const PROGRAM_LABELS: Record<string, string> = { ...BENIGN_PROGRAM_NAMES, ...ASSERTION_PROGRAM_NAMES };

function knownProgramName(program: string): string | undefined {
  return PROGRAM_LABELS[program];
}

function addedLabel(program: string): string {
  return PROGRAM_LABELS[program] ?? program;
}

function dataOf(entry: string): string {
  return entry.slice(entry.indexOf("|d=") + 3);
}

function programLabel(program: string): string {
  return PROGRAM_LABELS[program] ?? `${program.slice(0, 8)}…`;
}

function shortRef(ref: string | undefined): string {
  if (!ref) {
    return "none";
  }
  if (ref.startsWith("alt:")) {
    const [, table, offset] = ref.split(":");
    return `ALT ${table?.slice(0, 4)}…#${offset}`;
  }
  return `${ref.slice(0, 4)}…`;
}

const MISMATCH_LIMIT = 3;

// Audited instructions the wallet could not reproduce, with their original positions.
function lostInstructions(before: string[], after: string[]): { entry: string; index: number }[] {
  const lost: { entry: string; index: number }[] = [];
  before.forEach((entry, index) => {
    if (!after.includes(entry)) {
      lost.push({ entry, index });
    }
  });
  return lost;
}

/**
 * Short, pasteable explanation of which audited instruction the wallet could not reproduce.
 * Positional account references mean nothing to a user, but "account 7 differs" tells us exactly
 * whether the wallet shifted indexes or genuinely swapped accounts.
 */
function explainMismatches(lost: { entry: string; index: number }[], after: string[]): string[] {
  const lines = lost.slice(0, MISMATCH_LIMIT).map(({ entry, index }) => `instruction #${index + 1}: ${explainEntry(entry, after)}`);
  const rest = lost.length - lines.length;
  if (rest > 0) {
    lines.push(`… and ${rest} more`);
  }
  return lines;
}

function explainEntry(entry: string, after: string[]): string {
  const program = programOf(entry);
  const label = programLabel(program);
  const counterpart = after
    .filter((candidate) => programOf(candidate) === program)
    .find((candidate) => dataOf(candidate) === dataOf(entry));
  if (!counterpart) {
    const sameProgram = after.some((candidate) => programOf(candidate) === program);
    return sameProgram
      ? "instruction data changed (amount or arguments)"
      : "the program is not present in the wallet transaction";
  }

  const accounts = accountsOf(entry);
  const afterAccounts = accountsOf(counterpart);
  const differences: string[] = [];
  const length = Math.max(accounts.length, afterAccounts.length);
  for (let position = 0; position < length && differences.length < 2; position += 1) {
    if (accounts[position] !== afterAccounts[position]) {
      differences.push(`#${position}: ${shortRef(accounts[position])} → ${shortRef(afterAccounts[position])}`);
    }
  }
  return `different accounts (${differences.join("; ")})`;
}
