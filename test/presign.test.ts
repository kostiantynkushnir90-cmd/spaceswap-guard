import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  AMOUNT,
  OUT_AMOUNT,
  PLATFORM_FEE_BPS,
  SLIPPAGE_BPS,
  TOKEN_PROGRAM_ID,
  buildLegitSwap,
  buildSwapWithHiddenWritableDrain,
  encodeMint2022,
  encodeMintBase,
  encodeTokenAccount,
  jupiterRouteInstruction,
  makeActors,
  makeOrder,
  compile,
  computeBudgetInstruction,
} from "./fixtures";
import {
  auditMinOut,
  findUnexpectedUserWritable,
  listWritableAccounts,
  mintRiskIssues,
  parseMintRisk,
  parseTokenAccount,
  passThroughMintIssue,
  postStateAuthorityIssues,
  associatedTokenAddress,
} from "../src/presign";

const actors = makeActors();
const expectedMinOut = ((OUT_AMOUNT * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n).toString();

describe("auditMinOut — the on-chain price floor", () => {
  test("decodes amount, quote, slippage and fee from the route instruction itself", () => {
    const transaction = buildLegitSwap(actors);
    const audit = auditMinOut(transaction, { writable: [], readonly: [] }, makeOrder(actors, transaction));
    assert.equal(audit.source, "instruction");
    assert.equal(audit.quotedOutAmount, OUT_AMOUNT.toString());
    assert.equal(audit.slippageBps, SLIPPAGE_BPS);
    assert.equal(audit.platformFeeBps, PLATFORM_FEE_BPS);
    assert.equal(audit.minOutAmount, expectedMinOut);
  });

  test("falls back to the quote-derived floor when the instruction bytes do not reproduce the order", () => {
    const transaction = buildLegitSwap(actors);
    const tampered = { ...makeOrder(actors, transaction), outAmount: (OUT_AMOUNT * 2n).toString() };
    const audit = auditMinOut(transaction, { writable: [], readonly: [] }, tampered);
    assert.equal(audit.source, "quote");
    assert.equal(audit.platformFeeBps, null);
    // Honest fallback: the floor is still computed, but from the order values, never claimed as decoded.
    assert.equal(audit.minOutAmount, ((2n * OUT_AMOUNT * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n).toString());
  });

  test("a route instruction shorter than the 19 trailing bytes is never trusted as decoded", () => {
    const short = compile(
      [{ programId: jupiterRouteInstruction(actors).programId, keys: [{ pubkey: actors.taker, isSigner: true, isWritable: true }], data: Buffer.alloc(26) }],
      actors.taker,
    );
    const audit = auditMinOut(short, { writable: [], readonly: [] }, { amount: AMOUNT.toString(), outAmount: OUT_AMOUNT.toString(), slippageBps: SLIPPAGE_BPS });
    assert.equal(audit.source, "quote");
  });
});

describe("listWritableAccounts + findUnexpectedUserWritable — the CPI reach bound", () => {
  test("the writable set is exactly what the signed message declares", () => {
    const transaction = buildLegitSwap(actors);
    const writables = listWritableAccounts(transaction.message);
    assert.ok(writables.includes(actors.taker.toBase58()));
    assert.ok(writables.includes(actors.ataIn.toBase58()));
    assert.ok(writables.includes(actors.ataOut.toBase58()));
    // Read-only mints are not writable.
    assert.ok(!writables.includes(actors.mintIn.toBase58()));
  });

  test("the drain fixture makes a SECOND user-owned token account writable", () => {
    const transaction = buildSwapWithHiddenWritableDrain(actors);
    const writables = listWritableAccounts(transaction.message);
    assert.ok(writables.includes(actors.victimAta.toBase58()));
  });

  test("a writable user token account outside the swap route is detected", () => {
    const transaction = buildSwapWithHiddenWritableDrain(actors);
    const writables = listWritableAccounts(transaction.message);
    const infos: Record<string, { owner: string; data: Uint8Array } | null> = {
      [actors.victimAta.toBase58()]: {
        owner: TOKEN_PROGRAM_ID.toBase58(),
        data: encodeTokenAccount({ mint: actors.victimMint, owner: actors.taker }),
      },
    };
    const expected = new Set([actors.ataIn.toBase58(), actors.ataOut.toBase58()]);
    const unexpected = findUnexpectedUserWritable(writables, infos, actors.taker.toBase58(), expected);
    assert.deepEqual(unexpected, [actors.victimAta.toBase58()]);
  });

  test("the legitimate route's own accounts pass the same bound", () => {
    const transaction = buildLegitSwap(actors);
    const writables = listWritableAccounts(transaction.message);
    const infos: Record<string, { owner: string; data: Uint8Array } | null> = {
      [actors.ataIn.toBase58()]: { owner: TOKEN_PROGRAM_ID.toBase58(), data: encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker }) },
      [actors.ataOut.toBase58()]: { owner: TOKEN_PROGRAM_ID.toBase58(), data: encodeTokenAccount({ mint: actors.mintOut, owner: actors.taker }) },
    };
    const expected = new Set([
      actors.ataIn.toBase58(),
      actors.ataOut.toBase58(),
      associatedTokenAddress(actors.mintIn, actors.taker).toBase58(),
    ]);
    assert.deepEqual(findUnexpectedUserWritable(writables, infos, actors.taker.toBase58(), expected), []);
  });

  test("accounts owned by someone else, or not token accounts, are not the user's funds", () => {
    const transaction = buildSwapWithHiddenWritableDrain(actors);
    const writables = listWritableAccounts(transaction.message);
    const otherOwner = encodeTokenAccount({ mint: actors.victimMint, owner: actors.drainDelegate });
    const infos = { [actors.victimAta.toBase58()]: { owner: TOKEN_PROGRAM_ID.toBase58(), data: otherOwner } };
    assert.deepEqual(findUnexpectedUserWritable(writables, infos, actors.taker.toBase58(), new Set()), []);
  });
});

