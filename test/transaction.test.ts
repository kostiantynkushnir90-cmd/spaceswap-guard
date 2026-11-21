import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  buildLegitSwap,
  buildSwapWithApproveCheckedDrain,
  buildSwapWithApproveDrain,
  buildSwapWithSetAuthorityDrain,
  compile,
  makeActors,
} from "./fixtures";
import { inspectSwapTransaction } from "../src/transaction";

const actors = makeActors();
const codes = (level: "block" | "warn", issues: { level: string; code: string }[]) =>
  issues.filter((issue) => issue.level === level).map((issue) => issue.code);

describe("inspectSwapTransaction — instruction decode", () => {
  test("a legitimate Jupiter-shaped swap raises no block", () => {
    const issues = inspectSwapTransaction(buildLegitSwap(actors));
    assert.deepEqual(codes("block", issues), []);
    assert.deepEqual(codes("warn", issues), []);
  });

  test("a top-level Approve (delegation of spending rights) hard-blocks", () => {
    const issues = inspectSwapTransaction(buildSwapWithApproveDrain(actors));
    assert.deepEqual(codes("block", issues), ["DRAIN_APPROVE"]);
  });

  test("a top-level SetAuthority (ownership rewrite) hard-blocks", () => {
    const issues = inspectSwapTransaction(buildSwapWithSetAuthorityDrain(actors));
    assert.deepEqual(codes("block", issues), ["DRAIN_SET_AUTHORITY"]);
  });

  test("ApproveChecked — a scoped delegation — also hard-blocks", () => {
    const issues = inspectSwapTransaction(buildSwapWithApproveCheckedDrain(actors));
    assert.deepEqual(codes("block", issues), ["DRAIN_APPROVE_CHECKED"]);
  });

  test("the same drain via Token-2022 blocks too and warns about extensions", () => {
    const drain = compile(
      [
        {
          programId: TOKEN_2022_PROGRAM_ID,
          keys: [
            { pubkey: actors.victimAta, isSigner: false, isWritable: true },
            { pubkey: actors.taker, isSigner: true, isWritable: false },
            { pubkey: actors.drainDelegate, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([4, ...new Uint8Array(8)]), // Approve
        },
      ],
      actors.taker,
    );
    const issues = inspectSwapTransaction(drain);
    assert.ok(codes("block", issues).includes("DRAIN_APPROVE"));
    assert.ok(codes("warn", issues).includes("TOKEN_2022_IN_TX"));
  });

  test("an unknown program is disclosed as a warning, never passed silently", () => {
    const withUnknown = buildLegitSwap(actors, {
      extraInstructions: [{ programId: actors.unknownProgram, keys: [], data: Buffer.from([9]) }],
    });
    const issues = inspectSwapTransaction(withUnknown);
    const unknowns = codes("warn", issues).filter((code) => code === "UNKNOWN_PROGRAM");
    assert.equal(unknowns.length, 1);
    assert.match(
      issues.find((issue) => issue.code === "UNKNOWN_PROGRAM")!.message,
      new RegExp(actors.unknownProgram.toBase58().slice(0, 8)),
    );
  });

  test("the drain detection survives extra padding in the instruction data", () => {
    // Approve with a bloated data field: only the discriminator byte decides, so padding changes nothing.
    const padded = compile(
      [
        {
          programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          keys: [
            { pubkey: actors.victimAta, isSigner: false, isWritable: true },
            { pubkey: actors.taker, isSigner: true, isWritable: false },
            { pubkey: actors.drainDelegate, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xab)]),
        },
      ],
      actors.taker,
    );
    assert.deepEqual(codes("block", inspectSwapTransaction(padded)), ["DRAIN_APPROVE"]);
  });
});
