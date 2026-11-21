import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  buildLegitSwap,
  buildSwapWithApproveDrain,
  buildSwapWithHiddenWritableDrain,
  encodeMint2022,
  encodeTokenAccount,
  makeActors,
  makeOrder,
} from "./fixtures";
import { SwapGuardError } from "../src/errors";
import { associatedTokenAddress } from "../src/presign";
import { preparePreSignAudit, type PreSignDeps } from "../src/presign-audit";
import type { OrderResponse } from "../src/types";

const actors = makeActors();
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const request = {
  inputMint: actors.mintIn.toBase58(),
  outputMint: actors.mintOut.toBase58(),
  amount: "1000000",
  slippageBps: 50,
};

// All accounts absent until a test says otherwise; lookups empty; block height steady.
function deps(overrides: {
  order?: OrderResponse;
  infos?: Record<string, { owner: string; data: Uint8Array } | null>;
  simulatePostState?: PreSignDeps["simulatePostState"];
  now?: () => number;
}): PreSignDeps {
  return {
    getOrder: async () => {
      if (!overrides.order) throw new Error("no order in this test");
      return overrides.order;
    },
    getBlockHeight: async () => 1000,
    getAddressLookupTableAccounts: async () => [],
    getAccountInfo: async (addresses) =>
      Object.fromEntries(addresses.map((address) => [address, overrides.infos?.[address] ?? null])),
    simulatePostState:
      overrides.simulatePostState ??
      (async (_tx, addresses) => Object.fromEntries(addresses.map((address) => [address, null]))),
    now: overrides.now,
  };
}

function baseParams() {
  return { request, taker: actors.taker.toBase58(), publicKey: actors.taker, feeConfigured: true };
}

