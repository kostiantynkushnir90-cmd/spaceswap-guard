import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  buildLegitSwap,
  encodeTokenAccount,
  makeActors,
} from "./fixtures";
import { associatedTokenAddress } from "../src/presign";
import { auditPostStateAuthorities } from "../src/poststate-audit";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const actors = makeActors();
const transaction = buildLegitSwap(actors);

const ataIn = associatedTokenAddress(actors.mintIn, actors.taker).toBase58();

// Addresses the audit will ask about: both token programs' ATAs for input, output and WSOL.
const ALL_MINTS = [actors.mintIn, actors.mintOut, WSOL_MINT];
function allAtaAddresses(): string[] {
  const out: string[] = [];
  for (const mint of ALL_MINTS) {
    for (const program of [TOKEN_PROGRAM_ID, new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")]) {
      out.push(associatedTokenAddress(mint, actors.taker, program).toBase58());
    }
  }
  return out;
}

function mapAddresses<T>(addresses: string[], fill: (address: string) => T): Record<string, T> {
  return Object.fromEntries(addresses.map((address) => [address, fill(address)]));
}

describe("auditPostStateAuthorities — pre-sign simulation diff", () => {
  test("accounts that come back unchanged pass the audit", async () => {
    const pre = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker });
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey: actors.taker, inputMint: actors.mintIn.toBase58(), outputMint: actors.mintOut.toBase58() },
      {
        getAccountInfo: async (addresses) =>
          mapAddresses(addresses, (address) =>
            address === ataIn ? { owner: TOKEN_PROGRAM_ID.toBase58(), data: pre } : null,
          ),
        simulatePostState: async (_tx, addresses) =>
          mapAddresses(addresses, (address) => (address === ataIn ? pre : null)),
      },
    );
    assert.deepEqual(issues, []);
  });

  test("a delegate created by an inner CPI is caught before signing", async () => {
    const pre = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker });
    const post = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker, delegate: actors.drainDelegate });
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey: actors.taker, inputMint: actors.mintIn.toBase58(), outputMint: actors.mintOut.toBase58() },
      {
        getAccountInfo: async (addresses) =>
          mapAddresses(addresses, (address) =>
            address === ataIn ? { owner: TOKEN_PROGRAM_ID.toBase58(), data: pre } : null,
          ),
        simulatePostState: async (_tx, addresses) =>
          mapAddresses(addresses, (address) => (address === ataIn ? post : null)),
      },
    );
    assert.deepEqual(issues.map((i) => i.code), ["POST_STATE_AUTHORITY_CHANGED"]);
    assert.equal(issues[0].level, "block");
    assert.match(issues[0].message, new RegExp(ataIn.slice(0, 4)));
  });

  test("no simulation answer degrades to an explicit warning, never a silent pass", async () => {
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey: actors.taker, inputMint: actors.mintIn.toBase58(), outputMint: actors.mintOut.toBase58() },
      {
        getAccountInfo: async (addresses) => mapAddresses(addresses, () => null),
        simulatePostState: async () => null,
      },
    );
    assert.deepEqual(issues.map((i) => i.code), ["POST_STATE_UNAVAILABLE"]);
    assert.equal(issues[0].level, "warn");
  });

  test("an RPC that throws on the simulation is treated as unavailable, not as clean", async () => {
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey: actors.taker, inputMint: actors.mintIn.toBase58(), outputMint: actors.mintOut.toBase58() },
      {
        getAccountInfo: async (addresses) => mapAddresses(addresses, () => null),
        simulatePostState: async () => {
          throw new Error("rpc down");
        },
      },
    );
    assert.deepEqual(issues.map((i) => i.code), ["POST_STATE_UNAVAILABLE"]);
  });

  test("a simulation that ran and FAILED blocks: consent cannot fix a failing swap", async () => {
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey: actors.taker, inputMint: actors.mintIn.toBase58(), outputMint: actors.mintOut.toBase58() },
      {
        getAccountInfo: async (addresses) => mapAddresses(addresses, () => null),
        simulatePostState: async () => ({ executionError: "AccountNotFound: program" }),
      },
    );
    assert.deepEqual(issues.map((i) => i.code), ["SIMULATION_EXECUTION_FAILED"]);
    assert.equal(issues[0].level, "block");
    assert.match(issues[0].message, /AccountNotFound/);
  });

  test("a truncated result map is 'incomplete' — warned, not asserted clean", async () => {
    const issues = await auditPostStateAuthorities(
      { transaction, publicKey: actors.taker, inputMint: actors.mintIn.toBase58(), outputMint: actors.mintOut.toBase58() },
      {
        getAccountInfo: async (addresses) => mapAddresses(addresses, () => null),
        // Returns entries for only ONE of the many addresses: missing keys are not evidence of absence.
        simulatePostState: async (_tx, addresses) => {
          const partial: Record<string, Uint8Array | null> = { [addresses[0] ?? "x"]: null };
          return partial;
        },
      },
    );
    assert.deepEqual(issues.map((i) => i.code), ["POST_STATE_UNAVAILABLE"]);
  });

  test("the audit covers every mint of a multi-hop route, not just the endpoints", async () => {
    const hopMint = PublicKey.default;
    const seen: string[][] = [];
    await auditPostStateAuthorities(
      {
        transaction,
        publicKey: actors.taker,
        inputMint: actors.mintIn.toBase58(),
        outputMint: actors.mintOut.toBase58(),
        routeMints: [hopMint.toBase58()],
      },
      {
        getAccountInfo: async (addresses) => {
          seen.push(addresses);
          return mapAddresses(addresses, () => null);
        },
        simulatePostState: async (_tx, addresses) => mapAddresses(addresses, () => null),
      },
    );
    const hopAta = associatedTokenAddress(hopMint, actors.taker).toBase58();
    assert.ok(seen[0].includes(hopAta), "intermediate-hop ATA must be part of the compared set");
    // 4 mints (in, out, WSOL, hop) x 2 token programs = 8 accounts.
    assert.equal(seen[0].length, 8);
  });
});
