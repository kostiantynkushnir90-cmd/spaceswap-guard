import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  BLOCKHASH,
  buildLegitSwap,
  buildSwapWithApproveDrain,
  compile,
  computeBudgetInstruction,
  computeBudgetPriceInstruction,
  makeActors,
  memoInstruction,
  TOKEN_PROGRAM_ID,
} from "./fixtures";
import { classifyMessageChange, diffMessages } from "../src/message-equality";
import { AMOUNT, createAtaInstruction, jupiterRouteInstruction } from "./fixtures";
import { TransactionMessage } from "@solana/web3.js";

const actors = makeActors();

const legitInstructions = () => [
  computeBudgetInstruction(),
  createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
  jupiterRouteInstruction(actors),
];

describe("diffMessages — semantic equality of the signed transaction", () => {
  test("the same message reports no changes", () => {
    const message = buildLegitSwap(actors).message;
    assert.deepEqual(diffMessages(message, message), []);
  });

  test("rebuilding the identical effect from scratch reports no changes", () => {
    const original = buildLegitSwap(actors).message;
    const rebuilt = compile(legitInstructions(), actors.taker).message;
    assert.deepEqual(diffMessages(original, rebuilt), []);
  });

  test("a different blockhash is a semantic change and a hard block", () => {
    const audited = buildLegitSwap(actors).message;
    const moved = new TransactionMessage({
      payerKey: actors.taker,
      recentBlockhash: "EkVrDbXiCyAKVVfsMDXCiu44uVfWP3Mddvj8QxVN95QS",
      instructions: legitInstructions(),
    }).compileToV0Message();
    assert.ok(diffMessages(audited, moved).includes("blockhash"));
    assert.equal(classifyMessageChange(audited, moved).kind, "modified");
  });

  test("an added Approve instruction surfaces as an instructions change", () => {
    const audited = buildLegitSwap(actors).message;
    const signed = buildSwapWithApproveDrain(actors).message;
    assert.ok(diffMessages(audited, signed).includes("instructions"));
  });
});

describe("classifyMessageChange — what a wallet may still do", () => {
  test("an untouched signature passes", () => {
    const audited = buildLegitSwap(actors).message;
    assert.deepEqual(classifyMessageChange(audited, audited), { kind: "unchanged" });
  });

  test("appending the wallet's own compute budget price is benign", () => {
    const audited = buildLegitSwap(actors).message;
    const signed = compile(
      [
        computeBudgetInstruction(),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        jupiterRouteInstruction(actors),
        computeBudgetPriceInstruction(1000n),
      ],
      actors.taker,
    ).message;
    const verdict = classifyMessageChange(audited, signed);
    assert.equal(verdict.kind, "benign-additions");
    assert.deepEqual((verdict as { programs: string[] }).programs, ["ComputeBudget"]);
  });

  test("appending a memo is benign", () => {
    const audited = buildLegitSwap(actors).message;
    const signed = compile(
      [
        computeBudgetInstruction(),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        jupiterRouteInstruction(actors),
        memoInstruction("spacewap"),
      ],
      actors.taker,
    ).message;
    assert.equal(classifyMessageChange(audited, signed).kind, "benign-additions");
  });

  test("appending a token Approve — a fund-moving instruction — hard-blocks", () => {
    const audited = buildLegitSwap(actors).message;
    const signed = buildSwapWithApproveDrain(actors).message;
    const verdict = classifyMessageChange(audited, signed);
    assert.equal(verdict.kind, "modified");
    const modified = verdict as { added: string[]; addedAccounts: string[] };
    // The user is told WHICH program was called (in full, so it can be looked up)…
    assert.ok(modified.added.includes(TOKEN_PROGRAM_ID.toBase58()));
    // …and which NEW account money could move to.
    assert.ok(modified.addedAccounts.includes(actors.victimAta.toBase58()));
  });

  test("changing the swap amount mid-signature is a modification, explained", () => {
    const audited = buildLegitSwap(actors).message;
    const tamperedRoute = {
      ...jupiterRouteInstruction(actors),
      data: (() => {
        const route = jupiterRouteInstruction(actors);
        const data = Buffer.from(route.data);
        data.writeBigUInt64LE(AMOUNT / 2n, 20); // silently halve the input amount
        return data;
      })(),
    };
    const signed = compile(
      [
        computeBudgetInstruction(),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        tamperedRoute,
      ],
      actors.taker,
    ).message;
    const verdict = classifyMessageChange(audited, signed);
    assert.equal(verdict.kind, "modified");
    const mismatch = (verdict as { mismatch: string[] }).mismatch;
    assert.equal(mismatch.length, 1);
    assert.match(mismatch[0], /instruction data changed/);
  });

  test("a wallet replacing Jupiter's compute budget with a small one is allowed as wallet-fees-only", () => {
    const audited = compile(
      [
        computeBudgetInstruction(200_000),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        jupiterRouteInstruction(actors),
      ],
      actors.taker,
    ).message;
    const signed = compile(
      [
        computeBudgetInstruction(300_000),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        jupiterRouteInstruction(actors),
      ],
      actors.taker,
    ).message;
    assert.equal(classifyMessageChange(audited, signed).kind, "wallet-fees-only");
  });

  test("a wallet-substituted fee above the 0.01 SOL ceiling is refused, blaming the wallet's fee logic", () => {
    const audited = compile(
      [
        computeBudgetInstruction(200_000),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        jupiterRouteInstruction(actors),
      ],
      actors.taker,
    ).message;
    // 1.4M units * 10M µlam/unit = 14 SOL worst case — far above the 0.01 SOL ceiling.
    const signed = compile(
      [
        computeBudgetPriceInstruction(10_000_000n),
        createAtaInstruction(actors.taker, actors.ataOut, actors.taker, actors.mintOut),
        jupiterRouteInstruction(actors),
      ],
      actors.taker,
    ).message;
    const verdict = classifyMessageChange(audited, signed);
    assert.equal(verdict.kind, "modified");
    assert.equal((verdict as { walletRewroteFees: boolean }).walletRewroteFees, true);
  });
});
