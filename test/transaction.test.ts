import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  JUPITER_PROGRAM,
  buildLegitSwap,
  buildRouterSwap,
  buildSwapWithApproveCheckedDrain,
  buildSwapWithApproveDrain,
  buildSwapWithSetAuthorityDrain,
  tokenApproveInstruction,
  compile,
  makeActors,
} from "./fixtures";
import { ROUTER_PROGRAMS, inspectSwapTransaction } from "../src/transaction";

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

// Jupiter's swap API is a meta-aggregator: it names the router that built the transaction in
// `order.router`, so the guard has to be able to tell "this program was declared" from "this program
// appeared on its own". Measured addresses, mainnet, 2026-11-21.
describe("inspectSwapTransaction — Jupiter routers", () => {
  const OKX_ROUTER = new PublicKey("proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u");

  test("the router Jupiter named for this build is expected, not disclosed as unknown", () => {
    const issues = inspectSwapTransaction(buildRouterSwap(actors, OKX_ROUTER), undefined, "okx");
    assert.deepEqual(codes("block", issues), []);
    assert.deepEqual(codes("warn", issues), []);
  });

  test("the same transaction with no declared router still warns", () => {
    const issues = inspectSwapTransaction(buildRouterSwap(actors, OKX_ROUTER));
    assert.deepEqual(codes("warn", issues), ["UNKNOWN_PROGRAM"]);
  });

  test("a declared router that does not match the build does not silence the warning", () => {
    for (const declared of ["metis", "dflow", "jupiterz", "jito", ""]) {
      const issues = inspectSwapTransaction(buildRouterSwap(actors, OKX_ROUTER), undefined, declared);
      assert.deepEqual(codes("warn", issues), ["UNKNOWN_PROGRAM"], `router=${declared || "(empty)"}`);
    }
  });
  test("a declared router does not soften the drain rules", () => {
    const swap = buildRouterSwap(actors, OKX_ROUTER, [
      tokenApproveInstruction(actors.victimAta, actors.taker, actors.drainDelegate),
    ]);
    const issues = inspectSwapTransaction(swap, undefined, "okx");
    assert.deepEqual(codes("block", issues), ["DRAIN_APPROVE"]);
    assert.deepEqual(codes("warn", issues), []);
  });

  test("the router catalog is complete and every address is a real program id", () => {
    assert.deepEqual([...ROUTER_PROGRAMS.keys()].sort(), ["dflow", "jupiterz", "metis", "okx"]);
    for (const [name, address] of ROUTER_PROGRAMS) {
      assert.equal(new PublicKey(address).toBase58(), address, name);
    }
    // metis is Jupiter's own router: its address is the aggregator KNOWN_PROGRAMS already lists.
    assert.equal(ROUTER_PROGRAMS.get("metis"), JUPITER_PROGRAM.toBase58());
  });
});