// The post-state audit needs every expected ATA key present in the maps; "all absent" maps are
// built from the same derivation the guard uses.
function expectedAtas(): string[] {
  const out: string[] = [];
  for (const mint of [actors.mintIn.toBase58(), actors.mintOut.toBase58(), WSOL_MINT]) {
    for (const program of [TOKEN_PROGRAM_ID, new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")]) {
      out.push(associatedTokenAddress(new PublicKey(mint), actors.taker, program).toBase58());
    }
  }
  return out;
}

describe("preparePreSignAudit — the full pre-sign pipeline", () => {
  test("a legitimate swap passes every check and reports its on-chain floor", async () => {
    const transaction = buildLegitSwap(actors);
    const { audit } = await preparePreSignAudit(baseParams(), deps({ order: makeOrder(actors, transaction) }));
    assert.equal(audit.minOut.source, "instruction");
    assert.equal(audit.accountsReadable, true);
    assert.equal(audit.postState?.status, "verified");
    assert.equal(audit.issuerConsentRequired, false);
    assert.deepEqual(audit.warnings, []);
    // The writable set shown to the user contains their own trade accounts.
    assert.ok(audit.writableAccounts.includes(actors.ataIn.toBase58()));
  });

  test("an Approve drain anywhere in the transaction blocks BEFORE the wallet sees anything", async () => {
    const transaction = buildSwapWithApproveDrain(actors);
    await assert.rejects(
      preparePreSignAudit(baseParams(), deps({ order: makeOrder(actors, transaction) })),
      (error: unknown) => {
        assert.ok(error instanceof SwapGuardError);
        assert.ok(error.issues.some((issue) => issue.code === "DRAIN_APPROVE" && issue.level === "block"));
        return true;
      },
    );
  });

  test("a user token account made writable outside the route blocks (DRAIN_WRITABLE_ACCOUNT)", async () => {
    const transaction = buildSwapWithHiddenWritableDrain(actors);
    await assert.rejects(
      preparePreSignAudit(baseParams(), deps({
        order: makeOrder(actors, transaction),
        infos: {
          [actors.victimAta.toBase58()]: {
            owner: TOKEN_PROGRAM_ID.toBase58(),
            data: encodeTokenAccount({ mint: actors.victimMint, owner: actors.taker }),
          },
        },
      })),
      (error: unknown) => {
        assert.ok(error instanceof SwapGuardError);
        assert.ok(error.issues.some((issue) => issue.code === "DRAIN_WRITABLE_ACCOUNT"));
        assert.match(error.message, new RegExp(actors.victimAta.toBase58()));
        return true;
      },
    );
  });

  test("a CPI-hidden delegate change found in simulation blocks before signing", async () => {
    const transaction = buildLegitSwap(actors);
    const ataIn = actors.ataIn.toBase58();
    const pre = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker });
    const post = encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker, delegate: actors.drainDelegate });
    await assert.rejects(
      preparePreSignAudit(baseParams(), deps({
        order: makeOrder(actors, transaction),
        infos: { [ataIn]: { owner: TOKEN_PROGRAM_ID.toBase58(), data: pre } },
        simulatePostState: async (_tx, addresses) =>
          Object.fromEntries(addresses.map((address) => [address, address === ataIn ? post : null])),
      })),
      (error: unknown) => {
        assert.ok(error instanceof SwapGuardError);
        assert.ok(error.issues.some((issue) => issue.code === "POST_STATE_AUTHORITY_CHANGED"));
        return true;
      },
    );
  });

  test("issuer custody powers are consent-gated, not silently allowed or blanket-banned", async () => {
    const transaction = buildLegitSwap(actors);
    const riskyMint = actors.mintIn.toBase58();
    const { audit } = await preparePreSignAudit(baseParams(), deps({
      order: makeOrder(actors, transaction, { routeMints: [riskyMint] }),
      infos: {
        [riskyMint]: {
          owner: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").toBase58(),
          data: encodeMint2022({ permanentDelegate: actors.drainDelegate }),
        },
      },
    }));
    assert.equal(audit.issuerConsentRequired, true);
    assert.ok(audit.warnings.some((issue) => issue.code === "ISSUER_PERMANENT_DELEGATE"));
  });

  test("an order that differs from what the user requested is refused (ORDER_MISMATCH)", async () => {
    const transaction = buildLegitSwap(actors);
    const order = { ...makeOrder(actors, transaction), amount: "999999" };
    await assert.rejects(
      preparePreSignAudit(baseParams(), deps({ order })),
      (error: unknown) => error instanceof SwapGuardError && error.issues.some((i) => i.code === "ORDER_MISMATCH"),
    );
  });

  test("a taker who is not a signer of the transaction is refused", async () => {
    const transaction = buildLegitSwap(actors);
    const stranger = makeActors();
    await assert.rejects(
      preparePreSignAudit({ ...baseParams(), publicKey: stranger.taker, taker: stranger.taker.toBase58() }, deps({
        order: makeOrder(actors, transaction),
      })),
      (error: unknown) => error instanceof SwapGuardError && error.issues.some((i) => i.code === "TAKER_NOT_SIGNER"),
    );
  });

  test("a stale quote blocks on freshness before anything else is trusted", async () => {
    const transaction = buildLegitSwap(actors);
    const order = makeOrder(actors, transaction, { fetchedAt: Date.now() - 60_000 });
    await assert.rejects(
      preparePreSignAudit(baseParams(), deps({ order })),
      (error: unknown) => error instanceof SwapGuardError && error.issues.some((i) => i.code === "QUOTE_STALE"),
    );
  });

  test("simulation unavailable is DISCLOSED in the audit the user confirms, not hidden", async () => {
    const transaction = buildLegitSwap(actors);
    const { audit } = await preparePreSignAudit(baseParams(), deps({
      order: makeOrder(actors, transaction),
      simulatePostState: async () => null,
    }));
    assert.equal(audit.postState?.status, "unavailable");
    assert.ok(audit.warnings.some((issue) => issue.code === "POST_STATE_UNAVAILABLE"));
  });

  test("the simulation covers the full route: every intermediate mint ATA is requested", async () => {
    const transaction = buildLegitSwap(actors);
    const hopMint = PublicKey.default.toBase58();
    const requested: string[][] = [];
    await preparePreSignAudit(baseParams(), deps({
      order: makeOrder(actors, transaction, { routeMints: [hopMint] }),
      simulatePostState: async (_tx, addresses) => {
        requested.push(addresses);
        return Object.fromEntries(addresses.map((address) => [address, null]));
      },
    }));
    const addresses = requested.at(-1) ?? [];
    const hopAta = associatedTokenAddress(PublicKey.default, actors.taker).toBase58();
    assert.ok(addresses.includes(hopAta));
    for (const address of expectedAtas()) {
      assert.ok(addresses.includes(address), `${address} must be compared`);
    }
  });
});