describe("parseTokenAccount / parseMintRisk — reading raw chain state", () => {
  test("an existing delegate with unlimited delegated amount is surfaced", () => {
    const data = encodeTokenAccount({
      mint: actors.victimMint,
      owner: actors.taker,
      delegate: actors.drainDelegate,
      delegatedAmount: 2n ** 64n - 1n,
    });
    const parsed = parseTokenAccount(data)!;
    assert.equal(parsed.owner, actors.taker.toBase58());
    assert.equal(parsed.delegate, actors.drainDelegate.toBase58());
    assert.equal(parsed.state, 1);
  });

  test("short or corrupt account data parses to nothing rather than a clean verdict", () => {
    assert.equal(parseTokenAccount(new Uint8Array(164)), null);
    assert.equal(parseMintRisk(new Uint8Array(81)), null);
  });

  test("Token-2022 TLV extensions decode permanent delegate and transfer hook", () => {
    const data = encodeMint2022({ permanentDelegate: actors.drainDelegate, transferHook: actors.unknownProgram });
    const risk = parseMintRisk(data)!;
    assert.equal(risk.permanentDelegate, actors.drainDelegate.toBase58());
    assert.equal(risk.transferHook, actors.unknownProgram.toBase58());
    const issues = mintRiskIssues(actors.victimMint.toBase58(), risk);
    const codes = issues.map((issue) => issue.code);
    assert.ok(codes.includes("ISSUER_PERMANENT_DELEGATE"));
    assert.ok(codes.includes("ISSUER_TRANSFER_HOOK"));
    // Issuer custody powers are consent-gated warnings, and every message names the power plainly.
    assert.ok(issues.every((issue) => issue.level === "warn"));
    assert.match(issues[0].message, /without your signature/);
  });

  test("a pass-through hop names only the powers that act inside this transaction", () => {
    const hop = actors.victimMint.toBase58();
    const custody = parseMintRisk(encodeMint2022({ permanentDelegate: actors.drainDelegate }))!;
    const issue = passThroughMintIssue(hop, custody);
    assert.equal(issue?.level, "warn");
    assert.equal(issue?.code, "ROUTE_PASSTHROUGH_ISSUER_POWERS");
    assert.equal(issue?.params?.powers, "permanent delegate");
    assert.match(issue?.message ?? "", /you do not keep it/);
    // Freeze authority alone stops a later sale of a token the user does not hold — no line for it.
    assert.equal(passThroughMintIssue(hop, parseMintRisk(encodeMintBase({ freezeAuthority: actors.drainDelegate }))!), null);
  });

  test("a classic SPL mint keeps freeze authority from the base layout", () => {
    const risk = parseMintRisk(encodeMintBase({ freezeAuthority: actors.drainDelegate }))!;
    assert.equal(risk.freezeAuthority, actors.drainDelegate.toBase58());
    assert.equal(risk.permanentDelegate, null);
    assert.equal(mintRiskIssues("mint", risk)[0].code, "MINT_FREEZE_AUTHORITY");
  });

  test("a clean mint produces no issues at all", () => {
    const risk = parseMintRisk(encodeMintBase())!;
    assert.deepEqual(mintRiskIssues("mint", risk), []);
  });
});

describe("postStateAuthorityIssues — the simulation diff that catches CPI-hidden drains", () => {
  const clean = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker });
  const delegated = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker, delegate: actors.drainDelegate });
  const reOwned = encodeTokenAccount({ mint: actors.mintIn, owner: actors.drainDelegate });
  const closed = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker, closeAuthority: actors.drainDelegate });

  test("a swap that only moves amounts passes", () => {
    const changed = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker, amount: 5n });
    assert.deepEqual(postStateAuthorityIssues([{ address: "ata-in", pre: parseTokenAccount(clean), post: parseTokenAccount(changed) }]), []);
  });

  test("a delegate appearing inside the swap blocks", () => {
    const issues = postStateAuthorityIssues([{ address: "ata-in", pre: parseTokenAccount(clean), post: parseTokenAccount(delegated) }]);
    assert.deepEqual(issues.map((i) => i.code), ["POST_STATE_AUTHORITY_CHANGED"]);
    assert.equal(issues[0].level, "block");
    assert.match(issues[0].message, /delegate/);
  });

  test("an ownership rewrite or a new close authority blocks too", () => {
    for (const post of [reOwned, closed]) {
      const issues = postStateAuthorityIssues([{ address: "ata-in", pre: parseTokenAccount(clean), post: parseTokenAccount(post) }]);
      assert.equal(issues[0]?.code, "POST_STATE_AUTHORITY_CHANGED");
    }
  });

  test("accounts missing on either side are skipped, not guessed", () => {
    assert.deepEqual(postStateAuthorityIssues([{ address: "x", pre: null, post: parseTokenAccount(delegated) }]), []);
  });
});
